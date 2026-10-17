/**
 * Revenue wallet job (docs/DECISIONS.md D34, docs/OPERATIONS.md "Automatic tasks",
 * docs/INTERFACES.md "Revenue forwards").
 *
 * The revenue wallet (FORGE_REVENUE_WALLET, keystore role `revenue`) is where the non-native
 * trading revenue lands: the 0.3% platform fee (native SOL, FORGE_PLATFORM_FEE_WALLET is that
 * wallet), the Meteora referral fees (wrapped SOL in FORGE_METEORA_REFERRAL_ACCOUNT, a token
 * account it holds) and the Jupiter referral claims (wrapped SOL, USDC or any other currency
 * Jupiter collected in, in its token accounts). The vault cannot unwrap or swap a token without
 * a multisig signature, so this job does it with the hot key, then forwards native SOL to the
 * vault (D8: the buyback budget). Every run:
 *
 *   1. settles the transaction in flight, if any (one at a time, never replaced while it may
 *      still land), and refuses to plan on top of an unfinalized forward or unwrap this journal
 *      does not know about (another instance, a lost journal);
 *   2. reads the native balance and reconciles it with the journal: a native inflow since the
 *      last run is the platform fee (the only native stream into this wallet), an unexplained
 *      drop beyond the job's own fees is alerted (`revenue_unexpected_outflow`);
 *   3. converts the non-SOL balances to SOL with the conversion machinery of jobs/convert.ts
 *      (Jupiter, mainnet-beta only, same policy, same `convert_paused` switch and live flag);
 *      on devnet, where Jupiter does not index anything, the swaps are skipped with a log line;
 *   4. unwraps the wrapped SOL: one transaction creates an ephemeral WSOL account (seeded from
 *      the wallet, no extra signer), moves every WSOL balance into it and closes it to the wallet,
 *      so the referral account itself (referenced by every swap) is never closed;
 *   5. forwards the native SOL above the reserve (rent + SIGNER_REVENUE_RESERVE_LAMPORTS +
 *      fee buffer) to FORGE_MULTISIG_VAULT, in one policy-checked transfer, when it reaches
 *      SIGNER_REVENUE_MIN_FORWARD_LAMPORTS, and records it in the append-only forward journal
 *      (`revenue-forward.<signature>.json`) with a breakdown by source.
 *
 * Source breakdown. The journal keeps, per source, the gross lamports received since the last
 * forward: `meteora_referral` (WSOL unwrapped from FORGE_METEORA_REFERRAL_ACCOUNT),
 * `jupiter_referral` (WSOL unwrapped from the wallet's other accounts and the output of the
 * conversions of the Jupiter claim mints, SIGNER_JUPITER_CLAIMS_MINTS), `platform_fee` (native
 * SOL received directly) and `other` (conversions of any other mint, and what a forward cannot
 * explain, e.g. the first run's balance). The job's own network fees are not booked: a forward's
 * breakdown is the pending buckets, scaled down proportionally when they exceed the forwarded
 * amount (fees, reserve; largest remainder, so it sums exactly), the remainder booked as `other`
 * when they fall short; then the buckets are reset.
 *
 * Crash recovery. The state journal is written before every broadcast (signature + signed
 * bytes), so a restart settles the transaction first and never signs a second one. A forward is
 * written to the forward journal when it is seen FINALIZED, keyed by its signature: writing it
 * twice is the same entry, and a forward whose finalization was observed but not recorded is
 * recorded by the next run. Nothing is ever deleted from the forward journal.
 *
 * Policy (TX_POLICY before anything is signed): the forward is exactly one System transfer from
 * the revenue wallet to the vault with the memo, optional bounded compute budget, fee payer and
 * only signer the wallet (`assertSolTransferTx`). The unwrap is exactly: System
 * `createAccountWithSeed` of the ephemeral account (base = the wallet, the expected seed, the
 * rent of a token account, 165 bytes, owned by the SPL Token program), SPL Token
 * `InitializeAccount3` of that account for wrapped SOL owned by the wallet, one SPL Token
 * `Transfer` per expected source account (held by the wallet, the exact amount read) into it,
 * one `CloseAccount` of it to the wallet, the memo, optional bounded compute budget; nothing else
 * (`assertRevenueUnwrapTx`). Kill switches: env SIGNER_REVENUE_PAUSED and the `revenue_paused`
 * flag (migration 0016), fail closed, read before the run, and again right before each signature.
 * Dry run (SIGNER_REVENUE_DRY_RUN, true by default): reads, plans and logs, signs nothing.
 */
import {
  ACCOUNT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
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
import { z } from 'zod';
import { OPS } from '@forge/shared';
import type { SignerCore } from '../core-adapter.js';
import { planSweep } from './cashbox.js';
import type { ConvertRunSummary } from './convert.js';
import { parseJupiterClaimMints } from './jupiter-claims.js';
import type { PriorityFees } from './priority.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  JOB_FLAGS,
  JobError,
  MEMO_PROGRAM_ID,
  alertAbnormalPause,
  assertSolTransferTx,
  awaitSettlement,
  broadcast,
  assertComputeBudgetSet,
  checkComputeBudget,
  checkPaused,
  checkSettlement,
  createAnnouncer,
  createFileJournal,
  describeError,
  formatSol,
  parseBoolEnv,
  parseLamportsEnv,
  parsePositiveIntEnv,
  realSleep,
  requireRoleRef,
  requiredSigners,
  rpcFromConnection,
  sendAlert,
  signWithKeystore,
  spendableBalance,
  withRetry,
  type BeforeSendHook,
  type FlagsReader,
  type JobAlerter,
  type JobLogger,
  type Journal,
  type KeystoreLike,
  type RetryOptions,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';

// ---------------------------------------------------------------------------------------
// Sources and breakdowns

export const REVENUE_SOURCES = [
  'meteora_referral',
  'jupiter_referral',
  'platform_fee',
  'other',
] as const;
export type RevenueSource = (typeof REVENUE_SOURCES)[number];

/** Lamports per source. */
export type RevenueBreakdown = Record<RevenueSource, bigint>;

const lamportsString = z.string().regex(/^[0-9]{1,20}$/);

export const RevenueBreakdownEntry = z.object({
  meteora_referral: lamportsString,
  jupiter_referral: lamportsString,
  platform_fee: lamportsString,
  other: lamportsString,
});
export type RevenueBreakdownEntry = z.infer<typeof RevenueBreakdownEntry>;

export function zeroBreakdown(): RevenueBreakdown {
  return { meteora_referral: 0n, jupiter_referral: 0n, platform_fee: 0n, other: 0n };
}

export function breakdownToEntry(b: RevenueBreakdown): RevenueBreakdownEntry {
  return {
    meteora_referral: b.meteora_referral.toString(),
    jupiter_referral: b.jupiter_referral.toString(),
    platform_fee: b.platform_fee.toString(),
    other: b.other.toString(),
  };
}

export function breakdownFromEntry(e: RevenueBreakdownEntry): RevenueBreakdown {
  return {
    meteora_referral: BigInt(e.meteora_referral),
    jupiter_referral: BigInt(e.jupiter_referral),
    platform_fee: BigInt(e.platform_fee),
    other: BigInt(e.other),
  };
}

export function sumBreakdown(b: RevenueBreakdown): bigint {
  return REVENUE_SOURCES.reduce((total, s) => total + b[s], 0n);
}

/**
 * Pure: splits `total` over `weights` proportionally, in whole lamports, with the largest
 * remainder method so the shares sum to exactly `total`. With no positive weight, everything goes
 * to the last index.
 */
export function splitProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new JobError('INVALID_AMOUNT', 'total is negative');
  if (weights.length === 0) throw new JobError('INVALID_AMOUNT', 'no weights');
  for (const w of weights) if (w < 0n) throw new JobError('INVALID_AMOUNT', 'weight is negative');
  const sum = weights.reduce((a, w) => a + w, 0n);
  const shares = weights.map(() => 0n);
  if (sum === 0n) {
    shares[shares.length - 1] = total;
    return shares;
  }
  const remainders: Array<{ index: number; remainder: bigint }> = [];
  let distributed = 0n;
  weights.forEach((w, index) => {
    const exact = total * w;
    shares[index] = exact / sum;
    distributed += shares[index]!;
    remainders.push({ index, remainder: exact % sum });
  });
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (let left = total - distributed, i = 0; left > 0n; left--, i++) {
    shares[remainders[i % remainders.length]!.index]! += 1n;
  }
  return shares;
}

