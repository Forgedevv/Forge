/*
 * On-chain monitoring job (docs/OPERATIONS.md "Alerts", docs/SECURITY.md "creator transfer").
 *
 * Polls the FORGE accounts and the FORGE launchpad pools and raises Telegram alerts for:
 *   - balance below a threshold (payer, cashbox, vault, fee wallet, creator wallets' rent SOL);
 *   - an account that is not rent-exempt (devnet finding: a fee recipient below the rent minimum
 *     makes the whole swap transaction fail);
 *   - an unexpected outflow from the vault or the cashbox, in SOL (pre/post balances) and in
 *     tokens (pre/post token balances BY OWNER, read from the owner's transactions and from each
 *     of its token accounts' transactions, so a delegate or a closed account is seen too);
 *   - a pool whose creator role moved (transferPoolCreator), a graduated pool, a vanished pool;
 *   - a launchpad row that cannot be turned into a watch target (alerted, the others still run);
 *   - a streak of failed RPC cycles.
 *
 * Every detection is a pure function of fixtures-friendly inputs (snapshots in, `Detection[]`
 * out). The I/O is behind the small `WatchRpc` and `WatchTargetSource` interfaces; the adapters
 * for web3.js, the DBC SDK and Supabase are at the bottom of the file.
 *
 * Outflow cursors: for each address, every signature at or older than its cursor has been
 * examined. A cycle pages backwards (`before`) from the newest signature down to the cursor and
 * examines the gap oldest first; the cursor only ever moves over examined signatures. A gap
 * larger than one cycle's bound (`signatureLimit` x `maxSignaturePages`) raises OUTFLOW_BACKLOG
 * and is worked through over the next cycles (the paging point is remembered), never skipped.
 *
 * The fixed FORGE accounts (`staticAccounts`) are checked on every cycle even when the dynamic
 * targets (launchpads from Supabase) cannot be loaded.
 *
 * State (cursors, paging points, pool references, expected signatures) is persisted to a file
 * journal (`SIGNER_JOURNAL_DIR`, namespace `watch`) after every cycle and restored at start, so a
 * restart resumes where it stopped and the downtime is examined. Only the very first observation
 * of an address or a pool (no saved state) is silent.
 *
 * The job is read-only: it never signs and never sends a transaction.
 */
import { PublicKey, type Connection } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { z } from 'zod';
import type { Alerter, AlertLevel } from '../alerts.js';
import { createFileJournal, type Journal } from './shared.js';

// ---------------------------------------------------------------------------------------------
// Types

export type WatchRole = 'vault' | 'platformFee' | 'cashbox' | 'creator' | 'referral' | 'payer';

export interface WatchedAccount {
  address: string;
  label: string;
  role: WatchRole;
  /** Alert when the balance is below this many lamports. Absent or 0n disables the check. */
  minLamports?: bigint;
  /** Alert when the account is missing or below the rent-exempt minimum for its data size. */
  requireRentExempt?: boolean;
  /** Read the account's transactions and alert on outflows (SOL and tokens it owns). */
  watchOutflows?: boolean;
  /** Also read the transactions of every token account this address owns (token outflows). */
  watchTokenAccounts?: boolean;
  /** Recipients that make an outflow normal (e.g. the multisig vault for the cashbox). */
  allowedDestinations?: readonly string[];
}

export interface WatchedPool {
  address: string;
  label: string;
  /** Creator wallet the pool must keep. Absent: the creator seen first is the reference. */
  expectedCreator?: string;
}

/** A target row that could not be used (malformed, invalid address...). */
export interface InvalidTarget {
  /** Row reference for the operator (launchpad slug, or the row position). */
  ref: string;
  reason: string;
}

export interface WatchTargets {
  accounts: WatchedAccount[];
  pools: WatchedPool[];
  /** Rows skipped individually (each one alerted). */
  invalid?: InvalidTarget[];
}

export interface AccountSnapshot {
  address: string;
  exists: boolean;
  lamports: bigint;
  dataLength: number;
}

export interface PoolSnapshot {
  address: string;
  exists: boolean;
  creator: string;
  isMigrated: boolean;
  migrationProgress?: number;
}

/** A token balance of a transaction (`meta.pre/postTokenBalances`). */
export interface TokenBalanceLite {
  accountIndex: number;
  mint: string;
  /** Owner of the token account; null when the node does not report it. */
  owner: string | null;
  /** Raw units. */
  amount: bigint;
}

/** The parts of a confirmed transaction the outflow detection needs. */
export interface TxLite {
  signature: string;
  /** true when the transaction failed (no balance moved besides the fee). */
  failed: boolean;
  fee: bigint;
  /** Full account key list (static keys then loaded lookup-table keys). */
  accountKeys: readonly string[];
  preBalances: readonly bigint[];
  postBalances: readonly bigint[];
  preTokenBalances?: readonly TokenBalanceLite[];
  postTokenBalances?: readonly TokenBalanceLite[];
}

export interface SignatureLite {
  signature: string;
  failed: boolean;
}

export interface Detection {
  code: string;
  level: AlertLevel;
  message: string;
  /** Distinct per subject, so two wallets raising the same code are two alerts. */
  dedupKey: string;
  details: Record<string, unknown>;
  /** Raised once (the cursor moves on): the alerter retries it until delivered. */
  oneShot?: boolean;
}

export interface WatchRpc {
  getAccounts(addresses: readonly string[]): Promise<(AccountSnapshot | null)[]>;
  getRentExemptMinimum(dataLength: number): Promise<bigint>;
  /**
   * Newest first. `until` excludes that signature and everything older; `before` excludes that
   * signature and everything newer.
   */
  getSignatures(
    address: string,
    opts: { until?: string; before?: string; limit: number },
  ): Promise<SignatureLite[]>;
  getTransaction(signature: string): Promise<TxLite | null>;
  /** One snapshot per address, `exists: false` when the account is gone. */
  getPools(addresses: readonly string[]): Promise<PoolSnapshot[]>;
  /** Addresses of the token accounts (classic and Token-2022) owned by `owner`. */
  getTokenAccounts(owner: string): Promise<string[]>;
}

