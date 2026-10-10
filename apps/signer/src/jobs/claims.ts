/**
 * Creator-fee claims job (tasks/05-SIGNER.md, docs/OPERATIONS.md, docs/SECURITY.md §5).
 *
 * FORGE is the pool creator of each launchpad's own coin (D6: creatorTradingFeePercentage = 25),
 * through a dedicated creator wallet per launchpad held in the keystore
 * (`launchpads.creator_wallet_ref`). Every run (default 24 h), for each such pool:
 *   1. a claim still in flight is settled first (never two claims of a pool in flight);
 *   2. the pool is read: missing pool -> skip (launch never signed); creator changed ->
 *      IMMEDIATE alert (transferPoolCreator, SECURITY §5) and no claim;
 *   3. if the unclaimed creator share (SOL side) reaches the threshold, the claim is built by core
 *      (`claimCreatorTradingFeeToReceiver`, receiver = FORGE multisig vault), checked against the
 *      claim policy, signed by the creator wallet (+ the payer wallet when it pays the fees),
 *      journaled, sent and confirmed by polling.
 * The creator signs, the vault only receives: no Squads proposal is needed.
 * Partner fees are NOT claimed here: they belong to the client (`feeClaimer` = client wallet),
 * who claims them from the dashboard.
 *
 * Results are kept in a per-pool journal (last claim, pending-since, failures); an alert is raised
 * on any failure and when fees above the threshold stay unclaimed for more than 48 h.
 * Every launchpad is read on every run; at most `maxPerRun` claims are built per run, and the
 * next run starts where the previous one stopped, so no pool is starved. The kill switch is read
 * at the start of the run and again before each claim is signed.
 * After graduation, the DBC creator share stays claimable here; the fees of the creator's locked
 * DAMM v2 position are not claimed automatically yet (core has no builder for them): a one-time
 * alert per pool asks for a manual claim.
 */
import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { OPS, type LaunchpadStatus } from '@forge/shared';
import { creatorRole } from '../keystore.js';
import type { SignerCore } from '../core-adapter.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  JOB_FLAGS,
  JobError,
  alertAbnormalPause,
  assertCreatorClaimTx,
  awaitSettlement,
  broadcast,
  checkPaused,
  checkSettlement,
  createAnnouncer,
  describeError,
  formatSol,
  parseAddress,
  parseBoolEnv,
  parseLamportsEnv,
  parsePositiveIntEnv,
  realSleep,
  requireRoleRef,
  sendAlert,
  signWithKeystore,
  withRetry,
  type BeforeSendHook,
  type FlagsReader,
  type JobAlerter,
  type JobLogger,
  type Journal,
  type KeystoreLike,
  type KeystoreSignerRef,
  type PauseReason,
  type PostgrestClient,
  type RetryOptions,
  type Settlement,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';

export interface CreatorLaunchpad {
  id: string;
  status: LaunchpadStatus;
  coinConfig: string;
  coinMint: string;
  creatorWalletRef: string;
}

export interface ClaimsStore {
  /** Launchpads whose coin pool may exist (coin config, coin mint and creator ref all set). */
  listCreatorLaunchpads(): Promise<CreatorLaunchpad[]>;
}

