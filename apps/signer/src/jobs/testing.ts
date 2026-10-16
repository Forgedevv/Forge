/**
 * Test doubles for the money-moving jobs: an in-memory chain that executes System transfers
 * (signatures verified, fees, rent rule, blockhash expiry, finality lag, failure injection), a
 * fake DBC program for creator claims, in-memory stores with the same compare-and-set semantics
 * as the Supabase ones, and recording alerts/flags. No network, no private key material: signing
 * always goes through a real keystore in the tests.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { MEMO_PROGRAM_ID } from './shared.js';
import type {
  ClaimTxResult,
  CreatorClaimParams,
  CreatorPoolState,
  ExpectedPayment,
  PaymentVerification,
  SignerCore,
} from '../core-adapter.js';
import { buildSolTransferTx } from '../core-adapter.js';
import type { CashboxStore, PaymentAnomalySummary } from './cashbox.js';
import type { ClaimsStore, CreatorLaunchpad } from './claims.js';
import type {
  InFlightRefund,
  RefundCandidate,
  RefundJob,
  RefundPayment,
  RefundStore,
} from './refunds.js';
import {
  DBC_CREATOR_CLAIM_DISCRIMINATORS,
  base58Encode,
  decodeSystemTransfer,
  type AlertLevel,
  type FlagsReader,
  type JobAlerter,
  type JobLogger,
  type RecentSignature,
  type SignatureLookup,
  type SolanaRpc,
} from './shared.js';

export function randomAddress(): PublicKey {
  return new PublicKey(randomBytes(32));
}

export function uuid(): string {
  const h = randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A plausible (random) transaction signature, base58 of 64 bytes. */
export function randomSignature(): string {
  return base58Encode(randomBytes(64));
}

export class TransientRpcError extends Error {
  override readonly name = 'FetchError';
  readonly code = 'ECONNRESET';
  constructor() {
    super('fetch failed');
  }
}

// ---------------------------------------------------------------------------------------
// Chain

export type SendBehavior =
  'land' | 'drop' | 'fail_onchain' | 'network_error' | 'land_then_network_error' | 'reject';

export interface Ledger {
  debit(address: PublicKey, lamports: bigint): void;
  credit(address: PublicKey, lamports: bigint): void;
  /** Program state change applied only when the transaction lands (not on simulation). */
  onCommit(fn: () => void): void;
  /** Scratch space of one execution (e.g. a temporary token account's balance). */
  scratch: Map<string, bigint>;
}

export interface LandedTx {
  signature: string;
  slot: number;
  height: number;
  err: unknown;
  /** Account keys of the transaction (base58). */
  accounts: string[];
  /** Memo as the RPC reports it (`[len] text`), null when none. */
  memo: string | null;
}

type RpcMethod = keyof SolanaRpc;

export class FakeChain implements SolanaRpc {
  height: number;
  finalityLag: number;
  defaultBehavior: SendBehavior = 'land';
  readonly behaviors: SendBehavior[] = [];
  readonly balances = new Map<string, bigint>();
  /** Finalized balance when it differs from the confirmed one. */
  readonly finalizedBalances = new Map<string, bigint>();
  readonly blockhashes = new Map<string, number>();
  readonly landed = new Map<string, LandedTx>();
  readonly transfers: Array<{ signature: string; from: string; to: string; lamports: bigint }> = [];
  readonly sendAttempts: string[] = [];
  readonly calls: RpcMethod[] = [];
  readonly failures = new Map<RpcMethod, Error[]>();
  /** Fixed blockhash for every call (to produce identical transactions), when set. */
  fixedBlockhash: string | null = null;
  rentPerByteYear = 3480n;
  /** Slots the node answering `getSignatureStatuses` is behind the tip (lagging RPC node). */
  statusLag = 0;
  /** Signatures the status index misses but `getTransaction(finalized)` still returns. */
  readonly statusIndexGaps = new Set<string>();
  /** Effects of a non-System instruction (fake DBC, token program), in order. Throw to fail. */
  onInstruction: ((ix: TransactionInstruction, tx: Transaction, ledger: Ledger) => void) | null =
    null;