export interface WatchTargetSource {
  load(): Promise<WatchTargets>;
}

export interface WatchConfig {
  intervalMs: number;
  maxBackoffMs: number;
  /** Consecutive failed cycles before the RPC alert. */
  rpcErrorStreak: number;
  /** Outflows at or below this are ignored (transaction fees). */
  outflowToleranceLamports: bigint;
  /** Signatures read per page. */
  signatureLimit: number;
  /** Pages read per address and cycle before the gap is declared a backlog. */
  maxSignaturePages: number;
  minLamports: {
    vault: bigint;
    platformFee: bigint;
    cashbox: bigint;
    payer: bigint;
    creator: bigint;
  };
}

// ---------------------------------------------------------------------------------------------
// Configuration

const lamportsString = z
  .string()
  .regex(/^\d{1,18}$/, 'expected a non-negative integer number of lamports')
  .transform((v) => BigInt(v));

const envSchema = z.object({
  WATCH_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  WATCH_MAX_BACKOFF_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .default(15 * 60_000),
  WATCH_RPC_ERROR_STREAK: z.coerce.number().int().min(1).default(5),
  WATCH_OUTFLOW_TOLERANCE_LAMPORTS: lamportsString.default(20_000n),
  WATCH_SIGNATURE_LIMIT: z.coerce.number().int().min(1).max(1000).default(50),
  WATCH_MAX_SIGNATURE_PAGES: z.coerce.number().int().min(1).max(1000).default(20),
  WATCH_MIN_VAULT_LAMPORTS: lamportsString.default(0n),
  WATCH_MIN_PLATFORM_FEE_LAMPORTS: lamportsString.default(0n),
  WATCH_MIN_CASHBOX_LAMPORTS: lamportsString.default(100_000_000n),
  WATCH_MIN_PAYER_LAMPORTS: lamportsString.default(200_000_000n),
  WATCH_MIN_CREATOR_LAMPORTS: lamportsString.default(5_000_000n),
});

/** Reads the WATCH_* variables (all optional, with defaults). Throws on malformed values. */
export function parseWatchConfig(env: Readonly<Record<string, string | undefined>>): WatchConfig {
  const parsed = envSchema.parse(env);
  return {
    intervalMs: parsed.WATCH_INTERVAL_MS,
    maxBackoffMs: Math.max(parsed.WATCH_MAX_BACKOFF_MS, parsed.WATCH_INTERVAL_MS),
    rpcErrorStreak: parsed.WATCH_RPC_ERROR_STREAK,
    outflowToleranceLamports: parsed.WATCH_OUTFLOW_TOLERANCE_LAMPORTS,
    signatureLimit: parsed.WATCH_SIGNATURE_LIMIT,
    maxSignaturePages: parsed.WATCH_MAX_SIGNATURE_PAGES,
    minLamports: {
      vault: parsed.WATCH_MIN_VAULT_LAMPORTS,
      platformFee: parsed.WATCH_MIN_PLATFORM_FEE_LAMPORTS,
      cashbox: parsed.WATCH_MIN_CASHBOX_LAMPORTS,
      payer: parsed.WATCH_MIN_PAYER_LAMPORTS,
      creator: parsed.WATCH_MIN_CREATOR_LAMPORTS,
    },
  };
}

export interface ForgeWatchAddresses {
  vault: string;
  platformFee: string;
  cashbox: string;
  /** Meteora and Jupiter referral token accounts. */
  referrals?: readonly string[];
  /** Wallet paying for configs and launch transactions. */
  payer?: string;
}

/** Account list for the fixed FORGE addresses (pass it as `WatchDeps.staticAccounts`). */
export function buildStaticAccounts(
  addresses: ForgeWatchAddresses,
  config: WatchConfig,
): WatchedAccount[] {
  const out: WatchedAccount[] = [
    {
      address: addresses.vault,
      label: 'multisig vault',
      role: 'vault',
      minLamports: config.minLamports.vault,
      watchOutflows: true,
      watchTokenAccounts: true,
      allowedDestinations: [],
    },
    {
      address: addresses.platformFee,
      label: 'platform fee wallet',
      role: 'platformFee',
      minLamports: config.minLamports.platformFee,
      requireRentExempt: true,
    },
    {
      address: addresses.cashbox,
      label: 'cashbox',
      role: 'cashbox',
      minLamports: config.minLamports.cashbox,
      requireRentExempt: true,
      watchOutflows: true,
      watchTokenAccounts: true,
      allowedDestinations: [addresses.vault],
    },
  ];
  if (addresses.payer) {
    out.push({
      address: addresses.payer,
      label: 'payer wallet',
      role: 'payer',
      minLamports: config.minLamports.payer,
      requireRentExempt: true,
    });
  }
  (addresses.referrals ?? []).forEach((address, i) => {
    out.push({
      address,
      label: `referral account ${i + 1}`,
      role: 'referral',
      requireRentExempt: true,
    });
  });
  return out;
}

/** Account entries for creator wallets: SOL left for rent and fees. */
export function buildCreatorAccounts(
  wallets: readonly { address: string; label: string }[],
  config: WatchConfig,
): WatchedAccount[] {
  return wallets.map((w) => ({
    address: w.address,
    label: w.label,
    role: 'creator' as const,
    minLamports: config.minLamports.creator,
  }));
}

// ---------------------------------------------------------------------------------------------
// Pure detection

