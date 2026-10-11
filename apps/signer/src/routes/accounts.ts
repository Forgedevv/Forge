/**
 * "Create this account exactly once" for the accounts the routes create with the payer wallet:
 * the two configs of a launchpad and its durable nonce account.
 *
 * Invariants (the reason this file exists):
 * - a creation transaction is journaled (signature + signed bytes + last valid block height)
 *   BEFORE its first broadcast; a crash at any point leaves either nothing sent, or a journaled
 *   transaction that is re-sent byte for byte (same signature) and settled;
 * - a new transaction, with a NEW one-time key and so a new address, is only built once the
 *   previous one is proven failed on-chain or expired (`checkSettlement`), or when no transaction
 *   was ever recorded. The account of an attempt is checked on-chain first: if it exists, that
 *   attempt created it, whatever the signature index says (only its one-time key could sign it);
 * - the payer balance check, the signatures, the journal write and the broadcast run under the
 *   payer lock, so two creations never race on the payer wallet; the rent of the creations still
 *   in flight (signed, not landed) is reserved and subtracted from the balance (reservations.ts);
 * - the kill switch is read again right before a FORGE key signs;
 * - failed attempts are bounded (`maxAttempts`), each one alerted.
 */
import { PublicKey, type Transaction } from '@solana/web3.js';
import {
  awaitSettlement,
  broadcast,
  checkSettlement,
  describeError,
  formatSol,
  signWithKeystore,
  spendableBalance,
  withRetry,
  type JobLogger,
  type KeystoreLike,
  type Mutex,
  type RetryOptions,
  type Settlement,
  type SettleTiming,
  type SolanaRpc,
} from '../jobs/shared.js';
import type { PayerReservations } from '../jobs/reservations.js';
import { createEphemeralKey } from './ephemeral.js';
import { fail } from './errors.js';
import type { AccountCreation, CreationAttempt } from './journal.js';

export type AlertFn = (
  level: 'immediate' | 'high' | 'normal',
  code: string,
  message: string,
  details: Record<string, unknown>,
  dedupKey?: string,
) => Promise<void>;

export interface CreationEnv {
  rpc: SolanaRpc;
  keystore: KeystoreLike;
  payer: { ref: string; publicKey: PublicKey };
  payerLock: Mutex;
  /** Payer lamports promised to transactions in flight (shared with the payer jobs). */
  reservations: PayerReservations;
  /** Pre-registration with the outflow watcher; false = do not broadcast (see createAnnouncer). */
  announce: (signature: string) => boolean;
  /** Re-reads the kill switch; throws a RouteError when the routes are paused. */
  assertNotPaused: () => Promise<void>;
  retry: RetryOptions;
  settle: SettleTiming;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  logger: JobLogger;
  alert: AlertFn;
  /** Failed or expired transactions tolerated per account before manual handling. */
  maxAttempts: number;
  /** Kept on top of the rent for the network fees. */
  payerFeeBufferLamports: bigint;
}

export interface CreationTarget {
  /** `launchpad_config`, `launchpad_coin_config` or `nonce_account` (logs, alerts, codes). */
  label: string;
  /** Launchpad the account belongs to (logs and alerts). */
  launchpadId: string;
  /** Hash of what the account is created from: a confirmed account with another hash is refused. */
  paramsHash: string;
  /** Unsigned creation transaction of a fresh account (built by core). */
  build(
    address: PublicKey,
  ): Promise<{ transaction: Transaction; lastValidBlockHeight: number; rentLamports: bigint }>;
  /** Transaction policy, before any signature. Throws JobError('TX_POLICY'). */
  check(transaction: Transaction, address: PublicKey, rentLamports: bigint): void;
  /** True when the account exists on-chain with the expected owner and shape. */
  exists(address: PublicKey): Promise<boolean>;
}

export function openCreation(paramsHash: string): AccountCreation {
  return {
    paramsHash,
    status: 'open',
    current: null,
    address: null,
    confirmedAt: null,
    history: [],
  };
}

type AttemptState =
  | { kind: 'created' }
  | { kind: 'failed'; error: string }
  | { kind: 'expired' }
  | { kind: 'pending' };