  constructor(options: { height?: number; finalityLag?: number } = {}) {
    this.height = options.height ?? 1_000;
    this.finalityLag = options.finalityLag ?? 32;
  }

  get finalizedHeight(): number {
    return this.height - this.finalityLag;
  }

  setBalance(address: PublicKey, lamports: bigint): void {
    this.balances.set(address.toBase58(), lamports);
  }

  balanceOf(address: PublicKey): bigint {
    return this.balances.get(address.toBase58()) ?? 0n;
  }

  failNext(method: RpcMethod, error: Error, times = 1): void {
    const list = this.failures.get(method) ?? [];
    for (let i = 0; i < times; i++) list.push(error);
    this.failures.set(method, list);
  }

  advance(blocks: number): void {
    this.height += blocks;
  }

  /** Total lamports transferred to `address` by landed, successful transactions. */
  receivedBy(address: PublicKey): bigint {
    const id = address.toBase58();
    return this.transfers.filter((t) => t.to === id).reduce((a, t) => a + t.lamports, 0n);
  }

  rentExempt(dataLength: number): bigint {
    return BigInt(128 + dataLength) * this.rentPerByteYear * 2n;
  }

  private enter(method: RpcMethod): void {
    this.calls.push(method);
    const queue = this.failures.get(method);
    const err = queue?.shift();
    if (err) throw err;
  }

  async getLatestBlockhash() {
    this.enter('getLatestBlockhash');
    const blockhash = this.fixedBlockhash ?? new PublicKey(randomBytes(32)).toBase58();
    const lastValidBlockHeight = this.height + 150;
    if (!this.blockhashes.has(blockhash)) this.blockhashes.set(blockhash, lastValidBlockHeight);
    return { blockhash, lastValidBlockHeight: this.blockhashes.get(blockhash)! };
  }

  async getBlockHeight(commitment: 'confirmed' | 'finalized') {
    this.enter('getBlockHeight');
    return commitment === 'finalized' ? this.finalizedHeight : this.height;
  }

  /** In this fake, one block per slot: the finalized slot equals the finalized height. */
  async getSlot() {
    this.enter('getSlot');
    return this.finalizedHeight;
  }

  async getSignatureState(signature: string): Promise<SignatureLookup> {
    this.enter('getSignatureState');
    const contextSlot = this.height - this.statusLag;
    const t = this.landed.get(signature);
    if (!t || this.statusIndexGaps.has(signature) || t.height > contextSlot) {
      return { state: null, contextSlot };
    }
    return {
      state: {
        slot: t.slot,
        confirmationStatus: this.finalizedHeight >= t.height ? 'finalized' : 'confirmed',
        err: t.err,
      },
      contextSlot,
    };
  }

  async hasFinalizedTransaction(signature: string): Promise<boolean> {
    this.enter('hasFinalizedTransaction');
    const t = this.landed.get(signature);
    return !!t && this.finalizedHeight >= t.height;
  }

  async getRecentSignatures(address: PublicKey, limit: number): Promise<RecentSignature[]> {
    this.enter('getRecentSignatures');
    const id = address.toBase58();
    return [...this.landed.values()]
      .filter((t) => t.accounts.includes(id))
      .sort((a, b) => b.height - a.height)
      .slice(0, limit)
      .map((t) => ({
        signature: t.signature,
        confirmationStatus: this.finalizedHeight >= t.height ? 'finalized' : 'confirmed',
        failed: t.err !== null,
        memo: t.memo,
      }));
  }

  async getBalance(address: PublicKey, commitment: 'confirmed' | 'finalized') {
    this.enter('getBalance');
    const id = address.toBase58();
    if (commitment === 'finalized' && this.finalizedBalances.has(id)) {
      return this.finalizedBalances.get(id)!;
    }
    return this.balances.get(id) ?? 0n;
  }

