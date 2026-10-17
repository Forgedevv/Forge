/**
 * Refunds job (docs/DECISIONS.md D4/D18, docs/INTERFACES.md §4-§5, tasks/05-SIGNER.md).
 *
 * Eligible: a job in `failed` with `failed_stage = 'build'` and `attempts = 2`, not locked, with
 * exactly one paid (`confirmed`) payment. A failure after approval (`onchain` / `deploy`) is
 * NEVER refunded here (D18: alert + manual handling, done by the builder's alerts).
 * Amount: the payment's lamports, re-verified on-chain (finalized) as paid by the payer to the
 * cashbox; recipient: that payer only, which must also be the launchpad owner. Sent from the
 * cashbox (key in the keystore), then payment -> `refunded`, job -> `refunded`.
 *
 * Exactly-once, with the current schema (`payments.refund_signature`):
 *   pending  = payment confirmed, refund_signature null
 *   sending  = payment confirmed, refund_signature = S (S is the ONLY transaction allowed to pay)
 *   sent     = payment refunded (and job refunded)
 * 1. The refund transaction is built, policy-checked and signed first: its signature S is known
 *    before anything is sent. A durable journal entry (signed bytes + last valid block height) is
 *    written, then S is recorded with a compare-and-set (`refund_signature is null` -> S). Only the
 *    winner of that CAS ever broadcasts, and only S's bytes.
 * 2. After a crash, a timeout or an RPC error, S is looked up with `getSignatureStatuses`
 *    (full history) before anything else: finalized success -> record; failed -> manual;
 *    unknown -> wait (re-broadcasting the same bytes). S is released (CAS S -> null) only once it is
 *    PROVEN unable to land (finalized height past its last valid block height, then still unknown).
 *    Without a journal entry, the expiry bound is derived from a block height observed after S
 *    was recorded (`FALLBACK_EXPIRY_BLOCKS`).
 * 3. Journal entries whose payment no longer points to S are reconciled too: a landed S that the
 *    database lost is repaired and alerted, never paid twice.
 * Kill switches: env `paused`, flag `refunds_paused` (fail closed when the flags cannot be read or
 * the row is missing), read at the start of the run AND again right before each new refund is
 * signed, so turning the switch on stops a run in progress.
 * Manual handling: a job that cannot be refunded automatically (anomaly, included modification
 * with nothing to pay back, refused verification...) is alerted ONCE per reason and remembered in
 * the `manualMarks` journal, instead of being re-alerted on every run.
 *
 * Never twice, whatever the database says. The database rows (status, refund_signature, job
 * state) can be rewritten by anyone holding the service role key; the on-chain payment stays
 * valid forever. Three guards that the database cannot touch, checked before any new refund:
 * 1. the `ledger`: a local, append-only record in SIGNER_JOURNAL_DIR of every refund attempt this
 *    signer broadcast or saw landed, keyed by the payment id AND by the original payment's
 *    transaction signature, written (fsynced) before the first broadcast and never deleted. A
 *    payment (or payment signature) with an attempt that landed is refused for good (alert); one
 *    with an attempt still `sent` is settled on-chain first (landed: refused; proven expired or
 *    failed: allowed, nothing moved);
 * 2. the cashbox's recent history: a successful transaction carrying the refund memo
 *    `forge:refund:<paymentId>` means the refund exists on-chain (even with every local file
 *    lost): refused, alerted;
 * 3. a floor per payment kind (`minPaymentLamports`): a row below it cannot come from a quote.
 * Migration 0012 adds the database side: `refunded` is final and a refund signature is never
 * replaced.
 */
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import {
  JobStatus,
  PRICING,
  type FailedStage,
  type JobType,
  type PaymentKind,
  type PaymentStatus,
} from '@forge/shared';
import type { SignerCore } from '../core-adapter.js';
import {
  NO_PRIORITY_FEES,
  SOL_TRANSFER_COMPUTE_UNITS,
  signerBudgetInstructions,
  type PriorityFees,
} from './priority.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  FALLBACK_EXPIRY_BLOCKS,
  JOB_FLAGS,
  JobError,
  alertAbnormalPause,
  assertSolTransferTx,
  awaitSettlement,
  broadcast,
  checkPaused,
  checkSettlement,
  createAnnouncer,
  createFileJournal,
  describeError,
  eq,
  formatSol,
  parseAddress,
  parseBoolEnv,
  parseLamports,
  parseLamportsEnv,
  parsePositiveIntEnv,
  paymentMinimumsFromEnv,
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
  type PauseReason,
  type PaymentMinimums,
  type PostgrestClient,
  type RetryOptions,
  type Settlement,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';

// ---------------------------------------------------------------------------------------
// Data

export interface RefundPayment {
  id: string;
  jobId: string;
  payerWallet: string;
  kind: PaymentKind;
  lamports: bigint;
  txSignature: string | null;
  status: PaymentStatus;
  refundSignature: string | null;
}

export interface RefundJob {
  id: string;
  launchpadId: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  failedStage: FailedStage | null;
  lockedAt: string | null;
  /** launchpads.owner_wallet */
  ownerWallet: string;
}

export interface RefundCandidate {
  job: RefundJob;
  payments: RefundPayment[];
}

export interface InFlightRefund {
  payment: RefundPayment;
  job: RefundJob;
}

/**
 * Database operations of the refunds job. Every write is a compare-and-set; a write whose
 * response is lost must be safe to repeat (implementations re-read on a 0-row update).
 */
export interface RefundStore {
  /**
   * Jobs in `failed` / `build` with attempts >= the refund threshold, with their payments,
   * oldest first (page `offset` .. `offset + limit`).
   */
  listRefundCandidates(limit: number, offset: number): Promise<RefundCandidate[]>;
  /** Payments still `confirmed` with a `refund_signature` (refund in flight), oldest first. */
  listInFlightRefunds(limit: number, offset: number): Promise<InFlightRefund[]>;
  getPayment(paymentId: string): Promise<RefundPayment | null>;
  /** CAS `refund_signature`: null -> S (payment confirmed, same tx_signature). True if S is recorded. */
  beginRefund(p: {
    paymentId: string;
    txSignature: string;
    refundSignature: string;
  }): Promise<boolean>;
  /** CAS `refund_signature`: S -> null (payment still confirmed). True if it is null afterwards. */
  releaseRefund(p: { paymentId: string; refundSignature: string }): Promise<boolean>;
  /** CAS status confirmed -> refunded where refund_signature = S. True if refunded with S. */
  completeRefund(p: { paymentId: string; refundSignature: string }): Promise<boolean>;
  /** CAS job failed/build -> refunded. True if the job is refunded afterwards. */
  markJobRefunded(jobId: string): Promise<boolean>;
  /** Client-visible progress message (best effort). */
  addJobEvent(jobId: string, message: string): Promise<void>;
}