export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''} SOL`;
}

const LOW_BALANCE_LEVEL: Record<WatchRole, AlertLevel> = {
  vault: 'high',
  platformFee: 'high',
  cashbox: 'high',
  payer: 'high',
  creator: 'normal',
  referral: 'high',
};

export function detectLowBalance(account: WatchedAccount, snap: AccountSnapshot): Detection | null {
  const min = account.minLamports ?? 0n;
  if (min <= 0n) return null;
  const lamports = snap.exists ? snap.lamports : 0n;
  if (lamports >= min) return null;
  return {
    code: 'LOW_BALANCE',
    level: LOW_BALANCE_LEVEL[account.role],
    message: `Low balance on the ${account.label}: ${formatSol(lamports)} (minimum ${formatSol(min)})`,
    dedupKey: `low:${account.address}`,
    details: {
      account: account.address,
      role: account.role,
      balance: formatSol(lamports),
      minimum: formatSol(min),
    },
  };
}

/**
 * `rentMinimum` is the cluster's minimum for the account's data size. A missing account is
 * reported too: a first transfer below the minimum to it would fail the whole transaction.
 */
export function detectNotRentExempt(
  account: WatchedAccount,
  snap: AccountSnapshot,
  rentMinimum: bigint,
): Detection | null {
  if (!account.requireRentExempt) return null;
  if (snap.exists && snap.lamports >= rentMinimum) return null;
  const lamports = snap.exists ? snap.lamports : 0n;
  return {
    code: 'NOT_RENT_EXEMPT',
    level: 'high',
    message: snap.exists
      ? `The ${account.label} is not rent-exempt: ${formatSol(lamports)} (minimum ${formatSol(rentMinimum)})`
      : `The ${account.label} does not exist yet: fund it with at least ${formatSol(rentMinimum)}`,
    dedupKey: `rent:${account.address}`,
    details: {
      account: account.address,
      role: account.role,
      exists: snap.exists,
      balance: formatSol(lamports),
      rentMinimum: formatSol(rentMinimum),
    },
  };
}

/** Lamports that left `address` in this transaction (0n when it gained or did not move). */
export function outflowOf(tx: TxLite, address: string): bigint {
  if (tx.failed) return 0n;
  const index = tx.accountKeys.indexOf(address);
  if (index < 0) return 0n;
  const pre = tx.preBalances[index];
  const post = tx.postBalances[index];
  if (pre === undefined || post === undefined) return 0n;
  let delta = post - pre;
  // The fee payer (first key) also pays the transaction fee: that is not an outflow.
  if (index === 0) delta += tx.fee;
  return delta < 0n ? -delta : 0n;
}

/** Accounts whose balance went up in this transaction. */
export function recipientsOf(tx: TxLite, excluding: string): string[] {
  const out: string[] = [];
  tx.accountKeys.forEach((key, i) => {
    const pre = tx.preBalances[i];
    const post = tx.postBalances[i];
    if (key !== excluding && pre !== undefined && post !== undefined && post > pre) out.push(key);
  });
  return out;
}

export interface TokenOutflow {
  mint: string;
  /** Raw units that left the owner's token accounts. */
  amount: bigint;
  /** Owners whose balance of that mint went up. */
  recipients: string[];
}

function sumByOwnerAndMint(
  balances: readonly TokenBalanceLite[] | undefined,
  mint: string | null,
  include: (owner: string) => boolean,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const b of balances ?? []) {
    if (b.owner === null || !include(b.owner) || (mint !== null && b.mint !== mint)) continue;
    const k = mint === null ? b.mint : b.owner;
    out.set(k, (out.get(k) ?? 0n) + b.amount);
  }
  return out;
}

/**
 * Tokens that left the token accounts OWNED by `owner` in this transaction, per mint (by owner,
 * not by account: a closed account, an owner change or a delegate transfer all count).
 */
export function tokenOutflowsOf(tx: TxLite, owner: string): TokenOutflow[] {
  if (tx.failed) return [];
  const mine = (o: string) => o === owner;
  const pre = sumByOwnerAndMint(tx.preTokenBalances, null, mine);
  const post = sumByOwnerAndMint(tx.postTokenBalances, null, mine);
  const out: TokenOutflow[] = [];
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(mint) ?? 0n) - (pre.get(mint) ?? 0n);
    if (delta >= 0n) continue;
    const others = (o: string) => o !== owner;
    const before = sumByOwnerAndMint(tx.preTokenBalances, mint, others);
    const after = sumByOwnerAndMint(tx.postTokenBalances, mint, others);
    const recipients = [...new Set([...before.keys(), ...after.keys()])].filter(
      (o) => (after.get(o) ?? 0n) > (before.get(o) ?? 0n),
    );
    out.push({ mint, amount: -delta, recipients });
  }
  return out;
}

export interface OutflowContext {
  toleranceLamports: bigint;
  /** Signatures sent by FORGE jobs themselves (refunds, sweeps, buyback funding). */
  isExpectedSignature?: (signature: string) => boolean;
}

export function detectOutflows(
  account: WatchedAccount,
  txs: readonly TxLite[],
  ctx: OutflowContext,
): Detection[] {
  const out: Detection[] = [];
  const allowed = new Set(account.allowedDestinations ?? []);
  for (const tx of txs) {
    const amount = outflowOf(tx, account.address);
    if (amount <= ctx.toleranceLamports) continue;
    if (ctx.isExpectedSignature?.(tx.signature)) continue;
    const recipients = recipientsOf(tx, account.address);
    if (recipients.length > 0 && recipients.every((r) => allowed.has(r))) continue;
    out.push({
      code: 'UNEXPECTED_OUTFLOW',
      level: 'immediate',
      message: `Unexpected outflow of ${formatSol(amount)} from the ${account.label}`,
      dedupKey: `outflow:${tx.signature}`,
      oneShot: true,
      details: {
        account: account.address,
        role: account.role,
        amount: formatSol(amount),
        signature: tx.signature,
        recipients: recipients.slice(0, 5),
      },
    });
  }
  return out;
}

/** Token outflows from the token accounts owned by `account` (no tolerance: any amount). */
export function detectTokenOutflows(
  account: WatchedAccount,
  txs: readonly TxLite[],
  ctx: Pick<OutflowContext, 'isExpectedSignature'>,
): Detection[] {
  const out: Detection[] = [];
  const allowed = new Set(account.allowedDestinations ?? []);
  for (const tx of txs) {
    if (ctx.isExpectedSignature?.(tx.signature)) continue;
    for (const flow of tokenOutflowsOf(tx, account.address)) {
      if (flow.recipients.length > 0 && flow.recipients.every((r) => allowed.has(r))) continue;
      out.push({
        code: 'UNEXPECTED_TOKEN_OUTFLOW',
        level: 'immediate',
        message: `Unexpected token outflow from the ${account.label}`,
        dedupKey: `token-outflow:${tx.signature}:${flow.mint}`,
        oneShot: true,
        details: {
          account: account.address,
          role: account.role,
          mint: flow.mint,
          amount: flow.amount.toString(),
          signature: tx.signature,
          recipients: flow.recipients.slice(0, 5),
        },
      });
    }
  }
  return out;
}

export interface PoolMemory {
  creator: string;
  isMigrated: boolean;
}

/** Compares a pool to the previous observation. `prev` undefined: first sight, silent. */
export function detectPoolChanges(
  pool: WatchedPool,
  snap: PoolSnapshot,
  prev: PoolMemory | undefined,
): Detection[] {
  const out: Detection[] = [];
  if (!snap.exists) {
    // A vanished pool is only news if it existed before.
    if (prev !== undefined) {
      out.push({
        code: 'POOL_MISSING',
        level: 'high',
        message: `Pool ${pool.label} can no longer be read on-chain`,
        dedupKey: `missing:${pool.address}`,
        details: { pool: pool.address },
      });
    }
    return out;
  }
  const referenceCreator = pool.expectedCreator ?? prev?.creator;
  if (referenceCreator !== undefined && snap.creator !== referenceCreator) {
    out.push({
      code: 'POOL_CREATOR_CHANGED',
      level: 'immediate',
      message: `The creator role of pool ${pool.label} moved (transferPoolCreator)`,
      dedupKey: `creator:${pool.address}:${snap.creator}`,
      details: { pool: pool.address, expected: referenceCreator, actual: snap.creator },
    });
  }
  if (prev !== undefined && !prev.isMigrated && snap.isMigrated) {
    out.push({
      code: 'POOL_MIGRATED',
      level: 'normal',
      message: `Pool ${pool.label} graduated and migrated: check the post-graduation claims`,
      dedupKey: `migrated:${pool.address}`,
      oneShot: true,
      details: { pool: pool.address },
    });
  }
  return out;
}

export function detectInvalidTarget(target: InvalidTarget): Detection {
  return {
    code: 'WATCH_TARGET_INVALID',
    level: 'high',
    message: `A launchpad row cannot be watched (${target.reason}): fix the row`,
    dedupKey: `invalid-target:${target.ref}:${target.reason}`,
    details: { row: target.ref, reason: target.reason },
  };
}

export function detectRpcErrorStreak(
  streak: number,
  threshold: number,
  lastError: string | undefined,
): Detection | null {
  if (streak < threshold) return null;
  return {
    code: 'RPC_ERRORS',
    level: 'high',
    message: `RPC errors on ${streak} consecutive monitoring cycles`,
    dedupKey: 'rpc-errors',
    details: { streak, lastError: lastError ?? 'unknown' },
  };
}

/** Delay before the next cycle: the interval, doubled per failed cycle up to the cap, with jitter. */
export function nextDelayMs(
  config: Pick<WatchConfig, 'intervalMs' | 'maxBackoffMs'>,
  failureStreak: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(failureStreak, 0), 20);
  const base = Math.min(config.intervalMs * 2 ** exponent, config.maxBackoffMs);
  const jitter = 1 + (random() - 0.5) * 0.2; // +/- 10%
  return Math.round(base * jitter);
}

// ---------------------------------------------------------------------------------------------
// State

export interface WatchState {
  rpcErrorStreak: number;
  /** Per address: every signature at or older than this one was examined ('' = none exists). */
  outflowCursor: Map<string, string>;
  /** Per address: where a gap too large for one cycle continues paging (see `checkStream`). */
  backfillBefore: Map<string, string>;
  pools: Map<string, PoolMemory>;
  /** Owners whose token accounts were listed once: a token account found later is read in full. */
  tokenOwnersSeen: Set<string>;
}

export function createWatchState(): WatchState {
  return {
    rpcErrorStreak: 0,
    outflowCursor: new Map(),
    backfillBefore: new Map(),
    pools: new Map(),
    tokenOwnersSeen: new Set(),
  };
}

export const SerializedWatchState = z.object({
  v: z.literal(1),
  outflowCursor: z.record(z.string(), z.string()),
  backfillBefore: z.record(z.string(), z.string()),
  pools: z.record(z.string(), z.object({ creator: z.string(), isMigrated: z.boolean() })),
  tokenOwnersSeen: z.array(z.string()),
  expected: z.array(z.object({ signature: z.string(), at: z.number() })),
});
export type SerializedWatchState = z.infer<typeof SerializedWatchState>;

/** Accepted by `importWatchState`: the current form, or the older one (cursors and pools only). */
export type SerializedWatchStateInput = Pick<SerializedWatchState, 'outflowCursor' | 'pools'> &
  Partial<SerializedWatchState>;

export function exportWatchState(
  state: WatchState,
  expected?: ExpectedSignatures,
): SerializedWatchState {
  return {
    v: 1,
    outflowCursor: Object.fromEntries(state.outflowCursor),
    backfillBefore: Object.fromEntries(state.backfillBefore),
    pools: Object.fromEntries(state.pools),
    tokenOwnersSeen: [...state.tokenOwnersSeen].sort(),
    expected: expected?.entries() ?? [],
  };
}

export function importWatchState(
  data: SerializedWatchStateInput,
  expected?: ExpectedSignatures,
): WatchState {
  const state = createWatchState();
  applyWatchState(state, data, expected);
  return state;
}

function applyWatchState(
  state: WatchState,
  data: SerializedWatchStateInput,
  expected?: ExpectedSignatures,
): void {
  for (const [k, v] of Object.entries(data.outflowCursor)) state.outflowCursor.set(k, v);
  for (const [k, v] of Object.entries(data.backfillBefore ?? {})) state.backfillBefore.set(k, v);
  for (const [k, v] of Object.entries(data.pools)) state.pools.set(k, v);
  for (const owner of data.tokenOwnersSeen ?? []) state.tokenOwnersSeen.add(owner);
  if (expected && data.expected) expected.restore(data.expected);
}

export const WATCH_STATE_KEY = 'state';

/** File journal of the watcher state (`<dir>/watch.state.json`). */
export function createWatchStateJournal(dir: string): Journal<SerializedWatchState> {
  return createFileJournal({ dir, namespace: 'watch', schema: SerializedWatchState });
}

/** Remembers signatures sent by FORGE jobs so their outflows are not flagged. */
export interface ExpectedSignatures {
  /** Call right after signing and before sending, so the watcher cannot see the tx first. */
  expect(signature: string): void;
  has(signature: string): boolean;
  /** Live entries, for persistence. */
  entries(): Array<{ signature: string; at: number }>;
  /** Re-adds persisted entries (expired ones are ignored). */
  restore(entries: ReadonlyArray<{ signature: string; at: number }>): void;
}

export function createExpectedSignatures(
  ttlMs = 24 * 60 * 60_000,
  now: () => number = Date.now,
): ExpectedSignatures {
  const map = new Map<string, number>();
  const prune = (t: number) => {
    for (const [sig, at] of map) if (t - at > ttlMs) map.delete(sig);
  };
  return {
    expect(signature) {
      const t = now();
      prune(t);
      map.set(signature, t);
    },
    has(signature) {
      const at = map.get(signature);
      return at !== undefined && now() - at <= ttlMs;
    },
    entries() {
      prune(now());
      return [...map].map(([signature, at]) => ({ signature, at }));
    },
    restore(entries) {
      const t = now();
      for (const e of entries) {
        if (t - e.at <= ttlMs && (map.get(e.signature) ?? -Infinity) < e.at) {
          map.set(e.signature, e.at);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cycle

export interface WatchLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WatchDeps {
  rpc: WatchRpc;
  /** Dynamic targets (launchpad pools and creator wallets). */
  targets: WatchTargetSource;
  /** Fixed FORGE accounts: checked on every cycle, even when `targets` fails. */
  staticAccounts?: readonly WatchedAccount[];
  alerter: Alerter;
  logger: WatchLogger;
  config: WatchConfig;
  state: WatchState;
  expected?: ExpectedSignatures;
  /** Durable state (cursors...). Saved after every cycle, restored by `startWatch`. */
  journal?: Journal<SerializedWatchState>;
}

export interface WatchCycleResult {
  detections: Detection[];
  errors: string[];
  accountsChecked: number;
  poolsChecked: number;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

async function checkAccounts(
  deps: WatchDeps,
  accounts: readonly WatchedAccount[],
  out: Detection[],
): Promise<void> {
  if (accounts.length === 0) return;
  const snaps = await deps.rpc.getAccounts(accounts.map((a) => a.address));
  const rentByLength = new Map<number, bigint>();
  for (const [i, account] of accounts.entries()) {
    const raw = snaps[i];
    const snap: AccountSnapshot = raw ?? {
      address: account.address,
      exists: false,
      lamports: 0n,
      dataLength: 0,
    };
    const low = detectLowBalance(account, snap);
    if (low) out.push(low);
    if (account.requireRentExempt) {
      let rent = rentByLength.get(snap.dataLength);
      if (rent === undefined) {
        rent = await deps.rpc.getRentExemptMinimum(snap.dataLength);
        rentByLength.set(snap.dataLength, rent);
      }
      const notExempt = detectNotRentExempt(account, snap, rent);
      if (notExempt) out.push(notExempt);
    }
  }
}

interface Gap {
  /** Newest first. */
  sigs: SignatureLite[];
  complete: boolean;
  /** When incomplete: the oldest signature read, where the next cycle continues. */
  before?: string;
}

/** Pages backwards from `startBefore` (or the newest) down to `cursor`, within the cycle bound. */
async function collectGap(
  deps: WatchDeps,
  address: string,
  cursor: string,
  startBefore: string | undefined,
): Promise<Gap> {
  const limit = deps.config.signatureLimit;
  const pages = Math.max(1, deps.config.maxSignaturePages);
  let before = startBefore;
  const sigs: SignatureLite[] = [];
  for (let page = 0; page < pages; page++) {
    const batch = await deps.rpc.getSignatures(address, {
      ...(cursor ? { until: cursor } : {}),
      ...(before ? { before } : {}),
      limit,
    });
    sigs.push(...batch);
    if (batch.length < limit) return { sigs, complete: true };
    before = batch[batch.length - 1]!.signature;
  }
  return { sigs, complete: false, ...(before ? { before } : {}) };
}

/**
 * Examines the new signatures of `stream` (an owner, or one of its token accounts) for outflows
 * of `owner`. On first sight the cursor is set silently to the newest signature, unless
 * `fullHistoryOnFirstSight` (a token account that appeared after its owner was first listed).
 */
async function checkStream(
  deps: WatchDeps,
  stream: string,
  owner: WatchedAccount,
  kind: 'owner' | 'token',
  fullHistoryOnFirstSight: boolean,
  out: Detection[],
): Promise<void> {
  const cursor = deps.state.outflowCursor.get(stream);
  if (cursor === undefined && !fullHistoryOnFirstSight) {
    // First sight: remember where we are, do not alert on history.
    const latest = await deps.rpc.getSignatures(stream, { limit: 1 });
    deps.state.outflowCursor.set(stream, latest[0]?.signature ?? '');
    deps.state.backfillBefore.delete(stream);
    return;
  }
  const startBefore = deps.state.backfillBefore.get(stream);
  const gap = await collectGap(deps, stream, cursor ?? '', startBefore);
  if (!gap.complete) {
    if (gap.before) deps.state.backfillBefore.set(stream, gap.before);
    const bound = deps.config.signatureLimit * deps.config.maxSignaturePages;
    out.push({
      code: 'OUTFLOW_BACKLOG',
      level: 'high',
      message: `More than ${bound} unexamined transactions on the ${owner.label}: they are being read over the next cycles, nothing is skipped`,
      dedupKey: `backlog:${stream}`,
      details: { account: owner.address, stream, bound },
    });
    return;
  }

  // Oldest first, so the cursor only moves past transactions that were really examined. When
  // a backfill reaches the cursor, its paging point (the signature just above the segment) is
  // examined too: the cursor then always makes progress.
  const ordered = [...gap.sigs].reverse();
  if (startBefore) ordered.push({ signature: startBefore, failed: false });
  const txs: TxLite[] = [];
  let lastExamined: string | undefined;
  let failure: unknown;
  for (const s of ordered) {
    if (s.failed) {
      lastExamined = s.signature;
      continue;
    }
    try {
      const tx = await deps.rpc.getTransaction(s.signature);
      if (!tx) throw new Error('transaction not available yet');
      txs.push(tx);
      lastExamined = s.signature;
    } catch (err) {
      failure = err;
      break;
    }
  }
  const isExpectedSignature = deps.expected
    ? (sig: string) => deps.expected!.has(sig)
    : undefined;
  const ctx = {
    toleranceLamports: deps.config.outflowToleranceLamports,
    ...(isExpectedSignature ? { isExpectedSignature } : {}),
  };
  if (kind === 'owner') out.push(...detectOutflows(owner, txs, ctx));
  out.push(...detectTokenOutflows(owner, txs, ctx));
  if (lastExamined !== undefined) deps.state.outflowCursor.set(stream, lastExamined);
  else if (cursor === undefined && ordered.length === 0) deps.state.outflowCursor.set(stream, '');
  if (failure !== undefined) throw failure;
  deps.state.backfillBefore.delete(stream);
}

/** Every token account of `owner`: its own transaction stream, token outflows by owner. */
async function checkTokenAccounts(
  deps: WatchDeps,
  owner: WatchedAccount,
  out: Detection[],
): Promise<void> {
  const tokenAccounts = await deps.rpc.getTokenAccounts(owner.address);
  const known = deps.state.tokenOwnersSeen.has(owner.address);
  let failure: unknown;
  for (const address of tokenAccounts) {
    try {
      await checkStream(deps, address, owner, 'token', known, out);
    } catch (err) {
      failure ??= err;
      deps.logger.error(
        { stage: `tokens:${owner.role}`, errorName: errorName(err) },
        'token account stream failed',
      );
    }
  }
  deps.state.tokenOwnersSeen.add(owner.address);
  if (failure !== undefined) throw failure;
}

async function checkPools(
  deps: WatchDeps,
  pools: readonly WatchedPool[],
  out: Detection[],
): Promise<void> {
  if (pools.length === 0) return;
  const snaps = await deps.rpc.getPools(pools.map((p) => p.address));
  const byAddress = new Map(snaps.map((s) => [s.address, s]));
  for (const pool of pools) {
    const snap = byAddress.get(pool.address);
    if (!snap) continue;
    const prev = deps.state.pools.get(pool.address);
    out.push(...detectPoolChanges(pool, snap, prev));
    if (snap.exists) {
      deps.state.pools.set(pool.address, {
        // The reference creator never follows a transfer: keep the first one seen.
        creator: prev?.creator ?? pool.expectedCreator ?? snap.creator,
        isMigrated: snap.isMigrated || (prev?.isMigrated ?? false),
      });
    }
  }
}

function uniqueAccounts(accounts: readonly WatchedAccount[]): WatchedAccount[] {
  const seen = new Set<string>();
  const out: WatchedAccount[] = [];
  for (const a of accounts) {
    if (seen.has(a.address)) continue;
    seen.add(a.address);
    out.push(a);
  }
  return out;
}

function uniqueDetections(detections: readonly Detection[]): Detection[] {
  const seen = new Set<string>();
  return detections.filter((d) => {
    const k = `${d.code}|${d.dedupKey}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Writes the state to the journal (no-op without a journal). */