  async getMinimumBalanceForRentExemption(dataLength: number) {
    this.enter('getMinimumBalanceForRentExemption');
    return this.rentExempt(dataLength);
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
    const lvbh = this.blockhashes.get(tx.recentBlockhash!);
    if (lvbh === undefined || this.height > lvbh) {
      throw new Error('Transaction simulation failed: Blockhash not found');
    }
    const behavior = this.behaviors.shift() ?? this.defaultBehavior;
    switch (behavior) {
      case 'reject':
        throw new Error(
          'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1',
        );
      case 'network_error':
        throw new TransientRpcError();
      case 'drop':
        return signature;
      case 'fail_onchain':
        this.land(tx, signature, { InstructionError: [0, { Custom: 1 }] });
        return signature;
      case 'land_then_network_error':
        this.simulateOrThrow(tx);
        this.land(tx, signature, null);
        throw new TransientRpcError();
      case 'land':
        this.simulateOrThrow(tx);
        this.land(tx, signature, null);
        return signature;
    }
  }

  private feeOf(tx: Transaction): bigint {
    return 5_000n * BigInt(tx.signatures.length);
  }

  /** Runs the transaction on a copy of the balances; returns them, or throws a simulation error. */
  private execute(tx: Transaction): { next: Map<string, bigint>; commits: Array<() => void> } {
    const next = new Map(this.balances);
    const touched = new Set<string>();
    const commits: Array<() => void> = [];
    const ledger: Ledger = {
      scratch: new Map(),
      onCommit: (fn) => void commits.push(fn),
      debit: (address, lamports) => {
        const id = address.toBase58();
        const b = next.get(id) ?? 0n;
        if (b < lamports) throw new Error('insufficient lamports');
        next.set(id, b - lamports);
        touched.add(id);
      },
      credit: (address, lamports) => {
        const id = address.toBase58();
        next.set(id, (next.get(id) ?? 0n) + lamports);
        touched.add(id);
      },
    };
    ledger.debit(tx.feePayer!, this.feeOf(tx));
    for (const ix of tx.instructions) {
      if (ix.programId.equals(SystemProgram.programId)) {
        const t = decodeSystemTransfer(ix);
        if (!t) throw new Error('unsupported system instruction');
        ledger.debit(t.from, t.lamports);
        ledger.credit(t.to, t.lamports);
      } else {
        this.onInstruction?.(ix, tx, ledger);
      }
    }
    // Token accounts that were never closed keep what they received.
    for (const [account, lamports] of ledger.scratch) {
      if (lamports > 0n) ledger.credit(new PublicKey(account), lamports);
    }
    const rent = this.rentExempt(0);
    for (const id of touched) {
      const b = next.get(id) ?? 0n;
      if (b !== 0n && b < rent) throw new Error('insufficient funds for rent');
    }
    return { next, commits };
  }

  private simulateOrThrow(tx: Transaction): void {
    try {
      this.execute(tx);
    } catch (err) {
      throw new Error(`Transaction simulation failed: ${(err as Error).message}`, { cause: err });
    }
  }

  private land(tx: Transaction, signature: string, forcedErr: unknown): void {
    let err: unknown = forcedErr;
    if (err === null) {
      try {
        const { next, commits } = this.execute(tx);
        this.balances.clear();
        for (const [k, v] of next) this.balances.set(k, v);
        for (const commit of commits) commit();
        for (const ix of tx.instructions) {
          const t = decodeSystemTransfer(ix);
          if (t) {
            this.transfers.push({
              signature,
              from: t.from.toBase58(),
              to: t.to.toBase58(),
              lamports: t.lamports,
            });
          }
        }
      } catch {
        err = { InstructionError: [0, 'InsufficientFunds'] };
      }
    }
    if (err !== null) {
      // A failed transaction still pays its fee.
      const payer = tx.feePayer!.toBase58();
      const b = this.balances.get(payer) ?? 0n;
      this.balances.set(payer, b - this.feeOf(tx));
    }
    const memos = tx.instructions
      .filter((ix) => ix.programId.equals(MEMO_PROGRAM_ID))
      .map((ix) => {
        const text = Buffer.from(ix.data).toString('utf8');
        return `[${text.length}] ${text}`;
      });
    this.landed.set(signature, {
      signature,
      slot: this.height,
      height: this.height,
      err,
      accounts: tx.compileMessage().accountKeys.map((k) => k.toBase58()),
      memo: memos.length > 0 ? memos.join('; ') : null,
    });
    this.height += 1;
  }
}

