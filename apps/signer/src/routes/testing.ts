/**
 * Test doubles for the signing routes: an in-memory chain that is both the `SolanaRpc` and the
 * `RouteCore` of the routes (it builds transactions shaped like core's, executes the config,
 * nonce and launch instructions it understands, verifies signatures, expires blockhashes, lags
 * finality, injects failures), and an in-memory `RouteStore` with the same compare-and-set
 * semantics as the Supabase one. Also used by the devnet script for the database side only.
 * No private key material: FORGE signatures always go through a real keystore in the tests.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  paymentMemo,
  type ConfigKind,
  type LaunchCoinSummary,
  type LaunchCoinTx,
} from '@forge/core';
import type { JobStatus, LaunchpadSpec, LaunchpadStatus, PaymentStatus } from '@forge/shared';
import type { ExpectedPayment, PaymentVerification } from '../core-adapter.js';
import {
  base58Encode,
  type RecentSignature,
  type SignatureLookup,
  type SolanaRpc,
} from '../jobs/shared.js';
import type {
  AccountSummary,
  BuiltCreationTx,
  LaunchBuildParams,
  NonceState,
  ReadCommitment,
  RouteCore,
} from './onchain.js';
import { canonicalJson, sha256Hex } from './onchain.js';
import type { RoutePaymentVerifier } from './payment.js';
import { DBC_DISCRIMINATORS } from './policy.js';
import type {
  LaunchpadAddressColumn,
  RouteJob,
  RouteLaunchpad,
  RoutePayment,
  RouteStore,
} from './store.js';

export function randomKey(): PublicKey {
  return new PublicKey(randomBytes(32));
}

export class TransientRpcError extends Error {
  override readonly name = 'FetchError';
  readonly code = 'ECONNRESET';
  constructor() {
    super('fetch failed');
  }
}

export type SendBehavior =
  'land' | 'drop' | 'fail_onchain' | 'network_error' | 'land_then_network_error' | 'reject';

export interface FakeAccount {
  owner: PublicKey;
  lamports: bigint;
  dataLength: number;
  /** Set on initialized nonce accounts. */
  nonce?: { authority: PublicKey; value: string };
  /** Height at which the account appeared (finalized reads only see it once finalized). */
  height: number;
}

interface LandedTx {
  signature: string;
  height: number;
  err: unknown;
  accounts: string[];
}

/** A client payment to the cashbox, as the chain sees it (for `verifyPayment`). */
export interface FakePayment {
  payer: PublicKey;
  recipient: PublicKey;
  lamports: bigint;
  memo: string;
  slot: number;
  finalized: boolean;
  failed: boolean;
}

type Method = keyof SolanaRpc | keyof RouteCore | keyof RoutePaymentVerifier;

export const CONFIG_ACCOUNT_SIZE = 1048;
export const LAUNCH_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

/** Random base58 transaction signature (64 bytes). */
export function randomSignature(): string {
  return base58Encode(randomBytes(64));
}

/** In-memory chain: the routes' `SolanaRpc`, `RouteCore` and payment verifier at once. */
export class FakeRouteChain implements SolanaRpc, RouteCore, RoutePaymentVerifier {
  readonly dbcProgramId = DYNAMIC_BONDING_CURVE_PROGRAM_ID;
  readonly firstBuyReferral = null;
  readonly cashbox = randomKey();
  /** Client payments by signature (what `verifyPayment` finds on-chain). */
  readonly payments = new Map<string, FakePayment>();
  height = 1_000;
  finalityLag = 32;
  defaultBehavior: SendBehavior = 'land';
  readonly behaviors: SendBehavior[] = [];
  readonly balances = new Map<string, bigint>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly blockhashes = new Map<string, number>();
  readonly landed = new Map<string, LandedTx>();
  readonly sendAttempts: string[] = [];
  readonly calls: Method[] = [];
  /** `minContextSlot` of every account read that set one. */
  readonly minContextSlots: number[] = [];
  readonly failures = new Map<Method, Error[]>();
  readonly built = { config: 0, nonce: 0, launch: 0 };
  /** Successful transactions touching an address (for `hasSuccessfulTransaction`). */
  readonly history = new Map<string, boolean[]>();
  /** Makes the next launch build report another nonce value than the one read before it. */
  launchNonceOverride: string | null = null;
  configRent = 8_184_960n;
  nonceRent = 1_447_680n;