/**
 * Pure: the breakdown of a forward of `lamports` from the pending gross amounts per source:
 * the buckets as they are plus the unexplained remainder as `other` when they fall short, scaled
 * down proportionally when they exceed it (fees, reserve). Sums to exactly `lamports`.
 */
export function forwardBreakdown(pending: RevenueBreakdown, lamports: bigint): RevenueBreakdown {
  if (lamports < 0n) throw new JobError('INVALID_AMOUNT', 'lamports is negative');
  const total = sumBreakdown(pending);
  if (total <= lamports) return { ...pending, other: pending.other + (lamports - total) };
  const shares = splitProportionally(
    lamports,
    REVENUE_SOURCES.map((s) => pending[s]),
  );
  const out = zeroBreakdown();
  REVENUE_SOURCES.forEach((s, i) => {
    out[s] = shares[i]!;
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// Journals

export const REVENUE_STATE_KEY = 'state';
export const REVENUE_JOURNAL_NAMESPACE = 'revenue';
export const REVENUE_FORWARD_NAMESPACE = 'revenue-forward';
export const FORWARD_MEMO = 'forge:revenue-forward';
export const UNWRAP_MEMO = 'forge:revenue-unwrap';
/** Recent signatures scanned for an unfinalized forward or unwrap before planning a new one. */
export const REVENUE_SCAN_LIMIT = 25;
/** Most unwrap and conversion signatures remembered for the next forward's entry. */
const MAX_RELATED_SIGNATURES = 50;

const InFlightBase = {
  signature: z.string(),
  rawTx: z.string(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  startedAt: z.string(),
};

export const RevenueStateEntry = z.object({
  v: z.literal(1),
  /** Native balance after the last accounting; null before the first observation. */
  expectedNativeLamports: lamportsString.nullable(),
  /** Gross lamports received per source since the last forward. */
  pending: RevenueBreakdownEntry,
  /** Unwrap and conversion signatures since the last forward (bounded). */
  relatedSignatures: z.array(z.string()),
  inFlight: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('unwrap'),
        ...InFlightBase,
        /** Amounts moved out of each source's WSOL accounts. */
        sources: RevenueBreakdownEntry,
      }),
      z.object({
        kind: z.literal('forward'),
        ...InFlightBase,
        lamports: lamportsString,
        breakdown: RevenueBreakdownEntry,
      }),
    ])
    .nullable(),
  lastForward: z
    .object({ signature: z.string(), lamports: lamportsString, at: z.string() })
    .nullable(),
});
export type RevenueStateEntry = z.infer<typeof RevenueStateEntry>;

/**
 * One finalized forward to the vault (`revenue-forward.<signature>.json`, append-only). This is
 * what the buyback budget reads (docs/INTERFACES.md "Revenue forwards").
 */
export const RevenueForwardEntry = z.object({
  v: z.literal(1),
  /** Signature of the forward transaction (also the file key). */
  signature: z.string(),
  /** Lamports received by the vault. */
  lamports: lamportsString,
  /** ISO 8601, when the transfer was sent. */
  sentAt: z.string(),
  /** ISO 8601, when the signer saw it finalized. Entries are ordered by it. */
  finalizedAt: z.string(),
  /** Lamports per source; the four values sum to `lamports`. */
  breakdown: RevenueBreakdownEntry,
  /** Unwrap and conversion signatures that fed this forward since the previous one. */
  relatedSignatures: z.array(z.string()),
});
export type RevenueForwardEntry = z.infer<typeof RevenueForwardEntry>;

export function createRevenueStateJournal(dir: string): Journal<RevenueStateEntry> {
  return createFileJournal({
    dir,
    namespace: REVENUE_JOURNAL_NAMESPACE,
    schema: RevenueStateEntry,
  });
}

export function createRevenueForwardJournal(dir: string): Journal<RevenueForwardEntry> {
  return createFileJournal({
    dir,
    namespace: REVENUE_FORWARD_NAMESPACE,
    schema: RevenueForwardEntry,
  });
}

export interface RevenueForwardTotals {
  lamports: bigint;
  count: number;
  breakdown: RevenueBreakdown;
}

/** Read side of the forward journal, for the buyback budget (slice S2). */
export interface RevenueForwardReader {
  /** Every forward finalized at or after `since` (ISO 8601; all when absent), oldest first. */
  list(options?: { since?: string }): Promise<RevenueForwardEntry[]>;
  /** Lamports forwarded to the vault at or after `since`, with their breakdown. */
  totalForwardedSince(since: string): Promise<RevenueForwardTotals>;
}

/** Sums entries (pure). */
export function totalsOf(entries: readonly RevenueForwardEntry[]): RevenueForwardTotals {
  const breakdown = zeroBreakdown();
  let lamports = 0n;
  for (const e of entries) {
    lamports += BigInt(e.lamports);
    const b = breakdownFromEntry(e.breakdown);
    for (const s of REVENUE_SOURCES) breakdown[s] += b[s];
  }
  return { lamports, count: entries.length, breakdown };
}

function parseIso(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new JobError('CONFIG', `${what} is not an ISO 8601 date`);
  return ms;
}

export function createRevenueForwardReader(
  journal: Journal<RevenueForwardEntry> | string,
): RevenueForwardReader {
  const forwards = typeof journal === 'string' ? createRevenueForwardJournal(journal) : journal;
  const list = async (options: { since?: string } = {}): Promise<RevenueForwardEntry[]> => {
    const sinceMs = options.since === undefined ? null : parseIso(options.since, 'since');
    const entries = (await forwards.list())
      .map((x) => x.value)
      .filter((e) => sinceMs === null || parseIso(e.finalizedAt, 'finalizedAt') >= sinceMs);
    return entries.sort((a, b) => {
      const d = parseIso(a.finalizedAt, 'finalizedAt') - parseIso(b.finalizedAt, 'finalizedAt');
      return d !== 0 ? d : a.signature.localeCompare(b.signature);
    });
  };
  return {
    list,
    async totalForwardedSince(since) {
      return totalsOf(await list({ since }));
    },
  };
}

// ---------------------------------------------------------------------------------------
// Unwrap transaction (pure build and policy)

export interface UnwrapSource {
  /** A wrapped SOL token account held by the revenue wallet. */
  account: PublicKey;
  /** Raw units (= lamports) to move out of it: its balance when it was read. */
  amount: bigint;
}

