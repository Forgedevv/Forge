import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSolTransferTx } from '../core-adapter.js';
import { openKeystore, type Keystore } from '../keystore.js';
import type { ConvertRunSummary } from './convert.js';
import { createPriorityFees } from './priority.js';
import {
  DEFAULT_REVENUE_MIN_FORWARD_LAMPORTS,
  DEFAULT_REVENUE_RESERVE_LAMPORTS,
  FORWARD_FEE_BUFFER_LAMPORTS,
  FORWARD_MEMO,
  REVENUE_SOURCES,
  REVENUE_STATE_KEY,
  RevenueForwardEntry,
  RevenueStateEntry,
  UNWRAP_MEMO,
  assertRevenueUnwrapTx,
  buildRevenueUnwrapTx,
  createRevenueForwardReader,
  createRevenueJob,
  createRevenueRpc,
  forwardBreakdown,
  revenueConfigFromEnv,
  revenueWiringProblems,
  splitProportionally,
  zeroBreakdown,
  type RevenueBreakdown,
  type RevenueConfig,
  type RevenueDeps,
  type RevenueOutcome,
  type RevenueRpc,
  type RevenueTokenAccount,
  type RevenueUnwrapExpectation,
} from './revenue.js';
import {
  JobError,
  MEMO_PROGRAM_ID,
  createMemoryJournal,
  signWithKeystore,
  type RetryOptions,
} from './shared.js';
import {
  FakeChain,
  FakeClock,
  RecordingAlerter,
  RecordingLogger,
  chainSleep,
  memoryFlags,
  randomAddress,
  type Ledger,
} from './testing.js';

const FAST = { N: 1 << 14, r: 8, p: 1 };
const PASSPHRASE = 'revenue job test passphrase, long enough for the keystore';
const SOL = 1_000_000_000n;
const SEED = 'unwrap-0123456789abcdef';
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
/** The Jupiter aggregator program of the Swap API V2 build fixture (a fake AMM here). */
const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
/** Output of the fixture jupiter-v2-build-usdc-sol.json: 5 USDC -> 48,014,162 lamports. */
const FIXTURE_IN_AMOUNT = 5_000_000n;
const FIXTURE_OUT_AMOUNT = 48_014_162n;

let dir: string;
let keystore: Keystore;
let revenue: PublicKey;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-revenue-'));
  keystore = await openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST });
  revenue = (await keystore.createKey('revenue')).publicKey;
});

afterEach(async () => {
  await keystore.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// A fake SPL Token program over the fake chain: enough for the unwrap transaction.

interface FakeTokenAccount {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  programId: PublicKey;
  frozen?: boolean;
}

class RevenueChain extends FakeChain implements RevenueRpc {
  readonly tokenAccounts = new Map<string, FakeTokenAccount>();
  /** Amounts moved out of each account within one execution (simulation or landing). */
  private readonly moved = new WeakMap<Ledger, Map<string, bigint>>();

  constructor() {
    super();
    this.onInstruction = (ix, _tx, ledger) => this.apply(ix, ledger);
  }

  addTokenAccount(address: PublicKey, account: FakeTokenAccount): void {
    this.tokenAccounts.set(address.toBase58(), account);
    const rent = this.rentExempt(ACCOUNT_SIZE);
    this.setBalance(address, account.mint.equals(NATIVE_MINT) ? rent + account.amount : rent);
  }

  tokenAmount(address: PublicKey): bigint | undefined {
    return this.tokenAccounts.get(address.toBase58())?.amount;
  }

  async getTokenAccounts(owner: PublicKey): Promise<RevenueTokenAccount[]> {
    return [...this.tokenAccounts.entries()]
      .filter(([, a]) => a.owner.equals(owner))
      .map(([address, a]) => ({
        address: new PublicKey(address),
        mint: a.mint,
        amount: a.amount,
        lamports: this.balanceOf(new PublicKey(address)),
        programId: a.programId,
        frozen: a.frozen ?? false,
      }));
  }

  private apply(ix: TransactionInstruction, ledger: Ledger): void {
    const key = (i: number): PublicKey => ix.keys[i]!.pubkey;
    if (ix.programId.equals(SystemProgram.programId)) {
      const c = SystemInstruction.decodeCreateWithSeed(ix);
      const id = c.newAccountPubkey.toBase58();
      if (this.tokenAccounts.has(id) || ledger.scratch.has(id)) throw new Error('account in use');
      ledger.debit(c.fromPubkey, BigInt(c.lamports));
      ledger.scratch.set(id, BigInt(c.lamports));
      return;
    }
    if (ix.programId.equals(MEMO_PROGRAM_ID)) return;
    // Its fee is charged by FakeChain with the signatures.
    if (ix.programId.equals(ComputeBudgetProgram.programId)) return;
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // CreateIdempotent (u8 1): payer (signer), ata, owner, mint, system, token program. The
      // setup instruction of a Swap API V2 build with `wrapAndUnwrapSol`.
      if (Buffer.from(ix.data).toString('hex') !== '01') throw new Error('unsupported ATA call');
      if (!ix.keys[0]!.isSigner) throw new Error('ATA payer must sign');
      const ata = key(1).toBase58();
      if (this.tokenAccounts.has(ata) || ledger.scratch.has(ata)) return;
      const [owner, mint] = [key(2), key(3)];
      if (!getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID).equals(key(1))) {
        throw new Error('not the associated token address');
      }
      const rent = this.rentExempt(ACCOUNT_SIZE);
      ledger.debit(key(0), rent);
      ledger.scratch.set(ata, rent);
      ledger.onCommit(() =>
        this.tokenAccounts.set(ata, { mint, owner, amount: 0n, programId: TOKEN_PROGRAM_ID }),
      );
      return;
    }
    if (ix.programId.equals(JUPITER_V6)) {
      // Fake aggregator: taker (signer), source token account, destination WSOL account; data =
      // u64 in amount + u64 out amount. The output lamports appear from the (fake) pools.
      const data = Buffer.from(ix.data);
      const [inAmount, outAmount] = [data.readBigUInt64LE(0), data.readBigUInt64LE(8)];
      const source = key(1).toBase58();
      const destination = key(2).toBase58();
      const src = this.tokenAccounts.get(source);
      if (!src) throw new Error('swap source missing');
      if (!src.owner.equals(key(0)) || !ix.keys[0]!.isSigner) throw new Error('taker mismatch');
      if (src.amount < inAmount) throw new Error('insufficient token balance');
      if (!this.tokenAccounts.has(destination) && !ledger.scratch.has(destination)) {
        throw new Error('swap destination missing');
      }
      ledger.scratch.set(destination, (ledger.scratch.get(destination) ?? 0n) + outAmount);
      ledger.onCommit(() => {
        src.amount -= inAmount;
        const dst = this.tokenAccounts.get(destination);
        if (dst) dst.amount += outAmount;
      });
      return;
    }
    if (!ix.programId.equals(TOKEN_PROGRAM_ID)) throw new Error('unknown program');
    const data = Buffer.from(ix.data);
    if (data[0] === 18) {
      const account = key(0).toBase58();
      const mint = key(1);
      const owner = new PublicKey(data.subarray(1, 33));
      if ((ledger.scratch.get(account) ?? 0n) < this.rentExempt(ACCOUNT_SIZE)) {
        throw new Error('account not rent-exempt');
      }
      ledger.onCommit(() =>
        this.tokenAccounts.set(account, { mint, owner, amount: 0n, programId: TOKEN_PROGRAM_ID }),
      );
      return;
    }
    if (data[0] === 3) {
      const amount = data.readBigUInt64LE(1);
      const source = key(0);
      const destination = key(1).toBase58();
      const src = this.tokenAccounts.get(source.toBase58());
      if (!src) throw new Error('source missing');
      if (!src.owner.equals(key(2)) || !ix.keys[2]!.isSigner) throw new Error('owner mismatch');
      let moved = this.moved.get(ledger);
      if (!moved) this.moved.set(ledger, (moved = new Map()));
      const already = moved.get(source.toBase58()) ?? 0n;
      if (src.amount - already < amount) throw new Error('insufficient token balance');
      moved.set(source.toBase58(), already + amount);
      if (src.mint.equals(NATIVE_MINT)) {
        ledger.debit(source, amount);
        ledger.scratch.set(destination, (ledger.scratch.get(destination) ?? 0n) + amount);
      }
      ledger.onCommit(() => {
        src.amount -= amount;
        const dst = this.tokenAccounts.get(destination);
        if (dst) dst.amount += amount;
      });
      return;
    }
    if (data[0] === 9) {
      // CloseAccount: everything the account holds (its committed lamports and what it received
      // in this execution) goes to the destination; the account is gone once landed.
      const account = key(0).toBase58();
      if (!ix.keys[2]!.isSigner) throw new Error('close authority must sign');
      const existing = this.tokenAccounts.get(account);
      if (existing && !existing.owner.equals(key(2))) throw new Error('close authority mismatch');
      const held = existing ? this.balanceOf(key(0)) : 0n;
      if (held > 0n) ledger.debit(key(0), held);
      ledger.credit(key(1), held + (ledger.scratch.get(account) ?? 0n));
      ledger.scratch.set(account, 0n);
      ledger.onCommit(() => this.tokenAccounts.delete(account));
      return;
    }
    throw new Error('unsupported token instruction');
  }
}