export async function saveWatchState(deps: WatchDeps): Promise<void> {
  if (!deps.journal) return;
  await deps.journal.put(WATCH_STATE_KEY, exportWatchState(deps.state, deps.expected));
}

/**
 * Loads the saved state into `deps.state` (and the expected signatures). Never throws: an
 * unreadable journal is alerted and the watcher starts fresh. Returns true when state was loaded.
 */
export async function restoreWatchState(deps: WatchDeps): Promise<boolean> {
  if (!deps.journal) return false;
  try {
    const saved = await deps.journal.get(WATCH_STATE_KEY);
    if (!saved) return false;
    applyWatchState(deps.state, saved, deps.expected);
    deps.logger.info(
      { cursors: deps.state.outflowCursor.size, pools: deps.state.pools.size },
      'watch state restored',
    );
    return true;
  } catch (err) {
    deps.logger.error({ errorName: errorName(err) }, 'watch state unreadable');
    try {
      await deps.alerter.alert(
        'high',
        'WATCH_STATE_UNREADABLE',
        'The watcher state could not be read: it starts fresh, so the downtime is not examined',
        { error: errorName(err) },
        { dedupKey: 'watch-state-unreadable' },
      );
    } catch {
      /* alerting must not stop the watcher */
    }
    return false;
  }
}