export interface RevenueUnwrapParams {
  /** The revenue wallet: fee payer, only signer, authority of every account. */
  owner: PublicKey;
  /** `PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID)`, computed by the caller. */
  ephemeral: PublicKey;
  seed: string;
  /** Rent-exempt minimum of a token account (165 bytes), read from the cluster. */
  rentLamports: bigint;
  sources: readonly UnwrapSource[];
  memo: string;
  /** Compute unit price (the job prices it with `PriorityFees`); 0 adds no compute budget. */
  computeUnitPriceMicroLamports?: number;
}

/** Compute units requested when a priority fee is set: the fixed part plus one per transfer. */
export const UNWRAP_BASE_COMPUTE_UNITS = 40_000;
export const UNWRAP_COMPUTE_UNITS_PER_TRANSFER = 6_000;

/** Compute unit limit of an unwrap of `sources` accounts. */
export function unwrapComputeUnits(sources: number): number {
  return UNWRAP_BASE_COMPUTE_UNITS + UNWRAP_COMPUTE_UNITS_PER_TRANSFER * sources;
}
export const FORWARD_COMPUTE_UNITS = 30_000;
/** Most WSOL accounts unwrapped in one transaction (size and compute bounds). */
export const MAX_UNWRAP_SOURCES = 8;
/** Seed of the ephemeral account: `unwrap-` plus 16 hex characters (at most 32 bytes). */
export const UNWRAP_SEED_RE = /^unwrap-[0-9a-f]{16}$/;

const TOKEN_IX = { transfer: 3, closeAccount: 9, initializeAccount3: 18 } as const;

function computeBudgetIxs(units: number, price: number | undefined): TransactionInstruction[] {
  if (!price || price <= 0) return [];
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
  ];
}

/**
 * Pure: the unwrap transaction (SPL Token program layouts: InitializeAccount3 = u8 18 + owner,
 * Transfer = u8 3 + u64 amount, CloseAccount = u8 9). The caller sets the blockhash.
 */
export function buildRevenueUnwrapTx(p: RevenueUnwrapParams): Transaction {
  if (!UNWRAP_SEED_RE.test(p.seed)) throw new JobError('CONFIG', 'invalid unwrap seed');
  if (p.sources.length === 0 || p.sources.length > MAX_UNWRAP_SOURCES) {
    throw new JobError('INVALID_AMOUNT', 'between 1 and 8 WSOL accounts per unwrap');
  }
  if (p.rentLamports <= 0n) throw new JobError('INVALID_AMOUNT', 'rent must be positive');
  const tx = new Transaction();
  for (const ix of computeBudgetIxs(
    unwrapComputeUnits(p.sources.length),
    p.computeUnitPriceMicroLamports,
  )) {
    tx.add(ix);
  }
  tx.add(
    SystemProgram.createAccountWithSeed({
      fromPubkey: p.owner,
      basePubkey: p.owner,
      seed: p.seed,
      newAccountPubkey: p.ephemeral,
      lamports: Number(p.rentLamports),
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  tx.add(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: p.ephemeral, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([TOKEN_IX.initializeAccount3]), p.owner.toBuffer()]),
    }),
  );
  for (const source of p.sources) {
    if (source.amount <= 0n) throw new JobError('INVALID_AMOUNT', 'unwrap amount must be positive');
    const data = Buffer.alloc(9);
    data.writeUInt8(TOKEN_IX.transfer, 0);
    data.writeBigUInt64LE(source.amount, 1);
    tx.add(
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: source.account, isSigner: false, isWritable: true },
          { pubkey: p.ephemeral, isSigner: false, isWritable: true },
          { pubkey: p.owner, isSigner: true, isWritable: false },
        ],
        data,
      }),
    );
  }
  tx.add(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: p.ephemeral, isSigner: false, isWritable: true },
        { pubkey: p.owner, isSigner: false, isWritable: true },
        { pubkey: p.owner, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([TOKEN_IX.closeAccount]),
    }),
  );
  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(p.memo, 'utf8'),
    }),
  );
  return tx;
}

export interface RevenueUnwrapExpectation {
  owner: PublicKey;
  ephemeral: PublicKey;
  seed: string;
  rentLamports: bigint;
  sources: readonly UnwrapSource[];
  memo: string;
}

function policy(rule: string): never {
  throw new JobError('TX_POLICY', rule);
}

/**
 * Unwrap policy: fee payer and only required signer = the wallet; in order: optional bounded
 * compute budget, the exact `createAccountWithSeed`, `InitializeAccount3` (wrapped SOL, owner =
 * the wallet), one `Transfer` per expected source (each once, exact amount, into the ephemeral
 * account, authority = the wallet), `CloseAccount` of the ephemeral account to the wallet by the
 * wallet, the memo. No other instruction, program or account.
 */
export function assertRevenueUnwrapTx(tx: Transaction, e: RevenueUnwrapExpectation): void {
  if (!tx.feePayer?.equals(e.owner)) policy('unexpected fee payer');
  if (!tx.recentBlockhash) policy('missing recent blockhash');
  for (const s of requiredSigners(tx)) if (!s.equals(e.owner)) policy('unexpected required signer');
  if (e.sources.length === 0) policy('no source account');
  if (e.ephemeral.equals(e.owner)) policy('ephemeral account is the wallet');
  for (const s of e.sources)
    if (s.account.equals(e.ephemeral)) policy('source is the ephemeral account');

  const key = (ix: TransactionInstruction, i: number): PublicKey => {
    const meta = ix.keys[i];
    if (!meta) policy('instruction is missing accounts');
    return meta.pubkey;
  };
  // Instructions must come in this order: compute budget (optional), create, initialize,
  // transfers, close, memo, then nothing.
  let stage: 'create' | 'initialize' | 'transfer' | 'memo' | 'done' = 'create';
  const transferred = new Set<string>();
  for (const ix of tx.instructions) {
    const data = Buffer.from(ix.data);
    if (stage === 'done') policy('instruction after the memo');
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (stage !== 'create') policy('compute budget after the first instruction');
      checkComputeBudget(ix);
      continue;
    }
    if (ix.programId.equals(SystemProgram.programId)) {
      if (stage !== 'create') policy('system instruction out of place');
      let created;
      try {
        created = SystemInstruction.decodeCreateWithSeed(ix);
      } catch {
        policy('system instruction other than createAccountWithSeed');
      }
      if (
        !created.fromPubkey.equals(e.owner) ||
        !created.basePubkey.equals(e.owner) ||
        !created.newAccountPubkey.equals(e.ephemeral) ||
        created.seed !== e.seed ||
        BigInt(created.lamports) !== e.rentLamports ||
        created.space !== ACCOUNT_SIZE ||
        !created.programId.equals(TOKEN_PROGRAM_ID)
      ) {
        policy('unexpected ephemeral account creation');
      }
      stage = 'initialize';
      continue;
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      if (stage === 'initialize') {
        if (data.length !== 33 || data[0] !== TOKEN_IX.initializeAccount3)
          policy('expected InitializeAccount3');
        if (!key(ix, 0).equals(e.ephemeral)) policy('initialize of an unexpected account');
        if (!key(ix, 1).equals(NATIVE_MINT)) policy('ephemeral account is not wrapped SOL');
        if (!new PublicKey(data.subarray(1, 33)).equals(e.owner))
          policy('ephemeral account owner is not the wallet');
        stage = 'transfer';
        continue;
      }
      if (stage === 'transfer' && data.length === 9 && data[0] === TOKEN_IX.transfer) {
        const source = key(ix, 0);
        const expected = e.sources.find((s) => s.account.equals(source));
        if (!expected) policy('transfer from an unexpected account');
        if (transferred.has(source.toBase58())) policy('source transferred twice');
        if (!key(ix, 1).equals(e.ephemeral)) policy('transfer to an unexpected account');
        if (!key(ix, 2).equals(e.owner)) policy('unexpected transfer authority');
        if (data.readBigUInt64LE(1) !== expected.amount) policy('transfer amount mismatch');
        transferred.add(source.toBase58());
        continue;
      }
      if (stage === 'transfer' && data.length === 1 && data[0] === TOKEN_IX.closeAccount) {
        if (transferred.size !== e.sources.length) policy('expected source not transferred');
        if (!key(ix, 0).equals(e.ephemeral)) policy('close of an unexpected account');
        if (!key(ix, 1).equals(e.owner)) policy('account closed to a non-wallet');
        if (!key(ix, 2).equals(e.owner)) policy('unexpected close authority');
        stage = 'memo';
        continue;
      }
      policy('token instruction not allowed');
    }
    if (ix.programId.equals(MEMO_PROGRAM_ID)) {
      if (stage !== 'memo') policy('memo out of place');
      if (ix.keys.length !== 0) policy('memo with signer keys');
      if (data.toString('utf8') !== e.memo) policy('memo mismatch');
      stage = 'done';
      continue;
    }
    policy('program not allowed in an unwrap');
  }
  if (stage !== 'done') policy('unwrap transaction incomplete');
  if (transferred.size !== e.sources.length) policy('expected source not transferred');
  assertComputeBudgetSet(tx.instructions);
}

