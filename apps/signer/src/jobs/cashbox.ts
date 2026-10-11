/**
 * Cashbox sweep job (docs/INTERFACES.md §8 "Cashbox", docs/OPERATIONS.md).
 *
 * The cashbox (FORGE_CASHBOX_WALLET, key in the keystore) receives client payments. Every run
 * (default 24 h) it keeps a floor and sweeps the excess to the FORGE multisig vault:
 *
 *   floor  = rent-exempt minimum (read from the cluster)
 *          + configured reserve (refunds buffer, fees)
 *          + outstanding refund liabilities (confirmed payments of jobs that can still be
 *            refunded automatically: spec_ready / paid / building / failed at build)
 *          + fee buffer of the sweep itself
 *   excess = spendable balance (lower of confirmed and finalized) - floor
 *   sweep  = excess, capped by `maxSweepLamports`, only if excess >= `minSweepLamports`
 *
 * The balance never goes below the floor: the amount is computed from the lowest balance, the
 * transaction is a single policy-checked transfer whose fee is covered by the fee buffer, a sweep
 * in flight blocks the next one until it is FINALIZED (a confirmed sweep is not recorded yet),
 * a recent unfinalized `forge:cashbox-sweep` transaction on the cashbox (e.g. sent by another
 * instance or before a lost journal) blocks planning, and the refunds job (the only other
 * spender) shares the same, required, `walletLock`. Dry-run mode computes and logs the plan
 * without signing. Kill switches: env `paused`, flag `cashbox_sweep_paused` (fail closed).
 */
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { OPS } from '@forge/shared';
import type { SignerCore } from '../core-adapter.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  JOB_FLAGS,
  JobError,
  alertAbnormalPause,
  assertSolTransferTx,
  awaitSettlement,
  broadcast,
  checkPaused,
  checkSettlement,
  createAnnouncer,
  describeError,
  formatSol,
  parseBoolEnv,
  parseLamports,
  parseLamportsEnv,
  parsePositiveIntEnv,
  realSleep,
  requireRoleRef,
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
  type Mutex,
  type PostgrestClient,
  type RetryOptions,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';

export interface CashboxStore {
  /**
   * Sum (lamports) of the payments the refunds job may still have to pay back: payments in
   * `confirmed` whose job is `spec_ready`, `paid`, `building`, or `failed` at the build stage.
   */
  outstandingRefundLiabilities(): Promise<bigint>;
}

/** Kept on top of the floor for the sweep's own fee (one signature = 5 000 lamports today). */
export const SWEEP_FEE_BUFFER_LAMPORTS = 10_000n;
export const SWEEP_MEMO = 'forge:cashbox-sweep';
export const SWEEP_JOURNAL_KEY = 'sweep';
/** Recent cashbox signatures scanned for an unfinalized sweep before planning a new one. */
export const SWEEP_SCAN_LIMIT = 25;

export interface SweepInput {
  balance: bigint;
  rentExemptLamports: bigint;
  reserveLamports: bigint;
  liabilitiesLamports: bigint;
  feeBufferLamports: bigint;
  minSweepLamports: bigint;
  maxSweepLamports?: bigint | null;
}

export type SweepPlan =
  | { sweep: true; amount: bigint; floor: bigint; excess: bigint }
  | { sweep: false; reason: 'below_reserve' | 'below_threshold'; floor: bigint; excess: bigint };

/** Pure: what to sweep. Invariant: balance - amount >= floor (floor includes the fee buffer). */
export function planSweep(input: SweepInput): SweepPlan {
  for (const [name, v] of Object.entries(input)) {
    if (typeof v === 'bigint' && v < 0n)
      throw new JobError('INVALID_AMOUNT', `${name} is negative`);
  }
  if (input.minSweepLamports <= 0n) throw new JobError('CONFIG', 'minimum sweep must be positive');
  const floor =
    input.rentExemptLamports +
    input.reserveLamports +
    input.liabilitiesLamports +
    input.feeBufferLamports;
  if (input.balance <= floor) return { sweep: false, reason: 'below_reserve', floor, excess: 0n };
  const excess = input.balance - floor;
  if (excess < input.minSweepLamports) {
    return { sweep: false, reason: 'below_threshold', floor, excess };
  }
  const cap = input.maxSweepLamports ?? null;
  const amount = cap !== null && cap < excess ? cap : excess;
  return { sweep: true, amount, floor, excess };
}