  get finalizedHeight(): number {
    return this.height - this.finalityLag;
  }

  setBalance(address: PublicKey, lamports: bigint): void {
    this.balances.set(address.toBase58(), lamports);
  }

  balanceOf(address: PublicKey): bigint {
    return this.balances.get(address.toBase58()) ?? 0n;
  }

  failNext(method: Method, error: Error, times = 1): void {
    const list = this.failures.get(method) ?? [];
    for (let i = 0; i < times; i++) list.push(error);
    this.failures.set(method, list);
  }

  advance(blocks: number): void {
    this.height += blocks;
  }

  /** Accounts created by landed transactions, by kind of owner. */
  accountsOwnedBy(owner: PublicKey): string[] {
    return [...this.accounts.entries()].filter(([, a]) => a.owner.equals(owner)).map(([k]) => k);
  }

  /** Moves a nonce forward as if another transaction had used it. */
  advanceNonce(nonceAccount: PublicKey): string {
    const account = this.accounts.get(nonceAccount.toBase58());
    if (!account?.nonce) throw new Error('not a nonce account');
    const value = randomKey().toBase58();
    account.nonce = { ...account.nonce, value };
    this.height += 1;
    return value;
  }

  private enter(method: Method): void {
    this.calls.push(method);
    const err = this.failures.get(method)?.shift();
    if (err) throw err;
  }

  private visible(account: FakeAccount | undefined, commitment: ReadCommitment): boolean {
    if (!account) return false;
    return commitment === 'confirmed' || account.height <= this.finalizedHeight;
  }

  private newBlockhash(): { blockhash: string; lastValidBlockHeight: number } {
    const blockhash = randomKey().toBase58();
    const lastValidBlockHeight = this.height + 150;
    this.blockhashes.set(blockhash, lastValidBlockHeight);
    return { blockhash, lastValidBlockHeight };
  }

  // -- SolanaRpc -------------------------------------------------------------------------

  async getLatestBlockhash() {
    this.enter('getLatestBlockhash');
    return this.newBlockhash();
  }

  async getBlockHeight(commitment: 'confirmed' | 'finalized') {
    this.enter('getBlockHeight');
    return commitment === 'finalized' ? this.finalizedHeight : this.height;
  }

  async getSlot() {
    this.enter('getSlot');
    return this.finalizedHeight;
  }

  async getSignatureState(signature: string): Promise<SignatureLookup> {
    this.enter('getSignatureState');
    const t = this.landed.get(signature);
    if (!t) return { state: null, contextSlot: this.height };
    return {
      state: {
        slot: t.height,
        confirmationStatus: this.finalizedHeight >= t.height ? 'finalized' : 'confirmed',
        err: t.err,
      },
      contextSlot: this.height,
    };
  }

  async hasFinalizedTransaction(signature: string): Promise<boolean> {
    this.enter('hasFinalizedTransaction');
    const t = this.landed.get(signature);
    return !!t && this.finalizedHeight >= t.height;
  }

  async getRecentSignatures(): Promise<RecentSignature[]> {
    this.enter('getRecentSignatures');
    return [];
  }

  async getBalance(address: PublicKey) {
    this.enter('getBalance');
    return this.balanceOf(address);
  }

