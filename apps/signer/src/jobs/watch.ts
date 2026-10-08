/*
 * On-chain monitoring job (docs/OPERATIONS.md "Alerts", docs/SECURITY.md "creator transfer").
 *
 * Polls the FORGE accounts and the FORGE launchpad pools and raises Telegram alerts for:
 *   - balance below a threshold (payer, cashbox, vault, fee wallet, creator wallets' rent SOL);
 *   - an account that is not rent-exempt (devnet finding: a fee recipient below the rent minimum
 *     makes the whole swap transaction fail);
 *   - an unexpected outflow from the vault or the cashbox (read from the transactions, so a
 *     withdrawal masked by a deposit in the same interval is still seen);
 *   - a pool whose creator role moved (transferPoolCreator), a graduated pool, a vanished pool;
 *   - a streak of failed RPC cycles.
 *
 * Every detection is a pure function of fixtures-friendly inputs (snapshots in, `Detection[]`
 * out). The I/O is behind the small `WatchRpc` and `WatchTargetSource` interfaces; the adapters
 * for web3.js, the DBC SDK and Supabase are at the bottom of the file.
 *
 * State is kept in memory only (no migration provides a table for it): `exportWatchState` /
 * `importWatchState` give a JSON form the caller can persist. After a restart the first
 * observation of a pool or of an outflow cursor is silent: nothing is alerted retroactively.
 *
 * The job is read-only: it never signs and never sends a transaction.
 */
import { PublicKey, type Connection } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { z } from 'zod';
import type { Alerter, AlertLevel } from '../alerts.js';

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
  /** Read the account's transactions and alert on outflows. */
  watchOutflows?: boolean;
  /** Recipients that make an outflow normal (e.g. the multisig vault for the cashbox). */
  allowedDestinations?: readonly string[];
}

export interface WatchedPool {
  address: string;
  label: string;
  /** Creator wallet the pool must keep. Absent: the creator seen first is the reference. */
  expectedCreator?: string;
}

export interface WatchTargets {
  accounts: WatchedAccount[];
  pools: WatchedPool[];
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
}

export interface WatchRpc {
  getAccounts(addresses: readonly string[]): Promise<(AccountSnapshot | null)[]>;
  getRentExemptMinimum(dataLength: number): Promise<bigint>;
  /** Newest first. `until` excludes that signature and everything older. */
  getSignatures(address: string, opts: { until?: string; limit: number }): Promise<SignatureLite[]>;
  getTransaction(signature: string): Promise<TxLite | null>;
  /** One snapshot per address, `exists: false` when the account is gone. */
  getPools(addresses: readonly string[]): Promise<PoolSnapshot[]>;
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
  /** Signatures read per account and cycle. */
  signatureLimit: number;
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

/** Account list for the fixed FORGE addresses. */
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
      details: { pool: pool.address },
    });
  }
  return out;
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
// State and cycle

export interface WatchState {
  rpcErrorStreak: number;
  /** Newest signature already examined, per watched address. */
  outflowCursor: Map<string, string>;
  pools: Map<string, PoolMemory>;
}

export function createWatchState(): WatchState {
  return { rpcErrorStreak: 0, outflowCursor: new Map(), pools: new Map() };
}

export interface SerializedWatchState {
  outflowCursor: Record<string, string>;
  pools: Record<string, PoolMemory>;
}

export function exportWatchState(state: WatchState): SerializedWatchState {
  return {
    outflowCursor: Object.fromEntries(state.outflowCursor),
    pools: Object.fromEntries(state.pools),
  };
}

export function importWatchState(data: SerializedWatchState): WatchState {
  const state = createWatchState();
  for (const [k, v] of Object.entries(data.outflowCursor)) state.outflowCursor.set(k, v);
  for (const [k, v] of Object.entries(data.pools)) state.pools.set(k, v);
  return state;
}

/** Remembers signatures sent by FORGE jobs so their outflows are not flagged. */
export interface ExpectedSignatures {
  /** Call right after signing and before sending, so the watcher cannot see the tx first. */
  expect(signature: string): void;
  has(signature: string): boolean;
}

export function createExpectedSignatures(
  ttlMs = 24 * 60 * 60_000,
  now: () => number = Date.now,
): ExpectedSignatures {
  const map = new Map<string, number>();
  return {
    expect(signature) {
      const t = now();
      for (const [sig, at] of map) if (t - at > ttlMs) map.delete(sig);
      map.set(signature, t);
    },
    has(signature) {
      const at = map.get(signature);
      return at !== undefined && now() - at <= ttlMs;
    },
  };
}

