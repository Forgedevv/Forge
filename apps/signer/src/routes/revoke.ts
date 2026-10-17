/**
 * Operator revocation of a prepared launch (`tsx src/index.ts --revoke-launch <jobId>`).
 *
 * A prepared launch transaction (launch.ts) is bound to the launchpad's durable nonce: it stays
 * valid until that nonce moves. To take back a transaction already handed out (wrong spec, leak,
 * client asking to start over), the creator wallet, which is the nonce authority, advances the
 * nonce: the handed-out transaction can then never land, and the next prepare proves at finalized
 * commitment that no coin was launched and builds a new one (new mint).
 *
 * - The transaction is one System `AdvanceNonceAccount` of the launchpad's nonce account by the
 *   creator wallet, paid by the payer wallet, with a regular recent blockhash (so it expires and
 *   its settlement can be proven); the revoke policy (policy.ts) is checked before any signature.
 * - It is journaled (`launch-revoke.<jobId>`) before its first broadcast and settled by polling;
 *   a new one is built only once the previous one is proven failed or expired.
 * - Nothing is sent when the nonce already moved: the handed-out transaction is already dead
 *   (launched, or replaced).
 * - The kill switch is NOT read: revoking is a safety action, wanted most when deploys are paused.
 * - While a revocation of the current nonce value exists, prepare refuses to hand out the old
 *   transaction again (503 `launch_revoking`).
 *
 * Building a nonce advance is local (core has no builder for it yet: change request).
 */
import { CREATE_NONCE_ACCOUNT_COMPUTE_UNITS, type PriorityFeeQuote } from '@forge/core';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { creatorRole } from '../keystore.js';
import {
  DEFAULT_RETRY,
  Mutex,
  awaitSettlement,
  broadcast,
  checkSettlement,
  createAnnouncer,
  formatSol,
  realSleep,
  requireRoleRef,
  sendAlert,
  signWithKeystore,
  spendableBalance,
  withRetry,
  type BeforeSendHook,
  type JobAlerter,
  type JobLogger,
  type KeystoreLike,
  type RetryOptions,
  type Settlement,
  type SettleTiming,
  type SolanaRpc,
} from '../jobs/shared.js';
import { NO_PRIORITY_FEES, signerBudgetInstructions, type PriorityFees } from '../jobs/priority.js';
import { fail } from './errors.js';
import type { LaunchRevocationEntry, RouteJournals } from './journal.js';
import type { RouteCore } from './onchain.js';
import { assertRevokeNonceTx } from './policy.js';
import { DEFAULT_ROUTE_SETTLE } from './context.js';