  async getMinimumBalanceForRentExemption(dataLength: number) {
    this.enter('getMinimumBalanceForRentExemption');
    return BigInt(128 + dataLength) * 6_960n;
  }

  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    this.enter('sendRawTransaction');
    const tx = Transaction.from(Buffer.from(raw));
    if (!tx.verifySignatures(true)) throw new Error('invalid transaction signatures');
    const signature = base58Encode(tx.signature!);
    this.sendAttempts.push(signature);
    if (this.landed.has(signature)) {
      throw new Error('Transaction simulation failed: This transaction has already been processed');
    }
    if (!this.blockhashValid(tx)) {
      throw new Error('Transaction simulation failed: Blockhash not found');
    }
    const behavior = this.behaviors.shift() ?? this.defaultBehavior;
    switch (behavior) {
      case 'reject':
        throw new Error(
          'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1',
        );
      case 'network_error':
        throw new TransientRpcError();
      case 'drop':
        return signature;
      case 'fail_onchain':
        this.land(tx, signature, { InstructionError: [1, { Custom: 1 }] });
        return signature;
      case 'land_then_network_error':
        this.land(tx, signature, null);
        throw new TransientRpcError();
      case 'land':
        this.land(tx, signature, null);
        return signature;
    }
  }

  /** As on Solana: a recent valid blockhash first; otherwise the durable nonce rule. */
  private blockhashValid(tx: Transaction): boolean {
    const recent = this.blockhashes.get(tx.recentBlockhash ?? '');
    if (recent !== undefined && this.height <= recent) return true;
    const first = tx.instructions[0];
    if (first?.programId.equals(SystemProgram.programId)) {
      try {
        if (SystemInstruction.decodeInstructionType(first) === 'AdvanceNonceAccount') {
          const p = SystemInstruction.decodeNonceAdvance(first);
          const account = this.accounts.get(p.noncePubkey.toBase58());
          return account?.nonce?.value === tx.recentBlockhash;
        }
      } catch {
        // not a system instruction we know: fall through to the blockhash rule
      }
    }
    const lvbh = this.blockhashes.get(tx.recentBlockhash ?? '');
    return lvbh !== undefined && this.height <= lvbh;
  }

  private debit(next: Map<string, bigint>, address: PublicKey, lamports: bigint): void {
    const id = address.toBase58();
    const balance = next.get(id) ?? 0n;
    if (balance < lamports) throw new Error('insufficient lamports');
    next.set(id, balance - lamports);
  }

  /** Applies a transaction; a failing one only pays its fee. */
  private land(tx: Transaction, signature: string, forced: unknown): void {
    const fee = LAUNCH_FEE_LAMPORTS_PER_SIGNATURE * BigInt(tx.signatures.length);
    const next = new Map(this.balances);
    const created = new Map<string, FakeAccount>();
    const nonceUpdates: Array<() => void> = [];
    let err: unknown = forced;
    if (err === null) {
      try {
        this.debit(next, tx.feePayer!, fee);
        for (const ix of tx.instructions) this.apply(ix, next, created, nonceUpdates);
      } catch (e) {
        err = { InstructionError: [0, (e as Error).message] };
      }
    }
    if (err === null) {
      this.balances.clear();
      for (const [k, v] of next) this.balances.set(k, v);
      for (const [k, v] of created) this.accounts.set(k, v);
      for (const update of nonceUpdates) update();
    } else {
      const payer = tx.feePayer!.toBase58();
      this.balances.set(payer, (this.balances.get(payer) ?? 0n) - fee);
      // A failed durable-nonce transaction still advances its nonce (not one with a recent
      // blockhash: its instructions are rolled back).
      const first = tx.instructions[0];
      const durable = !this.blockhashes.has(tx.recentBlockhash ?? '');
      if (first && durable && this.isNonceAdvance(first)) this.applyNonceAdvance(first);
    }
    const accounts = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    for (const a of accounts) {
      const list = this.history.get(a) ?? [];
      list.push(err === null);
      this.history.set(a, list);
    }
    this.landed.set(signature, { signature, height: this.height, err, accounts });
    this.height += 1;
  }

  private isNonceAdvance(ix: TransactionInstruction): boolean {
    if (!ix.programId.equals(SystemProgram.programId)) return false;
    try {
      return SystemInstruction.decodeInstructionType(ix) === 'AdvanceNonceAccount';
    } catch {
      return false;
    }
  }

  private applyNonceAdvance(ix: TransactionInstruction): void {
    const p = SystemInstruction.decodeNonceAdvance(ix);
    const account = this.accounts.get(p.noncePubkey.toBase58());
    if (!account?.nonce || !account.nonce.authority.equals(p.authorizedPubkey)) {
      throw new Error('nonce advance refused');
    }
    account.nonce = { ...account.nonce, value: randomKey().toBase58() };
  }

  private apply(
    ix: TransactionInstruction,
    next: Map<string, bigint>,
    created: Map<string, FakeAccount>,
    nonceUpdates: Array<() => void>,
  ): void {
    const at = this.height;
    if (ix.programId.equals(SystemProgram.programId)) {
      const type = SystemInstruction.decodeInstructionType(ix);
      if (type === 'Create') {
        const p = SystemInstruction.decodeCreateAccount(ix);
        if (this.accounts.has(p.newAccountPubkey.toBase58())) throw new Error('account in use');
        this.debit(next, p.fromPubkey, BigInt(p.lamports));
        created.set(p.newAccountPubkey.toBase58(), {
          owner: p.programId,
          lamports: BigInt(p.lamports),
          dataLength: p.space,
          height: at,
        });
      } else if (type === 'InitializeNonceAccount') {
        const p = SystemInstruction.decodeNonceInitialize(ix);
        const account = created.get(p.noncePubkey.toBase58());
        if (!account) throw new Error('nonce account missing');
        account.nonce = { authority: p.authorizedPubkey, value: randomKey().toBase58() };
      } else if (type === 'AdvanceNonceAccount') {
        nonceUpdates.push(() => this.applyNonceAdvance(ix));
      } else if (type === 'Transfer') {
        const p = SystemInstruction.decodeTransfer(ix);
        this.debit(next, p.fromPubkey, p.lamports);
        next.set(p.toPubkey.toBase58(), (next.get(p.toPubkey.toBase58()) ?? 0n) + p.lamports);
      } else {
        throw new Error(`unsupported system instruction ${type}`);
      }
      return;
    }
    if (ix.programId.equals(this.dbcProgramId)) {
      const disc = Buffer.from(ix.data).subarray(0, 8);
      if (disc.equals(DBC_DISCRIMINATORS.createConfig)) {
        const config = ix.keys[0]!.pubkey;
        if (this.accounts.has(config.toBase58())) throw new Error('config in use');
        this.debit(next, ix.keys[4]!.pubkey, this.configRent);
        created.set(config.toBase58(), {
          owner: this.dbcProgramId,
          lamports: this.configRent,
          dataLength: CONFIG_ACCOUNT_SIZE,
          height: at,
        });
      } else if (disc.equals(DBC_DISCRIMINATORS.initializePool)) {
        const mint = ix.keys[3]!.pubkey;
        const pool = ix.keys[5]!.pubkey;
        if (this.accounts.has(mint.toBase58())) throw new Error('mint in use');
        created.set(mint.toBase58(), {
          owner: TOKEN_PROGRAM_ID,
          lamports: 1_461_600n,
          dataLength: 82,
          height: at,
        });
        created.set(pool.toBase58(), {
          owner: this.dbcProgramId,
          lamports: 4_000_000n,
          dataLength: 424,
          height: at,
        });
      }
      return;
    }
    // Compute budget, token and associated token instructions: no effect in this fake.
  }

  // -- RouteCore -------------------------------------------------------------------------

  configParamsHash(spec: LaunchpadSpec, kind: ConfigKind): string {
    return sha256Hex(
      canonicalJson({
        kind,
        owner: spec.ownerWallet,
        tradingFeeBps: spec.tradingFeeBps,
        share: kind === 'launchpad' ? spec.coinCreatorSharePct : 25,
        poolCreationFeeSol: spec.poolCreationFeeSol,
        antiSniper: spec.antiSniper,
      }),
    );
  }

  async buildCreateConfigTx(params: {
    spec: LaunchpadSpec;
    kind: ConfigKind;
    config: PublicKey;
    payer: PublicKey;
    computeUnitPriceMicroLamports: number;
  }): Promise<BuiltCreationTx> {
    this.enter('buildCreateConfigTx');
    this.built.config++;
    const owner = new PublicKey(params.spec.ownerWallet);
    const { blockhash, lastValidBlockHeight } = this.newBlockhash();
    const tx = new Transaction({ feePayer: params.payer, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx.add(
      new TransactionInstruction({
        programId: this.dbcProgramId,
        keys: [
          { pubkey: params.config, isSigner: true, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: params.payer, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([DBC_DISCRIMINATORS.createConfig, Buffer.from(params.kind)]),
      }),
    );
    return { transaction: tx, lastValidBlockHeight, rentLamports: this.configRent };
  }

  async buildCreateNonceAccountTx(params: {
    payer: PublicKey;
    nonceAccount: PublicKey;
    authority: PublicKey;
  }): Promise<BuiltCreationTx> {
    this.enter('buildCreateNonceAccountTx');
    this.built.nonce++;
    const { blockhash, lastValidBlockHeight } = this.newBlockhash();
    const tx = new Transaction({ feePayer: params.payer, blockhash, lastValidBlockHeight });
    tx.add(
      SystemProgram.createNonceAccount({
        fromPubkey: params.payer,
        noncePubkey: params.nonceAccount,
        authorizedPubkey: params.authority,
        lamports: Number(this.nonceRent),
      }),
    );
    return { transaction: tx, lastValidBlockHeight, rentLamports: this.nonceRent };
  }

  async readNonce(
    nonceAccount: PublicKey,
    authority: PublicKey,
    commitment: ReadCommitment,
  ): Promise<NonceState | null> {
    this.enter('readNonce');
    const account = this.accounts.get(nonceAccount.toBase58());
    if (!this.visible(account, commitment) || !account) return null;
    if (!account.nonce) throw new Error('not a nonce account');
    if (!account.nonce.authority.equals(authority)) throw new Error('nonce authority mismatch');
    return { nonce: account.nonce.value, slot: this.height };
  }

  async buildLaunchCoinTx(params: LaunchBuildParams): Promise<LaunchCoinTx> {
    this.enter('buildLaunchCoinTx');
    this.built.launch++;
    const nonceAccount = this.accounts.get(params.nonceAccount.toBase58());
    if (!nonceAccount?.nonce) throw new Error('nonce account missing');
    const nonce = this.launchNonceOverride ?? nonceAccount.nonce.value;
    this.launchNonceOverride = null;
    const { owner, creator, mint, config } = params;
    const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, config);
    const ownerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
    const ownerCoin = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
    const tx = new Transaction({ feePayer: owner, recentBlockhash: nonce });
    tx.add(
      SystemProgram.nonceAdvance({ noncePubkey: params.nonceAccount, authorizedPubkey: creator }),
    );
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, ownerWsol, owner, NATIVE_MINT));
    tx.add(
      new TransactionInstruction({
        programId: this.dbcProgramId,
        keys: [
          { pubkey: config, isSigner: false, isWritable: false },
          { pubkey: randomKey(), isSigner: false, isWritable: false },
          { pubkey: creator, isSigner: true, isWritable: false },
          { pubkey: mint, isSigner: true, isWritable: true },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: pool, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: true, isWritable: true },
        ],
        data: Buffer.concat([DBC_DISCRIMINATORS.initializePool, Buffer.from(params.name)]),
      }),
    );
    const firstBuy = params.firstBuyLamports > 0n;
    if (firstBuy) {
      tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, ownerCoin, owner, mint));
      tx.add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: ownerWsol,
          lamports: params.firstBuyLamports,
        }),
      );
      tx.add(createSyncNativeInstruction(ownerWsol));
      tx.add(
        new TransactionInstruction({
          programId: this.dbcProgramId,
          keys: [
            { pubkey: randomKey(), isSigner: false, isWritable: false },
            { pubkey: config, isSigner: false, isWritable: false },
            { pubkey: pool, isSigner: false, isWritable: true },
            { pubkey: ownerWsol, isSigner: false, isWritable: true },
            { pubkey: ownerCoin, isSigner: false, isWritable: true },
            { pubkey: randomKey(), isSigner: false, isWritable: true },
            { pubkey: randomKey(), isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([DBC_DISCRIMINATORS.swap, Buffer.alloc(16)]),
        }),
      );
      tx.add(createCloseAccountInstruction(ownerWsol, owner, owner));
    }
    const summary: LaunchCoinSummary = {
      config,
      pool,
      mint,
      creator,
      owner,
      feePayer: owner,
      rentPayer: owner,
      feeClaimer: owner,
      referralTokenAccount: null,
      referralSource: 'none',
      referralOmittedForSize: false,
      name: params.name,
      symbol: params.symbol,
      metadataUri: params.metadataUri,
      expectedTokensOut: firstBuy ? 1_000_000n : 0n,
      minimumTokensOut: firstBuy ? 990_000n : 0n,
      slippageBps: 100,
      costs: {
        firstBuyLamports: firstBuy ? params.firstBuyLamports : 0n,
        firstBuyFeeLamports: 0n,
        poolCreationFeeLamports: 0n,
        poolAccountsRentLamports: 10_000_000n,
        metaplexFeeLamports: 10_000_000n,
        ownerTokenAccountRentLamports: firstBuy ? 2_039_280n : 0n,
        ownerTemporaryLamports: firstBuy ? 2_039_280n : 0n,
        networkFeeLamports: 15_000n,
        networkFeeSource: 'estimate',
        ownerTotalLamports: (firstBuy ? params.firstBuyLamports + 2_039_280n : 0n) + 20_015_000n,
        ownerRequiredBalanceLamports: 0n,
        creatorTotalLamports: 0n,
      },
      durableNonce: { nonceAccount: params.nonceAccount, authority: creator, nonce },
      recentBlockhash: nonce,
      lastValidBlockHeight: null,
      computeUnitLimit: 300_000,
      computeUnitPriceMicroLamports: 0,
      signerSideSigners: [creator, mint],
      ownerSigner: owner,
      txBytes: 1_000,
    };
    return { transaction: tx, summary };
  }

  /** `minContextSlot` is recorded only: this chain has a single node, always current. */
  async getAccount(
    address: PublicKey,
    commitment: ReadCommitment,
    minContextSlot?: number,
  ): Promise<AccountSummary | null> {
    this.enter('getAccount');
    if (minContextSlot !== undefined) this.minContextSlots.push(minContextSlot);
    const account = this.accounts.get(address.toBase58());
    if (!this.visible(account, commitment) || !account) return null;
    return { owner: account.owner, lamports: account.lamports, dataLength: account.dataLength };
  }

  async accountsExist(
    addresses: readonly PublicKey[],
    commitment: ReadCommitment,
  ): Promise<boolean[]> {
    this.enter('accountsExist');
    return addresses.map((a) => this.visible(this.accounts.get(a.toBase58()), commitment));
  }

  async hasSuccessfulTransaction(address: PublicKey): Promise<boolean> {
    this.enter('hasSuccessfulTransaction');
    return (this.history.get(address.toBase58()) ?? []).some(Boolean);
  }

  poolAddress(config: PublicKey, mint: PublicKey): PublicKey {
    return deriveDbcPoolAddress(NATIVE_MINT, mint, config);
  }

  // -- RoutePaymentVerifier --------------------------------------------------------------

  /** Records a finalized payment of `jobId` to the cashbox (overrides: a wrong one). */
  recordPayment(
    signature: string,
    input: { payer: PublicKey; lamports: bigint; jobId: string } & Partial<FakePayment>,
  ): void {
    this.payments.set(signature, {
      payer: input.payer,
      recipient: input.recipient ?? this.cashbox,
      lamports: input.lamports,
      memo: input.memo ?? paymentMemo(input.jobId),
      slot: input.slot ?? this.height,
      finalized: input.finalized ?? true,
      failed: input.failed ?? false,
    });
  }

  /** Same decisions as core `verifyPayment` at finalized commitment. */
  async verifyPayment(signature: string, expected: ExpectedPayment): Promise<PaymentVerification> {
    this.enter('verifyPayment');
    const p = this.payments.get(signature);
    if (!p || !p.finalized) return { status: 'pending', signature };
    const invalid = (reason: string): PaymentVerification => ({
      status: 'invalid',
      signature,
      reason,
      detail: reason,
      slot: p.slot,
    });
    if (p.failed) return invalid('transaction_failed');
    if (!p.recipient.equals(this.cashbox)) return invalid('recipient_mismatch');
    if (!p.payer.equals(expected.payer)) return invalid('payer_mismatch');
    if (p.lamports !== expected.lamports) return invalid('amount_mismatch');
    if (p.memo !== paymentMemo(expected.jobId)) return invalid('memo_mismatch');
    return {
      status: 'confirmed',
      signature,
      slot: p.slot,
      confirmationStatus: 'finalized',
      payer: p.payer,
      recipient: p.recipient,
      lamports: p.lamports,
      memo: p.memo,
    };
  }
}