interface SetupOptions {
  cluster?: 'devnet' | 'mainnet-beta';
  config?: Partial<RevenueConfig>;
  deps?: Partial<RevenueDeps>;
  /** Native lamports of the revenue wallet at start. */
  native?: bigint;
  /** Wrapped SOL in the Meteora referral account (always held by the wallet unless `noReferral`). */
  referralWsol?: bigint;
  noReferral?: boolean;
  /** Wrapped SOL in the wallet's own WSOL account (the Jupiter claims land there). */
  otherWsol?: bigint;
}

function setup(options: SetupOptions = {}) {
  const chain = new RevenueChain();
  const alerter = new RecordingAlerter();
  const logger = new RecordingLogger();
  const flags = memoryFlags();
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const sleep = chainSleep(chain, sleeps, clock);
  const retry: RetryOptions = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000, sleep };
  const journal = createMemoryJournal(RevenueStateEntry);
  const forwards = createMemoryJournal(RevenueForwardEntry);
  const vault = randomAddress();
  const referral = randomAddress();
  // The Jupiter referral claims land in the partner's associated WSOL account: the one a swap
  // with `wrapAndUnwrapSol` creates in its setup and closes in its cleanup.
  const ownWsol = getAssociatedTokenAddressSync(NATIVE_MINT, revenue, false, TOKEN_PROGRAM_ID);
  chain.setBalance(vault, SOL);
  const rent = chain.rentExempt(0);
  const native = options.native ?? rent + DEFAULT_REVENUE_RESERVE_LAMPORTS + 50_000_000n;
  chain.setBalance(revenue, native);
  if (!options.noReferral) {
    chain.addTokenAccount(referral, {
      mint: NATIVE_MINT,
      owner: revenue,
      amount: options.referralWsol ?? 0n,
      programId: TOKEN_PROGRAM_ID,
    });
  }
  if (options.otherWsol !== undefined) {
    chain.addTokenAccount(ownWsol, {
      mint: NATIVE_MINT,
      owner: revenue,
      amount: options.otherWsol,
      programId: TOKEN_PROGRAM_ID,
    });
  }
  const config: RevenueConfig = {
    revenue,
    vault,
    meteoraReferral: referral,
    jupiterClaimMints: [NATIVE_MINT, USDC],
    reserveLamports: DEFAULT_REVENUE_RESERVE_LAMPORTS,
    minForwardLamports: DEFAULT_REVENUE_MIN_FORWARD_LAMPORTS,
    minUnwrapLamports: 1_000_000n,
    outflowToleranceLamports: 100_000n,
    computeUnitPriceMicroLamports: 0,
    dryRun: false,
    settle: { timeoutMs: 120_000, pollMs: 2_000, rebroadcastMs: 6_000 },
    ...options.config,
  };
  const announced: string[] = [];
  const job = (extra: Partial<RevenueDeps> = {}) =>
    createRevenueJob({
      rpc: chain,
      core: { buildSolTransferTx },
      keystore,
      journal,
      forwards,
      flags,
      alerter,
      logger,
      config,
      cluster: options.cluster ?? 'devnet',
      retry,
      sleep,
      now: clock.now,
      seed: () => SEED,
      onBeforeSend: (signature) => void announced.push(signature),
      ...options.deps,
      ...extra,
    });
  const floor = rent + config.reserveLamports + FORWARD_FEE_BUFFER_LAMPORTS;
  const state = async () => (await journal.get(REVENUE_STATE_KEY))!;
  const pending = async (): Promise<RevenueBreakdown> => {
    const s = await state();
    return {
      meteora_referral: BigInt(s.pending.meteora_referral),
      jupiter_referral: BigInt(s.pending.jupiter_referral),
      platform_fee: BigInt(s.pending.platform_fee),
      other: BigInt(s.pending.other),
    };
  };
  return {
    chain,
    alerter,
    logger,
    flags,
    clock,
    journal,
    forwards,
    vault,
    referral,
    ownWsol,
    rent,
    native,
    config,
    announced,
    job,
    floor,
    state,
    pending,
    retry,
  };
}

/**
 * A conversion in the shape of a Swap API V2 build with `wrapAndUnwrapSol` (fixture
 * jupiter-v2-build-usdc-sol.json): the idempotent creation of the taker's associated WSOL
 * account in setup, the swap, and the CloseAccount of that account to the taker in cleanup.
 * Signed by the revenue key and sent to the fake chain, as the conversion machinery would.
 */
async function fixtureShapedSwap(
  t: ReturnType<typeof setup>,
  usdcAccount: PublicKey,
  inAmount = FIXTURE_IN_AMOUNT,
  outAmount = FIXTURE_OUT_AMOUNT,
): Promise<string> {
  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      revenue,
      t.ownWsol,
      revenue,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
  );
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(inAmount, 0);
  data.writeBigUInt64LE(outAmount, 8);
  tx.add(
    new TransactionInstruction({
      programId: JUPITER_V6,
      keys: [
        { pubkey: revenue, isSigner: true, isWritable: false },
        { pubkey: usdcAccount, isSigner: false, isWritable: true },
        { pubkey: t.ownWsol, isSigner: false, isWritable: true },
      ],
      data,
    }),
  );
  tx.add(createCloseAccountInstruction(t.ownWsol, revenue, revenue, [], TOKEN_PROGRAM_ID));
  const { blockhash } = await t.chain.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = revenue;
  const ref = (await keystore.findRef('revenue'))!;
  const { raw, signature } = await signWithKeystore(keystore, tx, [{ ref, expected: revenue }]);
  await t.chain.sendRawTransaction(raw);
  return signature;
}

function conversionSummary(items: ConvertRunSummary['items']): ConvertRunSummary {
  return { status: 'ran', mode: 'live', modeReason: 'test', window: '1', items };
}

function usdcConversion(signature: string): ConvertRunSummary['items'][number] {
  return {
    owner: revenue.toBase58(),
    mint: USDC.toBase58(),
    amount: FIXTURE_IN_AMOUNT,
    outcome: { status: 'confirmed', signature, outAmount: FIXTURE_OUT_AMOUNT },
  };
}

// ---------------------------------------------------------------------------------------
// Pure helpers