/** Manual clock for the jobs' `now` option. */
export class FakeClock {
  constructor(public t = Date.UTC(2026, 9, 9)) {}
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Sleep that advances the fake chain (400 ms per block) and the fake clock instead of waiting.
 */
export function chainSleep(
  chain: FakeChain,
  recorder?: number[],
  clock?: FakeClock,
): (ms: number) => Promise<void> {
  return async (ms: number) => {
    recorder?.push(ms);
    clock?.advance(ms);
    chain.advance(Math.max(1, Math.ceil(ms / 400)));
  };
}

// ---------------------------------------------------------------------------------------
// Fake DBC program + core

export interface FakePool {
  config: PublicKey;
  baseMint: PublicKey;
  creator: PublicKey;
  claimableQuote: bigint;
  graduated: boolean;
}

/**
 * Quote-side layouts of a creator claim:
 * - `close_to_receiver`: SDK `claimCreatorTradingFeeToReceiver` (temporary WSOL account of the
 *   creator, closed to the receiver);
 * - `forward_from_creator`: temporary WSOL account closed to the creator, then an exact System
 *   transfer creator -> receiver of the claimed lamports (the creator keeps the account rent);
 * - `exact`: what core really builds when the receiver is not the payer: a self-transfer of the
 *   claimed lamports on the temporary account, closed to the FEE PAYER, then an exact System
 *   transfer fee payer -> receiver.
 */
export type FakeClaimShape = 'close_to_receiver' | 'forward_from_creator' | 'exact';

export class FakeDbc {
  readonly programId = randomAddress();
  readonly pools = new Map<string, FakePool>();
  /** Lets a test tamper with the built transaction (policy tests). */
  tamper: ((tx: Transaction, params: CreatorClaimParams) => void) | null = null;
  claimShape: FakeClaimShape = 'close_to_receiver';

  constructor(readonly chain: FakeChain) {
    chain.onInstruction = (ix, _tx, ledger) => this.execute(ix, ledger);
  }

  poolAddress(config: PublicKey, baseMint: PublicKey): PublicKey {
    const digest = createHash('sha256')
      .update(Buffer.concat([Buffer.from('pool'), config.toBuffer(), baseMint.toBuffer()]))
      .digest();
    return new PublicKey(digest);
  }

  addPool(pool: FakePool): PublicKey {
    const address = this.poolAddress(pool.config, pool.baseMint);
    this.pools.set(address.toBase58(), { ...pool });
    return address;
  }

  /** Claim: the quote fees go to the token account `tokenB` (kept in the execution scratch). */
  private execute(ix: TransactionInstruction, ledger: Ledger): void {
    if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9) {
      // CloseAccount: the temporary account's lamports go to the destination.
      const account = ix.keys[0]!.pubkey.toBase58();
      const held = ledger.scratch.get(account) ?? 0n;
      ledger.scratch.delete(account);
      if (held > 0n) ledger.credit(ix.keys[1]!.pubkey, held);
      return;
    }
    if (!ix.programId.equals(this.programId)) return;
    const pool = this.pools.get(ix.keys[1]!.pubkey.toBase58());
    if (!pool) throw new Error('pool not found');
    if (!pool.creator.equals(ix.keys[8]!.pubkey)) throw new Error('not the creator');
    const tokenB = ix.keys[3]!.pubkey.toBase58();
    ledger.scratch.set(tokenB, (ledger.scratch.get(tokenB) ?? 0n) + pool.claimableQuote);
    ledger.onCommit(() => {
      pool.claimableQuote = 0n;
    });
  }