/** Sleep that advances the fake chain (400 ms per block) instead of waiting. */
export function chainSleep(chain: FakeRouteChain, clock?: { t: number }) {
  return async (ms: number): Promise<void> => {
    if (clock) clock.t += ms;
    chain.advance(Math.max(1, Math.ceil(ms / 400)));
  };
}

// ---------------------------------------------------------------------------------------
// Store

const FIELD: Record<LaunchpadAddressColumn, keyof RouteLaunchpad> = {
  launchpad_config: 'launchpadConfig',
  launchpad_coin_config: 'launchpadCoinConfig',
  launchpad_coin_mint: 'launchpadCoinMint',
  creator_wallet_ref: 'creatorWalletRef',
};

export class MemoryRouteStore implements RouteStore {
  readonly jobs = new Map<string, RouteJob>();
  readonly launchpads = new Map<string, RouteLaunchpad>();
  readonly payments: RoutePayment[] = [];
  readonly updates: Array<{ launchpadId: string; values: Record<string, string> }> = [];
  failNextRead = 0;

  private check(): void {
    if (this.failNextRead > 0) {
      this.failNextRead--;
      throw Object.assign(new Error('request failed (ECONNRESET)'), { code: 'ECONNRESET' });
    }
  }

  async getJob(jobId: string) {
    this.check();
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  async getLaunchpad(id: string) {
    this.check();
    const lp = this.launchpads.get(id);
    return lp ? { ...lp } : null;
  }

  async listPayments(jobId: string) {
    this.check();
    return this.payments.filter((p) => p.jobId === jobId).map((p) => ({ ...p }));
  }

  async setLaunchpadColumns(
    launchpadId: string,
    values: Partial<Record<LaunchpadAddressColumn, string>>,
    expected: Partial<Record<LaunchpadAddressColumn, string | null>>,
  ) {
    const lp = this.launchpads.get(launchpadId);
    if (!lp) return false;
    for (const [column, value] of Object.entries(expected) as [
      LaunchpadAddressColumn,
      string | null,
    ][]) {
      if (lp[FIELD[column]] !== value) return false;
    }
    const record: Record<string, string> = {};
    for (const [column, value] of Object.entries(values) as [LaunchpadAddressColumn, string][]) {
      (lp as unknown as Record<string, unknown>)[FIELD[column]] = value;
      record[column] = value;
    }
    this.updates.push({ launchpadId, values: record });
    return true;
  }

  /**
   * Seeds one creation job in `onchain_setup` with a confirmed payment of 0.3 SOL (random
   * signature unless given). Returns the payment row (record it on the chain to make it real).
   */
  seed(input: {
    jobId: string;
    launchpadId: string;
    spec: LaunchpadSpec;
    slug?: string;
    jobStatus?: JobStatus;
    launchpadStatus?: LaunchpadStatus;
    paymentStatus?: PaymentStatus;
    paymentLamports?: bigint;
    txSignature?: string;
  }): RoutePayment {
    this.jobs.set(input.jobId, {
      id: input.jobId,
      launchpadId: input.launchpadId,
      type: 'create_launchpad',
      status: input.jobStatus ?? 'onchain_setup',
    });
    this.launchpads.set(input.launchpadId, {
      id: input.launchpadId,
      ownerWallet: input.spec.ownerWallet,
      slug: input.slug ?? input.spec.slug,
      spec: input.spec,
      status: input.launchpadStatus ?? 'draft',
      launchpadConfig: null,
      launchpadCoinConfig: null,
      launchpadCoinMint: null,
      creatorWalletRef: null,
    });
    const payment: RoutePayment = {
      id: uuid(),
      jobId: input.jobId,
      kind: 'creation',
      status: input.paymentStatus ?? 'confirmed',
      payerWallet: input.spec.ownerWallet,
      lamports: input.paymentLamports ?? 300_000_000n,
      txSignature: input.txSignature ?? randomSignature(),
      refundSignature: null,
    };
    this.payments.push(payment);
    return { ...payment };
  }
}

export function uuid(): string {
  const h = createHash('sha256').update(randomBytes(16)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A valid spec (shared schema) for the given owner wallet. */
export function testSpec(
  ownerWallet: string,
  overrides: Partial<LaunchpadSpec> = {},
): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet,
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'To the moon',
      designNotes: '',
    },
    launchpadCoin: {
      name: 'Moon',
      symbol: 'MOON',
      description: 'The MoonPad coin',
      imageUrl: 'https://example.com/moon.png',
      firstBuySol: 0.01,
    },
    ...overrides,
  };
}