describe('breakdown arithmetic', () => {
  it('splits proportionally in whole lamports that sum exactly', () => {
    expect(splitProportionally(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(splitProportionally(7n, [0n, 0n])).toEqual([0n, 7n]);
    expect(splitProportionally(0n, [5n, 5n])).toEqual([0n, 0n]);
    const shares = splitProportionally(1_000_000_007n, [3n, 7n, 11n, 13n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(1_000_000_007n);
    expect(() => splitProportionally(-1n, [1n])).toThrow(JobError);
    expect(() => splitProportionally(1n, [])).toThrow(JobError);
  });

  it('books the unexplained remainder as other and scales down when the buckets exceed the amount', () => {
    const pending = { ...zeroBreakdown(), meteora_referral: 300n, jupiter_referral: 100n };
    expect(forwardBreakdown(pending, 1_000n)).toEqual({
      meteora_referral: 300n,
      jupiter_referral: 100n,
      platform_fee: 0n,
      other: 600n,
    });
    const scaled = forwardBreakdown({ ...pending, platform_fee: 600n }, 500n);
    expect(scaled).toEqual({
      meteora_referral: 150n,
      jupiter_referral: 50n,
      platform_fee: 300n,
      other: 0n,
    });
    expect(REVENUE_SOURCES.reduce((a, s) => a + scaled[s], 0n)).toBe(500n);
    expect(forwardBreakdown(zeroBreakdown(), 42n)).toEqual({ ...zeroBreakdown(), other: 42n });
  });
});

// ---------------------------------------------------------------------------------------
// Unwrap transaction: layout and policy

describe('buildRevenueUnwrapTx', () => {
  async function build(sources: number, price = 0) {
    const owner = randomAddress();
    const ephemeral = await PublicKey.createWithSeed(owner, SEED, TOKEN_PROGRAM_ID);
    const e: RevenueUnwrapExpectation = {
      owner,
      ephemeral,
      seed: SEED,
      rentLamports: 2_039_280n,
      sources: Array.from({ length: sources }, (_, i) => ({
        account: randomAddress(),
        amount: BigInt(i + 1) * 1_000_000n,
      })),
      memo: UNWRAP_MEMO,
    };
    const tx = buildRevenueUnwrapTx({ ...e, computeUnitPriceMicroLamports: price });
    tx.recentBlockhash = randomAddress().toBase58();
    tx.feePayer = owner;
    return { tx, e };
  }

  it('pins the SPL Token instruction layouts and the account order', async () => {
    const { tx, e } = await build(2);
    const [create, init, t1, t2, close, memo] = tx.instructions;
    expect(tx.instructions).toHaveLength(6);
    const created = SystemInstruction.decodeCreateWithSeed(create!);
    expect(created.basePubkey.equals(e.owner)).toBe(true);
    expect(created.fromPubkey.equals(e.owner)).toBe(true);
    expect(created.newAccountPubkey.equals(e.ephemeral)).toBe(true);
    expect(created.seed).toBe(SEED);
    expect(BigInt(created.lamports)).toBe(2_039_280n);
    expect(created.space).toBe(165);
    expect(created.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    // InitializeAccount3: u8 18 + the owner's 32 bytes; accounts: account (writable), mint.
    expect(init!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(init!.data)).toEqual(Buffer.concat([Buffer.from([18]), e.owner.toBuffer()]));
    expect(init!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [e.ephemeral.toBase58(), false, true],
      [NATIVE_MINT.toBase58(), false, false],
    ]);
    // Transfer: u8 3 + u64 amount LE; accounts: source (w), destination (w), authority (signer).
    for (const [ix, source] of [
      [t1!, e.sources[0]!],
      [t2!, e.sources[1]!],
    ] as const) {
      const data = Buffer.from(ix.data);
      expect(data.length).toBe(9);
      expect(data[0]).toBe(3);
      expect(data.readBigUInt64LE(1)).toBe(source.amount);
      expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
        [source.account.toBase58(), false, true],
        [e.ephemeral.toBase58(), false, true],
        [e.owner.toBase58(), true, false],
      ]);
    }
    // CloseAccount: u8 9; accounts: account (w), destination (w), authority (signer).
    expect(Buffer.from(close!.data)).toEqual(Buffer.from([9]));
    expect(close!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [e.ephemeral.toBase58(), false, true],
      [e.owner.toBase58(), false, true],
      [e.owner.toBase58(), true, false],
    ]);
    expect(memo!.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(memo!.keys).toEqual([]);
    expect(Buffer.from(memo!.data).toString('utf8')).toBe(UNWRAP_MEMO);
    expect(() => assertRevenueUnwrapTx(tx, e)).not.toThrow();
  });

  it('adds a bounded compute budget only with a priority fee, accepted by the policy within its cap', async () => {
    const { tx, e } = await build(1, 1_000);
    expect(tx.instructions).toHaveLength(7);
    expect(tx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(tx.instructions[1]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(() => assertRevenueUnwrapTx(tx, e)).not.toThrow();
    // One source: 46,000 CU at 1,000 micro-lamports = 46 lamports.
    expect(() => assertRevenueUnwrapTx(tx, { ...e, maxPriorityFeeLamports: 46n })).not.toThrow();
    expect(() => assertRevenueUnwrapTx(tx, { ...e, maxPriorityFeeLamports: 45n })).toThrow(
      /priority fee too high/,
    );
    const unpriced = await build(1);
    expect(() =>
      assertRevenueUnwrapTx(unpriced.tx, { ...unpriced.e, maxPriorityFeeLamports: 0n }),
    ).not.toThrow();
  });

  it('refuses a bad seed, no source, too many sources or a zero amount', async () => {
    const { e } = await build(1);
    expect(() => buildRevenueUnwrapTx({ ...e, seed: 'unwrap-xyz' })).toThrow(/seed/);
    expect(() => buildRevenueUnwrapTx({ ...e, sources: [] })).toThrow(/between 1 and 8/);
    expect(() =>
      buildRevenueUnwrapTx({
        ...e,
        sources: Array.from({ length: 9 }, () => ({ account: randomAddress(), amount: 1n })),
      }),
    ).toThrow(/between 1 and 8/);
    expect(() =>
      buildRevenueUnwrapTx({ ...e, sources: [{ account: randomAddress(), amount: 0n }] }),
    ).toThrow(/positive/);
  });

  type Mutation = (tx: Transaction, e: RevenueUnwrapExpectation) => void;
  const attacker = randomAddress();
  const tokenIx = (keys: PublicKey[], data: Buffer, signerIndex = -1) =>
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: keys.map((pubkey, i) => ({
        pubkey,
        isSigner: i === signerIndex,
        isWritable: i !== signerIndex,
      })),
      data,
    });
  const cases: Array<[string, Mutation, RegExp]> = [
    ['another fee payer', (tx) => void (tx.feePayer = attacker), /fee payer/],
    [
      'an extra required signer',
      (tx, e) =>
        void tx.instructions.push(
          new TransactionInstruction({
            programId: MEMO_PROGRAM_ID,
            keys: [{ pubkey: attacker, isSigner: true, isWritable: false }],
            data: Buffer.from(e.memo),
          }),
        ),
      /required signer/,
    ],
    [
      'a System transfer appended',
      (tx, e) =>
        void tx.instructions.push(
          SystemProgram.transfer({ fromPubkey: e.owner, toPubkey: attacker, lamports: 1 }),
        ),
      /after the memo/,
    ],
    [
      'a System transfer in place of the creation',
      (tx, e) =>
        void (tx.instructions[0] = SystemProgram.transfer({
          fromPubkey: e.owner,
          toPubkey: attacker,
          lamports: 1,
        })),
      /other than createAccountWithSeed/,
    ],
    [
      'another seed',
      (tx, e) => void (e.seed = 'unwrap-ffffffffffffffff'),
      /ephemeral account creation/,
    ],
    ['another rent', (tx, e) => void (e.rentLamports = 1n), /ephemeral account creation/],
    [
      'an ephemeral account owned by someone else',
      (tx) =>
        void (tx.instructions[1]!.data = Buffer.concat([Buffer.from([18]), attacker.toBuffer()])),
      /owner is not the wallet/,
    ],
    [
      'an ephemeral account of another mint',
      (tx) => void (tx.instructions[1]!.keys[1]!.pubkey = randomAddress()),
      /not wrapped SOL/,
    ],
    [
      'a transfer to another account',
      (tx) => void (tx.instructions[2]!.keys[1]!.pubkey = attacker),
      /transfer to an unexpected account/,
    ],
    [
      'a transfer from an unexpected account',
      (tx) => void (tx.instructions[2]!.keys[0]!.pubkey = attacker),
      /from an unexpected account/,
    ],
    [
      'a transfer with another authority',
      (tx) =>
        void (tx.instructions[2]!.keys[2] = {
          pubkey: attacker,
          isSigner: false,
          isWritable: false,
        }),
      /transfer authority/,
    ],
    [
      'a transfer signed by someone else',
      (tx) => void (tx.instructions[2]!.keys[2]!.pubkey = attacker),
      /required signer/,
    ],
    [
      'a transfer of another amount',
      (tx) => {
        const data = Buffer.from(tx.instructions[2]!.data);
        data.writeBigUInt64LE(1n, 1);
        tx.instructions[2]!.data = data;
      },
      /amount mismatch/,
    ],
    [
      'a source transferred twice',
      (tx) => void tx.instructions.splice(3, 0, tx.instructions[2]!),
      /transferred twice/,
    ],
    [
      'an expected source left out',
      (tx) => void tx.instructions.splice(3, 1),
      /expected source not transferred/,
    ],
    [
      'the ephemeral account closed to someone else',
      (tx) => void (tx.instructions[4]!.keys[1]!.pubkey = attacker),
      /closed to a non-wallet/,
    ],
    [
      'another close authority',
      (tx) =>
        void (tx.instructions[4]!.keys[2] = {
          pubkey: attacker,
          isSigner: false,
          isWritable: false,
        }),
      /close authority/,
    ],
    [
      'the referral account closed instead',
      (tx, e) => void (tx.instructions[4]!.keys[0]!.pubkey = e.sources[0]!.account),
      /close of an unexpected account/,
    ],
    [
      'an approve instruction',
      (tx, e) =>
        void tx.instructions.splice(
          3,
          0,
          tokenIx(
            [e.sources[0]!.account, attacker, e.owner],
            Buffer.from([4, 0, 0, 0, 0, 0, 0, 0, 1]),
            2,
          ),
        ),
      /token instruction not allowed/,
    ],
    ['a missing memo', (tx) => void tx.instructions.pop(), /incomplete/],
    [
      'another memo',
      (tx) => void (tx.instructions[5]!.data = Buffer.from('forge:cashbox-sweep')),
      /memo mismatch/,
    ],
    [
      'a memo with keys',
      (tx) =>
        void (tx.instructions[5]!.keys = [
          { pubkey: attacker, isSigner: false, isWritable: false },
        ]),
      /memo with signer keys/,
    ],
    [
      'a compute budget after the creation',
      (tx) =>
        void tx.instructions.splice(1, 0, ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })),
      /compute budget after/,
    ],
    [
      'an unknown program',
      (tx) =>
        void tx.instructions.splice(
          2,
          0,
          new TransactionInstruction({
            programId: randomAddress(),
            keys: [],
            data: Buffer.alloc(0),
          }),
        ),
      /program not allowed/,
    ],
    ['a missing blockhash', (tx) => void (tx.recentBlockhash = undefined), /blockhash/],
  ];
  it.each(cases)('refuses %s', async (_label, mutate, rule) => {
    const { tx, e } = await build(2);
    mutate(tx, e);
    let error: unknown;
    try {
      assertRevenueUnwrapTx(tx, e);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('TX_POLICY');
    expect((error as JobError).message).toMatch(rule);
  });
});

// ---------------------------------------------------------------------------------------
// Configuration and wiring

describe('revenueConfigFromEnv', () => {
  const addresses = () => ({
    revenue: randomAddress(),
    vault: randomAddress(),
    meteoraReferral: randomAddress(),
    computeUnitPriceMicroLamports: 0,
  });

  it('applies the defaults: dry run, 24 h, the claim mints', () => {
    const { config, intervalMs } = revenueConfigFromEnv({}, addresses());
    expect(config.dryRun).toBe(true);
    expect(config.paused).toBe(false);
    expect(config.reserveLamports).toBe(10_000_000n);
    expect(config.minForwardLamports).toBe(10_000_000n);
    expect(config.minUnwrapLamports).toBe(1_000_000n);
    expect(config.outflowToleranceLamports).toBe(100_000n);
    expect(config.jupiterClaimMints.map((m) => m.toBase58())).toEqual([
      NATIVE_MINT.toBase58(),
      USDC.toBase58(),
    ]);
    expect(intervalMs).toBe(24 * 60 * 60_000);
  });

  it('reads every variable and refuses malformed ones by name', () => {
    const { config, intervalMs } = revenueConfigFromEnv(
      {
        SIGNER_REVENUE_RESERVE_LAMPORTS: '5',
        SIGNER_REVENUE_MIN_FORWARD_LAMPORTS: '6',
        SIGNER_REVENUE_MIN_UNWRAP_LAMPORTS: '7',
        SIGNER_REVENUE_OUTFLOW_TOLERANCE_LAMPORTS: '8',
        SIGNER_REVENUE_DRY_RUN: 'false',
        SIGNER_REVENUE_INTERVAL_HOURS: '6',
        SIGNER_REVENUE_PAUSED: 'true',
      },
      { ...addresses(), computeUnitPriceMicroLamports: 500 },
    );
    expect([
      config.reserveLamports,
      config.minForwardLamports,
      config.minUnwrapLamports,
      config.outflowToleranceLamports,
    ]).toEqual([5n, 6n, 7n, 8n]);
    expect(config.dryRun).toBe(false);
    expect(config.paused).toBe(true);
    expect(config.computeUnitPriceMicroLamports).toBe(500);
    expect(intervalMs).toBe(6 * 60 * 60_000);
    for (const [name, value] of [
      ['SIGNER_REVENUE_RESERVE_LAMPORTS', '0.5'],
      ['SIGNER_REVENUE_MIN_FORWARD_LAMPORTS', '-1'],
      ['SIGNER_REVENUE_DRY_RUN', 'yes'],
      ['SIGNER_REVENUE_INTERVAL_HOURS', '0'],
    ]) {
      expect(() => revenueConfigFromEnv({ [name!]: value }, addresses())).toThrow(
        new RegExp(name!),
      );
    }
    expect(() =>
      revenueConfigFromEnv({ SIGNER_REVENUE_MIN_FORWARD_LAMPORTS: '0' }, addresses()),
    ).toThrow(/positive/);
  });

  it('refuses colliding addresses', () => {
    const a = addresses();
    expect(() => revenueConfigFromEnv({}, { ...a, vault: a.revenue })).toThrow(/must differ/);
    expect(() => revenueConfigFromEnv({}, { ...a, meteoraReferral: a.revenue })).toThrow(
      /own account/,
    );
  });
});

describe('revenueWiringProblems', () => {
  it('lists every mismatch by variable name and nothing when wired', () => {
    const wallet = randomAddress();
    const base = {
      revenue: wallet,
      platformFee: wallet,
      vault: randomAddress(),
      cashbox: randomAddress(),
      revenueKey: wallet,
      referralOwner: wallet,
    };
    expect(revenueWiringProblems(base)).toEqual([]);
    expect(revenueWiringProblems({ ...base, referralOwner: null })).toEqual([]);
    expect(revenueWiringProblems({ ...base, revenueKey: null })).toEqual([
      'no revenue key in the keystore (run --init-keys)',
    ]);
    const other = randomAddress();
    const problems = revenueWiringProblems({
      ...base,
      revenueKey: other,
      platformFee: other,
      referralOwner: other,
    });
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/keystore revenue key/);
    expect(problems.join('\n')).toMatch(/FORGE_PLATFORM_FEE_WALLET/);
    expect(problems.join('\n')).toMatch(/FORGE_METEORA_REFERRAL_ACCOUNT/);
    expect(problems.join('\n')).not.toContain(other.toBase58());
    expect(revenueWiringProblems({ ...base, vault: wallet })).toEqual([
      'FORGE_REVENUE_WALLET is the vault',
    ]);
    expect(revenueWiringProblems({ ...base, cashbox: wallet })).toEqual([
      'FORGE_REVENUE_WALLET is the cashbox',
    ]);
  });
});