export const SweepJournalEntry = z.object({
  v: z.literal(1),
  inFlight: z
    .object({
      signature: z.string(),
      rawTx: z.string(),
      lastValidBlockHeight: z.number().int().nonnegative(),
      lamports: z.string().regex(/^[0-9]+$/),
      startedAt: z.string(),
    })
    .nullable(),
  lastSweep: z
    .object({ signature: z.string(), lamports: z.string().regex(/^[0-9]+$/), at: z.string() })
    .nullable(),
});
export type SweepJournalEntry = z.infer<typeof SweepJournalEntry>;

export interface CashboxConfig {
  /** FORGE_CASHBOX_WALLET. */
  cashbox: PublicKey;
  /** FORGE_MULTISIG_VAULT. */
  vault: PublicKey;
  /** Buffer always kept on the cashbox on top of rent and liabilities. */
  reserveLamports: bigint;
  /** Sweep only when the excess reaches this amount. */
  minSweepLamports: bigint;
  /** Optional cap per sweep. */
  maxSweepLamports?: bigint | null;
  /** Compute and log only: never sign or send. */
  dryRun: boolean;
  paused?: boolean;
  settle?: Partial<SettleTiming>;
}

export interface CashboxDeps {
  store: CashboxStore;
  rpc: SolanaRpc;
  core: Pick<SignerCore, 'buildSolTransferTx'>;
  keystore: KeystoreLike;
  journal: Journal<SweepJournalEntry>;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  config: CashboxConfig;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Shared with the refunds job (both spend from the cashbox). Required. */
  walletLock: Mutex;
  /** Called with each sweep signature right before it is (re)broadcast by this process. Required. */
  onBeforeSend: BeforeSendHook;
}

export type CashboxOutcome =
  | { result: 'swept'; signature: string; lamports: bigint }
  | { result: 'dry_run'; lamports: bigint; floor: bigint }
  | { result: 'below_reserve'; balance: bigint; floor: bigint }
  | { result: 'below_threshold'; excess: bigint }
  | { result: 'in_flight'; signature: string; state: string }
  | { result: 'expired'; signature: string }
  | { result: 'failed'; signature: string; error: string }
  | { result: 'skipped'; reason: string };

export interface CashboxRunReport {
  status: 'ran' | 'paused' | 'busy' | 'error';
  reason?: string;
  outcome?: CashboxOutcome;
}

export interface CashboxJob {
  runOnce(): Promise<CashboxRunReport>;
}