/**
 * One monitoring pass. Stage failures are collected, not thrown: the other stages still run, and
 * the static accounts are always checked. The cycle counts as failed (RPC streak) when any stage
 * threw. Detections are alerted, then the state is saved.
 */
export async function runWatchCycle(deps: WatchDeps): Promise<WatchCycleResult> {
  const detections: Detection[] = [];
  const errors: string[] = [];
  const stage = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${name}: ${errorName(err)}`);
      deps.logger.error({ stage: name, errorName: errorName(err) }, 'watch stage failed');
    }
  };

  const staticAccounts = uniqueAccounts(deps.staticAccounts ?? []);
  let dynamic: WatchTargets = { accounts: [], pools: [] };
  await stage('targets', async () => {
    dynamic = await deps.targets.load();
  });
  const staticSet = new Set(staticAccounts.map((a) => a.address));
  const dynamicAccounts = uniqueAccounts(dynamic.accounts.filter((a) => !staticSet.has(a.address)));
  for (const bad of dynamic.invalid ?? []) detections.push(detectInvalidTarget(bad));

  await stage('accounts:static', () => checkAccounts(deps, staticAccounts, detections));
  await stage('accounts', () => checkAccounts(deps, dynamicAccounts, detections));
  const accounts = [...staticAccounts, ...dynamicAccounts];
  for (const account of accounts.filter((a) => a.watchOutflows)) {
    await stage(`outflows:${account.role}`, () =>
      checkStream(deps, account.address, account, 'owner', false, detections),
    );
  }
  for (const account of accounts.filter((a) => a.watchTokenAccounts)) {
    await stage(`tokens:${account.role}`, () => checkTokenAccounts(deps, account, detections));
  }
  await stage('pools', () => checkPools(deps, dynamic.pools, detections));

  const unique = uniqueDetections(detections);
  for (const d of unique) {
    await deps.alerter.alert(d.level, d.code, d.message, d.details, {
      dedupKey: d.dedupKey,
      ...(d.oneShot ? { oneShot: true } : {}),
    });
  }
  await stage('state', () => saveWatchState(deps));

  if (errors.length > 0) deps.state.rpcErrorStreak += 1;
  else deps.state.rpcErrorStreak = 0;
  const streak = detectRpcErrorStreak(
    deps.state.rpcErrorStreak,
    deps.config.rpcErrorStreak,
    errors[errors.length - 1],
  );
  if (streak) {
    unique.push(streak);
    await deps.alerter.alert(streak.level, streak.code, streak.message, streak.details, {
      dedupKey: streak.dedupKey,
    });
  }
  await deps.alerter.flushPending?.();
  return {
    detections: unique,
    errors,
    accountsChecked: accounts.length,
    poolsChecked: dynamic.pools.length,
  };
}

export interface WatchHandle {
  stop(): void;
  /** Resolves when the loop has stopped. */
  done: Promise<void>;
}

/**
 * Restores the saved state, then runs cycles forever: `intervalMs` apart, with exponential
 * backoff while cycles fail.
 */
export function startWatch(
  deps: WatchDeps,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  random: () => number = Math.random,
): WatchHandle {
  const controller = new AbortController();
  const loop = async (): Promise<void> => {
    await restoreWatchState(deps);
    while (!controller.signal.aborted) {
      try {
        await runWatchCycle(deps);
      } catch (err) {
        // runWatchCycle only throws if alerting or logging itself broke; keep the loop alive.
        deps.state.rpcErrorStreak += 1;
        deps.logger.error({ errorName: errorName(err) }, 'watch cycle crashed');
      }
      if (controller.signal.aborted) break;
      await sleep(nextDelayMs(deps.config, deps.state.rpcErrorStreak, random), controller.signal);
    }
  };
  return { stop: () => controller.abort(), done: loop() };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Adapters

const ACCOUNTS_PER_REQUEST = 100;

export interface PoolStateLite {
  creator: PublicKey;
  isMigrated: number;
  migrationProgress: number;
}

export interface Web3WatchRpcOptions {
  /** Reads one DBC pool; null when it does not exist. Default: the DBC SDK `state.getPool`. */
  getPoolState?: (address: PublicKey) => Promise<PoolStateLite | null>;
}

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

function toTokenBalances(list: readonly RawTokenBalance[] | null | undefined): TokenBalanceLite[] {
  return (list ?? []).map((b) => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner ?? null,
    amount: BigInt(b.uiTokenAmount.amount),
  }));
}

export function createWeb3WatchRpc(
  connection: Connection,
  options: Web3WatchRpcOptions = {},
): WatchRpc {
  let getPoolState = options.getPoolState;
  const poolReader = async (address: PublicKey): Promise<PoolStateLite | null> => {
    if (!getPoolState) {
      const { DynamicBondingCurveClient } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
      const client = new DynamicBondingCurveClient(connection, 'confirmed');
      getPoolState = async (pk) => {
        const pool = await client.state.getPool(pk);
        return pool ? (pool.poolState ?? (pool as unknown as PoolStateLite)) : null;
      };
    }
    return getPoolState(address);
  };

  return {
    async getAccounts(addresses) {
      const out: (AccountSnapshot | null)[] = [];
      for (let i = 0; i < addresses.length; i += ACCOUNTS_PER_REQUEST) {
        const chunk = addresses.slice(i, i + ACCOUNTS_PER_REQUEST);
        const infos = await connection.getMultipleAccountsInfo(
          chunk.map((a) => new PublicKey(a)),
          'confirmed',
        );
        chunk.forEach((address, j) => {
          const info = infos[j];
          out.push(
            info
              ? {
                  address,
                  exists: true,
                  lamports: BigInt(info.lamports),
                  dataLength: info.data.length,
                }
              : null,
          );
        });
      }
      return out;
    },
    async getRentExemptMinimum(dataLength) {
      return BigInt(await connection.getMinimumBalanceForRentExemption(dataLength, 'confirmed'));
    },
    async getSignatures(address, opts) {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(address),
        {
          limit: opts.limit,
          ...(opts.until ? { until: opts.until } : {}),
          ...(opts.before ? { before: opts.before } : {}),
        },
        'confirmed',
      );
      return sigs.map((s) => ({ signature: s.signature, failed: s.err !== null }));
    },
    async getTransaction(signature) {
      const tx = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta) return null;
      const keys = tx.transaction.message
        .getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
        .keySegments()
        .flat()
        .map((k) => k.toBase58());
      return {
        signature,
        failed: tx.meta.err !== null,
        fee: BigInt(tx.meta.fee),
        accountKeys: keys,
        preBalances: tx.meta.preBalances.map((b) => BigInt(b)),
        postBalances: tx.meta.postBalances.map((b) => BigInt(b)),
        preTokenBalances: toTokenBalances(tx.meta.preTokenBalances),
        postTokenBalances: toTokenBalances(tx.meta.postTokenBalances),
      };
    },
    async getPools(addresses) {
      const out: PoolSnapshot[] = [];
      for (const address of addresses) {
        const state = await poolReader(new PublicKey(address));
        out.push(
          state
            ? {
                address,
                exists: true,
                creator: state.creator.toBase58(),
                isMigrated: state.isMigrated !== 0,
                migrationProgress: state.migrationProgress,
              }
            : { address, exists: false, creator: '', isMigrated: false },
        );
      }
      return out;
    },
    async getTokenAccounts(owner) {
      const out: string[] = [];
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const res = await connection.getTokenAccountsByOwner(
          new PublicKey(owner),
          { programId },
          'confirmed',
        );
        for (const { pubkey } of res.value) out.push(pubkey.toBase58());
      }
      return out;
    },
  };
}

const launchpadRowSchema = z.object({
  slug: z.string(),
  launchpad_coin_config: z.string().nullable(),
  launchpad_coin_mint: z.string().nullable(),
  creator_wallet_ref: z.string().nullable(),
});
const PAGE_SIZE = 500;

export interface SupabaseTargetSourceOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
  /** Pool address of a (quote mint, base mint, config) triple. Default: the DBC SDK derivation. */
  derivePoolAddress?: (baseMint: PublicKey, config: PublicKey) => PublicKey;
  /** Public key of a keystore creator wallet reference. */
  resolveCreator: (ref: string) => Promise<string | undefined>;
  config: WatchConfig;
}

function rowRef(raw: unknown, index: number): string {
  const slug = (raw as { slug?: unknown } | null)?.slug;
  return typeof slug === 'string' && /^[a-z0-9-]{1,64}$/.test(slug) ? slug : `row ${index}`;
}

/**
 * Reads the launched pools and their creator wallets from the `launchpads` table over PostgREST
 * (service role key, read only). Dynamic targets only: the fixed FORGE accounts are passed to
 * the watcher separately. A row that cannot be used is skipped and reported (`invalid`); only a
 * failed request or a non-array answer fails the whole load.
 */
export function createSupabaseTargetSource(opts: SupabaseTargetSourceOptions): WatchTargetSource {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    async load() {
      const raws: unknown[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const url =
          `${opts.supabaseUrl.replace(/\/+$/, '')}/rest/v1/launchpads` +
          `?select=slug,launchpad_coin_config,launchpad_coin_mint,creator_wallet_ref` +
          `&launchpad_coin_mint=not.is.null&launchpad_coin_config=not.is.null` +
          `&order=created_at.asc&limit=${PAGE_SIZE}&offset=${offset}`;
        const res = await doFetch(url, {
          headers: {
            apikey: opts.serviceRoleKey,
            authorization: `Bearer ${opts.serviceRoleKey}`,
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`launchpads query failed with status ${res.status}`);
        const page = z.array(z.unknown()).parse(await res.json());
        raws.push(...page);
        if (page.length < PAGE_SIZE) break;
      }

      const derive = opts.derivePoolAddress ?? (await defaultDerive());
      const pools: WatchedPool[] = [];
      const creators: { address: string; label: string }[] = [];
      const seenCreators = new Set<string>();
      const invalid: InvalidTarget[] = [];
      for (const [index, raw] of raws.entries()) {
        const ref = rowRef(raw, index);
        const parsed = launchpadRowSchema.safeParse(raw);
        if (!parsed.success) {
          invalid.push({ ref, reason: 'malformed_row' });
          continue;
        }
        const row = parsed.data;
        if (!row.launchpad_coin_mint || !row.launchpad_coin_config) continue;
        let address: string;
        try {
          address = derive(
            new PublicKey(row.launchpad_coin_mint),
            new PublicKey(row.launchpad_coin_config),
          ).toBase58();
        } catch {
          invalid.push({ ref, reason: 'invalid_address' });
          continue;
        }
        let creator: string | undefined;
        if (row.creator_wallet_ref) {
          try {
            creator = await opts.resolveCreator(row.creator_wallet_ref);
          } catch {
            invalid.push({ ref, reason: 'creator_unresolved' });
          }
        }
        pools.push({
          address,
          label: row.slug,
          ...(creator ? { expectedCreator: creator } : {}),
        });
        if (creator && !seenCreators.has(creator)) {
          seenCreators.add(creator);
          creators.push({ address: creator, label: `creator wallet ${row.slug}` });
        }
      }
      return {
        accounts: buildCreatorAccounts(creators, opts.config),
        pools,
        ...(invalid.length > 0 ? { invalid } : {}),
      };
    },
  };
}

async function defaultDerive(): Promise<(baseMint: PublicKey, config: PublicKey) => PublicKey> {
  const { deriveDbcPoolAddress } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  return (baseMint, config) => deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
}