// ---------------------------------------------------------------------------------------
// Configuration

export const DEFAULT_REVENUE_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL
export const DEFAULT_REVENUE_MIN_FORWARD_LAMPORTS = 10_000_000n; // 0.01 SOL
export const DEFAULT_REVENUE_MIN_UNWRAP_LAMPORTS = 1_000_000n; // 0.001 SOL
export const DEFAULT_REVENUE_OUTFLOW_TOLERANCE_LAMPORTS = 100_000n; // 0.0001 SOL
/** Kept on top of the floor for the forward's own fee (one signature = 5 000 lamports today). */
export const FORWARD_FEE_BUFFER_LAMPORTS = 10_000n;
/** Native lamports the wallet must hold beyond the ephemeral account's rent to pay an unwrap. */
export const UNWRAP_FEE_BUFFER_LAMPORTS = 10_000n;

export interface RevenueConfig {
  /** FORGE_REVENUE_WALLET (= the keystore `revenue` key, checked at startup and before signing). */
  revenue: PublicKey;
  /** FORGE_MULTISIG_VAULT: the only forward destination. */
  vault: PublicKey;
  /** FORGE_METEORA_REFERRAL_ACCOUNT: WSOL account held by the revenue wallet (`meteora_referral`). */
  meteoraReferral: PublicKey;
  /** Mints whose conversion counts as `jupiter_referral` (SIGNER_JUPITER_CLAIMS_MINTS). */
  jupiterClaimMints: readonly PublicKey[];
  /** Kept on the wallet on top of the rent-exempt minimum. */
  reserveLamports: bigint;
  /** Forward only when the excess reaches this amount. */
  minForwardLamports: bigint;
  /** Unwrap only when the wrapped SOL total reaches this amount (fee vs dust). */
  minUnwrapLamports: bigint;
  /** A native drop between two runs beyond this (the job's own fees) raises an alert. */
  outflowToleranceLamports: bigint;
  /**
   * Fixed compute unit price, used only without `RevenueDeps.priorityFees` (the runtime passes
   * the priority fees and 0 here).
   */
  computeUnitPriceMicroLamports: number;
  /** Compute, plan and log only: never sign or send (true by default). */
  dryRun: boolean;
  paused?: boolean;
  settle?: Partial<SettleTiming>;
}

export const DEFAULT_REVENUE_INTERVAL_MS = OPS.claimIntervalHours * 60 * 60_000;

/**
 * SIGNER_REVENUE_RESERVE_LAMPORTS (default 0.01 SOL), SIGNER_REVENUE_MIN_FORWARD_LAMPORTS (default
 * 0.01 SOL), SIGNER_REVENUE_MIN_UNWRAP_LAMPORTS (default 0.001 SOL),
 * SIGNER_REVENUE_OUTFLOW_TOLERANCE_LAMPORTS (default 0.0001 SOL), SIGNER_REVENUE_DRY_RUN (default
 * TRUE: forwarding must be enabled explicitly), SIGNER_REVENUE_INTERVAL_HOURS (default 24),
 * SIGNER_REVENUE_PAUSED (default false); the claim mints from SIGNER_JUPITER_CLAIMS_MINTS and the
 * priority fee from the runtime. Addresses come from @forge/core `requireAddresses`.
 */
export function revenueConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  addresses: {
    revenue: PublicKey;
    vault: PublicKey;
    meteoraReferral: PublicKey;
    computeUnitPriceMicroLamports: number;
  },
): { config: RevenueConfig; intervalMs: number } {
  const config: RevenueConfig = {
    revenue: addresses.revenue,
    vault: addresses.vault,
    meteoraReferral: addresses.meteoraReferral,
    jupiterClaimMints: parseJupiterClaimMints(env.SIGNER_JUPITER_CLAIMS_MINTS).map((m) => m.mint),
    reserveLamports: parseLamportsEnv(
      env.SIGNER_REVENUE_RESERVE_LAMPORTS,
      'SIGNER_REVENUE_RESERVE_LAMPORTS',
      DEFAULT_REVENUE_RESERVE_LAMPORTS,
    ),
    minForwardLamports: parseLamportsEnv(
      env.SIGNER_REVENUE_MIN_FORWARD_LAMPORTS,
      'SIGNER_REVENUE_MIN_FORWARD_LAMPORTS',
      DEFAULT_REVENUE_MIN_FORWARD_LAMPORTS,
    ),
    minUnwrapLamports: parseLamportsEnv(
      env.SIGNER_REVENUE_MIN_UNWRAP_LAMPORTS,
      'SIGNER_REVENUE_MIN_UNWRAP_LAMPORTS',
      DEFAULT_REVENUE_MIN_UNWRAP_LAMPORTS,
    ),
    outflowToleranceLamports: parseLamportsEnv(
      env.SIGNER_REVENUE_OUTFLOW_TOLERANCE_LAMPORTS,
      'SIGNER_REVENUE_OUTFLOW_TOLERANCE_LAMPORTS',
      DEFAULT_REVENUE_OUTFLOW_TOLERANCE_LAMPORTS,
    ),
    computeUnitPriceMicroLamports: addresses.computeUnitPriceMicroLamports,
    dryRun: parseBoolEnv(env.SIGNER_REVENUE_DRY_RUN, 'SIGNER_REVENUE_DRY_RUN', true),
    paused: parseBoolEnv(env.SIGNER_REVENUE_PAUSED, 'SIGNER_REVENUE_PAUSED', false),
  };
  assertRevenueConfig(config);
  return {
    config,
    intervalMs:
      parsePositiveIntEnv(
        env.SIGNER_REVENUE_INTERVAL_HOURS,
        'SIGNER_REVENUE_INTERVAL_HOURS',
        OPS.claimIntervalHours,
      ) *
      60 *
      60_000,
  };
}