export const RefundJournalEntry = z.object({
  v: z.literal(1),
  paymentId: z.string(),
  jobId: z.string(),
  signature: z.string(),
  /** Signed transaction (base64), absent when reconstructed from the database. */
  rawTx: z.string().nullable(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  expirySource: z.enum(['blockhash', 'observed']),
  lamports: z.string().regex(/^[0-9]+$/),
  recipient: z.string(),
  /** prepared: signed, not recorded in the DB (never broadcast); sent: recorded, may be on-chain. */
  state: z.enum(['prepared', 'sent', 'manual']),
  manualReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RefundJournalEntry = z.infer<typeof RefundJournalEntry>;

/** A job sent to manual handling, remembered so it is alerted once (key: the job id). */
export const RefundManualMark = z.object({
  v: z.literal(1),
  jobId: z.string(),
  paymentId: z.string().nullable(),
  reason: z.string(),
  at: z.string(),
});
export type RefundManualMark = z.infer<typeof RefundManualMark>;

// ---------------------------------------------------------------------------------------
// Refund ledger (append-only, local, keyed by payment id and by payment signature)

/** `sent`: broadcast by this signer; `landed`: seen on-chain; `expired` / `failed`: proven to have moved nothing. */
export const RefundLedgerState = z.enum(['sent', 'landed', 'expired', 'failed']);
export type RefundLedgerState = z.infer<typeof RefundLedgerState>;

export const RefundLedgerAttempt = z.object({
  refundSignature: z.string(),
  lamports: z.string().regex(/^[0-9]+$/),
  recipient: z.string(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  state: RefundLedgerState,
  recordedAt: z.string(),
  updatedAt: z.string(),
});
export type RefundLedgerAttempt = z.infer<typeof RefundLedgerAttempt>;

export const RefundLedgerEntry = z.object({
  v: z.literal(1),
  paymentId: z.string(),
  jobId: z.string(),
  /** Transaction signature of the client's payment (the on-chain fact a refund is based on). */
  paymentSignature: z.string(),
  attempts: z.array(RefundLedgerAttempt).max(100),
});
export type RefundLedgerEntry = z.infer<typeof RefundLedgerEntry>;

export interface RefundLedgerRecord {
  paymentId: string;
  jobId: string;
  paymentSignature: string;
  refundSignature: string;
  lamports: bigint;
  recipient: string;
  lastValidBlockHeight: number;
  state: RefundLedgerState;
  at: string;
}

/**
 * Every refund attempt this signer ever broadcast or saw landed, for good. Two files per
 * payment (`refund-ledger.p-<paymentId>`, `refund-ledger.s-<paymentSignature>`) hold the same
 * entry, so a payment row re-created under another id for the same transaction is found too.
 * Entries are appended and an attempt only moves from `sent` to a terminal state: nothing is
 * ever removed or moved back.
 */
export interface RefundLedger {
  /** Attempts recorded under the payment id or the payment signature (merged, deduplicated). */
  find(ids: { paymentId: string; paymentSignature: string }): Promise<RefundLedgerAttempt[]>;
  /** Appends the attempt, or moves a `sent` attempt to the given terminal state. */
  record(entry: RefundLedgerRecord): Promise<void>;
}

const LEDGER_PAYMENT_KEY = (paymentId: string) => `p-${paymentId}`;
const LEDGER_SIGNATURE_KEY = (signature: string) => `s-${signature}`;
const TERMINAL_LEDGER_STATES: ReadonlySet<RefundLedgerState> = new Set([
  'landed',
  'expired',
  'failed',
]);

function mergeLedgerAttempts(entries: Array<RefundLedgerEntry | undefined>): RefundLedgerAttempt[] {
  const byRefund = new Map<string, RefundLedgerAttempt>();
  for (const entry of entries) {
    for (const attempt of entry?.attempts ?? []) {
      const known = byRefund.get(attempt.refundSignature);
      // Two files that disagree (crash between the two writes): keep the most advanced state.
      if (!known || (known.state === 'sent' && attempt.state !== 'sent')) {
        byRefund.set(attempt.refundSignature, attempt);
      }
    }
  }
  return [...byRefund.values()];
}

/** A ledger over any journal (file journal in production, memory journal in tests). */
export function createRefundLedger(journal: Journal<RefundLedgerEntry>): RefundLedger {
  const apply = (entry: RefundLedgerEntry, r: RefundLedgerRecord): RefundLedgerEntry => {
    const attempts = entry.attempts.map((a) => {
      if (a.refundSignature !== r.refundSignature) return a;
      if (a.state === 'sent' && TERMINAL_LEDGER_STATES.has(r.state)) {
        return { ...a, state: r.state, updatedAt: r.at };
      }
      return a;
    });
    if (!attempts.some((a) => a.refundSignature === r.refundSignature)) {
      attempts.push({
        refundSignature: r.refundSignature,
        lamports: r.lamports.toString(),
        recipient: r.recipient,
        lastValidBlockHeight: r.lastValidBlockHeight,
        state: r.state,
        recordedAt: r.at,
        updatedAt: r.at,
      });
    }
    return { ...entry, attempts };
  };
  return {
    async find({ paymentId, paymentSignature }) {
      return mergeLedgerAttempts([
        await journal.get(LEDGER_PAYMENT_KEY(paymentId)),
        await journal.get(LEDGER_SIGNATURE_KEY(paymentSignature)),
      ]);
    },
    async record(r) {
      for (const key of [
        LEDGER_PAYMENT_KEY(r.paymentId),
        LEDGER_SIGNATURE_KEY(r.paymentSignature),
      ]) {
        const current = (await journal.get(key)) ?? {
          v: 1 as const,
          paymentId: r.paymentId,
          jobId: r.jobId,
          paymentSignature: r.paymentSignature,
          attempts: [],
        };
        const next = apply(current, r);
        if (JSON.stringify(next) !== JSON.stringify(current)) await journal.put(key, next);
      }
    },
  };
}

/** The production ledger: `<dir>/refund-ledger.*.json`, written atomically and fsynced. */
export function createFileRefundLedger(dir: string): RefundLedger {
  return createRefundLedger(
    createFileJournal({ dir, namespace: 'refund-ledger', schema: RefundLedgerEntry }),
  );
}

export const REFUND_MEMO_PREFIX = 'forge:refund:';
/** Recent cashbox signatures scanned for an existing refund memo before a new refund is signed. */
export const REFUND_SCAN_LIMIT = 200;

/** Rows read per database page, and the most rows one run looks at per list. */
const PAGE_SIZE = 100;
const MAX_LISTED = 5_000;
/** Outcomes that cost on-chain work; `maxPerRun` bounds them. */
const ON_CHAIN_RESULTS = new Set<RefundOutcome['result']>([
  'refunded',
  'in_flight',
  'released',
  'lost_race',
  'error',
]);
export const refundMemo = (paymentId: string) => `${REFUND_MEMO_PREFIX}${paymentId}`;

/** Kept on top of the refund for the transaction fee (one signature = 5 000 lamports today). */
export const REFUND_FEE_BUFFER_LAMPORTS = 10_000n;

// ---------------------------------------------------------------------------------------
// Pure eligibility

export type ManualReason =
  | 'attempts_anomaly'
  | 'no_paid_payment'
  | 'multiple_payments'
  | 'refunded_without_signature'
  | 'missing_payment_signature'
  | 'zero_amount'
  | 'above_refund_cap'
  | 'payer_mismatch'
  | 'invalid_payer'
  | 'payment_not_verified'
  | 'payment_mismatch'
  | 'recipient_not_rent_exempt'
  | 'refund_failed_onchain'
  | 'below_minimum'
  | 'refund_already_sent'
  | 'refund_onchain_found';

export type SkipReason =
  'job_not_failed' | 'not_build_failure' | 'retry_pending' | 'job_locked' | 'in_flight';

export type RefundDecision =
  | { action: 'refund'; payment: RefundPayment & { txSignature: string }; payer: PublicKey }
  | { action: 'finalize_job'; payment: RefundPayment }
  | { action: 'manual'; reason: ManualReason; paymentId?: string }
  | { action: 'skip'; reason: SkipReason };

export interface DecideOptions {
  maxAttempts: number;
  maxRefundLamports: bigint;
  /** Floor per payment kind: a confirmed row below it cannot come from a quote (manual). */
  minPaymentLamports?: PaymentMinimums;
}

/** Decides what to do with a candidate job, from database data only (no network). */
export function decideRefund(candidate: RefundCandidate, opts: DecideOptions): RefundDecision {
  const { job } = candidate;
  if (job.status !== 'failed') return { action: 'skip', reason: 'job_not_failed' };
  // D18: a failure after approval is never refunded automatically.
  if (job.failedStage !== 'build') return { action: 'skip', reason: 'not_build_failure' };
  if (job.attempts < opts.maxAttempts) return { action: 'skip', reason: 'retry_pending' };
  if (job.attempts > opts.maxAttempts) return { action: 'manual', reason: 'attempts_anomaly' };
  if (job.lockedAt !== null) return { action: 'skip', reason: 'job_locked' };

  const paid = candidate.payments.filter(
    (p) => p.status === 'confirmed' || p.status === 'refunded',
  );
  if (paid.length === 0) return { action: 'manual', reason: 'no_paid_payment' };
  if (paid.length > 1) return { action: 'manual', reason: 'multiple_payments' };
  const payment = paid[0]!;
  if (payment.jobId !== job.id) return { action: 'manual', reason: 'no_paid_payment' };
  if (payment.status === 'refunded') {
    return payment.refundSignature
      ? { action: 'finalize_job', payment }
      : { action: 'manual', reason: 'refunded_without_signature', paymentId: payment.id };
  }
  if (payment.refundSignature !== null) return { action: 'skip', reason: 'in_flight' };
  // An included modification (0 lamports, no transaction): nothing to pay back. Checked before
  // the signature, which such a payment never has.
  if (payment.lamports <= 0n)
    return { action: 'manual', reason: 'zero_amount', paymentId: payment.id };
  if (!payment.txSignature) {
    return { action: 'manual', reason: 'missing_payment_signature', paymentId: payment.id };
  }
  const floor = opts.minPaymentLamports?.[payment.kind] ?? 0n;
  if (payment.lamports < floor) {
    return { action: 'manual', reason: 'below_minimum', paymentId: payment.id };
  }
  if (payment.lamports > opts.maxRefundLamports) {
    return { action: 'manual', reason: 'above_refund_cap', paymentId: payment.id };
  }
  const payer = parseAddress(payment.payerWallet);
  if (!payer) return { action: 'manual', reason: 'invalid_payer', paymentId: payment.id };
  if (payment.payerWallet !== job.ownerWallet) {
    return { action: 'manual', reason: 'payer_mismatch', paymentId: payment.id };
  }
  return { action: 'refund', payment: { ...payment, txSignature: payment.txSignature }, payer };
}

// ---------------------------------------------------------------------------------------
// Job

export interface RefundsConfig {
  /** FORGE_CASHBOX_WALLET (from `requireAddresses` of @forge/core at startup). */
  cashbox: PublicKey;
  /** Hard cap per refund: anything above goes to manual handling. */
  maxRefundLamports: bigint;
  /** Floor per payment kind (SIGNER_MIN_*_PAYMENT_LAMPORTS): below it, manual handling. */
  minPaymentLamports?: PaymentMinimums;
  /** New refund attempts per run (in-flight ones are always resumed). Default 10. */
  maxPerRun?: number;
  /** Local kill switch (env). */
  paused?: boolean;
  settle?: Partial<SettleTiming>;
}

export interface RefundsDeps {
  store: RefundStore;
  rpc: SolanaRpc;
  core: Pick<SignerCore, 'verifyPayment' | 'buildSolTransferTx'>;
  keystore: KeystoreLike;
  journal: Journal<RefundJournalEntry>;
  /** Jobs already alerted for manual handling (alert once per job and reason). */
  manualMarks: Journal<RefundManualMark>;
  /** Permanent record of every refund attempt (see the header). Required. */
  ledger: RefundLedger;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  config: RefundsConfig;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Shared with the cashbox job so they never spend from the cashbox at the same time. Required. */
  walletLock: Mutex;
  /** Called with each refund signature right before it is (re)broadcast by this process. Required. */
  onBeforeSend: BeforeSendHook;
  /** Priority fee of the refunds (SIGNER_PRIORITY_FEE_*, jobs/priority.ts). Default: none. */
  priorityFees?: PriorityFees;
}

export type RefundOutcome =
  | { result: 'refunded'; jobId: string; paymentId: string; signature: string; lamports: bigint }
  | { result: 'job_finalized'; jobId: string; paymentId: string }
  | { result: 'in_flight'; paymentId: string; signature: string; state: string }
  | { result: 'released'; paymentId: string; signature: string }
  | { result: 'repaired'; paymentId: string; signature: string }
  | { result: 'lost_race'; paymentId: string }
  | { result: 'manual'; jobId?: string; paymentId?: string; reason: string }
  | { result: 'skipped'; jobId?: string; paymentId?: string; reason: string }
  | { result: 'error'; jobId?: string; paymentId?: string; error: string };

export interface RefundsRunReport {
  status: 'ran' | 'paused' | 'busy' | 'error';
  reason?: string;
  outcomes: RefundOutcome[];
}

export interface RefundsJob {
  runOnce(): Promise<RefundsRunReport>;
}

export function createRefundsJob(deps: RefundsDeps): RefundsJob {
  const { store, rpc, core, keystore, journal, ledger, alerter, logger: log, config } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const settleTiming = { ...DEFAULT_SETTLE, ...config.settle };
  const maxPerRun = config.maxPerRun ?? 10;
  const priorityFees = deps.priorityFees ?? NO_PRIORITY_FEES;
  /** Network fee of a refund: signature and priority fee at its cap. */
  const refundFeeBuffer =
    REFUND_FEE_BUFFER_LAMPORTS + priorityFees.maxFeeLamports(SOL_TRANSFER_COMPUTE_UNITS);
  let running = false;
  /** Set when the kill switch is found on during a run: no further refund is started. */
  let stopReason: PauseReason | null = null;
  if (!deps.walletLock || typeof deps.walletLock.runExclusive !== 'function') {
    throw new JobError('CONFIG', 'walletLock is required (shared with the cashbox job)');
  }
  if (!deps.manualMarks) throw new JobError('CONFIG', 'manualMarks journal is required');
  if (!ledger || typeof ledger.find !== 'function' || typeof ledger.record !== 'function') {
    throw new JobError('CONFIG', 'refund ledger is required');
  }

  const iso = () => new Date(now()).toISOString();

  /** Writes an attempt (or its terminal state) to the permanent ledger. */
  const ledgerRecord = (
    payment: Pick<RefundPayment, 'id' | 'jobId' | 'txSignature' | 'payerWallet'>,
    entry: Pick<
      RefundJournalEntry,
      'signature' | 'lamports' | 'recipient' | 'lastValidBlockHeight'
    >,
    state: RefundLedgerState,
  ) =>
    ledger.record({
      paymentId: payment.id,
      jobId: payment.jobId,
      // A payment without a transaction signature is never refunded; keyed by id only then.
      paymentSignature: payment.txSignature ?? `none-${payment.id}`,
      refundSignature: entry.signature,
      lamports: BigInt(entry.lamports),
      recipient: entry.recipient,
      lastValidBlockHeight: entry.lastValidBlockHeight,
      state,
      at: iso(),
    });
  const alert = (
    level: 'immediate' | 'high' | 'normal',
    code: string,
    message: string,
    details: Record<string, unknown>,
    dedupKey?: string,
  ) => sendAlert(alerter, log, level, code, message, details, dedupKey);

  /** Tells the watcher about S before this process broadcasts it (once per process). */
  const announce = createAnnouncer(deps.onBeforeSend, log);

  /** Waits for S; re-broadcasts its bytes only when known and announced to the watcher. */
  const settle = (signature: string, entry: RefundJournalEntry) =>
    awaitSettlement(rpc, signature, {
      lastValidBlockHeight: entry.lastValidBlockHeight,
      ...(entry.rawTx && announce(signature) ? { raw: Buffer.from(entry.rawTx, 'base64') } : {}),
      until: 'finalized',
      ...settleTiming,
      retry,
      sleep,
      now,
      logger: log,
    });

  async function finishRefund(
    payment: RefundPayment,
    jobId: string,
    entry: RefundJournalEntry,
  ): Promise<RefundOutcome> {
    const signature = entry.signature;
    // The money moved: the ledger says so before the database is asked anything.
    await ledgerRecord(payment, entry, 'landed');
    const recorded = await store.completeRefund({
      paymentId: payment.id,
      refundSignature: signature,
    });
    if (!recorded) {
      await alert(
        'immediate',
        'refund_record_mismatch',
        'A refund landed on-chain but the payment could not be marked refunded: check it now',
        { jobId, paymentId: payment.id, signature },
        `refund_record_mismatch:${payment.id}`,
      );
      return { result: 'error', jobId, paymentId: payment.id, error: 'refund_record_mismatch' };
    }
    const jobDone = await store.markJobRefunded(jobId);
    if (!jobDone) {
      await alert(
        'high',
        'refund_job_state',
        'Refund sent but the job was not in failed/build: set its status by hand',
        { jobId, paymentId: payment.id, signature },
        `refund_job_state:${jobId}`,
      );
    }
    try {
      await store.addJobEvent(
        jobId,
        `Your payment of ${formatSol(payment.lamports)} was refunded to your wallet (transaction ${signature}).`,
      );
    } catch (err) {
      log.warn({ jobId, err: describeError(err) }, 'refund job event not recorded');
    }
    await journal.delete(payment.id);
    await deps.manualMarks.delete(jobId).catch((err: unknown) => {
      log.warn({ jobId, err: describeError(err) }, 'manual mark not cleared');
    });
    log.info(
      { jobId, paymentId: payment.id, signature, lamports: payment.lamports.toString() },
      'refund recorded',
    );
    await alert('normal', 'refund_sent', 'Job failed twice: payment refunded', {
      jobId,
      paymentId: payment.id,
      amount: formatSol(payment.lamports),
      recipient: payment.payerWallet,
      signature,
    });
    return {
      result: 'refunded',
      jobId,
      paymentId: payment.id,
      signature,
      lamports: payment.lamports,
    };
  }

  /** Acts on the settlement of the recorded refund signature S of `payment`. */
  async function onSettlement(
    payment: RefundPayment,
    jobId: string,
    entry: RefundJournalEntry,
    s: Settlement,
  ): Promise<RefundOutcome> {
    const signature = entry.signature;
    switch (s.kind) {
      case 'finalized':
        return finishRefund(payment, jobId, entry);
      case 'failed': {
        // No lamport moved (a failed transaction is atomic). Conservative: no automatic retry.
        await ledgerRecord(payment, entry, 'failed');
        await journal.put(payment.id, {
          ...entry,
          state: 'manual',
          manualReason: 'refund_failed_onchain',
          updatedAt: iso(),
        });
        await alert(
          'high',
          'refund_failed_onchain',
          'The refund transaction failed on-chain (nothing was sent): manual handling. To retry, clear payments.refund_signature.',
          { jobId, paymentId: payment.id, signature, error: s.error },
          `refund_failed_onchain:${payment.id}`,
        );
        return { result: 'manual', jobId, paymentId: payment.id, reason: 'refund_failed_onchain' };
      }
      case 'expired': {
        // Proven unable to land: the ledger says so before the signature is released.
        await ledgerRecord(payment, entry, 'expired');
        const released = await store.releaseRefund({
          paymentId: payment.id,
          refundSignature: signature,
        });
        if (!released) {
          await alert(
            'high',
            'refund_release_conflict',
            'An expired refund could not be released: the payment changed meanwhile',
            { jobId, paymentId: payment.id, signature },
            `refund_release_conflict:${payment.id}`,
          );
          return { result: 'error', jobId, paymentId: payment.id, error: 'release_conflict' };
        }
        await journal.delete(payment.id);
        log.warn({ jobId, paymentId: payment.id, signature }, 'refund expired unsent: released');
        return { result: 'released', paymentId: payment.id, signature };
      }
      default:
        return { result: 'in_flight', paymentId: payment.id, signature, state: s.kind };
    }
  }

  /** Step 1: a payment whose refund_signature S is set. */
  async function resumeInFlight(item: InFlightRefund): Promise<RefundOutcome> {
    const { payment, job } = item;
    const signature = payment.refundSignature;
    if (!signature) return { result: 'skipped', paymentId: payment.id, reason: 'not_in_flight' };
    let entry = await journal.get(payment.id);
    if (entry && entry.signature !== signature && entry.state !== 'prepared') {
      // Our own earlier attempt for this payment, replaced in the database by another one:
      // it must be dead before we forget it.
      const old = await checkSettlement(rpc, entry.signature, entry.lastValidBlockHeight, retry);
      if (old.kind === 'finalized' || old.kind === 'confirmed') {
        await alert(
          'immediate',
          'refund_double_risk',
          'Two refund transactions exist for one payment and the older one landed: check now',
          { paymentId: payment.id, landed: entry.signature, recorded: signature },
          `refund_double_risk:${payment.id}`,
        );
        return { result: 'manual', paymentId: payment.id, reason: 'refund_record_conflict' };
      }
      if (old.kind !== 'expired' && old.kind !== 'failed') {
        return {
          result: 'in_flight',
          paymentId: payment.id,
          signature: entry.signature,
          state: old.kind,
        };
      }
      entry = undefined;
    }
    if (!entry || entry.signature !== signature) {
      const observed = await withRetry(() => rpc.getBlockHeight('confirmed'), retry);
      entry = {
        v: 1,
        paymentId: payment.id,
        jobId: payment.jobId,
        signature,
        rawTx: null,
        lastValidBlockHeight: observed + FALLBACK_EXPIRY_BLOCKS,
        expirySource: 'observed',
        lamports: payment.lamports.toString(),
        recipient: payment.payerWallet,
        state: 'sent',
        manualReason: null,
        createdAt: iso(),
        updatedAt: iso(),
      };
      await journal.put(payment.id, entry);
      log.warn(
        { jobId: payment.jobId, paymentId: payment.id, signature },
        'in-flight refund without a journal entry: waiting for proven expiry before any resend',
      );
    }
    if (entry.state === 'manual') {
      return {
        result: 'manual',
        jobId: payment.jobId,
        paymentId: payment.id,
        reason: entry.manualReason ?? 'manual',
      };
    }
    if (entry.state === 'prepared') {
      // The database holds S: this exact transaction is the authorized refund.
      entry = { ...entry, state: 'sent', updatedAt: iso() };
      await journal.put(payment.id, entry);
    }
    // `settle` may (re)broadcast the signed bytes: the ledger knows the attempt first.
    if (entry.rawTx) await ledgerRecord(payment, entry, 'sent');
    const s = await settle(signature, entry);
    return onSettlement(payment, job.id, entry, s);
  }

  /** Step 2: journal entries whose payment does not (or no longer) record their signature. */
  async function reconcileJournal(entry: RefundJournalEntry): Promise<RefundOutcome> {
    const payment = await store.getPayment(entry.paymentId);
    const signature = entry.signature;
    if (!payment) {
      await alert(
        'high',
        'refund_payment_missing',
        'A refund journal entry points to a payment that no longer exists',
        { paymentId: entry.paymentId, signature },
        `refund_payment_missing:${entry.paymentId}`,
      );
      return { result: 'manual', paymentId: entry.paymentId, reason: 'payment_missing' };
    }
    if (payment.refundSignature === signature && payment.status === 'confirmed') {
      return { result: 'skipped', paymentId: payment.id, reason: 'resumed_in_flight' };
    }
    if (payment.refundSignature === signature && payment.status === 'refunded') {
      await ledgerRecord(payment, entry, 'landed');
      await journal.delete(entry.paymentId);
      return { result: 'skipped', paymentId: payment.id, reason: 'already_refunded' };
    }
    if (entry.state === 'prepared') {
      // Never recorded in the database, hence never broadcast: drop it.
      await journal.delete(entry.paymentId);
      return { result: 'skipped', paymentId: payment.id, reason: 'unsent_attempt_dropped' };
    }
    // S was recorded (and possibly broadcast), but the payment now says something else.
    const s = await checkSettlement(rpc, signature, entry.lastValidBlockHeight, retry);
    if (s.kind === 'expired' || s.kind === 'failed') {
      await ledgerRecord(payment, entry, s.kind);
      await journal.delete(entry.paymentId);
      return { result: 'skipped', paymentId: payment.id, reason: `stale_attempt_${s.kind}` };
    }
    if (s.kind === 'finalized' || s.kind === 'confirmed') {
      // Our refund S paid the client. Repair the record if possible, never pay again.
      await ledgerRecord(payment, entry, 'landed');
      if (
        payment.status === 'confirmed' &&
        payment.refundSignature === null &&
        payment.txSignature
      ) {
        const recorded = await store.beginRefund({
          paymentId: payment.id,
          txSignature: payment.txSignature,
          refundSignature: signature,
        });
        if (recorded) {
          await alert(
            'immediate',
            'refund_record_repaired',
            'A landed refund was missing from the database: it has been recorded again',
            { paymentId: payment.id, signature },
            `refund_record_repaired:${payment.id}`,
          );
          if (s.kind === 'finalized') {
            const done = await finishRefund(payment, payment.jobId, entry);
            return done.result === 'refunded'
              ? { result: 'repaired', paymentId: payment.id, signature }
              : done;
          }
          return { result: 'repaired', paymentId: payment.id, signature };
        }
      }
      await alert(
        'immediate',
        'refund_double_risk',
        'A landed refund does not match the payment record (possible double refund): check now',
        {
          paymentId: payment.id,
          signature,
          recordedSignature: payment.refundSignature ?? 'none',
          status: payment.status,
        },
        `refund_double_risk:${payment.id}`,
      );
      return { result: 'manual', paymentId: payment.id, reason: 'refund_record_conflict' };
    }
    // Still able to land: keep the entry, block any new attempt for this payment.
    return { result: 'in_flight', paymentId: payment.id, signature, state: s.kind };
  }

  /** Step 3: a candidate job. */
  async function processCandidate(
    candidate: RefundCandidate,
    cashboxRef: string,
  ): Promise<RefundOutcome> {
    const jobId = candidate.job.id;
    const decision = decideRefund(candidate, {
      maxAttempts: PRICING.maxAttemptsBeforeRefund,
      maxRefundLamports: config.maxRefundLamports,
      ...(config.minPaymentLamports ? { minPaymentLamports: config.minPaymentLamports } : {}),
    });
    switch (decision.action) {
      case 'skip':
        return { result: 'skipped', jobId, reason: decision.reason };
      case 'manual':
        await alertManual(jobId, decision.paymentId, decision.reason);
        return {
          result: 'manual',
          jobId,
          ...(decision.paymentId ? { paymentId: decision.paymentId } : {}),
          reason: decision.reason,
        };
      case 'finalize_job': {
        const done = await store.markJobRefunded(jobId);
        if (!done) {
          return {
            result: 'error',
            jobId,
            paymentId: decision.payment.id,
            error: 'job_update_failed',
          };
        }
        return { result: 'job_finalized', jobId, paymentId: decision.payment.id };
      }
      case 'refund':
        return attemptRefund(candidate.job, decision.payment, decision.payer, cashboxRef);
    }
  }

  /**
   * Alerts once per (job, reason): the mark is written after the alert, so a crash in between
   * repeats the alert rather than losing it. An unreadable mark alerts again (never silent).
   */
  async function alertManual(
    jobId: string,
    paymentId: string | undefined,
    reason: string,
    extra: Record<string, unknown> = {},
    custom?: { code: string; message: string },
  ) {
    let mark: RefundManualMark | undefined;
    try {
      mark = await deps.manualMarks.get(jobId);
    } catch (err) {
      log.warn({ jobId, err: describeError(err) }, 'manual mark unreadable');
    }
    if (mark?.reason === reason) {
      log.debug({ jobId, reason }, 'manual handling already alerted');
      return;
    }
    const zero = reason === 'zero_amount';
    const code = custom?.code ?? 'refund_manual';
    const message =
      custom?.message ??
      (zero
        ? 'A build-failed job used an included modification (nothing was paid): restore the included modification by hand if needed'
        : 'A build-failed job cannot be refunded automatically: manual handling needed');
    await alert(
      zero ? 'normal' : 'high',
      code,
      message,
      { jobId, paymentId: paymentId ?? 'none', reason, ...extra },
      `${code}:${jobId}:${reason}`,
    );
    try {
      await deps.manualMarks.put(jobId, {
        v: 1,
        jobId,
        paymentId: paymentId ?? null,
        reason,
        at: iso(),
      });
    } catch (err) {
      log.warn({ jobId, err: describeError(err) }, 'manual mark not recorded');
    }
  }

  async function attemptRefund(
    job: RefundJob,
    payment: RefundPayment & { txSignature: string },
    payer: PublicKey,
    cashboxRef: string,
  ): Promise<RefundOutcome> {
    const manual = async (
      reason: ManualReason,
      extra: Record<string, unknown> = {},
      custom?: { code: string; message: string },
    ): Promise<RefundOutcome> => {
      await alertManual(job.id, payment.id, reason, extra, custom);
      return { result: 'manual', jobId: job.id, paymentId: payment.id, reason };
    };
    if (await journal.get(payment.id)) {
      // An earlier attempt that may still land (reconcileJournal kept it): never start another.
      return {
        result: 'skipped',
        jobId: job.id,
        paymentId: payment.id,
        reason: 'previous_attempt_unsettled',
      };
    }

    // The permanent ledger: a refund this signer already broadcast for this payment (by id or
    // by payment signature) is never repeated, whatever the database rows say now.
    const prior = await ledger.find({
      paymentId: payment.id,
      paymentSignature: payment.txSignature,
    });
    for (const attempt of prior) {
      if (attempt.state === 'expired' || attempt.state === 'failed') continue;
      let state: RefundLedgerState = attempt.state;
      if (state === 'sent') {
        // Broadcast, never settled here (journal lost?): settle it on-chain now.
        const s = await checkSettlement(
          rpc,
          attempt.refundSignature,
          attempt.lastValidBlockHeight,
          retry,
        );
        if (s.kind === 'expired' || s.kind === 'failed') {
          await ledgerRecord(payment, { ...attempt, signature: attempt.refundSignature }, s.kind);
          continue;
        }
        if (s.kind !== 'finalized' && s.kind !== 'confirmed') {
          return {
            result: 'in_flight',
            paymentId: payment.id,
            signature: attempt.refundSignature,
            state: `ledger_${s.kind}`,
          };
        }
        await ledgerRecord(payment, { ...attempt, signature: attempt.refundSignature }, 'landed');
        state = 'landed';
      }
      log.error(
        { jobId: job.id, paymentId: payment.id, refundSignature: attempt.refundSignature },
        'refund refused: the ledger holds a refund that landed for this payment',
      );
      return manual(
        'refund_already_sent',
        { refundSignature: attempt.refundSignature, ledgerState: state },
        {
          code: 'refund_ledger_blocked',
          message:
            'The local ledger records a refund that already landed for this payment, yet the database presents it for a refund again (rows rewritten?): nothing was sent, check the database and the cashbox history',
        },
      );
    }

    // The cashbox history: a successful transaction with this refund's memo is this refund, even
    // when every local file was lost.
    const recent = await withRetry(
      () => rpc.getRecentSignatures(config.cashbox, REFUND_SCAN_LIMIT),
      retry,
    );
    const expectedMemo = refundMemo(payment.id);
    const onChain = recent.find(
      (r) => !r.failed && r.memo !== null && r.memo.includes(expectedMemo),
    );
    if (onChain) {
      log.error(
        { jobId: job.id, paymentId: payment.id, signature: onChain.signature },
        'refund refused: a transaction with this refund memo is already on the cashbox',
      );
      return manual(
        'refund_onchain_found',
        { signature: onChain.signature },
        {
          code: 'refund_onchain_duplicate',
          message:
            'A transaction carrying the refund memo of this payment is already on the cashbox, yet the database presents the payment for a refund (rows rewritten, local state lost?): nothing was sent, check it',
        },
      );
    }

    // The payment, re-verified on-chain at finalized commitment.
    const verified = await withRetry(
      () =>
        core.verifyPayment(payment.txSignature, {
          payer,
          lamports: payment.lamports,
          jobId: job.id,
        }),
      retry,
    );
    if (verified.status === 'pending') {
      log.warn({ jobId: job.id, paymentId: payment.id }, 'payment not finalized yet: refund later');
      return {
        result: 'skipped',
        jobId: job.id,
        paymentId: payment.id,
        reason: 'payment_not_final',
      };
    }
    if (verified.status === 'invalid') {
      log.warn(
        { jobId: job.id, paymentId: payment.id, reason: verified.reason },
        'payment invalid',
      );
      return manual('payment_not_verified', {
        verification: verified.reason,
        detail: verified.detail,
      });
    }
    if (
      !verified.payer.equals(payer) ||
      !verified.recipient.equals(config.cashbox) ||
      verified.lamports !== payment.lamports ||
      verified.signature !== payment.txSignature
    ) {
      return manual('payment_mismatch');
    }
    const amount = verified.lamports;
    if (amount <= 0n) return manual('zero_amount');
    if (amount > config.maxRefundLamports) return manual('above_refund_cap');

    // Balances (rent read from the cluster, never hard-coded).
    const rentExempt = await withRetry(() => rpc.getMinimumBalanceForRentExemption(0), retry);
    const cashboxBalance = await spendableBalance(rpc, config.cashbox, retry);
    if (cashboxBalance < amount + refundFeeBuffer + rentExempt) {
      await alert(
        'high',
        'cashbox_low_balance',
        'The cashbox cannot cover a refund (and stay rent-exempt): fund it',
        {
          jobId: job.id,
          paymentId: payment.id,
          needed: formatSol(amount + refundFeeBuffer + rentExempt),
          balance: formatSol(cashboxBalance),
        },
        'cashbox_low_balance:refund',
      );
      return {
        result: 'skipped',
        jobId: job.id,
        paymentId: payment.id,
        reason: 'cashbox_insufficient',
      };
    }
    const recipientBalance = await withRetry(() => rpc.getBalance(payer, 'confirmed'), retry);
    if (recipientBalance + amount < rentExempt) return manual('recipient_not_rent_exempt');

    // The kill switch may have been turned on since the run started: re-read it before signing.
    const pause = await checkPaused(deps.flags, JOB_FLAGS.refunds, config.paused, log);
    if (pause.paused) {
      stopReason = pause.reason;
      await alertAbnormalPause(alerter, log, 'refunds', JOB_FLAGS.refunds, pause.reason);
      return { result: 'skipped', jobId: job.id, paymentId: payment.id, reason: 'paused' };
    }

    // Build, check, sign. The signature is known before anything is recorded or sent. The
    // compute budget (SIGNER_PRIORITY_FEE_*) comes first.
    const memo = refundMemo(payment.id);
    const priorityFee = await priorityFees.quote(
      [config.cashbox, payer],
      SOL_TRANSFER_COMPUTE_UNITS,
    );
    const tx = core.buildSolTransferTx({ from: config.cashbox, to: payer, lamports: amount, memo });
    tx.instructions.unshift(...signerBudgetInstructions(priorityFee));
    const { blockhash, lastValidBlockHeight } = await withRetry(
      () => rpc.getLatestBlockhash(),
      retry,
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = config.cashbox;
    assertSolTransferTx(tx, { from: config.cashbox, to: payer, lamports: amount, memo });
    const { raw, signature } = await signWithKeystore(keystore, tx, [
      { ref: cashboxRef, expected: config.cashbox },
    ]);

    let entry: RefundJournalEntry = {
      v: 1,
      paymentId: payment.id,
      jobId: job.id,
      signature,
      rawTx: raw.toString('base64'),
      lastValidBlockHeight,
      expirySource: 'blockhash',
      lamports: amount.toString(),
      recipient: payer.toBase58(),
      state: 'prepared',
      manualReason: null,
      createdAt: iso(),
      updatedAt: iso(),
    };
    await journal.put(payment.id, entry);

    let won: boolean;
    try {
      won = await store.beginRefund({
        paymentId: payment.id,
        txSignature: payment.txSignature,
        refundSignature: signature,
      });
    } catch (err) {
      // Unknown outcome: do not send. The next run reads the payment and resumes or drops.
      log.error(
        { jobId: job.id, paymentId: payment.id, err: describeError(err) },
        'beginRefund failed',
      );
      return {
        result: 'error',
        jobId: job.id,
        paymentId: payment.id,
        error: 'begin_refund_unknown',
      };
    }
    if (!won) {
      await journal.delete(payment.id);
      log.warn({ jobId: job.id, paymentId: payment.id }, 'refund already started elsewhere');
      return { result: 'lost_race', paymentId: payment.id };
    }
    entry = { ...entry, state: 'sent', updatedAt: iso() };
    await journal.put(payment.id, entry);
    // Permanent record, fsynced before the first broadcast: this payment is never refunded again.
    await ledgerRecord(payment, entry, 'sent');

    if (!announce(signature)) {
      return { result: 'in_flight', paymentId: payment.id, signature, state: 'not_announced' };
    }
    const sent = await broadcast(rpc, raw, retry);
    if (sent.status === 'rejected') {
      // The RPC refused it (preflight). It stays recorded until it is proven expired.
      await alert(
        'high',
        'refund_send_rejected',
        'The RPC rejected a refund transaction; it will be released once expired and retried',
        { jobId: job.id, paymentId: payment.id, signature, reason: sent.reason },
        `refund_send_rejected:${payment.id}`,
      );
      return { result: 'in_flight', paymentId: payment.id, signature, state: 'rejected' };
    }
    log.info(
      {
        jobId: job.id,
        paymentId: payment.id,
        signature,
        lamports: amount.toString(),
        recipient: payer.toBase58(),
      },
      'refund sent',
    );
    const s = await settle(signature, entry);
    return onSettlement({ ...payment, lamports: amount }, job.id, entry, s);
  }

  async function guarded(
    ids: { jobId?: string; paymentId?: string },
    fn: () => Promise<RefundOutcome>,
  ): Promise<RefundOutcome> {
    try {
      return await fn();
    } catch (err) {
      const summary = describeError(err);
      log.error({ ...ids, err: summary }, 'refund step failed');
      const policy =
        err instanceof JobError && (err.code === 'TX_POLICY' || err.code === 'SIGNER_MISMATCH');
      await alert(
        'high',
        policy ? 'refund_policy_violation' : 'refund_error',
        policy
          ? 'A refund transaction was refused before signing (policy check)'
          : 'A refund step failed (repeated RPC or database errors?)',
        { ...ids, error: summary.message },
        `refund_error:${ids.paymentId ?? ids.jobId ?? 'run'}`,
      );
      return { result: 'error', ...ids, error: summary.message };
    }
  }

  async function runUnlocked(): Promise<RefundsRunReport> {
    let cashboxRef: string;
    try {
      ({ ref: cashboxRef } = await requireRoleRef(keystore, 'cashbox', config.cashbox));
    } catch (err) {
      const summary = describeError(err);
      await alert('high', 'refunds_config', 'Refunds stopped: cashbox key problem', {
        error: summary.message,
      });
      return { status: 'error', reason: 'cashbox_key', outcomes: [] };
    }
    const outcomes: RefundOutcome[] = [];

    // 1. Refunds in flight (recorded signature): settle them all before anything else.
    const handled = new Set<string>();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await store.listInFlightRefunds(PAGE_SIZE, offset);
      for (const item of page) {
        if (handled.has(item.payment.id)) continue;
        handled.add(item.payment.id);
        outcomes.push(
          await guarded({ jobId: item.job.id, paymentId: item.payment.id }, () =>
            resumeInFlight(item),
          ),
        );
      }
      if (page.length < PAGE_SIZE || offset + PAGE_SIZE >= MAX_LISTED) break;
    }

    // 2. Journal entries not covered above.
    for (const { value } of await journal.list()) {
      if (handled.has(value.paymentId)) continue;
      outcomes.push(
        await guarded({ jobId: value.jobId, paymentId: value.paymentId }, () =>
          reconcileJournal(value),
        ),
      );
    }

    // 3. New refunds, page by page (jobs left for manual handling never starve newer ones).
    let attempts = 0;
    const seen = new Set<string>();
    stopReason = null;
    pages: for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await store.listRefundCandidates(PAGE_SIZE, offset);
      for (const candidate of page) {
        if (attempts >= maxPerRun || stopReason !== null) break pages;
        if (seen.has(candidate.job.id)) continue;
        seen.add(candidate.job.id);
        const outcome = await guarded({ jobId: candidate.job.id }, () =>
          processCandidate(candidate, cashboxRef),
        );
        if (ON_CHAIN_RESULTS.has(outcome.result)) attempts++;
        outcomes.push(outcome);
      }
      if (page.length < PAGE_SIZE || offset + PAGE_SIZE >= MAX_LISTED) break;
    }
    if (stopReason !== null) return { status: 'paused', reason: stopReason, outcomes };
    return { status: 'ran', outcomes };
  }

  return {
    async runOnce() {
      if (running) return { status: 'busy', outcomes: [] };
      running = true;
      try {
        const pause = await checkPaused(deps.flags, JOB_FLAGS.refunds, config.paused, log);
        if (pause.paused) {
          log.info({ reason: pause.reason }, 'refunds paused');
          await alertAbnormalPause(alerter, log, 'refunds', JOB_FLAGS.refunds, pause.reason);
          return { status: 'paused', reason: pause.reason, outcomes: [] };
        }
        try {
          return await deps.walletLock.runExclusive(runUnlocked);
        } catch (err) {
          const summary = describeError(err);
          log.error({ err: summary }, 'refunds run failed');
          await alert(
            'high',
            'refunds_run_failed',
            'The refunds run failed (database or RPC unavailable?)',
            { error: summary.message },
            'refunds_run_failed',
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

/** Default cap per refund: 2 SOL (creation is ~0.3 SOL, a modification less). */
export const DEFAULT_MAX_REFUND_LAMPORTS = 2_000_000_000n;
export const DEFAULT_REFUNDS_INTERVAL_MS = 5 * 60_000;

export interface RefundsEnvConfig {
  config: RefundsConfig;
  intervalMs: number;
}

/**
 * SIGNER_REFUNDS_MAX_LAMPORTS (default 2 SOL), SIGNER_REFUNDS_INTERVAL_MINUTES (default 5),
 * SIGNER_REFUNDS_PAUSED (default false), SIGNER_MIN_CREATION_PAYMENT_LAMPORTS /
 * SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS (shared floors, jobs/shared.ts). `cashbox` comes from
 * @forge/core `requireAddresses`.
 */
export function refundsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  cashbox: PublicKey,
): RefundsEnvConfig {
  return {
    config: {
      cashbox,
      maxRefundLamports: parseLamportsEnv(
        env.SIGNER_REFUNDS_MAX_LAMPORTS,
        'SIGNER_REFUNDS_MAX_LAMPORTS',
        DEFAULT_MAX_REFUND_LAMPORTS,
      ),
      minPaymentLamports: paymentMinimumsFromEnv(env),
      paused: parseBoolEnv(env.SIGNER_REFUNDS_PAUSED, 'SIGNER_REFUNDS_PAUSED', false),
    },
    intervalMs:
      parsePositiveIntEnv(
        env.SIGNER_REFUNDS_INTERVAL_MINUTES,
        'SIGNER_REFUNDS_INTERVAL_MINUTES',
        5,
      ) * 60_000,
  };
}

// ---------------------------------------------------------------------------------------
// Supabase implementation of the store

const PAYMENT_COLUMNS =
  'id,job_id,payer_wallet,kind,lamports::text,tx_signature,status,refund_signature';
const JOB_COLUMNS = 'id,launchpad_id,type,status,attempts,failed_stage,locked_at';

const PaymentRowSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  payer_wallet: z.string(),
  kind: z.enum(['creation', 'modification']),
  lamports: z.union([z.string(), z.number()]),
  tx_signature: z.string().nullable(),
  status: z.enum(['quoted', 'confirmed', 'expired', 'refunded']),
  refund_signature: z.string().nullable(),
});

const JobRowSchema = z.object({
  id: z.string(),
  launchpad_id: z.string(),
  type: z.enum(['create_launchpad', 'modify_launchpad']),
  status: JobStatus,
  attempts: z.number().int(),
  failed_stage: z.enum(['build', 'onchain', 'deploy']).nullable(),
  locked_at: z.string().nullable(),
  launchpads: z.object({ owner_wallet: z.string() }),
});

const CandidateRowSchema = JobRowSchema.extend({ payments: z.array(PaymentRowSchema) });
const InFlightRowSchema = PaymentRowSchema.extend({ jobs: JobRowSchema });

function toPayment(row: z.infer<typeof PaymentRowSchema>): RefundPayment {
  return {
    id: row.id,
    jobId: row.job_id,
    payerWallet: row.payer_wallet,
    kind: row.kind,
    lamports: parseLamports(row.lamports),
    txSignature: row.tx_signature,
    status: row.status,
    refundSignature: row.refund_signature,
  };
}

function toJob(row: z.infer<typeof JobRowSchema>): RefundJob {
  return {
    id: row.id,
    launchpadId: row.launchpad_id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    failedStage: row.failed_stage,
    lockedAt: row.locked_at,
    ownerWallet: row.launchpads.owner_wallet,
  };
}

function parseRows<T>(schema: z.ZodType<T>, rows: unknown[], what: string): T[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw new JobError('DB_RESPONSE', `unexpected ${what} rows`);
  return parsed.data;
}

/** RefundStore over Supabase PostgREST (service role). */
export function createPostgrestRefundStore(db: PostgrestClient): RefundStore {
  const getPayment = async (paymentId: string): Promise<RefundPayment | null> => {
    const rows = parseRows(
      PaymentRowSchema,
      await db.select('payments', { select: PAYMENT_COLUMNS, id: eq(paymentId) }),
      'payment',
    );
    return rows[0] ? toPayment(rows[0]) : null;
  };
  const sig = (value: string) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value)) throw new JobError('DB', 'invalid signature');
    return `eq.${value}`;
  };

  return {
    async listRefundCandidates(limit, offset) {
      const rows = await db.select('jobs', {
        select: `${JOB_COLUMNS},launchpads(owner_wallet),payments(${PAYMENT_COLUMNS})`,
        status: 'eq.failed',
        failed_stage: 'eq.build',
        attempts: `gte.${PRICING.maxAttemptsBeforeRefund}`,
        order: 'created_at.asc,id.asc',
        limit: String(limit),
        offset: String(offset),
      });
      return parseRows(CandidateRowSchema, rows, 'refund candidate').map((r) => ({
        job: toJob(r),
        payments: r.payments.map(toPayment),
      }));
    },

    async listInFlightRefunds(limit, offset) {
      const rows = await db.select('payments', {
        select: `${PAYMENT_COLUMNS},jobs(${JOB_COLUMNS},launchpads(owner_wallet))`,
        status: 'eq.confirmed',
        refund_signature: 'not.is.null',
        order: 'created_at.asc,id.asc',
        limit: String(limit),
        offset: String(offset),
      });
      return parseRows(InFlightRowSchema, rows, 'in-flight refund').map((r) => ({
        payment: toPayment(r),
        job: toJob(r.jobs),
      }));
    },

    getPayment,

    async beginRefund({ paymentId, txSignature, refundSignature }) {
      const rows = await db.update(
        'payments',
        {
          id: eq(paymentId),
          status: 'eq.confirmed',
          refund_signature: 'is.null',
          tx_signature: sig(txSignature),
        },
        { refund_signature: refundSignature },
      );
      if (rows.length === 1) return true;
      const current = await getPayment(paymentId);
      return current?.refundSignature === refundSignature;
    },

    async releaseRefund({ paymentId, refundSignature }) {
      const rows = await db.update(
        'payments',
        { id: eq(paymentId), status: 'eq.confirmed', refund_signature: sig(refundSignature) },
        { refund_signature: null },
      );
      if (rows.length === 1) return true;
      const current = await getPayment(paymentId);
      return current?.status === 'confirmed' && current.refundSignature === null;
    },

    async completeRefund({ paymentId, refundSignature }) {
      const rows = await db.update(
        'payments',
        { id: eq(paymentId), status: 'eq.confirmed', refund_signature: sig(refundSignature) },
        { status: 'refunded' },
      );
      if (rows.length === 1) return true;
      const current = await getPayment(paymentId);
      return current?.status === 'refunded' && current.refundSignature === refundSignature;
    },

    async markJobRefunded(jobId) {
      const rows = await db.update(
        'jobs',
        { id: eq(jobId), status: 'eq.failed', failed_stage: 'eq.build' },
        { status: 'refunded' },
      );
      if (rows.length === 1) return true;
      const current = z
        .array(z.object({ status: z.string() }))
        .safeParse(await db.select('jobs', { select: 'status', id: eq(jobId) }));
      return current.success && current.data[0]?.status === 'refunded';
    },

    async addJobEvent(jobId, message) {
      await db.insert('job_events', { job_id: jobId, message });
    },
  };
}