export function createCashboxJob(deps: CashboxDeps): CashboxJob {
  const { store, rpc, core, keystore, journal, alerter, logger: log, config } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const settleTiming = { ...DEFAULT_SETTLE, ...config.settle };
  let running = false;

  if (config.cashbox.equals(config.vault)) {
    throw new JobError('CONFIG', 'the cashbox and the vault must differ');
  }
  if (!deps.walletLock || typeof deps.walletLock.runExclusive !== 'function') {
    throw new JobError('CONFIG', 'walletLock is required (shared with the refunds job)');
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
  const empty = (): SweepJournalEntry => ({ v: 1, inFlight: null, lastSweep: null });

  /** Settles a sweep in flight. Returns an outcome when the run must stop there. */
  async function settleInFlight(
    entry: SweepJournalEntry,
    wait: boolean,
  ): Promise<{ entry: SweepJournalEntry; outcome?: CashboxOutcome }> {
    const inFlight = entry.inFlight;
    if (!inFlight) return { entry };
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
    if (s.kind === 'finalized') {
      const next: SweepJournalEntry = {
        v: 1,
        inFlight: null,
        lastSweep: { signature: inFlight.signature, lamports: inFlight.lamports, at: iso() },
      };
      await journal.put(SWEEP_JOURNAL_KEY, next);
      const lamports = BigInt(inFlight.lamports);
      log.info(
        { signature: inFlight.signature, lamports: inFlight.lamports },
        'cashbox swept to the vault (finalized)',
      );
      return { entry: next, outcome: { result: 'swept', signature: inFlight.signature, lamports } };
    }
    if (s.kind === 'failed') {
      const next: SweepJournalEntry = { ...entry, inFlight: null };
      await journal.put(SWEEP_JOURNAL_KEY, next);
      await alert(
        'high',
        'cashbox_sweep_failed',
        'The cashbox sweep failed on-chain (nothing was moved)',
        { signature: inFlight.signature, error: s.error },
        'cashbox_sweep_failed',
      );
      return {
        entry: next,
        outcome: { result: 'failed', signature: inFlight.signature, error: s.error },
      };
    }
    if (s.kind === 'expired') {
      const next: SweepJournalEntry = { ...entry, inFlight: null };
      await journal.put(SWEEP_JOURNAL_KEY, next);
      log.warn({ signature: inFlight.signature }, 'cashbox sweep expired unsent');
      return {
        entry: next,
        ...(wait ? { outcome: { result: 'expired', signature: inFlight.signature } } : {}),
      };
    }
    if (!wait && s.kind === 'pending' && announce(inFlight.signature)) {
      try {
        await rpc.sendRawTransaction(raw);
      } catch (err) {
        log.debug({ err: describeError(err) }, 'sweep rebroadcast failed');
      }
    }
    return {
      entry,
      outcome: { result: 'in_flight', signature: inFlight.signature, state: s.kind },
    };
  }

  async function runUnlocked(): Promise<CashboxRunReport> {
    let cashboxRef: string | undefined;
    if (!config.dryRun) {
      try {
        ({ ref: cashboxRef } = await requireRoleRef(keystore, 'cashbox', config.cashbox));
      } catch (err) {
        await alert('high', 'cashbox_config', 'Cashbox sweep stopped: cashbox key problem', {
          error: describeError(err).message,
        });
        return { status: 'error', reason: 'cashbox_key' };
      }
    }

    // 1. A sweep in flight blocks everything until it is finalized (a confirmed one can still be
    //    rolled back, and its amount is not visible in the finalized balance yet).
    let entry = (await journal.get(SWEEP_JOURNAL_KEY)) ?? empty();
    if (entry.inFlight) {
      const settled = await settleInFlight(entry, false);
      entry = settled.entry;
      if (settled.outcome) return { status: 'ran', outcome: settled.outcome };
    }

    // 1b. A sweep this journal does not know about (another instance, a lost journal) that is not
    //     finalized yet: never plan on top of it.
    const recent = await withRetry(
      () => rpc.getRecentSignatures(config.cashbox, SWEEP_SCAN_LIMIT),
      retry,
    );
    const unfinalized = recent.find(
      (r) => !r.failed && r.confirmationStatus !== 'finalized' && r.memo?.includes(SWEEP_MEMO),
    );
    if (unfinalized) {
      await alert(
        'high',
        'cashbox_sweep_unfinalized',
        'An unfinalized cashbox sweep is on-chain that this signer did not record: no new sweep until it is finalized',
        { signature: unfinalized.signature },
        `cashbox_sweep_unfinalized:${unfinalized.signature}`,
      );
      return { status: 'ran', outcome: { result: 'skipped', reason: 'unfinalized_sweep' } };
    }

    // 2. Floor and excess.
    const balance = await spendableBalance(rpc, config.cashbox, retry);
    const rentExempt = await withRetry(() => rpc.getMinimumBalanceForRentExemption(0), retry);
    const liabilities = await store.outstandingRefundLiabilities();
    const plan = planSweep({
      balance,
      rentExemptLamports: rentExempt,
      reserveLamports: config.reserveLamports,
      liabilitiesLamports: liabilities,
      feeBufferLamports: SWEEP_FEE_BUFFER_LAMPORTS,
      minSweepLamports: config.minSweepLamports,
      maxSweepLamports: config.maxSweepLamports ?? null,
    });
    const required = rentExempt + config.reserveLamports + liabilities;
    if (balance < required) {
      await alert(
        'high',
        'cashbox_low_balance',
        'The cashbox balance is below its reserve (rent + buffer + refunds owed): fund it',
        {
          balance: formatSol(balance),
          required: formatSol(required),
          liabilities: formatSol(liabilities),
        },
        'cashbox_low_balance:reserve',
      );
    }
    const planLog = {
      balance: balance.toString(),
      floor: plan.floor.toString(),
      liabilities: liabilities.toString(),
      excess: plan.excess.toString(),
    };
    if (!plan.sweep) {
      log.info({ ...planLog, reason: plan.reason }, 'no cashbox sweep');
      return {
        status: 'ran',
        outcome:
          plan.reason === 'below_reserve'
            ? { result: 'below_reserve', balance, floor: plan.floor }
            : { result: 'below_threshold', excess: plan.excess },
      };
    }

    // 3. The vault must end rent-exempt (a transfer leaving it below rent fails).
    const vaultBalance = await withRetry(() => rpc.getBalance(config.vault, 'confirmed'), retry);
    if (vaultBalance + plan.amount < rentExempt) {
      return { status: 'ran', outcome: { result: 'skipped', reason: 'vault_not_rent_exempt' } };
    }

    if (config.dryRun) {
      log.info({ ...planLog, amount: plan.amount.toString() }, 'dry run: would sweep the cashbox');
      return {
        status: 'ran',
        outcome: { result: 'dry_run', lamports: plan.amount, floor: plan.floor },
      };
    }
    if (!cashboxRef) throw new JobError('CONFIG', 'cashbox key missing');

    // 4. Build, check, sign, journal, send, confirm.
    const tx = core.buildSolTransferTx({
      from: config.cashbox,
      to: config.vault,
      lamports: plan.amount,
      memo: SWEEP_MEMO,
    });
    const { blockhash, lastValidBlockHeight } = await withRetry(
      () => rpc.getLatestBlockhash(),
      retry,
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = config.cashbox;
    assertSolTransferTx(tx, {
      from: config.cashbox,
      to: config.vault,
      lamports: plan.amount,
      memo: SWEEP_MEMO,
    });
    const { raw, signature } = await signWithKeystore(keystore, tx, [
      { ref: cashboxRef, expected: config.cashbox },
    ]);
    entry = {
      ...entry,
      inFlight: {
        signature,
        rawTx: raw.toString('base64'),
        lastValidBlockHeight,
        lamports: plan.amount.toString(),
        startedAt: iso(),
      },
    };
    await journal.put(SWEEP_JOURNAL_KEY, entry);

    if (!announce(signature)) {
      return { status: 'ran', outcome: { result: 'in_flight', signature, state: 'not_announced' } };
    }
    const sent = await broadcast(rpc, raw, retry);
    if (sent.status === 'rejected') {
      await alert(
        'high',
        'cashbox_sweep_rejected',
        'The RPC rejected the cashbox sweep (simulation failed)',
        { signature, reason: sent.reason },
        'cashbox_sweep_rejected',
      );
      return { status: 'ran', outcome: { result: 'failed', signature, error: sent.reason } };
    }
    log.info({ ...planLog, signature, amount: plan.amount.toString() }, 'cashbox sweep sent');
    const settled = await settleInFlight(entry, true);
    return { status: 'ran', ...(settled.outcome ? { outcome: settled.outcome } : {}) };
  }

  return {
    async runOnce() {
      if (running) return { status: 'busy' };
      running = true;
      try {
        const pause = await checkPaused(deps.flags, JOB_FLAGS.cashbox, config.paused, log);
        if (pause.paused) {
          log.info({ reason: pause.reason }, 'cashbox sweep paused');
          await alertAbnormalPause(alerter, log, 'cashbox', JOB_FLAGS.cashbox, pause.reason);
          return { status: 'paused', reason: pause.reason };
        }
        try {
          return await deps.walletLock.runExclusive(runUnlocked);
        } catch (err) {
          const summary = describeError(err);
          const policy =
            err instanceof JobError && (err.code === 'TX_POLICY' || err.code === 'SIGNER_MISMATCH');
          log.error({ err: summary }, 'cashbox run failed');
          await alert(
            'high',
            policy ? 'cashbox_policy_violation' : 'cashbox_run_failed',
            policy
              ? 'The cashbox sweep transaction was refused before signing (policy check)'
              : 'The cashbox sweep run failed (database or RPC unavailable?)',
            { error: summary.message },
            'cashbox_run_failed',
          );
          return { status: 'error', reason: summary.message };
        }
      } finally {
        running = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Configuration from the environment

export const DEFAULT_CASHBOX_RESERVE_LAMPORTS = 100_000_000n; // 0.1 SOL
export const DEFAULT_MIN_SWEEP_LAMPORTS = 100_000_000n; // 0.1 SOL
export const DEFAULT_CASHBOX_INTERVAL_MS = OPS.claimIntervalHours * 60 * 60_000;

/**
 * SIGNER_CASHBOX_RESERVE_LAMPORTS (default 0.1 SOL), SIGNER_CASHBOX_MIN_SWEEP_LAMPORTS (default
 * 0.1 SOL), SIGNER_CASHBOX_MAX_SWEEP_LAMPORTS (optional), SIGNER_CASHBOX_DRY_RUN (default TRUE:
 * sweeping must be enabled explicitly), SIGNER_CASHBOX_INTERVAL_HOURS (default 24),
 * SIGNER_CASHBOX_PAUSED (default false). Addresses come from @forge/core `requireAddresses`.
 */
export function cashboxConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  addresses: { cashbox: PublicKey; vault: PublicKey },
): { config: CashboxConfig; intervalMs: number } {
  const max = env.SIGNER_CASHBOX_MAX_SWEEP_LAMPORTS;
  return {
    config: {
      cashbox: addresses.cashbox,
      vault: addresses.vault,
      reserveLamports: parseLamportsEnv(
        env.SIGNER_CASHBOX_RESERVE_LAMPORTS,
        'SIGNER_CASHBOX_RESERVE_LAMPORTS',
        DEFAULT_CASHBOX_RESERVE_LAMPORTS,
      ),
      minSweepLamports: parseLamportsEnv(
        env.SIGNER_CASHBOX_MIN_SWEEP_LAMPORTS,
        'SIGNER_CASHBOX_MIN_SWEEP_LAMPORTS',
        DEFAULT_MIN_SWEEP_LAMPORTS,
      ),
      maxSweepLamports:
        max === undefined || max === ''
          ? null
          : parseLamportsEnv(max, 'SIGNER_CASHBOX_MAX_SWEEP_LAMPORTS'),
      dryRun: parseBoolEnv(env.SIGNER_CASHBOX_DRY_RUN, 'SIGNER_CASHBOX_DRY_RUN', true),
      paused: parseBoolEnv(env.SIGNER_CASHBOX_PAUSED, 'SIGNER_CASHBOX_PAUSED', false),
    },
    intervalMs:
      parsePositiveIntEnv(
        env.SIGNER_CASHBOX_INTERVAL_HOURS,
        'SIGNER_CASHBOX_INTERVAL_HOURS',
        OPS.claimIntervalHours,
      ) *
      60 *
      60_000,
  };
}

// ---------------------------------------------------------------------------------------
// Supabase implementation of the store

/** Job statuses whose confirmed payment may still be refunded automatically. */
export const REFUNDABLE_JOB_STATUSES = ['spec_ready', 'paid', 'building', 'failed'] as const;

const LiabilityRow = z.object({
  lamports: z.union([z.string(), z.number()]),
  jobs: z.object({ status: z.string(), failed_stage: z.string().nullable() }),
});

/** Pure: liabilities from payment rows joined with their job. */
export function sumLiabilities(rows: Array<z.infer<typeof LiabilityRow>>): bigint {
  let total = 0n;
  for (const r of rows) {
    const status = r.jobs.status;
    const refundable =
      status === 'spec_ready' ||
      status === 'paid' ||
      status === 'building' ||
      (status === 'failed' && r.jobs.failed_stage === 'build');
    if (refundable) total += parseLamports(r.lamports);
  }
  return total;
}

export function createPostgrestCashboxStore(db: PostgrestClient, pageSize = 1000): CashboxStore {
  return {
    async outstandingRefundLiabilities() {
      let total = 0n;
      for (let offset = 0; ; offset += pageSize) {
        const rows = await db.select('payments', {
          select: 'id,lamports::text,jobs!inner(status,failed_stage)',
          status: 'eq.confirmed',
          'jobs.status': `in.(${REFUNDABLE_JOB_STATUSES.join(',')})`,
          order: 'created_at.asc,id.asc',
          limit: String(pageSize),
          offset: String(offset),
        });
        const parsed = z.array(LiabilityRow).safeParse(rows);
        if (!parsed.success) throw new JobError('DB_RESPONSE', 'unexpected liability rows');
        total += sumLiabilities(parsed.data);
        if (parsed.data.length < pageSize) return total;
      }
    },
  };
}