  /** `cashbox` is the recipient reported by the default (valid) payment verification. */
  core(
    options: { cashbox?: PublicKey } = {},
  ): SignerCore & { verifications: Map<string, PaymentVerification> } {
    const cashbox = options.cashbox ?? PublicKey.default;
    const verifications = new Map<string, PaymentVerification>();
    const chain = this.chain;
    return {
      verifications,
      dbcProgramId: this.programId,
      coinPoolAddress: (config, baseMint) => this.poolAddress(config, baseMint),
      readCreatorPool: async (pool): Promise<CreatorPoolState | null> => {
        const p = this.pools.get(pool.toBase58());
        if (!p) return null;
        return {
          pool,
          config: p.config,
          baseMint: p.baseMint,
          quoteMint: NATIVE_MINT,
          creator: p.creator,
          graduated: p.graduated,
          creatorClaimable: { base: 0n, quote: p.claimableQuote },
        };
      },
      buildCreatorClaimTx: async (params): Promise<ClaimTxResult> => {
        const p = this.pools.get(params.pool.toBase58());
        if (!p) throw new Error('DBC pool not found');
        if (!p.creator.equals(params.creator)) throw new Error('not_pool_creator');
        const payer = params.payer ?? params.creator;
        const summary = {
          kind: 'creator' as const,
          pool: params.pool,
          baseMint: p.baseMint,
          claimer: params.creator,
          receiver: params.receiver,
          payer,
          claimable: { base: 0n, quote: p.claimableQuote },
        };
        if (p.claimableQuote === 0n) {
          return { transaction: null, lastValidBlockHeight: null, summary };
        }
        const tx = buildFakeClaimTx(
          this.programId,
          params.pool,
          p.baseMint,
          params.creator,
          params.receiver,
          payer,
          this.claimShape === 'close_to_receiver' ? null : p.claimableQuote,
          this.claimShape === 'exact' ? { closeTo: 'payer', selfTransfer: true } : {},
        );
        this.tamper?.(tx, params);
        const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
        tx.feePayer = payer;
        tx.recentBlockhash = blockhash;
        return { transaction: tx, lastValidBlockHeight, summary };
      },
      verifyPayment: async (signature: string, expected: ExpectedPayment) => {
        const v = verifications.get(signature);
        if (v) return v;
        return {
          status: 'confirmed',
          signature,
          slot: 1,
          confirmationStatus: 'finalized',
          payer: expected.payer,
          recipient: cashbox,
          lamports: expected.lamports,
          memo: `forge:job:${expected.jobId}`,
        } satisfies PaymentVerification;
      },
      buildSolTransferTx,
    };
  }
}

/**
 * Same layout as `claimCreatorTradingFeeToReceiver` for a SOL-quoted pool (SDK 1.5.13). With
 * `forwardLamports`, the temporary account is closed to the creator (or to the payer with
 * `closeTo: 'payer'`) instead and that many lamports are then transferred from that wallet to
 * the receiver; `selfTransfer` adds core's exact-amount SPL transfer on the temporary account
 * between the claim and the close (`exact`).
 */
export function buildFakeClaimTx(
  programId: PublicKey,
  pool: PublicKey,
  baseMint: PublicKey,
  creator: PublicKey,
  receiver: PublicKey,
  payer: PublicKey,
  forwardLamports: bigint | null = null,
  options: { closeTo?: 'creator' | 'payer'; selfTransfer?: boolean } = {},
): Transaction {
  const receiverBase = getAssociatedTokenAddressSync(baseMint, receiver, true, TOKEN_PROGRAM_ID);
  const tempWsol = getAssociatedTokenAddressSync(NATIVE_MINT, creator, true, TOKEN_PROGRAM_ID);
  const keys = [
    randomAddress(), // poolAuthority
    pool,
    receiverBase, // tokenAAccount
    tempWsol, // tokenBAccount
    randomAddress(), // baseVault
    randomAddress(), // quoteVault
    baseMint,
    NATIVE_MINT,
    creator,
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    randomAddress(), // eventAuthority
    programId,
  ].map((pubkey, i) => ({ pubkey, isSigner: i === 8, isWritable: [1, 2, 3, 4, 5].includes(i) }));
  const data = Buffer.alloc(24);
  DBC_CREATOR_CLAIM_DISCRIMINATORS[0]!.copy(data, 0);
  data.writeBigUInt64LE((1n << 64n) - 1n, 8);
  data.writeBigUInt64LE((1n << 64n) - 1n, 16);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer, receiverBase, receiver, baseMint),
    createAssociatedTokenAccountIdempotentInstruction(payer, tempWsol, creator, NATIVE_MINT),
    new TransactionInstruction({ programId, keys, data }),
  );
  if (forwardLamports === null) {
    return tx.add(createCloseAccountInstruction(tempWsol, receiver, creator));
  }
  const closeTo = options.closeTo === 'payer' ? payer : creator;
  if (options.selfTransfer) {
    tx.add(createTransferInstruction(tempWsol, tempWsol, creator, forwardLamports));
  }
  return tx.add(
    createCloseAccountInstruction(tempWsol, closeTo, creator),
    SystemProgram.transfer({ fromPubkey: closeTo, toPubkey: receiver, lamports: forwardLamports }),
  );
}