/** The wallet, the vault and the referral account are distinct; the thresholds are positive. */
export function assertRevenueConfig(config: RevenueConfig): void {
  if (config.revenue.equals(config.vault)) {
    throw new JobError('CONFIG', 'the revenue wallet and the vault must differ');
  }
  if (
    config.meteoraReferral.equals(config.revenue) ||
    config.meteoraReferral.equals(config.vault)
  ) {
    throw new JobError('CONFIG', 'the Meteora referral account must be its own account');
  }
  if (config.minForwardLamports <= 0n)
    throw new JobError('CONFIG', 'minimum forward must be positive');
  if (config.minUnwrapLamports <= 0n)
    throw new JobError('CONFIG', 'minimum unwrap must be positive');
  if (
    !Number.isInteger(config.computeUnitPriceMicroLamports) ||
    config.computeUnitPriceMicroLamports < 0
  ) {
    throw new JobError('CONFIG', 'invalid compute unit price');
  }
}

// ---------------------------------------------------------------------------------------
// Startup wiring check (runtime.ts)

export interface RevenueWiringInput {
  /** FORGE_REVENUE_WALLET. */
  revenue: PublicKey;
  /** FORGE_PLATFORM_FEE_WALLET. */
  platformFee: PublicKey;
  vault: PublicKey;
  cashbox: PublicKey;
  /** The keystore `revenue` key; null when the keystore has none. */
  revenueKey: PublicKey | null;
  /**
   * Owner of FORGE_METEORA_REFERRAL_ACCOUNT as read on-chain; null when the account is missing
   * or not a token account (reported, not a wiring error: the rent check alerts on it too);
   * undefined when it was not read.
   */
  referralOwner?: PublicKey | null;
}

/**
 * Pure: everything that must hold for the revenue wallet to receive and forward the revenue
 * (variable names only, never values). The runtime refuses to start on mainnet-beta when the list
 * is not empty, and raises a high alert on devnet.
 */