/** Where a journaled attempt stands, waiting (bounded) for it to settle. */
async function settleAttempt(
  env: CreationEnv,
  target: CreationTarget,
  attempt: CreationAttempt,
): Promise<AttemptState> {
  const address = new PublicKey(attempt.address);
  const exists = () => withRetry(() => target.exists(address), env.retry);
  if (await exists()) return { kind: 'created' };
  const announced = env.announce(attempt.signature);
  const raw = Buffer.from(attempt.rawTx, 'base64');
  let s: Settlement = await checkSettlement(
    env.rpc,
    attempt.signature,
    attempt.lastValidBlockHeight,
    env.retry,
  );
  if (s.kind === 'pending' || s.kind === 'processing' || s.kind === 'confirmed') {
    s = await awaitSettlement(env.rpc, attempt.signature, {
      lastValidBlockHeight: attempt.lastValidBlockHeight,
      ...(announced ? { raw } : {}),
      until: 'confirmed',
      ...env.settle,
      retry: env.retry,
      sleep: env.sleep,
      now: env.now,
      logger: env.logger,
    });
  }
  switch (s.kind) {
    case 'confirmed':
    case 'finalized':
      // A successful creation always creates the account; until it is visible, keep waiting.
      return (await exists()) ? { kind: 'created' } : { kind: 'pending' };
    case 'failed':
      return { kind: 'failed', error: s.error };
    case 'expired':
      return (await exists()) ? { kind: 'created' } : { kind: 'expired' };
    default:
      return { kind: 'pending' };
  }
}

/** Builds, checks, signs, journals and broadcasts a new creation transaction. */
async function sendNewAttempt(
  env: CreationEnv,
  target: CreationTarget,
  record: AccountCreation,
  save: (next: AccountCreation) => Promise<void>,
): Promise<AccountCreation> {
  await env.assertNotPaused();
  const key = createEphemeralKey();
  try {
    const address = key.publicKey;
    const built = await withRetry(() => target.build(address), env.retry);
    const tx = built.transaction;
    target.check(tx, address, built.rentLamports);

    return await env.payerLock.runExclusive(async () => {
      const needed = built.rentLamports + env.payerFeeBufferLamports;
      const balance = await spendableBalance(env.rpc, env.payer.publicKey, env.retry);
      // Creations signed and sent but not landed yet are not in the balance: subtract them.
      const reserved = await env.reservations.outstanding(env.rpc, env.retry);
      const available = balance > reserved ? balance - reserved : 0n;
      if (available < needed) {
        await env.alert(
          'high',
          'payer_low_balance',
          'The signer payer wallet cannot pay for a launchpad account: fund it',
          {
            address: env.payer.publicKey.toBase58(),
            balance: formatSol(balance),
            reservedInFlight: formatSol(reserved),
            needed: formatSol(needed),
            account: target.label,
          },
          `payer_low_balance:${env.payer.publicKey.toBase58()}`,
        );
        fail(503, 'payer_low_balance');
      }
      // The kill switch may have flipped while the transaction was being built.
      await env.assertNotPaused();
      key.signTransaction(tx);
      key.destroy();
      const { raw, signature } = await signWithKeystore(env.keystore, tx, [
        { ref: env.payer.ref, expected: env.payer.publicKey },
      ]);
      const attempt: CreationAttempt = {
        address: address.toBase58(),
        signature,
        rawTx: raw.toString('base64'),
        lastValidBlockHeight: built.lastValidBlockHeight,
        recordedAt: new Date(env.now()).toISOString(),
        lastError: null,
        reservedLamports: needed.toString(),
      };
      let next: AccountCreation = { ...record, status: 'in_flight', current: attempt };
      await save(next); // journaled BEFORE the first broadcast
      env.reservations.reserve(signature, needed, built.lastValidBlockHeight);
      env.logger.info(
        {
          launchpadId: target.launchpadId,
          account: target.label,
          address: attempt.address,
          signature,
        },
        'account creation signed and journaled',
      );
      if (!env.announce(signature)) return next;
      const sent = await broadcast(env.rpc, raw, env.retry);
      if (sent.status === 'rejected') {
        next = { ...next, current: { ...attempt, lastError: sent.reason } };
        await save(next);
        await env.alert(
          'high',
          'account_creation_rejected',
          'The RPC rejected a launchpad account creation (simulation failed)',
          {
            launchpadId: target.launchpadId,
            account: target.label,
            signature,
            reason: sent.reason,
          },
          `account_creation_rejected:${target.launchpadId}:${target.label}`,
        );
        fail(502, `${target.label}_send_rejected`);
      }
      return next;
    });
  } finally {
    key.destroy();
  }
}