// ---------------------------------------------------------------------------------------
// Stores

type StoreMethod = keyof RefundStore;

/** In-memory jobs + payments with the Supabase stores' compare-and-set semantics. */
export class MemoryRefundDb implements RefundStore, CashboxStore {
  readonly jobs = new Map<string, RefundJob>();
  readonly payments = new Map<string, RefundPayment>();
  readonly events: Array<{ jobId: string; message: string }> = [];
  /** `payment_anomalies` rows (migration 0008): null lamports = amount unknown. */
  readonly anomalies: Array<{ id: string; lamports: bigint | null; resolvedAt: string | null }> =
    [];
  /** Throw before applying. */
  readonly failBefore = new Map<StoreMethod, Error[]>();
  /** Apply, then throw (lost response). */
  readonly failAfter = new Map<StoreMethod, Error[]>();
  readonly calls: StoreMethod[] = [];

  addJob(job: Partial<RefundJob> = {}): RefundJob {
    const full: RefundJob = {
      id: uuid(),
      launchpadId: uuid(),
      type: 'create_launchpad',
      status: 'failed',
      attempts: 2,
      failedStage: 'build',
      lockedAt: null,
      ownerWallet: randomAddress().toBase58(),
      ...job,
    };
    this.jobs.set(full.id, full);
    return full;
  }

  addPayment(job: RefundJob, payment: Partial<RefundPayment> = {}): RefundPayment {
    const full: RefundPayment = {
      id: uuid(),
      jobId: job.id,
      payerWallet: job.ownerWallet,
      kind: 'creation',
      lamports: 300_000_000n,
      txSignature: randomSignature(),
      status: 'confirmed',
      refundSignature: null,
      ...payment,
    };
    this.payments.set(full.id, full);
    return full;
  }

  private before(method: StoreMethod): void {
    this.calls.push(method);
    const err = this.failBefore.get(method)?.shift();
    if (err) throw err;
  }

  private after(method: StoreMethod): void {
    const err = this.failAfter.get(method)?.shift();
    if (err) throw err;
  }

  async listRefundCandidates(limit: number, offset: number): Promise<RefundCandidate[]> {
    this.before('listRefundCandidates');
    return [...this.jobs.values()]
      .filter((j) => j.status === 'failed' && j.failedStage === 'build' && j.attempts >= 2)
      .slice(offset, offset + limit)
      .map((job) => ({
        job: { ...job },
        payments: [...this.payments.values()]
          .filter((p) => p.jobId === job.id)
          .map((p) => ({ ...p })),
      }));
  }

  async listInFlightRefunds(limit: number, offset: number): Promise<InFlightRefund[]> {
    this.before('listInFlightRefunds');
    return [...this.payments.values()]
      .filter((p) => p.status === 'confirmed' && p.refundSignature !== null)
      .slice(offset, offset + limit)
      .map((p) => ({ payment: { ...p }, job: { ...this.jobs.get(p.jobId)! } }));
  }

  async getPayment(paymentId: string): Promise<RefundPayment | null> {
    this.before('getPayment');
    const p = this.payments.get(paymentId);
    return p ? { ...p } : null;
  }

  async beginRefund(p: { paymentId: string; txSignature: string; refundSignature: string }) {
    this.before('beginRefund');
    const row = this.payments.get(p.paymentId);
    if (
      row &&
      row.status === 'confirmed' &&
      row.refundSignature === null &&
      row.txSignature === p.txSignature
    ) {
      row.refundSignature = p.refundSignature;
    }
    this.after('beginRefund');
    return row?.refundSignature === p.refundSignature;
  }