/** Payer lamports required to send a revocation (two signatures and a margin). */
export const REVOKE_FEE_BUFFER_LAMPORTS = 100_000n;
/** Failed or expired revocation transactions tolerated per launch before manual handling. */
export const MAX_REVOKE_ATTEMPTS = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RevokeDeps {
  core: Pick<RouteCore, 'readNonce'>;
  rpc: SolanaRpc;
  keystore: KeystoreLike;
  journals: Pick<RouteJournals, 'launches' | 'nonces' | 'revocations'>;
  alerter: JobAlerter;
  logger: JobLogger;
  /** Called with the signature right before its first broadcast (watcher expected set). */
  onBeforeSend: BeforeSendHook;
  /** Lock of the payer wallet (created when absent: the CLI runs in its own process). */
  payerLock?: Mutex;
  /**
   * Priority fee of the revocation (SIGNER_PRIORITY_FEE_*): it races the client's signature, so it
   * must land under congestion too. Default: none.
   */
  priorityFees?: PriorityFees;
  retry?: RetryOptions;
  settle?: Partial<SettleTiming>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type RevokeResult =
  | {
      /** The nonce moved through the revocation: the handed-out transaction is dead. */
      status: 'revoked';
      jobId: string;
      signature: string;
      nonceAccount: string;
      revokedNonce: string;
      mint: string;
    }
  | {
      /** The nonce had already moved (launch landed, or replaced): nothing was sent. */
      status: 'already_advanced';
      jobId: string;
      nonceAccount: string;
      mint: string;
    }
  | {
      /** Sent (or expired unsent), not settled yet: run the command again. */
      status: 'pending';
      jobId: string;
      signature: string;
    };

/** Compute unit limit of the revocation with a priority fee (one nonce advance). */
export const REVOKE_COMPUTE_UNITS = CREATE_NONCE_ACCOUNT_COMPUTE_UNITS;

/**
 * Pure: the unsigned nonce advance (fee payer = payer, authority = creator), after the compute
 * budget of `priorityFee` when its price is not 0.
 */
export function buildRevokeNonceTx(params: {
  payer: PublicKey;
  nonceAccount: PublicKey;
  authority: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
  priorityFee?: PriorityFeeQuote;
}): Transaction {
  return new Transaction({
    feePayer: params.payer,
    blockhash: params.blockhash,
    lastValidBlockHeight: params.lastValidBlockHeight,
  }).add(
    ...(params.priorityFee ? signerBudgetInstructions(params.priorityFee) : []),
    SystemProgram.nonceAdvance({
      noncePubkey: params.nonceAccount,
      authorizedPubkey: params.authority,
    }),
  );
}

export async function revokeLaunch(deps: RevokeDeps, jobId: string): Promise<RevokeResult> {
  const { core, rpc, keystore, journals, logger: log } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const settle = { ...DEFAULT_ROUTE_SETTLE, ...deps.settle };
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const payerLock = deps.payerLock ?? new Mutex();
  const announce = createAnnouncer(deps.onBeforeSend, log);
  const iso = () => new Date(now()).toISOString();
  const alert = (
    level: 'immediate' | 'high' | 'normal',
    code: string,
    message: string,
    details: Record<string, unknown>,
    dedupKey?: string,
  ) => sendAlert(deps.alerter, log, level, code, message, details, dedupKey);

  if (!UUID_RE.test(jobId)) fail(400, 'invalid_job_id');
  const launch = await journals.launches.get(jobId);
  if (!launch) fail(404, 'launch_not_prepared');
  const { launchpadId } = launch;
  const nonceEntry = await journals.nonces.get(launchpadId);
  const nonceAddress = nonceEntry?.creation?.address ?? null;
  if (
    !nonceEntry ||
    nonceEntry.creation?.status !== 'confirmed' ||
    nonceAddress === null ||
    nonceAddress !== launch.details.nonceAccount
  ) {
    fail(500, 'journal_error');
  }
  const creatorRef = await keystore.findRef(creatorRole(launchpadId));
  if (!creatorRef) fail(500, 'creator_missing');
  const creator = await keystore.getPublicKey(creatorRef);
  if (
    creator.toBase58() !== launch.details.creator ||
    creator.toBase58() !== nonceEntry.authority
  ) {
    fail(500, 'creator_mismatch');
  }
  const nonceAccount = new PublicKey(nonceAddress);
  const base = { jobId, launchpadId, nonceAccount: nonceAddress, mint: launch.mint };

  const revoked = (entry: LaunchRevocationEntry): RevokeResult => ({
    status: 'revoked',
    jobId,
    signature: entry.current!.signature,
    nonceAccount: nonceAddress,
    revokedNonce: entry.nonceValue,
    mint: entry.mint,
  });

  /** Applies a settlement; returns the result when the command is decided. */
  const applySettlement = async (
    entry: LaunchRevocationEntry,
    s: Settlement,
  ): Promise<{ entry: LaunchRevocationEntry; result?: RevokeResult }> => {
    const attempt = entry.current!;
    if (s.kind === 'confirmed' || s.kind === 'finalized') {
      const next: LaunchRevocationEntry = { ...entry, status: 'confirmed', confirmedAt: iso() };
      await journals.revocations.put(jobId, next);
      log.info({ ...base, signature: attempt.signature }, 'prepared launch revoked');
      await alert(
        'normal',
        'launch_revoked',
        'A prepared launch transaction was revoked by the operator (nonce advanced): the next prepare builds a new one',
        { ...base, signature: attempt.signature },
        `launch_revoked:${jobId}:${entry.nonceValue}`,
      );
      return { entry: next, result: revoked(next) };
    }
    if (s.kind === 'failed' || s.kind === 'expired') {
      const next: LaunchRevocationEntry = {
        ...entry,
        status: 'open',
        current: null,
        history: [
          ...entry.history,
          {
            signature: attempt.signature,
            outcome: s.kind,
            error: s.kind === 'failed' ? s.error : attempt.lastError,
            at: iso(),
          },
        ].slice(-20),
      };
      await journals.revocations.put(jobId, next);
      if (s.kind === 'failed') {
        await alert(
          'high',
          'launch_revoke_failed',
          'A launch revocation (nonce advance) failed on-chain',
          { ...base, signature: attempt.signature, error: s.error },
          `launch_revoke_failed:${attempt.signature}`,
        );
        fail(502, 'revoke_tx_failed');
      }
      return { entry: next };
    }
    return { entry, result: { status: 'pending', jobId, signature: attempt.signature } };
  };

  // 1. A revocation of this launch already journaled: done, or settle it first.
  let entry = await journals.revocations.get(jobId);
  if (entry && entry.nonceValue === launch.nonceValue) {
    if (entry.status === 'confirmed' && entry.current) return revoked(entry);
    if (entry.status === 'in_flight' && entry.current) {
      const attempt = entry.current;
      const announced = announce(attempt.signature);
      let s = await checkSettlement(rpc, attempt.signature, attempt.lastValidBlockHeight, retry);
      if (s.kind === 'pending' || s.kind === 'processing') {
        s = await awaitSettlement(rpc, attempt.signature, {
          lastValidBlockHeight: attempt.lastValidBlockHeight,
          ...(announced ? { raw: Buffer.from(attempt.rawTx, 'base64') } : {}),
          until: 'confirmed',
          ...settle,
          retry,
          sleep,
          now,
          logger: log,
        });
      }
      const applied = await applySettlement(entry, s);
      if (applied.result) return applied.result;
      entry = applied.entry;
    }
  }

  // 2. The nonce as it is now: already moved -> the handed-out transaction is dead already.
  const current = await withRetry(() => core.readNonce(nonceAccount, creator, 'confirmed'), retry);
  if (!current) fail(503, 'nonce_not_visible');
  if (current.nonce !== launch.nonceValue) {
    log.info(base, 'launch revocation: the nonce already moved, nothing sent');
    return { status: 'already_advanced', jobId, nonceAccount: nonceAddress, mint: launch.mint };
  }
  if (!entry || entry.nonceValue !== launch.nonceValue) {
    entry = {
      v: 1,
      jobId,
      launchpadId,
      nonceAccount: nonceAddress,
      nonceValue: launch.nonceValue,
      mint: launch.mint,
      status: 'open',
      current: null,
      confirmedAt: null,
      history: [],
    };
  }
  if (entry.history.length >= MAX_REVOKE_ATTEMPTS) {
    await alert(
      'high',
      'launch_revoke_exhausted',
      'A launch could not be revoked after several attempts: manual handling',
      { ...base, attempts: entry.history.length },
      `launch_revoke_exhausted:${jobId}`,
    );
    fail(409, 'revoke_attempts_exhausted');
  }

  // 3. Build, check (policy), sign (creator + payer), journal, send: under the payer lock.
  const payer = await requireRoleRef(keystore, 'payer');
  const priorityFee = await (deps.priorityFees ?? NO_PRIORITY_FEES).quote(
    [payer.publicKey, nonceAccount],
    REVOKE_COMPUTE_UNITS,
  );
  const { blockhash, lastValidBlockHeight } = await withRetry(
    () => rpc.getLatestBlockhash(),
    retry,
  );
  const tx = buildRevokeNonceTx({
    payer: payer.publicKey,
    nonceAccount,
    authority: creator,
    blockhash,
    lastValidBlockHeight,
    priorityFee,
  });
  assertRevokeNonceTx(tx, { payer: payer.publicKey, nonceAccount, authority: creator });
  const opened = entry;
  const sent = await payerLock.runExclusive(async () => {
    const balance = await spendableBalance(rpc, payer.publicKey, retry);
    if (balance < REVOKE_FEE_BUFFER_LAMPORTS) {
      await alert(
        'high',
        'payer_low_balance',
        'The signer payer wallet cannot pay for a launch revocation: fund it',
        {
          address: payer.publicKey.toBase58(),
          balance: formatSol(balance),
          needed: formatSol(REVOKE_FEE_BUFFER_LAMPORTS),
        },
        `payer_low_balance:${payer.publicKey.toBase58()}`,
      );
      fail(503, 'payer_low_balance');
    }
    const { raw, signature } = await signWithKeystore(keystore, tx, [
      { ref: creatorRef, expected: creator },
      { ref: payer.ref, expected: payer.publicKey },
    ]);
    let next: LaunchRevocationEntry = {
      ...opened,
      status: 'in_flight',
      current: {
        signature,
        rawTx: raw.toString('base64'),
        lastValidBlockHeight,
        recordedAt: iso(),
        lastError: null,
      },
    };
    await journals.revocations.put(jobId, next); // journaled BEFORE the first broadcast
    log.info({ ...base, signature }, 'launch revocation signed and journaled');
    if (!announce(signature)) return { entry: next, raw, signature, broadcast: false };
    const result = await broadcast(rpc, raw, retry);
    if (result.status === 'rejected') {
      next = { ...next, current: { ...next.current!, lastError: result.reason } };
      await journals.revocations.put(jobId, next);
      await alert(
        'high',
        'launch_revoke_rejected',
        'The RPC rejected a launch revocation (simulation failed)',
        { ...base, signature, reason: result.reason },
        `launch_revoke_rejected:${jobId}`,
      );
      fail(502, 'revoke_send_rejected');
    }
    return { entry: next, raw, signature, broadcast: true };
  });

  // 4. Confirmation by polling, outside the payer lock.
  const s = await awaitSettlement(rpc, sent.signature, {
    lastValidBlockHeight,
    ...(sent.broadcast ? { raw: sent.raw } : {}),
    until: 'confirmed',
    ...settle,
    retry,
    sleep,
    now,
    logger: log,
  });
  const applied = await applySettlement(sent.entry, s);
  return applied.result ?? { status: 'pending', jobId, signature: sent.signature };
}
