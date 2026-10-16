/**
 * Creator-fee claims job (tasks/05-SIGNER.md, docs/OPERATIONS.md, docs/SECURITY.md §5).
 *
 * FORGE is the pool creator of each launchpad's own coin (D6: creatorTradingFeePercentage = 25),
 * through a dedicated creator wallet per launchpad held in the keystore
 * (`launchpads.creator_wallet_ref`). Every run (default 1 h), for each such pool:
 *   1. a claim still in flight is settled first (never two claims of a pool in flight, whatever
 *      their kind);
 *   2. the pool is read: missing pool -> skip (launch never signed); creator changed ->
 *      IMMEDIATE alert (transferPoolCreator, SECURITY §5) and no claim;
 *   3. DBC share: if the unclaimed creator share (SOL side) reaches the threshold, the claim is
 *      built by core (`claimCreatorTradingFeeToReceiver`, receiver = FORGE multisig vault),
 *      checked against the claim policy, signed by the creator wallet (+ the payer wallet when it
 *      pays the fees), journaled, sent and confirmed by polling;
 *   4. once the pool has migrated to DAMM v2, its creator keeps a permanently locked position
 *      that earns the migrated pool's trading fees (devnet test 2). When the DBC share had nothing
 *      to send, the creator's positions are read (core `findCreatorDammV2Positions`) and, if their
 *      pending SOL fees reach their own, higher threshold (SIGNER_CLAIMS_MIN_POSITION_LAMPORTS:
 *      every position claim pays the rent of a temporary WSOL account, which reaches the vault
 *      with the fees), the position fee claim is built by core
 *      (`claim_position_fee`, SOL unwrapped to the vault), checked against its own policy
 *      (`assertCreatorPositionClaimTx`: no remove liquidity, no transfer of the position NFT, no
 *      other program), signed, journaled, sent and confirmed the same way.
 * A claim paid by the payer wallet is checked, built, signed and sent under the payer lock shared
 * with the signing routes. The creator signs, the vault only receives: no Squads proposal is needed.
 * Partner fees are NOT claimed here: they belong to the client (`feeClaimer` = client wallet),
 * who claims them from the dashboard.
 *
 * Results are kept in a per-pool journal (claim in flight, last claims of each kind, pending
 * since, failures); an alert is raised on any failure and when fees above the threshold stay
 * unclaimed for more than 48 h. Every launchpad is read on every run; at most `maxPerRun` claims
 * are built per run, and the next run starts where the previous one stopped, so no pool is
 * starved. The kill switch (`claims_paused`) is read at the start of the run and again before
 * each claim is signed.
 */
import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey, type Transaction } from '@solana/web3.js';
import { z } from 'zod';
import type { LaunchpadStatus } from '@forge/shared';
import { ClaimError } from '@forge/core';
import { creatorRole } from '../keystore.js';
import type { CreatorPoolState, CreatorPositionsState, SignerCore } from '../core-adapter.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  JOB_FLAGS,
  JobError,
  alertAbnormalPause,
  assertCreatorClaimTx,
  assertCreatorPositionClaimTx,
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
  type Mutex,
  type PauseReason,
  type PostgrestClient,
  type RetryOptions,
  type Settlement,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';
import type { PayerReservations } from './reservations.js';

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

/** `dbc`: the creator share of the bonding curve; `position`: the DAMM v2 position fees. */
export const ClaimKind = z.enum(['dbc', 'position']);
export type ClaimKind = z.infer<typeof ClaimKind>;