  async releaseRefund(p: { paymentId: string; refundSignature: string }) {
    this.before('releaseRefund');
    const row = this.payments.get(p.paymentId);
    if (row && row.status === 'confirmed' && row.refundSignature === p.refundSignature) {
      row.refundSignature = null;
    }
    this.after('releaseRefund');
    return row?.status === 'confirmed' && row.refundSignature === null;
  }

  async completeRefund(p: { paymentId: string; refundSignature: string }) {
    this.before('completeRefund');
    const row = this.payments.get(p.paymentId);
    if (row && row.status === 'confirmed' && row.refundSignature === p.refundSignature) {
      row.status = 'refunded';
    }
    this.after('completeRefund');
    return row?.status === 'refunded' && row.refundSignature === p.refundSignature;
  }

  async markJobRefunded(jobId: string) {
    this.before('markJobRefunded');
    const job = this.jobs.get(jobId);
    if (job && job.status === 'failed' && job.failedStage === 'build') job.status = 'refunded';
    this.after('markJobRefunded');
    return job?.status === 'refunded';
  }

  async addJobEvent(jobId: string, message: string) {
    this.before('addJobEvent');
    this.events.push({ jobId, message });
  }

  async outstandingRefundLiabilities(): Promise<bigint> {
    let total = 0n;
    for (const p of this.payments.values()) {
      if (p.status !== 'confirmed') continue;
      const job = this.jobs.get(p.jobId);
      if (!job) continue;
      const refundable =
        job.status === 'spec_ready' ||
        job.status === 'paid' ||
        job.status === 'building' ||
        (job.status === 'failed' && job.failedStage === 'build');
      if (refundable) total += p.lamports;
    }
    return total;
  }

  async unresolvedPaymentAnomalies(): Promise<PaymentAnomalySummary> {
    const out: PaymentAnomalySummary = { lamports: 0n, count: 0, unknownAmounts: 0 };
    for (const a of this.anomalies) {
      if (a.resolvedAt !== null) continue;
      out.count++;
      if (a.lamports === null) out.unknownAmounts++;
      else out.lamports += a.lamports;
    }
    return out;
  }
}

export class MemoryClaimsStore implements ClaimsStore {
  readonly launchpads: CreatorLaunchpad[] = [];
  failNext: Error | null = null;
  async listCreatorLaunchpads() {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return this.launchpads.map((l) => ({ ...l }));
  }
}

// ---------------------------------------------------------------------------------------
// Flags, alerts, logs

/** The kill switches seeded by migration 0005 (all off). */
export const DEFAULT_FLAGS: Readonly<Record<string, boolean>> = {
  claims_paused: false,
  cashbox_sweep_paused: false,
  refunds_paused: false,
};

export function memoryFlags(values: Record<string, boolean> = {}): FlagsReader & {
  values: Record<string, boolean>;
  fail: boolean;
} {
  const reader = {
    values: { ...DEFAULT_FLAGS, ...values },
    fail: false,
    async read() {
      if (reader.fail) throw new Error('flags unavailable');
      return new Map(Object.entries(reader.values));
    },
  };
  return reader;
}

export interface RecordedAlert {
  level: AlertLevel;
  code: string;
  message: string;
  details: Record<string, unknown>;
  dedupKey?: string;
}

export class RecordingAlerter implements JobAlerter {
  readonly alerts: RecordedAlert[] = [];
  async alert(
    level: AlertLevel,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    options?: { dedupKey?: string },
  ) {
    this.alerts.push({
      level,
      code,
      message,
      details,
      ...(options?.dedupKey ? { dedupKey: options.dedupKey } : {}),
    });
  }
  codes(): string[] {
    return this.alerts.map((a) => a.code);
  }
}

export class RecordingLogger implements JobLogger {
  readonly lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
  debug(fields: Record<string, unknown>, msg: string) {
    this.lines.push({ level: 'debug', fields, msg });
  }
  info(fields: Record<string, unknown>, msg: string) {
    this.lines.push({ level: 'info', fields, msg });
  }
  warn(fields: Record<string, unknown>, msg: string) {
    this.lines.push({ level: 'warn', fields, msg });
  }
  error(fields: Record<string, unknown>, msg: string) {
    this.lines.push({ level: 'error', fields, msg });
  }
}