export function revenueWiringProblems(input: RevenueWiringInput): string[] {
  const problems: string[] = [];
  if (!input.revenueKey) problems.push('no revenue key in the keystore (run --init-keys)');
  else if (!input.revenueKey.equals(input.revenue)) {
    problems.push('the keystore revenue key is not FORGE_REVENUE_WALLET');
  }
  if (!input.platformFee.equals(input.revenue)) {
    problems.push(
      'FORGE_PLATFORM_FEE_WALLET is not FORGE_REVENUE_WALLET (the platform fee is revenue, D34)',
    );
  }
  if (input.revenue.equals(input.vault)) problems.push('FORGE_REVENUE_WALLET is the vault');
  if (input.revenue.equals(input.cashbox)) problems.push('FORGE_REVENUE_WALLET is the cashbox');
  if (input.referralOwner && !input.referralOwner.equals(input.revenue)) {
    problems.push('FORGE_METEORA_REFERRAL_ACCOUNT is not held by FORGE_REVENUE_WALLET');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// RPC surface

export interface RevenueTokenAccount {
  address: PublicKey;
  mint: PublicKey;
  /** Raw units. */
  amount: bigint;
  programId: PublicKey;
  frozen: boolean;
}

export interface RevenueRpc extends SolanaRpc {
  /** Every token account (classic and Token-2022) held by `owner`, at finalized commitment. */
  getTokenAccounts(owner: PublicKey): Promise<RevenueTokenAccount[]>;
}

export function createRevenueRpc(connection: Connection): RevenueRpc {
  return {
    ...rpcFromConnection(connection),
    async getTokenAccounts(owner) {
      const out: RevenueTokenAccount[] = [];
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const res = await connection.getParsedTokenAccountsByOwner(
          owner,
          { programId },
          'finalized',
        );
        for (const { pubkey, account } of res.value) {
          const info = (account.data as { parsed?: { info?: unknown } }).parsed?.info as
            { mint?: string; state?: string; tokenAmount?: { amount?: string } } | undefined;
          const amount = info?.tokenAmount?.amount;
          if (!info?.mint || amount === undefined || !/^[0-9]{1,20}$/.test(amount)) continue;
          out.push({
            address: pubkey,
            mint: new PublicKey(info.mint),
            amount: BigInt(amount),
            programId,
            frozen: info.state === 'frozen',
          });
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Job

export interface RevenueDeps {
  rpc: RevenueRpc;
  core: Pick<SignerCore, 'buildSolTransferTx'>;
  keystore: KeystoreLike;
  /** State (`revenue.state.json`). */
  journal: Journal<RevenueStateEntry>;
  /** Append-only forwards (`revenue-forward.<signature>.json`). */
  forwards: Journal<RevenueForwardEntry>;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  config: RevenueConfig;
  cluster: 'devnet' | 'mainnet-beta';
  /**
   * One conversion pass of the wallet's non-SOL balances (jobs/convert.ts `runConvertOnce` over
   * the revenue wallet), mainnet-beta only. Null or absent: no conversion.
   */
  convert?: (() => Promise<ConvertRunSummary>) | null;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Seed of the ephemeral unwrap account (default: random; tests pin it). */
  seed?: () => string;
  /** Called with each signature right before it is (re)broadcast by this process. Required. */
  onBeforeSend: BeforeSendHook;
  /**
   * Priority fees of the unwrap and the forward (SIGNER_PRIORITY_FEE_*, jobs/priority.ts): priced
   * for the accounts each one writes; their cap is kept on the wallet on top of the fee buffers.
   * Absent: the fixed `config.computeUnitPriceMicroLamports`.
   */
  priorityFees?: PriorityFees;
}

export type RevenueOutcome =
  | { result: 'forwarded'; signature: string; lamports: bigint; breakdown: RevenueBreakdown }
  | { result: 'unwrapped'; signature: string; lamports: bigint }
  | { result: 'dry_run'; unwrapLamports: bigint; forwardLamports: bigint; floor: bigint }
  | { result: 'below_reserve'; balance: bigint; floor: bigint }
  | { result: 'below_threshold'; excess: bigint }
  | { result: 'in_flight'; kind: 'unwrap' | 'forward'; signature: string; state: string }
  | { result: 'expired'; kind: 'unwrap' | 'forward'; signature: string }
  | { result: 'failed'; kind: 'unwrap' | 'forward'; signature: string; error: string }
  | { result: 'skipped'; reason: string };

export interface RevenueRunReport {
  status: 'ran' | 'paused' | 'busy' | 'error';
  reason?: string;
  outcome?: RevenueOutcome;
}

export interface RevenueJob {
  runOnce(): Promise<RevenueRunReport>;
}

function randomSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `unwrap-${Buffer.from(bytes).toString('hex')}`;
}

function emptyState(): RevenueStateEntry {
  return {
    v: 1,
    expectedNativeLamports: null,
    pending: breakdownToEntry(zeroBreakdown()),
    relatedSignatures: [],
    inFlight: null,
    lastForward: null,
  };
}

function remember(list: readonly string[], signature: string): string[] {
  const next = [...list.filter((s) => s !== signature), signature];
  return next.length > MAX_RELATED_SIGNATURES ? next.slice(-MAX_RELATED_SIGNATURES) : next;
}

export function createRevenueJob(deps: RevenueDeps): RevenueJob {
  const { rpc, core, keystore, journal, forwards, alerter, logger: log, config } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const newSeed = deps.seed ?? randomSeed;
  const settleTiming = { ...DEFAULT_SETTLE, ...config.settle };
  const priorityFees = deps.priorityFees ?? null;
  /** The compute unit price of a transaction writing `writable`, of `units` CU. */
  const priceOf = async (writable: PublicKey[], units: number): Promise<number> =>
    priorityFees
      ? (await priorityFees.quote(writable, units)).microLamports
      : config.computeUnitPriceMicroLamports;
  /** The most a transaction of `units` CU pays as priority fee. */
  const maxPriorityFee = (units: number): bigint =>
    priorityFees
      ? priorityFees.maxFeeLamports(units)
      : (BigInt(units) * BigInt(config.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n;
  let running = false;

  assertRevenueConfig(config);
  if (deps.cluster !== 'devnet' && deps.cluster !== 'mainnet-beta') {
    throw new JobError('CONFIG', 'cluster must be devnet or mainnet-beta');
  }

  const iso = () => new Date(now()).toISOString();
  const alert = (
    level: 'immediate' | 'high' | 'normal',
    code: string,
    message: string,
    details: Record<string, unknown>,
    dedupKey?: string,
  ) => sendAlert(alerter, log, level, code, message, details, dedupKey);
  const announce = createAnnouncer(deps.onBeforeSend, log);

  const pendingOf = (state: RevenueStateEntry): RevenueBreakdown =>
    breakdownFromEntry(state.pending);
  const expectedOf = (state: RevenueStateEntry): bigint | null =>
    state.expectedNativeLamports === null ? null : BigInt(state.expectedNativeLamports);

  /**
   * Books a native balance observation: an inflow is platform fee; a drop is the job's own fees
   * (not booked) unless it exceeds the tolerance, then it is alerted. The first observation
   * books nothing.
   */
  async function reconcile(
    state: RevenueStateEntry,
    balance: bigint,
    context: string,
  ): Promise<RevenueStateEntry> {
    const expected = expectedOf(state);
    const pending = pendingOf(state);
    if (expected !== null) {
      const delta = balance - expected;
      if (delta > 0n) {
        pending.platform_fee += delta;
      } else if (
        delta < 0n &&
        // The job's own fees: an unwrap at most between two observations, priority fee included.
        -delta >
          config.outflowToleranceLamports + maxPriorityFee(unwrapComputeUnits(MAX_UNWRAP_SOURCES))
      ) {
        await alert(
          'high',
          'revenue_unexpected_outflow',
          'The revenue wallet lost more native SOL than the job can explain by its own fees: check its transactions',
          { context, drop: formatSol(-delta), balance: formatSol(balance) },
          'revenue_unexpected_outflow',
        );
      }
    }
    const next: RevenueStateEntry = {
      ...state,
      expectedNativeLamports: balance.toString(),
      pending: breakdownToEntry(pending),
    };
    await journal.put(REVENUE_STATE_KEY, next);
    return next;
  }

  /** Records a finalized forward (idempotent: keyed by signature) and resets the buckets. */
  async function bookForward(
    state: RevenueStateEntry,
    inFlight: Extract<NonNullable<RevenueStateEntry['inFlight']>, { kind: 'forward' }>,
  ): Promise<RevenueStateEntry> {
    const existing = await forwards.get(inFlight.signature);
    if (!existing) {
      await forwards.put(inFlight.signature, {
        v: 1,
        signature: inFlight.signature,
        lamports: inFlight.lamports,
        sentAt: inFlight.startedAt,
        finalizedAt: iso(),
        breakdown: inFlight.breakdown,
        relatedSignatures: state.relatedSignatures,
      });
    }
    const expected = expectedOf(state);
    const next: RevenueStateEntry = {
      ...state,
      expectedNativeLamports:
        expected === null ? null : (expected - BigInt(inFlight.lamports)).toString(),
      pending: breakdownToEntry(zeroBreakdown()),
      relatedSignatures: [],
      inFlight: null,
      lastForward: { signature: inFlight.signature, lamports: inFlight.lamports, at: iso() },
    };
    await journal.put(REVENUE_STATE_KEY, next);
    return next;
  }

  /** Books a finalized unwrap: the moved amounts are native now, per source. */
  async function bookUnwrap(
    state: RevenueStateEntry,
    inFlight: Extract<NonNullable<RevenueStateEntry['inFlight']>, { kind: 'unwrap' }>,
  ): Promise<RevenueStateEntry> {
    const moved = breakdownFromEntry(inFlight.sources);
    const pending = pendingOf(state);
    for (const s of REVENUE_SOURCES) pending[s] += moved[s];
    const expected = expectedOf(state);
    const next: RevenueStateEntry = {
      ...state,
      expectedNativeLamports:
        expected === null ? null : (expected + sumBreakdown(moved)).toString(),
      pending: breakdownToEntry(pending),
      relatedSignatures: remember(state.relatedSignatures, inFlight.signature),
      inFlight: null,
    };
    await journal.put(REVENUE_STATE_KEY, next);
    return next;
  }

  /** Settles the transaction in flight. Returns an outcome when the run must stop there. */
  async function settleInFlight(
    state: RevenueStateEntry,
    wait: boolean,
  ): Promise<{ state: RevenueStateEntry; outcome?: RevenueOutcome }> {
    const inFlight = state.inFlight;
    if (!inFlight) return { state };
    const raw = Buffer.from(inFlight.rawTx, 'base64');
    const s = wait
      ? await awaitSettlement(rpc, inFlight.signature, {
          lastValidBlockHeight: inFlight.lastValidBlockHeight,
          raw,
          until: 'finalized',
          ...settleTiming,
          retry,
          sleep,
          now,
          logger: log,
        })
      : await checkSettlement(rpc, inFlight.signature, inFlight.lastValidBlockHeight, retry);
    const kind = inFlight.kind;
    if (s.kind === 'finalized') {
      if (inFlight.kind === 'forward') {
        const next = await bookForward(state, inFlight);
        const lamports = BigInt(inFlight.lamports);
        log.info(
          {
            signature: inFlight.signature,
            lamports: inFlight.lamports,
            breakdown: inFlight.breakdown,
          },
          'revenue forwarded to the vault (finalized)',
        );
        return {
          state: next,
          outcome: {
            result: 'forwarded',
            signature: inFlight.signature,
            lamports,
            breakdown: breakdownFromEntry(inFlight.breakdown),
          },
        };
      }
      const next = await bookUnwrap(state, inFlight);
      const lamports = sumBreakdown(breakdownFromEntry(inFlight.sources));
      log.info(
        { signature: inFlight.signature, lamports: lamports.toString(), sources: inFlight.sources },
        'revenue wrapped SOL unwrapped (finalized)',
      );
      // Not an outcome that stops the run when it is this run's own unwrap (wait = true).
      return wait
        ? { state: next }
        : {
            state: next,
            outcome: { result: 'unwrapped', signature: inFlight.signature, lamports },
          };
    }
    if (s.kind === 'failed') {
      const next: RevenueStateEntry = { ...state, inFlight: null };
      await journal.put(REVENUE_STATE_KEY, next);
      await alert(
        'high',
        `revenue_${kind}_failed`,
        `The revenue ${kind} failed on-chain (nothing was moved)`,
        { signature: inFlight.signature, error: s.error },
        `revenue_${kind}_failed`,
      );
      return {
        state: next,
        outcome: { result: 'failed', kind, signature: inFlight.signature, error: s.error },
      };
    }
    if (s.kind === 'expired') {
      const next: RevenueStateEntry = { ...state, inFlight: null };
      await journal.put(REVENUE_STATE_KEY, next);
      log.warn({ signature: inFlight.signature, kind }, 'revenue transaction expired unsent');
      return {
        state: next,
        ...(wait ? { outcome: { result: 'expired', kind, signature: inFlight.signature } } : {}),
      };
    }
    if (!wait && s.kind === 'pending' && announce(inFlight.signature)) {
      try {
        await rpc.sendRawTransaction(raw);
      } catch (err) {
        log.debug({ err: describeError(err) }, 'revenue rebroadcast failed');
      }
    }
    return {
      state,
      outcome: { result: 'in_flight', kind, signature: inFlight.signature, state: s.kind },
    };
  }

  /** Kill switches (env, flag; fail closed). Null when the job may go on. */
  async function pausedReport(): Promise<RevenueRunReport | null> {
    const pause = await checkPaused(deps.flags, JOB_FLAGS.revenue, config.paused, log);
    if (!pause.paused) return null;
    log.info({ reason: pause.reason }, 'revenue job paused');
    await alertAbnormalPause(alerter, log, 'revenue', JOB_FLAGS.revenue, pause.reason);
    return { status: 'paused', reason: pause.reason };
  }

  /** Signs, journals, announces, sends and settles one transaction of this run. */
  async function sendAndSettle(
    state: RevenueStateEntry,
    tx: Transaction,
    revenueRef: string,
    lastValidBlockHeight: number,
    inFlightOf: (signature: string, rawTx: string) => NonNullable<RevenueStateEntry['inFlight']>,
  ): Promise<{ state: RevenueStateEntry; outcome?: RevenueOutcome }> {
    const { raw, signature } = await signWithKeystore(keystore, tx, [
      { ref: revenueRef, expected: config.revenue },
    ]);
    const inFlight = inFlightOf(signature, raw.toString('base64'));
    let next: RevenueStateEntry = { ...state, inFlight };
    await journal.put(REVENUE_STATE_KEY, next);
    if (!announce(signature)) {
      return {
        state: next,
        outcome: { result: 'in_flight', kind: inFlight.kind, signature, state: 'not_announced' },
      };
    }
    const sent = await broadcast(rpc, raw, retry);
    if (sent.status === 'rejected') {
      await alert(
        'high',
        `revenue_${inFlight.kind}_rejected`,
        `The RPC rejected the revenue ${inFlight.kind} (simulation failed)`,
        { signature, reason: sent.reason },
        `revenue_${inFlight.kind}_rejected`,
      );
      return {
        state: next,
        outcome: { result: 'failed', kind: inFlight.kind, signature, error: sent.reason },
      };
    }
    log.info({ signature, kind: inFlight.kind, lastValidBlockHeight }, 'revenue transaction sent');
    const settled = await settleInFlight(next, true);
    next = settled.state;
    return settled.outcome ? { state: next, outcome: settled.outcome } : { state: next };
  }

  async function runUnlocked(): Promise<RevenueRunReport> {
    let revenueRef: string | undefined;
    if (!config.dryRun) {
      try {
        ({ ref: revenueRef } = await requireRoleRef(keystore, 'revenue', config.revenue));
      } catch (err) {
        await alert('high', 'revenue_config', 'Revenue job stopped: revenue key problem', {
          error: describeError(err).message,
        });
        return { status: 'error', reason: 'revenue_key' };
      }
    }

    // 1. One transaction at a time: settle what is in flight first.
    let state = (await journal.get(REVENUE_STATE_KEY)) ?? emptyState();
    if (state.inFlight) {
      const settled = await settleInFlight(state, false);
      state = settled.state;
      if (settled.outcome && settled.outcome.result !== 'unwrapped') {
        return { status: 'ran', outcome: settled.outcome };
      }
    }

    // 1b. A forward or unwrap this journal does not know about, not finalized yet: never plan
    //     on top of it.
    const recent = await withRetry(
      () => rpc.getRecentSignatures(config.revenue, REVENUE_SCAN_LIMIT),
      retry,
    );
    const unfinalized = recent.find(
      (r) =>
        !r.failed &&
        r.confirmationStatus !== 'finalized' &&
        (r.memo?.includes(FORWARD_MEMO) || r.memo?.includes(UNWRAP_MEMO)),
    );
    if (unfinalized) {
      await alert(
        'high',
        'revenue_unfinalized_transaction',
        'An unfinalized revenue forward or unwrap is on-chain that this signer did not record: no new transaction until it is finalized',
        { signature: unfinalized.signature },
        `revenue_unfinalized_transaction:${unfinalized.signature}`,
      );
      return { status: 'ran', outcome: { result: 'skipped', reason: 'unfinalized_transaction' } };
    }

    // 2. Native balance, booked against the journal.
    const rentExempt = await withRetry(() => rpc.getMinimumBalanceForRentExemption(0), retry);
    let balance = await spendableBalance(rpc, config.revenue, retry);
    state = await reconcile(state, balance, 'run_start');

    // 3. Token accounts: the wrapped SOL to unwrap, the rest to convert.
    const tokens = await withRetry(() => rpc.getTokenAccounts(config.revenue), retry);
    if (!tokens.some((t) => t.address.equals(config.meteoraReferral))) {
      await alert(
        'high',
        'revenue_referral_not_owned',
        'FORGE_METEORA_REFERRAL_ACCOUNT is not a token account held by the revenue wallet: its referral fees cannot be unwrapped (create it with the revenue wallet as owner)',
        { referral: config.meteoraReferral.toBase58(), revenue: config.revenue.toBase58() },
        'revenue_referral_not_owned',
      );
    }
    const wsol = tokens.filter(
      (t) =>
        t.programId.equals(TOKEN_PROGRAM_ID) &&
        t.mint.equals(NATIVE_MINT) &&
        !t.frozen &&
        t.amount > 0n,
    );
    const others = tokens.filter((t) => !t.mint.equals(NATIVE_MINT) && !t.frozen && t.amount > 0n);

    // 4. Conversions (Jupiter): mainnet-beta only, live runs only.
    if (others.length > 0) {
      const mints = others.map((t) => t.mint.toBase58());
      if (deps.cluster !== 'mainnet-beta') {
        log.info({ mints }, 'non-SOL balances left as they are: no Jupiter on this cluster');
        for (const t of others) {
          await alert(
            'normal',
            'revenue_unconvertible_balance',
            'The revenue wallet holds a token this cluster cannot convert to SOL',
            { mint: t.mint.toBase58(), amount: t.amount.toString() },
            `revenue_unconvertible_balance:${t.mint.toBase58()}`,
          );
        }
      } else if (config.dryRun || !deps.convert) {
        log.info({ mints, dryRun: config.dryRun }, 'non-SOL balances not converted on this run');
      } else {
        const summary = await deps.convert();
        const confirmed = summary.items.filter(
          (
            i,
          ): i is typeof i & {
            outcome: { status: 'confirmed'; signature: string; outAmount: bigint };
          } => i.outcome.status === 'confirmed',
        );
        const after = await spendableBalance(rpc, config.revenue, retry);
        if (confirmed.length > 0 && after > balance) {
          const gain = after - balance;
          const shares = splitProportionally(
            gain,
            confirmed.map((i) => i.outcome.outAmount),
          );
          const pending = pendingOf(state);
          let related = state.relatedSignatures;
          confirmed.forEach((item, i) => {
            const mint = new PublicKey(item.mint);
            const source: RevenueSource = config.jupiterClaimMints.some((m) => m.equals(mint))
              ? 'jupiter_referral'
              : 'other';
            pending[source] += shares[i]!;
            related = remember(related, item.outcome.signature);
          });
          state = {
            ...state,
            expectedNativeLamports: after.toString(),
            pending: breakdownToEntry(pending),
            relatedSignatures: related,
          };
          await journal.put(REVENUE_STATE_KEY, state);
          log.info({ gain: gain.toString(), conversions: confirmed.length }, 'conversions booked');
        } else {
          state = await reconcile(state, after, 'after_conversions');
        }
        balance = after;
      }
    }

    // 5. Unwrap the wrapped SOL into native SOL, without closing any existing account.
    const unwrapTotal = wsol.reduce((t, a) => t + a.amount, 0n);
    const tokenRent = await withRetry(
      () => rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
      retry,
    );
    if (unwrapTotal >= config.minUnwrapLamports && !config.dryRun) {
      const unwrapFeeBuffer =
        UNWRAP_FEE_BUFFER_LAMPORTS +
        maxPriorityFee(unwrapComputeUnits(Math.min(wsol.length, MAX_UNWRAP_SOURCES)));
      if (balance < tokenRent + unwrapFeeBuffer) {
        await alert(
          'high',
          'revenue_low_balance',
          'The revenue wallet cannot pay the rent of the ephemeral unwrap account: fund it',
          {
            balance: formatSol(balance),
            needed: formatSol(tokenRent + unwrapFeeBuffer),
          },
          'revenue_low_balance',
        );
      } else {
        if (!revenueRef) throw new JobError('CONFIG', 'revenue key missing');
        const sources = wsol
          .slice(0, MAX_UNWRAP_SOURCES)
          .map((t) => ({ account: t.address, amount: t.amount }));
        const moved = zeroBreakdown();
        for (const s of sources) {
          moved[
            s.account.equals(config.meteoraReferral) ? 'meteora_referral' : 'jupiter_referral'
          ] += s.amount;
        }
        const seed = newSeed();
        const ephemeral = await PublicKey.createWithSeed(config.revenue, seed, TOKEN_PROGRAM_ID);
        const expectation: RevenueUnwrapExpectation = {
          owner: config.revenue,
          ephemeral,
          seed,
          rentLamports: tokenRent,
          sources,
          memo: UNWRAP_MEMO,
        };
        const tx = buildRevenueUnwrapTx({
          ...expectation,
          computeUnitPriceMicroLamports: await priceOf(
            [config.revenue, ephemeral, ...sources.map((s) => s.account)],
            unwrapComputeUnits(sources.length),
          ),
        });
        const { blockhash, lastValidBlockHeight } = await withRetry(
          () => rpc.getLatestBlockhash(),
          retry,
        );
        tx.recentBlockhash = blockhash;
        tx.feePayer = config.revenue;
        assertRevenueUnwrapTx(tx, expectation);
        const pausedBeforeSigning = await pausedReport();
        if (pausedBeforeSigning) return pausedBeforeSigning;
        const sent = await sendAndSettle(
          state,
          tx,
          revenueRef,
          lastValidBlockHeight,
          (signature, rawTx) => ({
            kind: 'unwrap',
            signature,
            rawTx,
            lastValidBlockHeight,
            startedAt: iso(),
            sources: breakdownToEntry(moved),
          }),
        );
        state = sent.state;
        if (sent.outcome) return { status: 'ran', outcome: sent.outcome };
        balance = await spendableBalance(rpc, config.revenue, retry);
        state = await reconcile(state, balance, 'after_unwrap');
      }
    }

    // 6. Forward the native excess to the vault.
    const plan = planSweep({
      balance,
      rentExemptLamports: rentExempt,
      reserveLamports: config.reserveLamports,
      liabilitiesLamports: 0n,
      feeBufferLamports: FORWARD_FEE_BUFFER_LAMPORTS + maxPriorityFee(FORWARD_COMPUTE_UNITS),
      minSweepLamports: config.minForwardLamports,
    });
    const planLog = {
      balance: balance.toString(),
      floor: plan.floor.toString(),
      excess: plan.excess.toString(),
      wrapped: unwrapTotal.toString(),
      pending: state.pending,
    };
    if (config.dryRun) {
      log.info(
        { ...planLog, forward: plan.sweep ? plan.amount.toString() : '0' },
        'dry run: would unwrap and forward the revenue',
      );
      return {
        status: 'ran',
        outcome: {
          result: 'dry_run',
          unwrapLamports: unwrapTotal >= config.minUnwrapLamports ? unwrapTotal : 0n,
          forwardLamports: plan.sweep ? plan.amount : 0n,
          floor: plan.floor,
        },
      };
    }
    if (!plan.sweep) {
      log.info({ ...planLog, reason: plan.reason }, 'no revenue forward');
      return {
        status: 'ran',
        outcome:
          plan.reason === 'below_reserve'
            ? { result: 'below_reserve', balance, floor: plan.floor }
            : { result: 'below_threshold', excess: plan.excess },
      };
    }
    // The vault must end rent-exempt (a transfer leaving it below rent fails).
    const vaultBalance = await withRetry(() => rpc.getBalance(config.vault, 'confirmed'), retry);
    if (vaultBalance + plan.amount < rentExempt) {
      return { status: 'ran', outcome: { result: 'skipped', reason: 'vault_not_rent_exempt' } };
    }
    if (!revenueRef) throw new JobError('CONFIG', 'revenue key missing');

    const tx = core.buildSolTransferTx({
      from: config.revenue,
      to: config.vault,
      lamports: plan.amount,
      memo: FORWARD_MEMO,
    });
    // The compute budget comes first.
    tx.instructions.unshift(
      ...computeBudgetIxs(
        FORWARD_COMPUTE_UNITS,
        await priceOf([config.revenue, config.vault], FORWARD_COMPUTE_UNITS),
      ),
    );
    const { blockhash, lastValidBlockHeight } = await withRetry(
      () => rpc.getLatestBlockhash(),
      retry,
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = config.revenue;
    assertSolTransferTx(tx, {
      from: config.revenue,
      to: config.vault,
      lamports: plan.amount,
      memo: FORWARD_MEMO,
    });
    const pausedBeforeSigning = await pausedReport();
    if (pausedBeforeSigning) return pausedBeforeSigning;
    const breakdown = forwardBreakdown(pendingOf(state), plan.amount);
    log.info({ ...planLog, amount: plan.amount.toString() }, 'revenue forward planned');
    const sent = await sendAndSettle(
      state,
      tx,
      revenueRef,
      lastValidBlockHeight,
      (signature, rawTx) => ({
        kind: 'forward',
        signature,
        rawTx,
        lastValidBlockHeight,
        startedAt: iso(),
        lamports: plan.amount.toString(),
        breakdown: breakdownToEntry(breakdown),
      }),
    );
    return { status: 'ran', ...(sent.outcome ? { outcome: sent.outcome } : {}) };
  }

  return {
    async runOnce() {
      if (running) return { status: 'busy' };
      running = true;
      try {
        const paused = await pausedReport();
        if (paused) return paused;
        try {
          return await runUnlocked();
        } catch (err) {
          const summary = describeError(err);
          const policyError =
            err instanceof JobError && (err.code === 'TX_POLICY' || err.code === 'SIGNER_MISMATCH');
          log.error({ err: summary }, 'revenue run failed');
          await alert(
            'high',
            policyError ? 'revenue_policy_violation' : 'revenue_run_failed',
            policyError
              ? 'A revenue transaction was refused before signing (policy check)'
              : 'The revenue run failed (RPC or journal unavailable?)',
            { error: summary.message },
            'revenue_run_failed',
          );
          return { status: 'error', reason: summary.message };
        }
      } finally {
        running = false;
      }
    },
  };
}