/**
 * Makes sure the account of `target` exists, creating it at most once. Returns the confirmed
 * record (with `address`), or throws a RouteError: 503 `confirmation_pending` while a transaction
 * is still in flight (call again), 502 when it failed on-chain, 409 when manual handling is needed.
 */
export async function ensureAccountCreated(
  env: CreationEnv,
  target: CreationTarget,
  existing: AccountCreation | null,
  save: (next: AccountCreation) => Promise<void>,
): Promise<AccountCreation & { address: string }> {
  let record = existing ?? openCreation(target.paramsHash);
  const base = { launchpadId: target.launchpadId, account: target.label };

  if (record.paramsHash !== target.paramsHash) {
    if (record.status !== 'open') {
      await env.alert(
        'high',
        'account_params_changed',
        'A launchpad account was created (or is being created) from parameters that no longer match the spec: manual check needed',
        base,
        `account_params_changed:${target.launchpadId}:${target.label}`,
      );
      fail(409, `${target.label}_params_changed`);
    }
    record = { ...record, paramsHash: target.paramsHash };
  }

  if (record.status === 'confirmed') {
    if (!record.address) fail(500, 'journal_error');
    const address = new PublicKey(record.address);
    if (!(await withRetry(() => target.exists(address), env.retry))) {
      await env.alert(
        'immediate',
        'account_vanished',
        'A launchpad account recorded as created is no longer on-chain',
        { ...base, address: record.address },
        `account_vanished:${record.address}`,
      );
      fail(409, `${target.label}_missing_onchain`);
    }
    return record as AccountCreation & { address: string };
  }

  for (;;) {
    if (record.status === 'in_flight' && record.current) {
      const attempt = record.current;
      // After a restart the registry is empty: the journaled attempt may still land.
      if (attempt.reservedLamports !== undefined && !env.reservations.has(attempt.signature)) {
        env.reservations.reserve(
          attempt.signature,
          BigInt(attempt.reservedLamports),
          attempt.lastValidBlockHeight,
        );
      }
      const state = await settleAttempt(env, target, attempt);
      if (state.kind !== 'pending') env.reservations.release(attempt.signature);
      const at = new Date(env.now()).toISOString();
      if (state.kind === 'created') {
        record = {
          ...record,
          status: 'confirmed',
          address: attempt.address,
          confirmedAt: at,
        };
        await save(record);
        env.logger.info(
          { ...base, address: attempt.address, signature: attempt.signature },
          'launchpad account created',
        );
        return record as AccountCreation & { address: string };
      }
      if (state.kind === 'pending') fail(503, 'confirmation_pending');
      const outcome = state.kind;
      record = {
        ...record,
        status: 'open',
        current: null,
        history: [
          ...record.history,
          {
            address: attempt.address,
            signature: attempt.signature,
            outcome,
            error: state.kind === 'failed' ? state.error : attempt.lastError,
            at,
          },
        ].slice(-50),
      };
      await save(record);
      if (state.kind === 'failed') {
        await env.alert(
          'high',
          'account_creation_failed',
          'A launchpad account creation failed on-chain',
          { ...base, signature: attempt.signature, error: state.error },
          `account_creation_failed:${attempt.signature}`,
        );
        fail(502, `${target.label}_tx_failed`);
      }
      env.logger.warn(
        { ...base, signature: attempt.signature },
        'account creation expired unsent: building a new one',
      );
    }

    if (record.history.length >= env.maxAttempts) {
      await env.alert(
        'high',
        'account_creation_exhausted',
        'A launchpad account could not be created after several attempts: manual handling',
        { ...base, attempts: record.history.length },
        `account_creation_exhausted:${target.launchpadId}:${target.label}`,
      );
      fail(409, `${target.label}_attempts_exhausted`);
    }
    try {
      record = await sendNewAttempt(env, target, record, save);
    } catch (err) {
      env.logger.warn({ ...base, err: describeError(err) }, 'account creation not sent');
      throw err;
    }
  }
}