describe('createRevenueRpc', () => {
  it('lists the token accounts of both programs with their raw amounts and lamports, at the asked commitment', async () => {
    const owner = randomAddress();
    const classic = randomAddress();
    const t22 = randomAddress();
    const calls: string[] = [];
    const connection = {
      async getParsedTokenAccountsByOwner(
        o: PublicKey,
        filter: { programId: PublicKey },
        commitment: string,
      ) {
        calls.push(`${o.toBase58()}:${filter.programId.toBase58()}:${commitment}`);
        const value = filter.programId.equals(TOKEN_PROGRAM_ID)
          ? [
              {
                pubkey: classic,
                account: {
                  lamports: 2_039_403,
                  data: {
                    parsed: {
                      info: {
                        mint: NATIVE_MINT.toBase58(),
                        state: 'initialized',
                        tokenAmount: { amount: '123' },
                      },
                    },
                  },
                },
              },
              {
                pubkey: randomAddress(),
                account: { lamports: 1, data: { parsed: { info: { mint: 'x' } } } },
              },
            ]
          : [
              {
                pubkey: t22,
                account: {
                  lamports: 2_039_280,
                  data: {
                    parsed: {
                      info: {
                        mint: USDC.toBase58(),
                        state: 'frozen',
                        tokenAmount: { amount: '7' },
                      },
                    },
                  },
                },
              },
            ];
        return { context: { slot: 1 }, value };
      },
    } as unknown as Connection;
    const rpc = createRevenueRpc(connection);
    const accounts = await rpc.getTokenAccounts(owner);
    expect(
      accounts.map((a) => [
        a.address.toBase58(),
        a.mint.toBase58(),
        a.amount,
        a.lamports,
        a.programId.toBase58(),
        a.frozen,
      ]),
    ).toEqual([
      [
        classic.toBase58(),
        NATIVE_MINT.toBase58(),
        123n,
        2_039_403n,
        TOKEN_PROGRAM_ID.toBase58(),
        false,
      ],
      [t22.toBase58(), USDC.toBase58(), 7n, 2_039_280n, TOKEN_2022_PROGRAM_ID.toBase58(), true],
    ]);
    expect(calls.every((c) => c.startsWith(owner.toBase58()) && c.endsWith(':finalized'))).toBe(
      true,
    );
    calls.length = 0;
    await rpc.getTokenAccounts(owner, 'confirmed');
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.endsWith(':confirmed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// The job

describe('revenue job', () => {
  it('unwraps the wrapped SOL through an ephemeral account, keeps the referral account, forwards to the vault with a breakdown', async () => {
    const t = setup({ referralWsol: 30_000_000n, otherWsol: 10_000_000n });
    const report = await t.job().runOnce();
    expect(report.status).toBe('ran');
    expect(report.outcome?.result).toBe('forwarded');
    const outcome = report.outcome as Extract<
      NonNullable<typeof report.outcome>,
      { result: 'forwarded' }
    >;
    // The referral account still exists, emptied; the ephemeral account is gone.
    expect(t.chain.tokenAmount(t.referral)).toBe(0n);
    expect(t.chain.tokenAmount(t.ownWsol)).toBe(0n);
    const ephemeral = await PublicKey.createWithSeed(revenue, SEED, TOKEN_PROGRAM_ID);
    expect(t.chain.tokenAccounts.has(ephemeral.toBase58())).toBe(false);
    expect(t.chain.balanceOf(ephemeral)).toBe(0n);
    // Two transactions announced and sent: the unwrap, then the forward.
    expect(t.announced).toHaveLength(2);
    expect(t.chain.sendAttempts.slice(0, 2)).toEqual(t.announced);
    // Forwarded: everything above the floor, received by the vault.
    const unwrapFee = 5_000n;
    const expectedAmount = t.native + 40_000_000n - unwrapFee - t.floor;
    expect(outcome.lamports).toBe(expectedAmount);
    expect(t.chain.receivedBy(t.vault)).toBe(expectedAmount);
    expect(t.chain.balanceOf(revenue)).toBe(t.floor - 5_000n);
    // Breakdown: the unwrapped amounts by source, the rest (the first run's native balance) as other.
    expect(outcome.breakdown).toEqual({
      meteora_referral: 30_000_000n,
      jupiter_referral: 10_000_000n,
      platform_fee: 0n,
      other: expectedAmount - 40_000_000n,
    });
    const entries = await t.forwards.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe(outcome.signature);
    expect(entries[0]!.value).toMatchObject({
      v: 1,
      signature: outcome.signature,
      lamports: expectedAmount.toString(),
      breakdown: {
        meteora_referral: '30000000',
        jupiter_referral: '10000000',
        platform_fee: '0',
        other: (expectedAmount - 40_000_000n).toString(),
      },
      relatedSignatures: [t.announced[0]],
    });
    const s = await t.state();
    expect(s.inFlight).toBeNull();
    expect(s.pending).toEqual({
      meteora_referral: '0',
      jupiter_referral: '0',
      platform_fee: '0',
      other: '0',
    });
    expect(s.lastForward?.signature).toBe(outcome.signature);
    expect(s.expectedNativeLamports).toBe(t.floor.toString());
    expect(t.alerter.codes()).toEqual([]);
    // The reader sees it.
    const reader = createRevenueForwardReader(t.forwards);
    expect((await reader.totalForwardedSince('2000-01-01T00:00:00.000Z')).lamports).toBe(
      expectedAmount,
    );
  });

  it('prices the unwrap and the forward from the recent fees, budget first, cap kept on the wallet', async () => {
    const reader = {
      getRecentPrioritizationFees: vi.fn(async () => [{ slot: 1, prioritizationFee: 100_000 }]),
    };
    const t = setup({
      referralWsol: 30_000_000n,
      otherWsol: 10_000_000n,
      deps: { priorityFees: createPriorityFees(reader) },
    });
    const report = await t.job().runOnce();
    expect(report.outcome?.result).toBe('forwarded');
    const [unwrap, forward] = [...t.chain.landed.values()];
    for (const landed of [unwrap!, forward!]) {
      expect(landed.programs.slice(0, 2)).toEqual([
        ComputeBudgetProgram.programId.toBase58(),
        ComputeBudgetProgram.programId.toBase58(),
      ]);
    }
    // Unwrap of two accounts: 52,000 CU; forward: 30,000 CU; both at 100,000 micro-lamports.
    expect(unwrap!.priorityFeeLamports).toBe(5_200n);
    expect(forward!.priorityFeeLamports).toBe(3_000n);
    // The forward floor keeps its fee at the cap (30,000 CU x 1 lamport).
    expect(t.chain.balanceOf(revenue)).toBe(t.floor + 30_000n - 5_000n - 3_000n);
    expect(t.alerter.codes()).toEqual([]);
  });

  it('books a native inflow as platform fee and forwards it on the next run', async () => {
    const t = setup({ referralWsol: 30_000_000n });
    await t.job().runOnce();
    const platformFee = 20_000_000n;
    t.chain.setBalance(revenue, t.chain.balanceOf(revenue) + platformFee);
    const report = await t.job().runOnce();
    const outcome = report.outcome as Extract<
      NonNullable<typeof report.outcome>,
      { result: 'forwarded' }
    >;
    expect(outcome.result).toBe('forwarded');
    // The previous forward's fee (5 000) was charged to the buckets: nothing to charge then, so
    // the inflow net of it is what the wallet holds above the floor.
    expect(outcome.lamports).toBe(platformFee - 5_000n);
    expect(outcome.breakdown).toEqual({
      meteora_referral: 0n,
      jupiter_referral: 0n,
      platform_fee: platformFee - 5_000n,
      other: 0n,
    });
    expect(t.announced).toHaveLength(3);
    expect(await t.forwards.list()).toHaveLength(2);
  });

  it('does nothing below the reserve or the threshold, and skips a vault that would not be rent-exempt', async () => {
    const t = setup({ native: 5_000_000n });
    expect((await t.job().runOnce()).outcome).toMatchObject({ result: 'below_reserve' });
    t.chain.setBalance(revenue, t.floor + 1_000n);
    expect((await t.job().runOnce()).outcome).toMatchObject({
      result: 'below_threshold',
      excess: 1_000n,
    });
    expect(t.chain.sendAttempts).toEqual([]);
    // An empty vault that the forward would leave below the rent-exempt minimum: skipped.
    const u = setup({ config: { minForwardLamports: 1_000n } });
    u.chain.setBalance(u.vault, 0n);
    u.chain.setBalance(revenue, u.floor + 1_000n);
    expect((await u.job().runOnce()).outcome).toEqual({
      result: 'skipped',
      reason: 'vault_not_rent_exempt',
    });
    expect(u.chain.sendAttempts).toEqual([]);
  });

  it('dry run: plans and logs, signs nothing', async () => {
    const t = setup({ referralWsol: 30_000_000n, config: { dryRun: true } });
    const report = await t.job().runOnce();
    expect(report.outcome).toMatchObject({ result: 'dry_run', unwrapLamports: 30_000_000n });
    const dry = report.outcome as Extract<
      NonNullable<typeof report.outcome>,
      { result: 'dry_run' }
    >;
    expect(dry.forwardLamports).toBe(t.native - t.floor);
    expect(t.chain.sendAttempts).toEqual([]);
    expect(t.chain.tokenAmount(t.referral)).toBe(30_000_000n);
    expect(t.logger.lines.some((l) => l.msg.includes('dry run'))).toBe(true);
  });

  it('fails closed on the kill switches: env, flag, missing row, unreadable flags', async () => {
    const t = setup({ referralWsol: 30_000_000n });
    expect(await t.job({ config: { ...t.config, paused: true } }).runOnce()).toEqual({
      status: 'paused',
      reason: 'config',
    });
    t.flags.values.revenue_paused = true;
    expect(await t.job().runOnce()).toEqual({ status: 'paused', reason: 'flag' });
    delete t.flags.values.revenue_paused;
    expect(await t.job().runOnce()).toEqual({ status: 'paused', reason: 'flag_missing' });
    t.flags.fail = true;
    expect(await t.job().runOnce()).toEqual({ status: 'paused', reason: 'flags_unavailable' });
    expect(t.alerter.codes()).toEqual([
      'revenue_paused_flag_missing',
      'revenue_paused_flags_unavailable',
    ]);
    expect(t.chain.sendAttempts).toEqual([]);
  });

  it('refuses a forward to anything but the vault before signing', async () => {
    const t = setup();
    const attacker = randomAddress();
    const job = t.job({
      core: {
        buildSolTransferTx: (p) => buildSolTransferTx({ ...p, to: attacker }),
      },
    });
    const report = await job.runOnce();
    expect(report.status).toBe('error');
    expect(report.reason).toMatch(/TX_POLICY/);
    expect(t.alerter.codes()).toEqual(['revenue_policy_violation']);
    expect(t.chain.sendAttempts).toEqual([]);
    expect(t.chain.balanceOf(attacker)).toBe(0n);
  });

  it('refuses to run when the configured wallet is not the keystore revenue key', async () => {
    const t = setup({ config: { revenue: randomAddress() } });
    const report = await t.job().runOnce();
    expect(report).toEqual({ status: 'error', reason: 'revenue_key' });
    expect(t.alerter.codes()).toEqual(['revenue_config']);
    expect(t.chain.sendAttempts).toEqual([]);
  });

  it('settles a forward left in flight by a crash on the next run, recorded exactly once', async () => {
    const t = setup({
      config: { settle: { timeoutMs: 1_000, pollMs: 1_000, rebroadcastMs: 10_000 } },
    });
    const first = await t.job().runOnce();
    expect(first.outcome).toMatchObject({ result: 'in_flight', kind: 'forward' });
    const signature = (first.outcome as { signature: string }).signature;
    expect((await t.state()).inFlight).toMatchObject({ kind: 'forward', signature });
    expect(await t.forwards.list()).toEqual([]);
    // "Restart": a new job over the same journals, the transaction now finalized.
    t.chain.advance(100);
    const second = await t.job().runOnce();
    expect(second.outcome).toMatchObject({ result: 'forwarded', signature });
    expect(await t.forwards.list()).toHaveLength(1);
    expect((await t.state()).inFlight).toBeNull();
    // Nothing new to forward (the wallet sits one fee below the floor), the entry stays single,
    // the balance was not sent twice.
    const third = await t.job().runOnce();
    expect(third.outcome?.result).toBe('below_reserve');
    expect(await t.forwards.list()).toHaveLength(1);
    expect(t.chain.sendAttempts.filter((s) => s === signature)).toHaveLength(1);
    expect(t.chain.receivedBy(t.vault)).toBe(t.native - t.floor);
  });

  it('keeps a forward entry written before a crash instead of rewriting it', async () => {
    const t = setup({
      config: { settle: { timeoutMs: 1_000, pollMs: 1_000, rebroadcastMs: 10_000 } },
    });
    const first = await t.job().runOnce();
    const signature = (first.outcome as { signature: string }).signature;
    // As if the process died between the forward journal write and the state update.
    const inFlight = (await t.state()).inFlight as Extract<
      NonNullable<RevenueStateEntry['inFlight']>,
      { kind: 'forward' }
    >;
    await t.forwards.put(signature, {
      v: 1,
      signature,
      lamports: inFlight.lamports,
      sentAt: inFlight.startedAt,
      finalizedAt: '2026-01-01T00:00:00.000Z',
      breakdown: inFlight.breakdown,
      relatedSignatures: [],
    });
    t.chain.advance(100);
    await t.job().runOnce();
    const entries = await t.forwards.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.value.finalizedAt).toBe('2026-01-01T00:00:00.000Z');
    expect((await t.state()).lastForward?.signature).toBe(signature);
  });

  it('books an unwrap left in flight on the next run, then forwards', async () => {
    const t = setup({
      referralWsol: 30_000_000n,
      config: { settle: { timeoutMs: 1_000, pollMs: 1_000, rebroadcastMs: 10_000 } },
    });
    const first = await t.job().runOnce();
    expect(first.outcome).toMatchObject({ result: 'in_flight', kind: 'unwrap' });
    t.chain.advance(100);
    const second = await t
      .job({ config: { ...t.config, settle: { timeoutMs: 120_000 } } })
      .runOnce();
    expect(second.outcome?.result).toBe('forwarded');
    const outcome = second.outcome as Extract<
      NonNullable<typeof second.outcome>,
      { result: 'forwarded' }
    >;
    expect(outcome.breakdown.meteora_referral).toBe(30_000_000n);
    expect(t.chain.tokenAmount(t.referral)).toBe(0n);
    expect((await t.forwards.list())[0]!.value.relatedSignatures).toEqual([t.announced[0]]);
  });

  it('does not plan on top of an unfinalized forward it did not record', async () => {
    const t = setup();
    // Another signer (or this one before a lost journal) sent a forward that is not finalized.
    const tx = buildSolTransferTx({
      from: revenue,
      to: t.vault,
      lamports: 1_000n,
      memo: FORWARD_MEMO,
    });
    const ref = (await keystore.findRef('revenue'))!;
    const { blockhash } = await t.chain.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = revenue;
    const { raw, signature } = await signWithKeystore(keystore, tx, [{ ref, expected: revenue }]);
    await t.chain.sendRawTransaction(raw);
    const report = await t.job().runOnce();
    expect(report.outcome).toEqual({ result: 'skipped', reason: 'unfinalized_transaction' });
    expect(t.alerter.alerts[0]).toMatchObject({
      code: 'revenue_unfinalized_transaction',
      details: { signature },
    });
    expect(t.chain.sendAttempts).toEqual([signature]);
    // Finalized: the next run goes on.
    t.chain.advance(100);
    expect((await t.job().runOnce()).outcome?.result).toBe('forwarded');
  });

  it('alerts on a native drop it cannot explain, within the tolerance stays quiet', async () => {
    const t = setup({ config: { minForwardLamports: 10n * SOL } });
    await t.job().runOnce();
    t.chain.setBalance(revenue, t.chain.balanceOf(revenue) - 50_000n);
    await t.job().runOnce();
    expect(t.alerter.codes()).toEqual([]);
    t.chain.setBalance(revenue, t.chain.balanceOf(revenue) - 1_000_000n);
    await t.job().runOnce();
    expect(t.alerter.codes()).toEqual(['revenue_unexpected_outflow']);
  });

  it('on devnet leaves other tokens alone with an alert and never calls the conversion', async () => {
    const t = setup({ referralWsol: 30_000_000n, config: { minForwardLamports: 10n * SOL } });
    const usdcAccount = randomAddress();
    t.chain.addTokenAccount(usdcAccount, {
      mint: USDC,
      owner: revenue,
      amount: 5_000_000n,
      programId: TOKEN_PROGRAM_ID,
    });
    const job = t.job({
      convert: async () => {
        throw new Error('must not be called on devnet');
      },
    });
    const report = await job.runOnce();
    expect(report.status).toBe('ran');
    expect(t.alerter.alerts).toMatchObject([
      {
        level: 'normal',
        code: 'revenue_unconvertible_balance',
        details: { mint: USDC.toBase58(), amount: '5000000' },
      },
    ]);
    expect(t.chain.tokenAmount(usdcAccount)).toBe(5_000_000n);
    expect(t.chain.tokenAmount(t.referral)).toBe(0n);
    expect(t.logger.lines.some((l) => l.msg.includes('no Jupiter on this cluster'))).toBe(true);
  });

  it('on mainnet books the conversion output by mint: claim mints as Jupiter referral, others as other', async () => {
    const t = setup({ cluster: 'mainnet-beta', config: { minForwardLamports: 10n * SOL } });
    const other = randomAddress();
    t.chain.addTokenAccount(randomAddress(), {
      mint: USDC,
      owner: revenue,
      amount: 5_000_000n,
      programId: TOKEN_PROGRAM_ID,
    });
    t.chain.addTokenAccount(randomAddress(), {
      mint: other,
      owner: revenue,
      amount: 9n,
      programId: TOKEN_PROGRAM_ID,
    });
    let calls = 0;
    const summary: ConvertRunSummary = {
      status: 'ran',
      mode: 'live',
      modeReason: 'test',
      window: '1',
      items: [
        {
          owner: revenue.toBase58(),
          mint: USDC.toBase58(),
          amount: 5_000_000n,
          outcome: { status: 'confirmed', signature: 'sigUSDC', outAmount: 30_000_000n },
        },
        {
          owner: revenue.toBase58(),
          mint: other.toBase58(),
          amount: 9n,
          outcome: { status: 'confirmed', signature: 'sigOTHER', outAmount: 10_000_000n },
        },
        {
          owner: revenue.toBase58(),
          mint: NATIVE_MINT.toBase58(),
          amount: 1n,
          outcome: { status: 'skipped', reason: 'already_sol' },
        },
      ],
    };
    const job = t.job({
      convert: async () => {
        calls++;
        // The swaps landed: native SOL grew by the two outputs minus their fees.
        t.chain.setBalance(revenue, t.chain.balanceOf(revenue) + 40_000_000n - 10_000n);
        return summary;
      },
    });
    await job.runOnce();
    expect(calls).toBe(1);
    expect(await t.pending()).toEqual({
      meteora_referral: 0n,
      jupiter_referral: 29_992_500n,
      platform_fee: 0n,
      other: 9_997_500n,
    });
    expect((await t.state()).relatedSignatures).toEqual(['sigUSDC', 'sigOTHER']);
    // Dry run: the conversion is not called either.
    const dry = t.job({
      config: { ...t.config, dryRun: true },
      convert: async () => {
        calls++;
        return summary;
      },
    });
    await dry.runOnce();
    expect(calls).toBe(1);
  });

  it('alerts when the referral account is not held by the wallet, and when the wallet cannot pay the unwrap rent', async () => {
    const t = setup({
      otherWsol: 30_000_000n,
      noReferral: true,
      native: 1_000n,
      config: { minForwardLamports: 10n * SOL },
    });
    const report = await t.job().runOnce();
    expect(report.status).toBe('ran');
    expect(t.alerter.codes()).toEqual(['revenue_referral_not_owned', 'revenue_low_balance']);
    expect(t.chain.tokenAmount(t.ownWsol)).toBe(30_000_000n);
    expect(t.chain.sendAttempts).toEqual([]);
  });

  it('leaves dust wrapped and reports a failed unwrap without touching the accounts', async () => {
    const t = setup({ referralWsol: 500_000n, config: { minForwardLamports: 10n * SOL } });
    await t.job().runOnce();
    expect(t.chain.tokenAmount(t.referral)).toBe(500_000n);
    expect(t.chain.sendAttempts).toEqual([]);
    const u = setup({ referralWsol: 30_000_000n, config: { minForwardLamports: 10n * SOL } });
    u.chain.behaviors.push('fail_onchain');
    const report = await u.job().runOnce();
    expect(report.outcome).toMatchObject({ result: 'failed', kind: 'unwrap' });
    expect(u.alerter.codes()).toEqual(['revenue_unwrap_failed']);
    expect(u.chain.tokenAmount(u.referral)).toBe(30_000_000n);
    expect((await u.state()).inFlight).toBeNull();
  });

  it('runs once at a time', async () => {
    const t = setup();
    const job = t.job();
    const [a, b] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect([a.status, b.status].sort()).toEqual(['busy', 'ran']);
  });

  // The Swap API V2 build with `wrapAndUnwrapSol` closes the taker's associated WSOL account in
  // its cleanup: the account where the Jupiter referral claims land. The unwrap must come first.
  describe('with conversions that close the Jupiter claims account', () => {
    function mainnet(options: SetupOptions = {}) {
      const t = setup({ cluster: 'mainnet-beta', ...options });
      const usdcAccount = randomAddress();
      t.chain.addTokenAccount(usdcAccount, {
        mint: USDC,
        owner: revenue,
        amount: FIXTURE_IN_AMOUNT,
        programId: TOKEN_PROGRAM_ID,
      });
      return { ...t, usdcAccount, tokenRent: t.chain.rentExempt(ACCOUNT_SIZE) };
    }
    const forwarded = (report: { outcome?: RevenueOutcome }) =>
      report.outcome as Extract<RevenueOutcome, { result: 'forwarded' }>;

    it('unwraps before the conversions, so the swap only returns the rent, and still forwards with the sources attributed', async () => {
      const t = mainnet({ referralWsol: 30_000_000n, otherWsol: 10_000_000n });
      let swapSignature = '';
      const job = t.job({
        convert: async () => {
          // The unwrap landed before the conversion: both WSOL accounts are empty but exist.
          expect(t.chain.tokenAmount(t.referral)).toBe(0n);
          expect(t.chain.tokenAmount(t.ownWsol)).toBe(0n);
          swapSignature = await fixtureShapedSwap(t, t.usdcAccount);
          return conversionSummary([usdcConversion(swapSignature)]);
        },
      });
      const report = await job.runOnce();
      expect(report.status).toBe('ran');
      expect(report.outcome?.result).toBe('forwarded');
      const outcome = forwarded(report);
      // Landed in this order: the unwrap, the swap, the forward.
      expect([...t.chain.landed.keys()]).toEqual([t.announced[0], swapSignature, t.announced[1]]);
      // The swap's cleanup closed the claims account; the referral account remains, emptied.
      expect(t.chain.tokenAccounts.has(t.ownWsol.toBase58())).toBe(false);
      expect(t.chain.tokenAmount(t.referral)).toBe(0n);
      expect(t.chain.tokenAmount(t.usdcAccount)).toBe(0n);
      // Forwarded: the native balance, the unwrapped WSOL, the swap output and the closed
      // account's rent, less the unwrap and swap fees and the floor.
      const expectedAmount =
        t.native + 40_000_000n + FIXTURE_OUT_AMOUNT + t.tokenRent - 10_000n - t.floor;
      expect(outcome.lamports).toBe(expectedAmount);
      expect(t.chain.receivedBy(t.vault)).toBe(expectedAmount);
      // Attribution: the unwrapped amounts by account, the swap output net of its fee as
      // Jupiter referral (USDC is a claim mint), the returned rent and the first run's balance
      // as other.
      const swapOutput = FIXTURE_OUT_AMOUNT - 5_000n;
      expect(outcome.breakdown).toEqual({
        meteora_referral: 30_000_000n,
        jupiter_referral: 10_000_000n + swapOutput,
        platform_fee: 0n,
        other: expectedAmount - 40_000_000n - swapOutput,
      });
      expect(outcome.breakdown.other).toBeGreaterThanOrEqual(t.tokenRent);
      const entry = (await t.forwards.list())[0]!.value;
      expect(entry.relatedSignatures).toEqual([t.announced[0], swapSignature]);
      expect(t.alerter.codes()).toEqual([]);
    });

    it('after a crash between the unwrap and the conversions, the next run converts and forwards without a second unwrap', async () => {
      const t = mainnet({ referralWsol: 30_000_000n, otherWsol: 10_000_000n });
      const crashed = await t
        .job({
          convert: async () => {
            throw new Error('process died');
          },
        })
        .runOnce();
      expect(crashed.status).toBe('error');
      expect(crashed.reason).toMatch(/process died/);
      // The unwrap had landed and was booked before the crash: nothing in flight, the amounts
      // pending by source, the accounts emptied but kept.
      expect((await t.state()).inFlight).toBeNull();
      expect(await t.pending()).toEqual({
        meteora_referral: 30_000_000n,
        jupiter_referral: 10_000_000n,
        platform_fee: 0n,
        other: 0n,
      });
      expect(t.chain.tokenAmount(t.referral)).toBe(0n);
      expect(t.chain.tokenAmount(t.ownWsol)).toBe(0n);
      expect(t.alerter.codes()).toEqual(['revenue_run_failed']);
      // Restart: nothing to unwrap, the conversion closes the empty claims account, then the
      // forward, with the same attribution as an uninterrupted run.
      let swapSignature = '';
      const report = await t
        .job({
          convert: async () => {
            swapSignature = await fixtureShapedSwap(t, t.usdcAccount);
            return conversionSummary([usdcConversion(swapSignature)]);
          },
        })
        .runOnce();
      expect(report.outcome?.result).toBe('forwarded');
      const outcome = forwarded(report);
      expect(t.announced).toHaveLength(2);
      expect([...t.chain.landed.keys()]).toEqual([t.announced[0], swapSignature, t.announced[1]]);
      const expectedAmount =
        t.native + 40_000_000n + FIXTURE_OUT_AMOUNT + t.tokenRent - 10_000n - t.floor;
      const swapOutput = FIXTURE_OUT_AMOUNT - 5_000n;
      expect(outcome.lamports).toBe(expectedAmount);
      expect(outcome.breakdown).toEqual({
        meteora_referral: 30_000_000n,
        jupiter_referral: 10_000_000n + swapOutput,
        platform_fee: 0n,
        other: expectedAmount - 40_000_000n - swapOutput,
      });
      expect((await t.forwards.list())[0]!.value.relatedSignatures).toEqual([
        t.announced[0],
        swapSignature,
      ]);
    });

    it('books the wrapped SOL a closed account still held to its source, and the rent as other', async () => {
      // Dust below the unwrap minimum stays in the claims account; the swap closes it anyway.
      const t = mainnet({ otherWsol: 500_000n, config: { minForwardLamports: 10n * SOL } });
      let swapSignature = '';
      await t
        .job({
          convert: async () => {
            expect(t.chain.tokenAmount(t.ownWsol)).toBe(500_000n);
            swapSignature = await fixtureShapedSwap(t, t.usdcAccount);
            return conversionSummary([usdcConversion(swapSignature)]);
          },
        })
        .runOnce();
      expect(t.chain.sendAttempts).toEqual([swapSignature]);
      expect(t.chain.tokenAccounts.has(t.ownWsol.toBase58())).toBe(false);
      expect(await t.pending()).toEqual({
        meteora_referral: 0n,
        jupiter_referral: 500_000n + FIXTURE_OUT_AMOUNT - 5_000n,
        platform_fee: 0n,
        other: t.tokenRent,
      });
      expect((await t.state()).expectedNativeLamports).toBe(t.chain.balanceOf(revenue).toString());
    });

    it('books a swap of unknown outcome that landed as other, with its signature', async () => {
      const t = mainnet({ otherWsol: 0n, config: { minForwardLamports: 10n * SOL } });
      let swapSignature = '';
      await t
        .job({
          convert: async () => {
            swapSignature = await fixtureShapedSwap(t, t.usdcAccount);
            return conversionSummary([
              {
                ...usdcConversion(swapSignature),
                outcome: { status: 'unknown', signature: swapSignature },
              },
            ]);
          },
        })
        .runOnce();
      expect(await t.pending()).toEqual({
        meteora_referral: 0n,
        jupiter_referral: 0n,
        platform_fee: 0n,
        other: FIXTURE_OUT_AMOUNT + t.tokenRent - 5_000n,
      });
      expect((await t.state()).relatedSignatures).toEqual([swapSignature]);
      expect(t.alerter.codes()).toEqual([]);
    });
  });
});

describe('createRevenueForwardReader', () => {
  it('lists forwards from a date, oldest first, and sums them with their breakdown', async () => {
    const forwards = createMemoryJournal(RevenueForwardEntry);
    const entry = (
      signature: string,
      finalizedAt: string,
      lamports: bigint,
      meteora: bigint,
    ): RevenueForwardEntry => ({
      v: 1,
      signature,
      lamports: lamports.toString(),
      sentAt: finalizedAt,
      finalizedAt,
      breakdown: {
        meteora_referral: meteora.toString(),
        jupiter_referral: '0',
        platform_fee: (lamports - meteora).toString(),
        other: '0',
      },
      relatedSignatures: [],
    });
    await forwards.put('sigB', entry('sigB', '2026-10-02T00:00:00.000Z', 300n, 100n));
    await forwards.put('sigA', entry('sigA', '2026-10-01T00:00:00.000Z', 200n, 50n));
    await forwards.put('sigC', entry('sigC', '2026-10-03T12:00:00.000Z', 1_000n, 1_000n));
    const reader = createRevenueForwardReader(forwards);
    expect((await reader.list()).map((e) => e.signature)).toEqual(['sigA', 'sigB', 'sigC']);
    expect(
      (await reader.list({ since: '2026-10-02T00:00:00.000Z' })).map((e) => e.signature),
    ).toEqual(['sigB', 'sigC']);
    expect(await reader.totalForwardedSince('2026-10-02T00:00:00.000Z')).toEqual({
      lamports: 1_300n,
      count: 2,
      breakdown: { meteora_referral: 1_100n, jupiter_referral: 0n, platform_fee: 200n, other: 0n },
    });
    expect(await reader.totalForwardedSince('2027-01-01T00:00:00.000Z')).toEqual({
      lamports: 0n,
      count: 0,
      breakdown: zeroBreakdown(),
    });
    await expect(reader.totalForwardedSince('yesterday')).rejects.toThrow(/ISO 8601/);
  });

  it('reads a directory of journal files', async () => {
    const reader = createRevenueForwardReader(path.join(dir, 'journal'));
    expect(await reader.list()).toEqual([]);
  });
});