const InFlightClaim = z.object({
  signature: z.string(),
  rawTx: z.string(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  claimableQuote: z.string().regex(/^[0-9]+$/),
  startedAt: z.string(),
});

export const ClaimJournalEntry = z.object({
  v: z.literal(1),
  pool: z.string(),
  launchpadId: z.string(),
  inFlight: InFlightClaim.nullable(),
  lastClaim: z
    .object({ signature: z.string(), quote: z.string().regex(/^[0-9]+$/), at: z.string() })
    .nullable(),
  /** First time the claimable amount was seen above the threshold without a successful claim. */
  pendingSince: z.string().nullable(),
  /** When the one-time "graduated: claim the DAMM v2 position fees by hand" alert was sent. */
  graduationNoticeAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type ClaimJournalEntry = z.infer<typeof ClaimJournalEntry>;

/** Accounts the payer may have to fund in one claim: the temporary WSOL ATA and the vault's ATA. */
export const CLAIM_TOKEN_ACCOUNTS_FUNDED = 2n;
export const TOKEN_ACCOUNT_SIZE = 165;
export const CLAIM_FEE_BUFFER_LAMPORTS = 20_000n;

export interface ClaimsConfig {
  /** FORGE_MULTISIG_VAULT (from `requireAddresses` of @forge/core at startup). */
  vault: PublicKey;
  /** Claim only when the unclaimed creator share (lamports) reaches this amount. */
  minClaimLamports: bigint;
  /** Who pays the network fee and the temporary accounts' rent: the payer wallet or the creator. */
  feePayer: 'payer' | 'creator';
  /** Alert when fees above the threshold stay unclaimed longer than this (default 48 h). */
  unclaimedAlertMs?: number;
  /**
   * Claims built (and sent) per run, default 500. Every launchpad is still read on every run, and
   * the next run starts after the last launchpad processed, so the cap never starves a pool.
   */
  maxPerRun?: number;
  paused?: boolean;
  settle?: Partial<SettleTiming>;
}

export interface ClaimsDeps {
  store: ClaimsStore;
  core: Pick<
    SignerCore,
    'dbcProgramId' | 'coinPoolAddress' | 'readCreatorPool' | 'buildCreatorClaimTx'
  >;
  rpc: SolanaRpc;
  keystore: KeystoreLike;
  journal: Journal<ClaimJournalEntry>;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  config: ClaimsConfig;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Called with each claim signature right before it is (re)broadcast by this process (the
   * watcher's expected signatures). Required: wiring the job without it is a startup error.
   */
  onBeforeSend: BeforeSendHook;
}

export type ClaimOutcome = {
  launchpadId: string;
  pool?: string;
} & (
  | { result: 'claimed'; signature: string; lamports: bigint }
  | { result: 'below_threshold'; claimable: bigint }
  | { result: 'nothing_to_claim' }
  | { result: 'no_pool' }
  | { result: 'in_flight'; signature: string; state: string }
  | { result: 'expired'; signature: string }
  | { result: 'failed'; signature: string; error: string }
  | { result: 'manual'; reason: string }
  | { result: 'skipped'; reason: string }
  | { result: 'error'; error: string }
);

/** Outcomes that built (and possibly sent) a claim: `maxPerRun` bounds them. */
const ON_CHAIN_RESULTS = new Set<ClaimOutcome['result']>([
  'claimed',
  'in_flight',
  'expired',
  'failed',
  'error',
]);

export interface ClaimsRunReport {
  status: 'ran' | 'paused' | 'busy' | 'error';
  reason?: string;
  outcomes: ClaimOutcome[];
}

export interface ClaimsJob {
  runOnce(): Promise<ClaimsRunReport>;
}

export const DEFAULT_UNCLAIMED_ALERT_MS = 48 * 60 * 60_000;

export function createClaimsJob(deps: ClaimsDeps): ClaimsJob {
  const { store, core, rpc, keystore, journal, alerter, logger: log, config } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const settleTiming = { ...DEFAULT_SETTLE, ...config.settle };
  const unclaimedAlertMs = config.unclaimedAlertMs ?? DEFAULT_UNCLAIMED_ALERT_MS;
  const maxPerRun = config.maxPerRun ?? 500;
  if (!Number.isInteger(maxPerRun) || maxPerRun < 1) {
    throw new JobError('CONFIG', 'maxPerRun must be a positive integer');
  }
  let running = false;
  /** Index (in the store order) where the next run starts. */
  let rotation = 0;
  /** Set when the kill switch flips during a run: the run stops before the next claim. */
  let stopReason: PauseReason | null = null;

  const iso = () => new Date(now()).toISOString();
  const alert = (
    level: 'immediate' | 'high' | 'normal',
    code: string,
    message: string,
    details: Record<string, unknown>,
    dedupKey?: string,
  ) => sendAlert(alerter, log, level, code, message, details, dedupKey);
  const announce = createAnnouncer(deps.onBeforeSend, log);

  const freshEntry = (pool: string, launchpadId: string): ClaimJournalEntry => ({
    v: 1,
    pool,
    launchpadId,
    inFlight: null,
    lastClaim: null,
    pendingSince: null,
    graduationNoticeAt: null,
    consecutiveFailures: 0,
    lastError: null,
  });

  /** Applies a settlement to the journal entry; returns the outcome when the claim is decided. */
  async function applySettlement(
    lp: CreatorLaunchpad,
    poolKey: string,
    entry: ClaimJournalEntry,
    s: Settlement,
  ): Promise<{ entry: ClaimJournalEntry; outcome?: ClaimOutcome }> {
    const inFlight = entry.inFlight;
    if (!inFlight) return { entry };
    const base = { launchpadId: lp.id, pool: poolKey };
    if (s.kind === 'confirmed' || s.kind === 'finalized') {
      const lamports = BigInt(inFlight.claimableQuote);
      const next: ClaimJournalEntry = {
        ...entry,
        inFlight: null,
        lastClaim: { signature: inFlight.signature, quote: inFlight.claimableQuote, at: iso() },
        pendingSince: null,
        consecutiveFailures: 0,
        lastError: null,
      };
      await journal.put(poolKey, next);
      log.info(
        {
          launchpadId: lp.id,
          pool: poolKey,
          signature: inFlight.signature,
          lamports: lamports.toString(),
        },
        'creator fees claimed to the vault',
      );
      return {
        entry: next,
        outcome: { ...base, result: 'claimed', signature: inFlight.signature, lamports },
      };
    }
    if (s.kind === 'failed') {
      const next: ClaimJournalEntry = {
        ...entry,
        inFlight: null,
        consecutiveFailures: entry.consecutiveFailures + 1,
        lastError: s.error,
      };
      await journal.put(poolKey, next);
      await alert(
        'high',
        'creator_claim_failed',
        'A creator-fee claim failed on-chain',
        { launchpadId: lp.id, pool: poolKey, signature: inFlight.signature, error: s.error },
        `creator_claim_failed:${poolKey}`,
      );
      return {
        entry: next,
        outcome: { ...base, result: 'failed', signature: inFlight.signature, error: s.error },
      };
    }
    if (s.kind === 'expired') {
      const next: ClaimJournalEntry = { ...entry, inFlight: null };
      await journal.put(poolKey, next);
      log.warn({ pool: poolKey, signature: inFlight.signature }, 'claim expired unsent');
      return { entry: next };
    }
    return {
      entry,
      outcome: { ...base, result: 'in_flight', signature: inFlight.signature, state: s.kind },
    };
  }

  async function processLaunchpad(
    lp: CreatorLaunchpad,
    payer: { ref: string; publicKey: PublicKey } | null,
  ): Promise<ClaimOutcome> {
    const manual = async (reason: string, details: Record<string, unknown> = {}) => {
      await alert(
        'high',
        'creator_claim_manual',
        'A launchpad pool cannot be claimed automatically: check it',
        { launchpadId: lp.id, reason, ...details },
        `creator_claim_manual:${lp.id}:${reason}`,
      );
      return { launchpadId: lp.id, result: 'manual', reason } as ClaimOutcome;
    };
    const configAddress = parseAddress(lp.coinConfig);
    const mint = parseAddress(lp.coinMint);
    if (!configAddress || !mint) return manual('invalid_addresses');

    // The creator key must be the keystore key of THIS launchpad's creator role.
    let role: string;
    try {
      role = creatorRole(lp.id);
    } catch {
      return manual('invalid_launchpad_id');
    }
    const expectedRef = await keystore.findRef(role);
    if (!expectedRef || expectedRef !== lp.creatorWalletRef) return manual('creator_ref_mismatch');
    const creator = await keystore.getPublicKey(expectedRef);

    const pool = core.coinPoolAddress(configAddress, mint);
    const poolKey = pool.toBase58();
    const base = { launchpadId: lp.id, pool: poolKey };
    let entry = (await journal.get(poolKey)) ?? freshEntry(poolKey, lp.id);
    if (entry.launchpadId !== lp.id) return manual('journal_launchpad_mismatch', { pool: poolKey });

    // 1. A claim in flight is settled first.
    if (entry.inFlight) {
      const s = await checkSettlement(
        rpc,
        entry.inFlight.signature,
        entry.inFlight.lastValidBlockHeight,
        retry,
      );
      if (s.kind === 'pending' && announce(entry.inFlight.signature)) {
        try {
          await rpc.sendRawTransaction(Buffer.from(entry.inFlight.rawTx, 'base64'));
        } catch (err) {
          log.debug({ pool: poolKey, err: describeError(err) }, 'claim rebroadcast failed');
        }
      }
      const applied = await applySettlement(lp, poolKey, entry, s);
      entry = applied.entry;
      if (applied.outcome) return applied.outcome;
    }

    // 2. Pool state: existence, creator, quote mint.
    const state = await withRetry(() => core.readCreatorPool(pool), retry);
    if (!state) return { ...base, result: 'no_pool' };
    if (!state.creator.equals(creator)) {
      await alert(
        'immediate',
        'pool_creator_changed',
        'The creator of a FORGE pool is no longer FORGE (transferPoolCreator?): investigate now',
        {
          launchpadId: lp.id,
          pool: poolKey,
          expected: creator.toBase58(),
          actual: state.creator.toBase58(),
        },
        `pool_creator_changed:${poolKey}`,
      );
      return { ...base, result: 'manual', reason: 'pool_creator_changed' };
    }
    if (!state.baseMint.equals(mint) || !state.config.equals(configAddress)) {
      return manual('pool_mismatch', { pool: poolKey });
    }
    if (!state.quoteMint.equals(NATIVE_MINT)) return manual('not_sol_quoted', { pool: poolKey });

    if (state.graduated && entry.graduationNoticeAt === null) {
      await alert(
        'normal',
        'post_graduation_lp_fees',
        'A FORGE launchpad coin graduated: its DAMM v2 creator position fees must be claimed by hand until core supports it',
        { launchpadId: lp.id, pool: poolKey },
        `post_graduation_lp_fees:${poolKey}`,
      );
      entry = { ...entry, graduationNoticeAt: iso() };
      await journal.put(poolKey, entry);
    }

    // 3. Threshold.
    const claimable = state.creatorClaimable.quote;
    if (claimable < config.minClaimLamports) {
      if (entry.pendingSince !== null) {
        entry = { ...entry, pendingSince: null };
        await journal.put(poolKey, entry);
      }
      return { ...base, result: 'below_threshold', claimable };
    }
    if (entry.pendingSince === null) {
      entry = { ...entry, pendingSince: iso() };
      await journal.put(poolKey, entry);
    }

    // 4. Fee payer funds: temporary WSOL account + vault token account rent + fees.
    const feePayer = payer ? payer.publicKey : creator;
    const tokenRent = await withRetry(
      () => rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
      retry,
    );
    const needed = tokenRent * CLAIM_TOKEN_ACCOUNTS_FUNDED + CLAIM_FEE_BUFFER_LAMPORTS;
    const feePayerBalance = await withRetry(() => rpc.getBalance(feePayer, 'confirmed'), retry);
    if (feePayerBalance < needed) {
      await alert(
        'high',
        'claim_payer_low_balance',
        'The wallet paying creator-fee claims is too low: fund it',
        {
          address: feePayer.toBase58(),
          balance: formatSol(feePayerBalance),
          needed: formatSol(needed),
        },
        `claim_payer_low_balance:${feePayer.toBase58()}`,
      );
      return { ...base, result: 'skipped', reason: 'payer_low_balance' };
    }

    // 5. Build (core), check (policy), sign (keystore), journal, send, confirm.
    const built = await withRetry(
      () => core.buildCreatorClaimTx({ pool, creator, receiver: config.vault, payer: feePayer }),
      retry,
    );
    const tx = built.transaction;
    if (!tx || built.lastValidBlockHeight === null) return { ...base, result: 'nothing_to_claim' };
    if (built.summary.claimable.quote < config.minClaimLamports) {
      return { ...base, result: 'below_threshold', claimable: built.summary.claimable.quote };
    }
    if (!built.summary.receiver.equals(config.vault) || !built.summary.claimer.equals(creator)) {
      throw new JobError('TX_POLICY', 'claim summary does not match the request');
    }
    assertCreatorClaimTx(tx, {
      dbcProgramId: core.dbcProgramId,
      pool,
      baseMint: mint,
      creator,
      feePayer,
      receiver: config.vault,
      claimedQuoteLamports: built.summary.claimable.quote,
    });
    // The kill switch may have been turned on since the run started: re-read it before signing.
    const pause = await checkPaused(deps.flags, JOB_FLAGS.claims, config.paused, log);
    if (pause.paused) {
      stopReason = pause.reason;
      await alertAbnormalPause(alerter, log, 'claims', JOB_FLAGS.claims, pause.reason);
      return { ...base, result: 'skipped', reason: 'paused' };
    }
    const signers: KeystoreSignerRef[] = [{ ref: expectedRef, expected: creator }];
    if (payer && !payer.publicKey.equals(creator)) {
      signers.push({ ref: payer.ref, expected: payer.publicKey });
    }
    const { raw, signature } = await signWithKeystore(keystore, tx, signers);
    entry = {
      ...entry,
      inFlight: {
        signature,
        rawTx: raw.toString('base64'),
        lastValidBlockHeight: built.lastValidBlockHeight,
        claimableQuote: built.summary.claimable.quote.toString(),
        startedAt: iso(),
      },
    };
    await journal.put(poolKey, entry);

    if (!announce(signature)) {
      return { ...base, result: 'in_flight', signature, state: 'not_announced' };
    }
    const sent = await broadcast(rpc, raw, retry);
    if (sent.status === 'rejected') {
      entry = { ...entry, lastError: sent.reason };
      await journal.put(poolKey, entry);
      await alert(
        'high',
        'creator_claim_rejected',
        'The RPC rejected a creator-fee claim (simulation failed)',
        { launchpadId: lp.id, pool: poolKey, signature, reason: sent.reason },
        `creator_claim_rejected:${poolKey}`,
      );
      return { ...base, result: 'failed', signature, error: sent.reason };
    }
    const s = await awaitSettlement(rpc, signature, {
      lastValidBlockHeight: built.lastValidBlockHeight,
      raw,
      until: 'confirmed',
      ...settleTiming,
      retry,
      sleep,
      now,
      logger: log,
    });
    const applied = await applySettlement(lp, poolKey, entry, s);
    if (applied.outcome) return applied.outcome;
    return { ...base, result: 'expired', signature };
  }

  async function checkUnclaimed(lp: CreatorLaunchpad, poolKey: string | undefined) {
    if (!poolKey) return;
    let entry: ClaimJournalEntry | undefined;
    try {
      entry = await journal.get(poolKey);
    } catch {
      return;
    }
    if (!entry?.pendingSince) return;
    const age = now() - Date.parse(entry.pendingSince);
    if (age > unclaimedAlertMs) {
      await alert(
        'normal',
        'creator_fees_unclaimed',
        'Creator fees above the threshold have been unclaimed for more than 48 h',
        {
          launchpadId: lp.id,
          pool: poolKey,
          since: entry.pendingSince,
          lastError: entry.lastError ?? 'none',
        },
        `creator_fees_unclaimed:${poolKey}`,
      );
    }
  }

  async function runUnlocked(): Promise<ClaimsRunReport> {
    let payer: { ref: string; publicKey: PublicKey } | null = null;
    if (config.feePayer === 'payer') {
      try {
        payer = await requireRoleRef(keystore, 'payer');
      } catch (err) {
        await alert('high', 'claims_config', 'Claims stopped: payer key problem', {
          error: describeError(err).message,
        });
        return { status: 'error', reason: 'payer_key', outcomes: [] };
      }
    }
    const launchpads = await store.listCreatorLaunchpads();
    const outcomes: ClaimOutcome[] = [];
    const total = launchpads.length;
    const start = total === 0 ? 0 : rotation % total;
    let attempts = 0;
    let processed = 0;
    stopReason = null;
    for (let i = 0; i < total; i++) {
      if (attempts >= maxPerRun || stopReason !== null) break;
      const lp = launchpads[(start + i) % total]!;
      let outcome: ClaimOutcome;
      try {
        outcome = await processLaunchpad(lp, payer);
      } catch (err) {
        const summary = describeError(err);
        const policy =
          err instanceof JobError && (err.code === 'TX_POLICY' || err.code === 'SIGNER_MISMATCH');
        log.error({ launchpadId: lp.id, err: summary }, 'creator claim failed');
        await alert(
          'high',
          policy ? 'claim_policy_violation' : 'creator_claim_error',
          policy
            ? 'A creator-fee claim transaction was refused before signing (policy check)'
            : 'A creator-fee claim step failed (repeated RPC errors?)',
          { launchpadId: lp.id, error: summary.message },
          `creator_claim_error:${lp.id}`,
        );
        outcome = { launchpadId: lp.id, result: 'error', error: summary.message };
      }
      await checkUnclaimed(lp, outcome.pool);
      outcomes.push(outcome);
      // A launchpad skipped because the switch flipped is the first one of the next run.
      if (stopReason === null) processed++;
      if (ON_CHAIN_RESULTS.has(outcome.result)) attempts++;
    }
    rotation = total === 0 ? 0 : (start + processed) % total;
    if (stopReason !== null) return { status: 'paused', reason: stopReason, outcomes };
    return { status: 'ran', outcomes };
  }

  return {
    async runOnce() {
      if (running) return { status: 'busy', outcomes: [] };
      running = true;
      try {
        const pause = await checkPaused(deps.flags, JOB_FLAGS.claims, config.paused, log);
        if (pause.paused) {
          log.info({ reason: pause.reason }, 'claims paused');
          await alertAbnormalPause(alerter, log, 'claims', JOB_FLAGS.claims, pause.reason);
          return { status: 'paused', reason: pause.reason, outcomes: [] };
        }
        try {
          return await runUnlocked();
        } catch (err) {
          const summary = describeError(err);
          log.error({ err: summary }, 'claims run failed');
          await alert(
            'high',
            'claims_run_failed',
            'The creator-fee claims run failed (database unavailable?)',
            { error: summary.message },
            'claims_run_failed',
          );
          return { status: 'error', reason: summary.message, outcomes: [] };
        }
      } finally {
        running = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Configuration from the environment

/** Default threshold: 0.01 SOL (a claim advances ~0.004 SOL of rent, returned to the vault). */
export const DEFAULT_MIN_CLAIM_LAMPORTS = 10_000_000n;
export const DEFAULT_CLAIMS_INTERVAL_MS = OPS.claimIntervalHours * 60 * 60_000;

/**
 * SIGNER_CLAIMS_MIN_LAMPORTS (default 0.01 SOL), SIGNER_CLAIMS_FEE_PAYER (`payer` | `creator`,
 * default `payer`), SIGNER_CLAIMS_INTERVAL_HOURS (default OPS.claimIntervalHours = 24),
 * SIGNER_CLAIMS_PAUSED (default false). `vault` comes from @forge/core `requireAddresses`.
 */
export function claimsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  vault: PublicKey,
): { config: ClaimsConfig; intervalMs: number } {
  const feePayer = env.SIGNER_CLAIMS_FEE_PAYER || 'payer';
  if (feePayer !== 'payer' && feePayer !== 'creator') {
    throw new JobError('CONFIG', 'SIGNER_CLAIMS_FEE_PAYER must be payer or creator');
  }
  return {
    config: {
      vault,
      minClaimLamports: parseLamportsEnv(
        env.SIGNER_CLAIMS_MIN_LAMPORTS,
        'SIGNER_CLAIMS_MIN_LAMPORTS',
        DEFAULT_MIN_CLAIM_LAMPORTS,
      ),
      feePayer,
      paused: parseBoolEnv(env.SIGNER_CLAIMS_PAUSED, 'SIGNER_CLAIMS_PAUSED', false),
    },
    intervalMs:
      parsePositiveIntEnv(
        env.SIGNER_CLAIMS_INTERVAL_HOURS,
        'SIGNER_CLAIMS_INTERVAL_HOURS',
        OPS.claimIntervalHours,
      ) *
      60 *
      60_000,
  };
}

// ---------------------------------------------------------------------------------------
// Supabase implementation of the store

const LaunchpadRowSchema = z.object({
  id: z.string(),
  status: z.enum(['draft', 'live', 'sleeping', 'disabled']),
  launchpad_coin_config: z.string(),
  launchpad_coin_mint: z.string(),
  creator_wallet_ref: z.string(),
});

/** ClaimsStore over Supabase PostgREST (service role), paginated. */
export function createPostgrestClaimsStore(db: PostgrestClient, pageSize = 500): ClaimsStore {
  return {
    async listCreatorLaunchpads() {
      const out: CreatorLaunchpad[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const rows = await db.select('launchpads', {
          select: 'id,status,launchpad_coin_config,launchpad_coin_mint,creator_wallet_ref',
          launchpad_coin_config: 'not.is.null',
          launchpad_coin_mint: 'not.is.null',
          creator_wallet_ref: 'not.is.null',
          order: 'created_at.asc,id.asc',
          limit: String(pageSize),
          offset: String(offset),
        });
        const parsed = z.array(LaunchpadRowSchema).safeParse(rows);
        if (!parsed.success) throw new JobError('DB_RESPONSE', 'unexpected launchpad rows');
        for (const r of parsed.data) {
          out.push({
            id: r.id,
            status: r.status,
            coinConfig: r.launchpad_coin_config,
            coinMint: r.launchpad_coin_mint,
            creatorWalletRef: r.creator_wallet_ref,
          });
        }
        if (parsed.data.length < pageSize) return out;
      }
    },
  };
}