const InFlightClaim = z.object({
  /** Absent in journals written before position claims existed: those were DBC claims. */
  kind: ClaimKind.default('dbc'),
  signature: z.string(),
  rawTx: z.string(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  claimableQuote: z.string().regex(/^[0-9]+$/),
  startedAt: z.string(),
  /** Positions of a position claim (addresses), empty for a DBC claim. */
  positions: z.array(z.string()).default([]),
});

const LastClaim = z.object({
  signature: z.string(),
  quote: z.string().regex(/^[0-9]+$/),
  at: z.string(),
});

export const ClaimJournalEntry = z.object({
  v: z.literal(1),
  pool: z.string(),
  launchpadId: z.string(),
  inFlight: InFlightClaim.nullable(),
  /** Last DBC creator share claim. */
  lastClaim: LastClaim.nullable(),
  /** Last DAMM v2 position fee claim (absent in older journals). */
  lastPositionClaim: LastClaim.extend({ positions: z.array(z.string()) })
    .nullable()
    .default(null),
  /** First time the DBC share was seen above the threshold without a successful claim. */
  pendingSince: z.string().nullable(),
  /** Same for the position fees (absent in older journals). */
  positionPendingSince: z.string().nullable().default(null),
  /**
   * When the operator was told that WSOL in the creator's account blocks the payer-paid claim
   * (core `claimer_wsol_not_empty`): alerted once, reset by the next claim that builds.
   */
  wsolBlockedAlertedAt: z.string().nullable().default(null),
  /** When the one-time "graduated" notice was sent. */
  graduationNoticeAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type ClaimJournalEntry = z.infer<typeof ClaimJournalEntry>;

/**
 * Accounts the payer may have to fund in one claim: the temporary WSOL ATA and the vault's ATA.
 * A position claim funds the same two (its WSOL rent then reaches the vault with the fees).
 */
export const CLAIM_TOKEN_ACCOUNTS_FUNDED = 2n;
export const TOKEN_ACCOUNT_SIZE = 165;
export const CLAIM_FEE_BUFFER_LAMPORTS = 20_000n;

export interface ClaimsConfig {
  /** FORGE_MULTISIG_VAULT (from `requireAddresses` of @forge/core at startup). */
  vault: PublicKey;
  /** Claim the DBC creator share only when it (lamports) reaches this amount. */
  minClaimLamports: bigint;
  /**
   * Claim the DAMM v2 position fees only when they (lamports) reach this amount. Higher than
   * the DBC one: every position claim pays the rent of a temporary WSOL account (about 0.002 SOL),
   * which reaches the vault with the fees but is lost to the payer each time.
   */
  minPositionClaimLamports: bigint;
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
    | 'dbcProgramId'
    | 'cpAmmProgramId'
    | 'coinPoolAddress'
    | 'readCreatorPool'
    | 'buildCreatorClaimTx'
    | 'readCreatorPositions'
    | 'buildCreatorPositionClaimTx'
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
  /**
   * Lock of the payer wallet, shared with the signing routes: a claim paid by the payer wallet is
   * checked, built, signed, journaled and sent under it (never interleaved with a creation).
   */
  payerLock?: Mutex;
  /** Payer lamports reserved by the routes' creations in flight (subtracted from its balance). */
  payerReservations?: PayerReservations;
}

export type ClaimOutcome = {
  launchpadId: string;
  pool?: string;
  /** Which fees the outcome is about (absent for outcomes decided before any pool read). */
  kind?: ClaimKind;
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

/** DBC outcomes after which the position fees of a migrated pool are looked at in the same run. */
const POSITION_PATH_AFTER = new Set<ClaimOutcome['result']>(['below_threshold', 'nothing_to_claim']);

export interface ClaimsRunReport {
  status: 'ran' | 'paused' | 'busy' | 'error';
  reason?: string;
  outcomes: ClaimOutcome[];
}

export interface ClaimsJob {
  runOnce(): Promise<ClaimsRunReport>;
}

export const DEFAULT_UNCLAIMED_ALERT_MS = 48 * 60 * 60_000;

/** What a claim path hands to the shared sign-and-send step. */
interface BuiltClaim {
  kind: ClaimKind;
  transaction: Transaction;
  lastValidBlockHeight: number;
  /** Quote lamports the claim collects (DBC: exact; position: a lower bound). */
  claimableQuote: bigint;
  positions: string[];
}

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
    lastPositionClaim: null,
    pendingSince: null,
    positionPendingSince: null,
    wsolBlockedAlertedAt: null,
    graduationNoticeAt: null,
    consecutiveFailures: 0,
    lastError: null,
  });

  const label = (kind: ClaimKind) => (kind === 'dbc' ? 'creator-fee' : 'position-fee');

  /**
   * Core refused to build the claim: the creator's WSOL account holds WSOL that the close would
   * hand to the payer (anyone can put a lamport there). Alerted once per pool, not every run,
   * until a claim of that pool builds again; the pool is left to the operator meanwhile.
   */
  async function wsolBlocked(ctx: PoolContext, kind: ClaimKind, err: ClaimError): Promise<ClaimOutcome> {
    const { lp, poolKey } = ctx;
    const outcome: ClaimOutcome = {
      launchpadId: lp.id,
      pool: poolKey,
      kind,
      result: 'manual',
      reason: 'claimer_wsol_not_empty',
    };
    if (ctx.entry.wsolBlockedAlertedAt !== null) {
      log.warn({ launchpadId: lp.id, pool: poolKey, kind }, 'claim still blocked by WSOL in the creator account');
      return outcome;
    }
    await alert(
      'high',
      'creator_wsol_blocked',
      `A ${label(kind)} claim is blocked: the creator's WSOL account holds WSOL that closing it would hand to the fee payer. Unwrap it, or claim it with the creator paying`,
      { launchpadId: lp.id, pool: poolKey, kind, error: err.message },
      `creator_wsol_blocked:${poolKey}`,
    );
    ctx.entry = { ...ctx.entry, wsolBlockedAlertedAt: iso() };
    await journal.put(poolKey, ctx.entry);
    return outcome;
  }
  const alertCode = (kind: ClaimKind, suffix: string) =>
    kind === 'dbc' ? `creator_claim_${suffix}` : `position_claim_${suffix}`;

  /** Applies a settlement to the journal entry; returns the outcome when the claim is decided. */
  async function applySettlement(
    lp: CreatorLaunchpad,
    poolKey: string,
    entry: ClaimJournalEntry,
    s: Settlement,
  ): Promise<{ entry: ClaimJournalEntry; outcome?: ClaimOutcome }> {
    const inFlight = entry.inFlight;
    if (!inFlight) return { entry };
    const kind = inFlight.kind;
    const base = { launchpadId: lp.id, pool: poolKey, kind };
    if (s.kind === 'confirmed' || s.kind === 'finalized') {
      const lamports = BigInt(inFlight.claimableQuote);
      const last = { signature: inFlight.signature, quote: inFlight.claimableQuote, at: iso() };
      const next: ClaimJournalEntry = {
        ...entry,
        inFlight: null,
        ...(kind === 'dbc'
          ? { lastClaim: last, pendingSince: null }
          : {
              lastPositionClaim: { ...last, positions: inFlight.positions },
              positionPendingSince: null,
            }),
        consecutiveFailures: 0,
        lastError: null,
      };
      await journal.put(poolKey, next);
      log.info(
        {
          launchpadId: lp.id,
          pool: poolKey,
          kind,
          signature: inFlight.signature,
          lamports: lamports.toString(),
          ...(kind === 'position' ? { positions: inFlight.positions } : {}),
        },
        kind === 'dbc' ? 'creator fees claimed to the vault' : 'position fees claimed to the vault',
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
        alertCode(kind, 'failed'),
        `A ${label(kind)} claim failed on-chain`,
        { launchpadId: lp.id, pool: poolKey, signature: inFlight.signature, error: s.error },
        `${alertCode(kind, 'failed')}:${poolKey}`,
      );
      return {
        entry: next,
        outcome: { ...base, result: 'failed', signature: inFlight.signature, error: s.error },
      };
    }
    if (s.kind === 'expired') {
      const next: ClaimJournalEntry = { ...entry, inFlight: null };
      await journal.put(poolKey, next);
      log.warn({ pool: poolKey, kind, signature: inFlight.signature }, 'claim expired unsent');
      return { entry: next };
    }
    return {
      entry,
      outcome: { ...base, result: 'in_flight', signature: inFlight.signature, state: s.kind },
    };
  }

  interface PoolContext {
    lp: CreatorLaunchpad;
    pool: PublicKey;
    poolKey: string;
    mint: PublicKey;
    creator: PublicKey;
    creatorRef: string;
    payer: { ref: string; publicKey: PublicKey } | null;
    entry: ClaimJournalEntry;
  }

  /**
   * Fee payer funds, build (core), check (policy), sign (keystore), journal, send, confirm. When
   * the payer wallet pays, everything up to the send runs under the payer lock (the signing
   * routes spend from that wallet too) and the lamports reserved by their creations in flight
   * are not counted. `build` returns the checked claim, or the outcome that replaces it.
   */
  async function claimAndSettle(
    ctx: PoolContext,
    kind: ClaimKind,
    build: (feePayer: PublicKey) => Promise<BuiltClaim | { outcome: ClaimOutcome }>,
  ): Promise<ClaimOutcome> {
    const { lp, poolKey, creator, payer } = ctx;
    const base = { launchpadId: lp.id, pool: poolKey, kind };
    const feePayer = payer ? payer.publicKey : creator;
    const signAndSend = async (): Promise<
      { outcome: ClaimOutcome } | { raw: Buffer; signature: string; lastValidBlockHeight: number }
    > => {
      const tokenRent = await withRetry(
        () => rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
        retry,
      );
      const needed = tokenRent * CLAIM_TOKEN_ACCOUNTS_FUNDED + CLAIM_FEE_BUFFER_LAMPORTS;
      const feePayerBalance = await withRetry(() => rpc.getBalance(feePayer, 'confirmed'), retry);
      const reserved =
        payer && deps.payerReservations ? await deps.payerReservations.outstanding(rpc, retry) : 0n;
      const available = feePayerBalance > reserved ? feePayerBalance - reserved : 0n;
      if (available < needed) {
        await alert(
          'high',
          'claim_payer_low_balance',
          'The wallet paying creator-fee claims is too low: fund it',
          {
            address: feePayer.toBase58(),
            balance: formatSol(feePayerBalance),
            reservedInFlight: formatSol(reserved),
            needed: formatSol(needed),
          },
          `claim_payer_low_balance:${feePayer.toBase58()}`,
        );
        return { outcome: { ...base, result: 'skipped', reason: 'payer_low_balance' } };
      }

      let built: BuiltClaim | { outcome: ClaimOutcome };
      try {
        built = await build(feePayer);
      } catch (err) {
        if (err instanceof ClaimError && err.code === 'claimer_wsol_not_empty') {
          return { outcome: await wsolBlocked(ctx, kind, err) };
        }
        throw err;
      }
      if ('outcome' in built) return built;
      // The kill switch may have been turned on since the run started: re-read it before signing.
      const pause = await checkPaused(deps.flags, JOB_FLAGS.claims, config.paused, log);
      if (pause.paused) {
        stopReason = pause.reason;
        await alertAbnormalPause(alerter, log, 'claims', JOB_FLAGS.claims, pause.reason);
        return { outcome: { ...base, result: 'skipped', reason: 'paused' } };
      }
      const signers: KeystoreSignerRef[] = [{ ref: ctx.creatorRef, expected: creator }];
      if (payer && !payer.publicKey.equals(creator)) {
        signers.push({ ref: payer.ref, expected: payer.publicKey });
      }
      const { raw, signature } = await signWithKeystore(keystore, built.transaction, signers);
      ctx.entry = {
        ...ctx.entry,
        // A claim that builds is no longer blocked by WSOL in the creator's account.
        wsolBlockedAlertedAt: null,
        inFlight: {
          kind,
          signature,
          rawTx: raw.toString('base64'),
          lastValidBlockHeight: built.lastValidBlockHeight,
          claimableQuote: built.claimableQuote.toString(),
          startedAt: iso(),
          positions: built.positions,
        },
      };
      await journal.put(poolKey, ctx.entry);

      if (!announce(signature)) {
        return { outcome: { ...base, result: 'in_flight', signature, state: 'not_announced' } };
      }
      const sent = await broadcast(rpc, raw, retry);
      if (sent.status === 'rejected') {
        ctx.entry = { ...ctx.entry, lastError: sent.reason };
        await journal.put(poolKey, ctx.entry);
        await alert(
          'high',
          alertCode(kind, 'rejected'),
          `The RPC rejected a ${label(kind)} claim (simulation failed)`,
          { launchpadId: lp.id, pool: poolKey, signature, reason: sent.reason },
          `${alertCode(kind, 'rejected')}:${poolKey}`,
        );
        return { outcome: { ...base, result: 'failed', signature, error: sent.reason } };
      }
      return { raw, signature, lastValidBlockHeight: built.lastValidBlockHeight };
    };
    const step =
      payer && deps.payerLock
        ? await deps.payerLock.runExclusive(signAndSend)
        : await signAndSend();
    if ('outcome' in step) return step.outcome;

    // Confirmation by polling, outside the payer lock.
    const { raw, signature } = step;
    const s = await awaitSettlement(rpc, signature, {
      lastValidBlockHeight: step.lastValidBlockHeight,
      raw,
      until: 'confirmed',
      ...settleTiming,
      retry,
      sleep,
      now,
      logger: log,
    });
    const applied = await applySettlement(lp, poolKey, ctx.entry, s);
    ctx.entry = applied.entry;
    if (applied.outcome) return applied.outcome;
    return { ...base, result: 'expired', signature };
  }

  /** The DBC creator share: threshold, build, policy, sign, send. */
  async function dbcPath(ctx: PoolContext, state: CreatorPoolState): Promise<ClaimOutcome> {
    const { lp, pool, poolKey, mint, creator } = ctx;
    const base = { launchpadId: lp.id, pool: poolKey, kind: 'dbc' as const };
    const claimable = state.creatorClaimable.quote;
    if (claimable < config.minClaimLamports) {
      if (ctx.entry.pendingSince !== null) {
        ctx.entry = { ...ctx.entry, pendingSince: null };
        await journal.put(poolKey, ctx.entry);
      }
      return { ...base, result: 'below_threshold', claimable };
    }
    if (ctx.entry.pendingSince === null) {
      ctx.entry = { ...ctx.entry, pendingSince: iso() };
      await journal.put(poolKey, ctx.entry);
    }
    return claimAndSettle(ctx, 'dbc', async (feePayer) => {
      const built = await withRetry(
        () => core.buildCreatorClaimTx({ pool, creator, receiver: config.vault, payer: feePayer }),
        retry,
      );
      const tx = built.transaction;
      if (!tx || built.lastValidBlockHeight === null) {
        return { outcome: { ...base, result: 'nothing_to_claim' } };
      }
      if (built.summary.claimable.quote < config.minClaimLamports) {
        return {
          outcome: { ...base, result: 'below_threshold', claimable: built.summary.claimable.quote },
        };
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
      return {
        kind: 'dbc',
        transaction: tx,
        lastValidBlockHeight: built.lastValidBlockHeight,
        claimableQuote: built.summary.claimable.quote,
        positions: [],
      };
    });
  }

  /** The DAMM v2 position fees of a migrated pool: read, threshold, build, policy, sign, send. */
  async function positionPath(ctx: PoolContext): Promise<ClaimOutcome> {
    const { lp, pool, poolKey, mint, creator } = ctx;
    const base = { launchpadId: lp.id, pool: poolKey, kind: 'position' as const };
    const read: CreatorPositionsState | null = await withRetry(
      () => core.readCreatorPositions(pool, creator),
      retry,
    );
    if (!read) return { ...base, result: 'manual', reason: 'position_read_mismatch' };
    if (read.positions.length === 0) {
      // A FORGE launchpad coin always leaves the creator a locked position: a missing one means
      // the NFT moved out of the creator wallet, or a config without creator liquidity.
      await alert(
        'high',
        'creator_position_missing',
        'A migrated FORGE pool has no DAMM v2 position held by its creator wallet: check it',
        { launchpadId: lp.id, pool: poolKey, dammPool: read.dammPool.toBase58() },
        `creator_position_missing:${poolKey}`,
      );
      return { ...base, result: 'manual', reason: 'creator_position_missing' };
    }
    const claimable = read.claimable.quote;
    if (claimable < config.minPositionClaimLamports) {
      if (ctx.entry.positionPendingSince !== null) {
        ctx.entry = { ...ctx.entry, positionPendingSince: null };
        await journal.put(poolKey, ctx.entry);
      }
      return { ...base, result: 'below_threshold', claimable };
    }
    if (ctx.entry.positionPendingSince === null) {
      ctx.entry = { ...ctx.entry, positionPendingSince: iso() };
      await journal.put(poolKey, ctx.entry);
    }
    const expectedPositions = read.positions.map((p) => ({
      position: p.position,
      positionNftAccount: p.positionNftAccount,
    }));
    return claimAndSettle(ctx, 'position', async (feePayer) => {
      const built = await withRetry(
        () =>
          core.buildCreatorPositionClaimTx({
            pool,
            creator,
            receiver: config.vault,
            payer: feePayer,
            positions: expectedPositions.map((p) => p.position),
          }),
        retry,
      );
      const tx = built.transaction;
      if (!tx || built.lastValidBlockHeight === null) {
        return { outcome: { ...base, result: 'nothing_to_claim' } };
      }
      if (built.summary.claimable.quote < config.minPositionClaimLamports) {
        return {
          outcome: { ...base, result: 'below_threshold', claimable: built.summary.claimable.quote },
        };
      }
      if (
        !built.summary.receiver.equals(config.vault) ||
        !built.summary.claimer.equals(creator) ||
        !built.summary.dammPool.equals(read.dammPool) ||
        !built.summary.baseMint.equals(mint)
      ) {
        throw new JobError('TX_POLICY', 'position claim summary does not match the request');
      }
      assertCreatorPositionClaimTx(tx, {
        cpAmmProgramId: core.cpAmmProgramId,
        dammPool: read.dammPool,
        baseMint: mint,
        creator,
        feePayer,
        receiver: config.vault,
        positions: expectedPositions,
      });
      return {
        kind: 'position',
        transaction: tx,
        lastValidBlockHeight: built.lastValidBlockHeight,
        claimableQuote: built.summary.claimable.quote,
        positions: expectedPositions.map((p) => p.position.toBase58()),
      };
    });
  }

  async function processLaunchpad(
    lp: CreatorLaunchpad,
    payer: { ref: string; publicKey: PublicKey } | null,
  ): Promise<ClaimOutcome[]> {
    const manual = async (reason: string, details: Record<string, unknown> = {}) => {
      await alert(
        'high',
        'creator_claim_manual',
        'A launchpad pool cannot be claimed automatically: check it',
        { launchpadId: lp.id, reason, ...details },
        `creator_claim_manual:${lp.id}:${reason}`,
      );
      return [{ launchpadId: lp.id, result: 'manual', reason } as ClaimOutcome];
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
    const ctx: PoolContext = {
      lp,
      pool,
      poolKey,
      mint,
      creator,
      creatorRef: expectedRef,
      payer,
      entry: (await journal.get(poolKey)) ?? freshEntry(poolKey, lp.id),
    };
    if (ctx.entry.launchpadId !== lp.id) {
      return manual('journal_launchpad_mismatch', { pool: poolKey });
    }

    // 1. A claim in flight (of either kind) is settled first.
    if (ctx.entry.inFlight) {
      const inFlight = ctx.entry.inFlight;
      const s = await checkSettlement(rpc, inFlight.signature, inFlight.lastValidBlockHeight, retry);
      if (s.kind === 'pending' && announce(inFlight.signature)) {
        try {
          await rpc.sendRawTransaction(Buffer.from(inFlight.rawTx, 'base64'));
        } catch (err) {
          log.debug({ pool: poolKey, err: describeError(err) }, 'claim rebroadcast failed');
        }
      }
      const applied = await applySettlement(lp, poolKey, ctx.entry, s);
      ctx.entry = applied.entry;
      if (applied.outcome) return [applied.outcome];
    }

    // 2. Pool state: existence, creator, quote mint.
    const state = await withRetry(() => core.readCreatorPool(pool), retry);
    if (!state) return [{ ...base, result: 'no_pool' }];
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
      return [{ ...base, result: 'manual', reason: 'pool_creator_changed' }];
    }
    if (!state.baseMint.equals(mint) || !state.config.equals(configAddress)) {
      return manual('pool_mismatch', { pool: poolKey });
    }
    if (!state.quoteMint.equals(NATIVE_MINT)) return manual('not_sol_quoted', { pool: poolKey });

    if (state.graduated && ctx.entry.graduationNoticeAt === null) {
      await alert(
        'normal',
        'pool_graduated',
        'A FORGE launchpad coin graduated: once migrated, the fees of its DAMM v2 creator position are claimed by this job',
        { launchpadId: lp.id, pool: poolKey },
        `pool_graduated:${poolKey}`,
      );
      ctx.entry = { ...ctx.entry, graduationNoticeAt: iso() };
      await journal.put(poolKey, ctx.entry);
    }

    // 3. The DBC creator share, then (migrated pool, nothing sent for the DBC share) the
    //    position fees. One claim at a time per pool: a DBC claim sent now leaves the position
    //    fees to the next run.
    const outcomes: ClaimOutcome[] = [await dbcPath(ctx, state)];
    const dbc = outcomes[0]!;
    if (state.migrated && POSITION_PATH_AFTER.has(dbc.result) && stopReason === null) {
      outcomes.push(await positionPath(ctx));
    }
    return outcomes;
  }

  async function checkUnclaimed(lp: CreatorLaunchpad, poolKey: string | undefined) {
    if (!poolKey) return;
    let entry: ClaimJournalEntry | undefined;
    try {
      entry = await journal.get(poolKey);
    } catch {
      return;
    }
    if (!entry) return;
    const pending: Array<[ClaimKind, string | null]> = [
      ['dbc', entry.pendingSince],
      ['position', entry.positionPendingSince],
    ];
    for (const [kind, since] of pending) {
      if (!since) continue;
      const age = now() - Date.parse(since);
      if (age <= unclaimedAlertMs) continue;
      const code = kind === 'dbc' ? 'creator_fees_unclaimed' : 'position_fees_unclaimed';
      await alert(
        'normal',
        code,
        kind === 'dbc'
          ? 'Creator fees above the threshold have been unclaimed for more than 48 h'
          : 'DAMM v2 position fees above the threshold have been unclaimed for more than 48 h',
        { launchpadId: lp.id, pool: poolKey, since, lastError: entry.lastError ?? 'none' },
        `${code}:${poolKey}`,
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
      let results: ClaimOutcome[];
      try {
        results = await processLaunchpad(lp, payer);
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
        results = [{ launchpadId: lp.id, result: 'error', error: summary.message }];
      }
      await checkUnclaimed(lp, results[0]?.pool);
      outcomes.push(...results);
      // A launchpad skipped because the switch flipped is the first one of the next run.
      if (stopReason === null) processed++;
      for (const outcome of results) if (ON_CHAIN_RESULTS.has(outcome.result)) attempts++;
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
/**
 * Default of SIGNER_CLAIMS_MIN_POSITION_LAMPORTS (0.05 SOL): a position claim pays the rent of a
 * temporary WSOL account (about 0.002 SOL) every time, so it waits for more than a DBC claim.
 */
export const DEFAULT_MIN_POSITION_CLAIM_LAMPORTS = 50_000_000n;
/**
 * Default run interval: 1 hour. A run is read-only unless a pool's unclaimed fees (DBC share or,
 * after migration, DAMM v2 position fees) reach the threshold, so the hourly cadence costs RPC
 * reads only. `OPS.claimIntervalHours` of @forge/shared (24) is no longer the signer default.
 */
export const DEFAULT_CLAIMS_INTERVAL_HOURS = 1;
export const DEFAULT_CLAIMS_INTERVAL_MS = DEFAULT_CLAIMS_INTERVAL_HOURS * 60 * 60_000;

/**
 * SIGNER_CLAIMS_MIN_LAMPORTS (default 0.01 SOL), SIGNER_CLAIMS_FEE_PAYER (`payer` | `creator`,
 * default `payer`), SIGNER_CLAIMS_INTERVAL_HOURS (default 1), SIGNER_CLAIMS_PAUSED (default
 * false). `vault` comes from @forge/core `requireAddresses`.
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
      minPositionClaimLamports: parseLamportsEnv(
        env.SIGNER_CLAIMS_MIN_POSITION_LAMPORTS,
        'SIGNER_CLAIMS_MIN_POSITION_LAMPORTS',
        DEFAULT_MIN_POSITION_CLAIM_LAMPORTS,
      ),
      feePayer,
      paused: parseBoolEnv(env.SIGNER_CLAIMS_PAUSED, 'SIGNER_CLAIMS_PAUSED', false),
    },
    intervalMs:
      parsePositiveIntEnv(
        env.SIGNER_CLAIMS_INTERVAL_HOURS,
        'SIGNER_CLAIMS_INTERVAL_HOURS',
        DEFAULT_CLAIMS_INTERVAL_HOURS,
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