export interface WatchLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WatchDeps {
  rpc: WatchRpc;
  targets: WatchTargetSource;
  alerter: Alerter;
  logger: WatchLogger;
  config: WatchConfig;
  state: WatchState;
  expected?: ExpectedSignatures;
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

async function checkOutflows(
  deps: WatchDeps,
  account: WatchedAccount,
  out: Detection[],
): Promise<void> {
  const cursor = deps.state.outflowCursor.get(account.address);
  if (cursor === undefined) {
    // First sight: remember where we are, do not alert on history.
    const latest = await deps.rpc.getSignatures(account.address, { limit: 1 });
    const newest = latest[0];
    if (newest) deps.state.outflowCursor.set(account.address, newest.signature);
    else deps.state.outflowCursor.set(account.address, '');
    return;
  }
  const limit = deps.config.signatureLimit;
  const sigs = await deps.rpc.getSignatures(account.address, {
    ...(cursor ? { until: cursor } : {}),
    limit,
  });
  if (sigs.length === 0) return;
  if (sigs.length >= limit) {
    out.push({
      code: 'OUTFLOW_BACKLOG',
      level: 'high',
      message: `More than ${limit} new transactions on the ${account.label} in one cycle: some may be skipped`,
      dedupKey: `backlog:${account.address}`,
      details: { account: account.address, limit },
    });
  }
  // Oldest first, so the cursor only moves past transactions that were really examined.
  const ordered = [...sigs].reverse();
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
  out.push(
    ...detectOutflows(account, txs, {
      toleranceLamports: deps.config.outflowToleranceLamports,
      ...(deps.expected ? { isExpectedSignature: (sig: string) => deps.expected!.has(sig) } : {}),
    }),
  );
  if (lastExamined !== undefined) deps.state.outflowCursor.set(account.address, lastExamined);
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

/**
 * One monitoring pass. Stage failures are collected, not thrown: the other stages still run.
 * The cycle counts as failed (RPC streak) when any stage threw.
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

  let targets: WatchTargets = { accounts: [], pools: [] };
  await stage('targets', async () => {
    targets = await deps.targets.load();
  });
  await stage('accounts', () => checkAccounts(deps, targets.accounts, detections));
  for (const account of targets.accounts.filter((a) => a.watchOutflows)) {
    await stage(`outflows:${account.role}`, () => checkOutflows(deps, account, detections));
  }
  await stage('pools', () => checkPools(deps, targets.pools, detections));

  if (errors.length > 0) deps.state.rpcErrorStreak += 1;
  else deps.state.rpcErrorStreak = 0;
  const streak = detectRpcErrorStreak(
    deps.state.rpcErrorStreak,
    deps.config.rpcErrorStreak,
    errors[errors.length - 1],
  );
  if (streak) detections.push(streak);

  for (const d of detections) {
    await deps.alerter.alert(d.level, d.code, d.message, d.details, { dedupKey: d.dedupKey });
  }
  return {
    detections,
    errors,
    accountsChecked: targets.accounts.length,
    poolsChecked: targets.pools.length,
  };
}

export interface WatchHandle {
  stop(): void;
  /** Resolves when the loop has stopped. */
  done: Promise<void>;
}

/** Runs cycles forever: `intervalMs` apart, with exponential backoff while cycles fail. */
export function startWatch(
  deps: WatchDeps,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  random: () => number = Math.random,
): WatchHandle {
  const controller = new AbortController();
  const loop = async (): Promise<void> => {
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
        { limit: opts.limit, ...(opts.until ? { until: opts.until } : {}) },
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
  /** Fixed FORGE accounts, always returned. */
  staticAccounts: readonly WatchedAccount[];
}

/**
 * Reads the launched pools and their creator wallets from the `launchpads` table over PostgREST
 * (service role key, read only), and merges them with the fixed accounts.
 */
export function createSupabaseTargetSource(opts: SupabaseTargetSourceOptions): WatchTargetSource {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    async load() {
      const rows: z.infer<typeof launchpadRowSchema>[] = [];
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
        const page = z.array(launchpadRowSchema).parse(await res.json());
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }

      const derive = opts.derivePoolAddress ?? (await defaultDerive());
      const pools: WatchedPool[] = [];
      const creators: { address: string; label: string }[] = [];
      const seenCreators = new Set<string>();
      for (const row of rows) {
        if (!row.launchpad_coin_mint || !row.launchpad_coin_config) continue;
        const creator = row.creator_wallet_ref
          ? await opts.resolveCreator(row.creator_wallet_ref)
          : undefined;
        const address = derive(
          new PublicKey(row.launchpad_coin_mint),
          new PublicKey(row.launchpad_coin_config),
        ).toBase58();
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
        accounts: [...opts.staticAccounts, ...buildCreatorAccounts(creators, opts.config)],
        pools,
      };
    },
  };
}

async function defaultDerive(): Promise<(baseMint: PublicKey, config: PublicKey) => PublicKey> {
  const { deriveDbcPoolAddress } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  return (baseMint, config) => deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
}
