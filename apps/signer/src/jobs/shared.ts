/**
 * Shared building blocks of the signer's money-moving jobs (claims, cashbox, refunds).
 *
 * Everything here is written for code that can lose money:
 * - amounts are `bigint` lamports, parsed strictly (never through floating point);
 * - every transaction is checked against a strict policy BEFORE the keystore signs it;
 * - a transaction is confirmed by polling `getSignatureStatuses`, and it is only declared
 *   "expired" (safe to replace) once the FINALIZED block height is past its last valid block
 *   height plus a margin, then its signature is still unknown on a node at least as recent, and
 *   no finalized transaction exists for it, in that order (see `checkSettlement`);
 * - network calls retry with exponential backoff; a signed transaction is only ever re-sent
 *   byte for byte (same signature), never rebuilt while it may still land;
 * - errors and log fields are scrubbed: no URL (the RPC URL carries the Helius key), no
 *   secret-looking field, no byte array. The keystore never exposes key bytes anyway.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type Connection,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import type pino from 'pino';
import { z } from 'zod';
import { PRICING, type FlagKey, type PaymentKind } from '@forge/shared';
import type { Keystore } from '../keystore.js';
import { redactSecrets } from '../keystore.js';

// ---------------------------------------------------------------------------------------
// Errors

export type JobErrorCode =
  | 'CONFIG'
  | 'INVALID_AMOUNT'
  | 'INVALID_ADDRESS'
  | 'TX_POLICY'
  | 'SIGNER_MISMATCH'
  | 'NOT_SIGNED'
  | 'JOURNAL_CORRUPT'
  | 'JOURNAL_IO'
  | 'DB'
  | 'DB_RESPONSE'
  | 'RPC';

/** Error with a static, non-secret message and an optional rule/detail for diagnostics. */
export class JobError extends Error {
  override readonly name = 'JobError';
  readonly code: JobErrorCode;
  readonly detail: string | undefined;
  readonly transient: boolean;

  constructor(code: JobErrorCode, detail?: string, options: { transient?: boolean } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
    this.transient = options.transient ?? false;
  }
}

export function isJobError(err: unknown, code?: JobErrorCode): err is JobError {
  return err instanceof JobError && (code === undefined || err.code === code);
}

const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const QUERY_SECRET_RE = /\b(api[-_]?key|key|token|secret|password|auth[a-z_-]*)=[^&\s"']+/gi;
const BYTE_ARRAY_RE = /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const MAX_ERROR_TEXT = 300;

/** Removes URLs, query secrets, bearer tokens and byte arrays from a text, and bounds its length. */
export function scrubText(text: string): string {
  const cleaned = text
    .replace(URL_RE, '[url]')
    .replace(QUERY_SECRET_RE, '$1=[redacted]')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(BYTE_ARRAY_RE, '[bytes]');
  return cleaned.length > MAX_ERROR_TEXT ? `${cleaned.slice(0, MAX_ERROR_TEXT)}...` : cleaned;
}

export interface ErrorSummary {
  name: string;
  code?: string;
  message: string;
}

/** Safe summary of any error, for logs and alerts. */
export function describeError(err: unknown): ErrorSummary {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
      message: scrubText(err.message),
    };
  }
  return { name: 'unknown', message: scrubText(String(err)) };
}

// ---------------------------------------------------------------------------------------
// Logging and alerts

export interface JobLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export const silentJobLogger: JobLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Child logger for a job. Every field goes through the keystore's `redactSecrets` (secret-looking
 * field names and byte arrays are replaced) and errors are reduced to `describeError`.
 * Public keys must be logged under names such as `address`, `pool` or `vault` (not `...Key`).
 */
export function createJobLogger(parent: pino.Logger | undefined, job: string): JobLogger {
  if (!parent) return silentJobLogger;
  const child = parent.child({ module: `job:${job}` });
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (fields: Record<string, unknown>, msg: string): void => {
      const prepared: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        prepared[k] = v instanceof Error ? describeError(v) : v;
      }
      child[level](redactSecrets(prepared) as Record<string, unknown>, msg);
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export type AlertLevel = 'immediate' | 'high' | 'normal';

/**
 * Alert sink (structurally compatible with the signer's Telegram alerter: level, code, message,
 * details, optional dedup key). Implementations must never throw; `sendAlert` guards anyway.
 */
export interface JobAlerter {
  alert(
    level: AlertLevel,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options?: { dedupKey?: string },
  ): Promise<void>;
}

export const silentAlerter: JobAlerter = { alert: async () => undefined };

/** Sends an alert; never throws (an alert failure must not change a money decision). */
export async function sendAlert(
  alerter: JobAlerter,
  logger: JobLogger,
  level: AlertLevel,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  dedupKey?: string,
): Promise<void> {
  try {
    await alerter.alert(level, code, message, details, dedupKey ? { dedupKey } : undefined);
  } catch (err) {
    logger.error({ code, err: describeError(err) }, 'alert failed');
  }
}

/** Called with the base58 signature of a signed transaction right before it is first sent. */
export type BeforeSendHook = (signature: string) => void;

/**
 * Wraps the `onBeforeSend` hook (pre-registration with the outflow watcher): called once per
 * signature per process, before the first broadcast. Returns false when the hook threw: the
 * caller must then NOT broadcast (the transaction stays tracked and settles or expires later).
 * The hook is required: a job wired without it would make the watcher raise false alerts.
 */
export function createAnnouncer(
  hook: BeforeSendHook,
  logger: JobLogger,
): (signature: string) => boolean {
  if (typeof hook !== 'function') throw new JobError('CONFIG', 'onBeforeSend hook is required');
  const announced = new Set<string>();
  return (signature) => {
    if (announced.has(signature)) return true;
    try {
      hook(signature);
    } catch (err) {
      logger.error({ signature, err: describeError(err) }, 'onBeforeSend failed: not broadcasting');
      return false;
    }
    announced.add(signature);
    return true;
  };
}

// ---------------------------------------------------------------------------------------
// Retry with backoff

export interface RetryOptions {
  /** Total attempts, including the first one. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 };

export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const TRANSIENT_RE =
  /fetch failed|socket hang up|network error|timed? ?out|\b429\b|too many requests|\b50[234]\b|bad gateway|service unavailable|gateway timeout|blockhash not found|node is behind|rate limit/i;

/** Network-level errors worth retrying. Program errors and simulation failures are not. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof JobError) return err.transient;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause !== err && isTransientError(cause)) return true;
  return TRANSIENT_RE.test(err.message);
}

/** Runs `fn`, retrying transient failures with exponential backoff (no jitter: deterministic). */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const sleep = options.sleep ?? realSleep;
  const retryable = options.isRetryable ?? isTransientError;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !retryable(err)) throw err;
      const delay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------------------
// Minimal RPC surface (a real Connection is wrapped by `rpcFromConnection`, tests use fakes)

export type ConfirmationLevel = 'processed' | 'confirmed' | 'finalized';

export interface SignatureState {
  slot: number;
  confirmationStatus: ConfirmationLevel;
  /** Transaction error when it executed and failed, null on success. */
  err: unknown;
}

/** A signature status lookup, with the slot of the node that answered. */
export interface SignatureLookup {
  /** Null when the signature is unknown to that node (full history searched). */
  state: SignatureState | null;
  /** `context.slot` of the `getSignatureStatuses` answer. */
  contextSlot: number;
}

/** A recent signature of an address (`getSignaturesForAddress`), newest first. */
export interface RecentSignature {
  signature: string;
  /** Null when the node does not report it (treated as not finalized). */
  confirmationStatus: ConfirmationLevel | null;
  failed: boolean;
  /** Memo text as reported by the RPC (e.g. `[19] forge:cashbox-sweep`), null when none. */
  memo: string | null;
}

/** The calls `checkSettlement` needs. */
export interface SettlementRpc {
  getBlockHeight(commitment: 'confirmed' | 'finalized'): Promise<number>;
  getSlot(commitment: 'finalized'): Promise<number>;
  /** Status of a signature, searching the whole transaction history. */
  getSignatureState(signature: string): Promise<SignatureLookup>;
  /** True when the node returns the transaction at finalized commitment. */
  hasFinalizedTransaction(signature: string): Promise<boolean>;
}

export interface SolanaRpc extends SettlementRpc {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Sends a fully signed transaction with preflight; returns its signature. */
  sendRawTransaction(raw: Uint8Array): Promise<string>;
  getBalance(address: PublicKey, commitment: 'confirmed' | 'finalized'): Promise<bigint>;
  getMinimumBalanceForRentExemption(dataLength: number): Promise<bigint>;
  /** Newest-first signatures of `address` at confirmed commitment. */
  getRecentSignatures(address: PublicKey, limit: number): Promise<RecentSignature[]>;
}

export type SettlementConnection = Pick<
  Connection,
  'getBlockHeight' | 'getSlot' | 'getSignatureStatuses' | 'getTransaction'
>;

/** `SettlementRpc` over a web3.js connection (also used by the conversion job). */
export function settlementRpcFromConnection(connection: SettlementConnection): SettlementRpc {
  return {
    getBlockHeight: (commitment) => connection.getBlockHeight(commitment),
    getSlot: (commitment) => connection.getSlot(commitment),
    async getSignatureState(signature) {
      const res = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = res.value[0];
      const contextSlot = res.context.slot;
      if (!status) return { state: null, contextSlot };
      const level: ConfirmationLevel =
        status.confirmationStatus ?? (status.confirmations === null ? 'finalized' : 'processed');
      return {
        state: { slot: status.slot, confirmationStatus: level, err: status.err ?? null },
        contextSlot,
      };
    },
    async hasFinalizedTransaction(signature) {
      const tx = await connection.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      return tx !== null;
    },
  };
}

export function rpcFromConnection(connection: Connection): SolanaRpc {
  return {
    ...settlementRpcFromConnection(connection),
    getLatestBlockhash: () => connection.getLatestBlockhash('confirmed'),
    async getRecentSignatures(address, limit) {
      const sigs = await connection.getSignaturesForAddress(address, { limit }, 'confirmed');
      return sigs.map((s) => ({
        signature: s.signature,
        confirmationStatus: s.confirmationStatus ?? null,
        failed: s.err !== null,
        memo: s.memo ?? null,
      }));
    },
    sendRawTransaction: (raw) =>
      connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      }),
    async getBalance(address, commitment) {
      return BigInt(await connection.getBalance(address, commitment));
    },
    async getMinimumBalanceForRentExemption(dataLength) {
      return BigInt(await connection.getMinimumBalanceForRentExemption(dataLength, 'confirmed'));
    },
  };
}

/** The lower of the confirmed and finalized balances (never over-estimate what can be spent). */
export async function spendableBalance(
  rpc: SolanaRpc,
  address: PublicKey,
  retry: RetryOptions,
): Promise<bigint> {
  const confirmed = await withRetry(() => rpc.getBalance(address, 'confirmed'), retry);
  const finalized = await withRetry(() => rpc.getBalance(address, 'finalized'), retry);
  return confirmed < finalized ? confirmed : finalized;
}

// ---------------------------------------------------------------------------------------
// Settlement of a sent transaction

/**
 * Blocks added on top of a height observed AFTER a signature was recorded, when the real
 * last valid block height of its blockhash is unknown (lost journal). A blockhash is valid for
 * 150 blocks; the observed height is at least the blockhash's height, so twice that is a
 * safe bound that also covers RPC nodes lagging behind each other.
 */
export const FALLBACK_EXPIRY_BLOCKS = 300;

/**
 * Blocks the finalized height must be past `lastValidBlockHeight` before an unknown signature is
 * declared expired. Covers RPC nodes behind a load balancer that disagree on heights, and a
 * `lastValidBlockHeight` reported by a node that was itself ahead.
 */
export const EXPIRY_MARGIN_BLOCKS = 150;

export type Settlement =
  | { kind: 'finalized'; slot: number }
  | { kind: 'confirmed'; slot: number }
  | { kind: 'failed'; slot: number; error: string }
  | { kind: 'processing' }
  | { kind: 'pending' }
  | { kind: 'expired' };

/**
 * Where a signature stands. `expired` is only returned when the transaction can never land:
 * 1. the finalized slot and the finalized block height are read FIRST, and that height is past
 *    `lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS`;
 * 2. the signature is then unknown in the full history, on a node whose answer (`context.slot`)
 *    is at least the finalized slot read in step 1 (a lagging node proves nothing);
 * 3. no finalized transaction is returned for it either.
 * Any block that could hold it is then finalized, so the history lookups would have found it.
 */
export async function checkSettlement(
  rpc: SettlementRpc,
  signature: string,
  lastValidBlockHeight: number,
  retry: RetryOptions,
): Promise<Settlement> {
  const finalizedSlot = await withRetry(() => rpc.getSlot('finalized'), retry);
  const finalizedHeight = await withRetry(() => rpc.getBlockHeight('finalized'), retry);
  const lookup = await withRetry(() => rpc.getSignatureState(signature), retry);
  const state = lookup.state;
  if (state) {
    if (state.confirmationStatus === 'processed') return { kind: 'processing' };
    if (state.err !== null && state.err !== undefined) {
      return { kind: 'failed', slot: state.slot, error: scrubText(safeJson(state.err)) };
    }
    return state.confirmationStatus === 'finalized'
      ? { kind: 'finalized', slot: state.slot }
      : { kind: 'confirmed', slot: state.slot };
  }
  if (finalizedHeight <= lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) return { kind: 'pending' };
  if (!Number.isFinite(lookup.contextSlot) || lookup.contextSlot < finalizedSlot) {
    return { kind: 'pending' };
  }
  if (await withRetry(() => rpc.hasFinalizedTransaction(signature), retry)) {
    // The status index missed it but the ledger has it: never call that expired.
    return { kind: 'pending' };
  }
  return { kind: 'expired' };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

export interface SettleOptions {
  lastValidBlockHeight: number;
  /** Signed bytes to re-broadcast while the signature is unknown (same signature, safe). */
  raw?: Uint8Array;
  /** Stop waiting at this level of success. */
  until: 'confirmed' | 'finalized';
  timeoutMs: number;
  pollMs: number;
  rebroadcastMs: number;
  retry: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: JobLogger;
}

export interface SettleTiming {
  /** Stop waiting after this long (the transaction stays tracked for the next run). */
  timeoutMs: number;
  pollMs: number;
  /** Re-send the same signed bytes this often while the signature is unknown. */
  rebroadcastMs: number;
}

export const DEFAULT_SETTLE: SettleTiming = {
  timeoutMs: 120_000,
  pollMs: 2_000,
  rebroadcastMs: 6_000,
};

/** Polls until the transaction is settled (success, failure or proven expiry) or the timeout. */
export async function awaitSettlement(
  rpc: SolanaRpc,
  signature: string,
  options: SettleOptions,
): Promise<Settlement> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const start = now();
  let lastBroadcast = start;
  for (;;) {
    const s = await checkSettlement(rpc, signature, options.lastValidBlockHeight, options.retry);
    if (s.kind === 'finalized' || s.kind === 'failed' || s.kind === 'expired') return s;
    if (s.kind === 'confirmed' && options.until === 'confirmed') return s;
    if (now() - start >= options.timeoutMs) return s;
    if (options.raw && s.kind === 'pending' && now() - lastBroadcast >= options.rebroadcastMs) {
      lastBroadcast = now();
      try {
        await rpc.sendRawTransaction(options.raw);
      } catch (err) {
        options.logger?.debug({ signature, err: describeError(err) }, 'rebroadcast failed');
      }
    }
    await sleep(options.pollMs);
  }
}

export type BroadcastResult =
  { status: 'sent' } | { status: 'already_processed' } | { status: 'rejected'; reason: string };

/**
 * Sends signed bytes, retrying network errors with the SAME bytes. A preflight rejection is
 * returned (not thrown): the caller still waits for proven expiry before replacing anything,
 * because an earlier attempt may have reached the network.
 */
export async function broadcast(
  rpc: SolanaRpc,
  raw: Uint8Array,
  retry: RetryOptions,
): Promise<BroadcastResult> {
  try {
    await withRetry(() => rpc.sendRawTransaction(raw), retry);
    return { status: 'sent' };
  } catch (err) {
    const summary = describeError(err);
    if (/already been processed|alreadyprocessed/i.test(summary.message)) {
      return { status: 'already_processed' };
    }
    if (isTransientError(err)) throw err;
    return { status: 'rejected', reason: summary.message };
  }
}

// ---------------------------------------------------------------------------------------
// Durable journal (one JSON file per key, written atomically)

export interface Journal<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; value: T }>>;
}

const JOURNAL_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;
const JOURNAL_NAMESPACE_RE = /^[a-z][a-z0-9-]{0,30}$/;

function assertJournalKey(key: string): void {
  if (!JOURNAL_KEY_RE.test(key)) throw new JobError('JOURNAL_IO', 'invalid journal key');
}

/** In-memory journal (tests, dry runs). Values are deep-copied through JSON like the file one. */
export function createMemoryJournal<T>(schema: z.ZodType<T>): Journal<T> & { size(): number } {
  const data = new Map<string, string>();
  return {
    async get(key) {
      assertJournalKey(key);
      const raw = data.get(key);
      return raw === undefined ? undefined : schema.parse(JSON.parse(raw));
    },
    async put(key, value) {
      assertJournalKey(key);
      data.set(key, JSON.stringify(schema.parse(value)));
    },
    async delete(key) {
      assertJournalKey(key);
      data.delete(key);
    },
    async list() {
      return [...data.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, raw]) => ({ key, value: schema.parse(JSON.parse(raw)) }));
    },
    size: () => data.size,
  };
}

/**
 * File journal: `<dir>/<namespace>.<key>.json`. Writes go to a private temp file (0600), are
 * fsynced, then renamed over the target, so a crash leaves either the old or the new content.
 * A file that does not parse or validate stops the job (JOURNAL_CORRUPT): never guess.
 */
export function createFileJournal<T>(options: {
  dir: string;
  namespace: string;
  schema: z.ZodType<T>;
}): Journal<T> {
  const { schema, namespace } = options;
  if (!JOURNAL_NAMESPACE_RE.test(namespace)) {
    throw new JobError('CONFIG', 'invalid journal namespace');
  }
  const dir = path.resolve(options.dir);
  const prefix = `${namespace}.`;
  const fileOf = (key: string) => path.join(dir, `${prefix}${key}.json`);
  let ready: Promise<void> | undefined;
  const ensureDir = () =>
    (ready ??= fs
      .mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch((err: unknown) => {
        ready = undefined;
        throw new JobError('JOURNAL_IO', describeError(err).code ?? 'mkdir failed');
      }));

  const parse = (raw: string): T => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new JobError('JOURNAL_CORRUPT', `${namespace} entry is not JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new JobError('JOURNAL_CORRUPT', `${namespace} entry is invalid`);
    return parsed.data;
  };

  const get = async (key: string): Promise<T | undefined> => {
    assertJournalKey(key);
    await ensureDir();
    let raw: string;
    try {
      raw = await fs.readFile(fileOf(key), 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return undefined;
      throw new JobError('JOURNAL_IO', describeError(err).code ?? 'read failed');
    }
    return parse(raw);
  };

  return {
    get,
    async put(key, value) {
      assertJournalKey(key);
      await ensureDir();
      const content = `${JSON.stringify(schema.parse(value), null, 2)}\n`;
      const target = fileOf(key);
      const tmp = path.join(dir, `.${prefix}${key}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        const handle = await fs.open(tmp, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(tmp, target);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw new JobError('JOURNAL_IO', describeError(err).code ?? 'write failed');
      }
      await syncDir(dir);
    },
    async delete(key) {
      assertJournalKey(key);
      await ensureDir();
      try {
        await fs.rm(fileOf(key), { force: true });
      } catch (err) {
        throw new JobError('JOURNAL_IO', describeError(err).code ?? 'delete failed');
      }
      await syncDir(dir);
    },
    async list() {
      await ensureDir();
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (err) {
        throw new JobError('JOURNAL_IO', describeError(err).code ?? 'readdir failed');
      }
      const out: Array<{ key: string; value: T }> = [];
      for (const name of names.sort()) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        const key = name.slice(prefix.length, -'.json'.length);
        if (!JOURNAL_KEY_RE.test(key)) continue;
        const value = await get(key);
        if (value !== undefined) out.push({ key, value });
      }
      return out;
    },
  };
}

/** Default directory of the job journals (relative to the working directory). */
export const DEFAULT_JOURNAL_DIR = './journal';

/** SIGNER_JOURNAL_DIR (default `./journal`): where every job keeps its durable state. */
export function journalDirFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const dir = env.SIGNER_JOURNAL_DIR;
  if (dir === undefined || dir === '') return DEFAULT_JOURNAL_DIR;
  if (dir.includes('\0')) throw new JobError('CONFIG', 'SIGNER_JOURNAL_DIR is invalid');
  return dir;
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows cannot fsync a directory; the file itself was fsynced before the rename.
  }
}

// ---------------------------------------------------------------------------------------
// Amounts and addresses

export const U64_MAX = (1n << 64n) - 1n;

/** Strict lamports parser: bigint, safe integer or canonical decimal string; never negative. */
export function parseLamports(value: unknown): bigint {
  let out: bigint;
  if (typeof value === 'bigint') out = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new JobError('INVALID_AMOUNT', 'not a safe integer');
    out = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) {
    out = BigInt(value);
  } else {
    throw new JobError('INVALID_AMOUNT', 'not an integer amount');
  }
  if (out < 0n || out > U64_MAX) throw new JobError('INVALID_AMOUNT', 'out of range');
  return out;
}

/** Display only: lamports as a SOL string ("0.001 SOL"). */
export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''} SOL`;
}

/** Canonical base58 address or null (rejects non-canonical encodings and the all-zero key). */
export function parseAddress(value: unknown): PublicKey | null {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value || key.equals(PublicKey.default)) return null;
    return key;
  } catch {
    return null;
  }
}

// Environment parsing (strict: a malformed value is a startup error, never a silent default)

const BOOL_RE = /^(true|false|1|0)$/;

export function parseBoolEnv(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (!BOOL_RE.test(value)) throw new JobError('CONFIG', `${name} must be true or false`);
  return value === 'true' || value === '1';
}

export function parseLamportsEnv(
  value: string | undefined,
  name: string,
  fallback?: bigint,
): bigint {
  if (value === undefined || value === '') {
    if (fallback === undefined) throw new JobError('CONFIG', `${name} is required`);
    return fallback;
  }
  try {
    return parseLamports(value);
  } catch {
    throw new JobError('CONFIG', `${name} must be an integer number of lamports`);
  }
}

export function parsePositiveIntEnv(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]{0,8}$/.test(value))
    throw new JobError('CONFIG', `${name} must be a positive integer`);
  return Number(value);
}

// ---------------------------------------------------------------------------------------
// Payment floors (the database's word on a payment is checked against them before any spend)

/** Lamports a confirmed payment row must at least hold, per payment kind. */
export type PaymentMinimums = Readonly<Record<PaymentKind, bigint>>;

/**
 * Defaults of SIGNER_MIN_CREATION_PAYMENT_LAMPORTS / SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS:
 * 0.02 SOL for a creation (what a launchpad costs the payer wallet in rent, and about $33 up to
 * SOL = $1 650), 0.003 SOL for a modification ($5.5 up to SOL = $1 833). A row below the floor
 * cannot come from a real quote: the routes refuse it before any payer spend and the refunds job
 * leaves it to manual handling.
 */
export const DEFAULT_MIN_PAYMENT_LAMPORTS: PaymentMinimums = {
  creation: 20_000_000n,
  modification: 3_000_000n,
};

/** Dollar price every confirmed payment row of a kind must carry (`payments.usd_amount`). */
export const PAYMENT_USD_BY_KIND: Readonly<Record<PaymentKind, number>> = {
  creation: PRICING.creationUsd,
  modification: PRICING.modificationUsd,
};

/** Reads the payment floors (strict integers, defaults above). */
export function paymentMinimumsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PaymentMinimums {
  return {
    creation: parseLamportsEnv(
      env.SIGNER_MIN_CREATION_PAYMENT_LAMPORTS,
      'SIGNER_MIN_CREATION_PAYMENT_LAMPORTS',
      DEFAULT_MIN_PAYMENT_LAMPORTS.creation,
    ),
    modification: parseLamportsEnv(
      env.SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS,
      'SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS',
      DEFAULT_MIN_PAYMENT_LAMPORTS.modification,
    ),
  };
}

// ---------------------------------------------------------------------------------------
// Transactions: signatures, inspection and policy

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** Fee payer signature (= transaction id) of a signed legacy transaction, base58. */
export function transactionSignature(tx: Transaction): string {
  const sig = tx.signature;
  if (!sig || sig.length !== 64 || sig.every((b) => b === 0)) {
    throw new JobError('NOT_SIGNED', 'fee payer signature missing');
  }
  return base58Encode(sig);
}

/** Serializes a legacy transaction, refusing any missing or invalid signature. */
export function serializeSigned(tx: Transaction): Buffer {
  try {
    return tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  } catch {
    throw new JobError('NOT_SIGNED', 'transaction is not fully and validly signed');
  }
}

/** Public keys whose signature the transaction requires (fee payer first). */
export function requiredSigners(tx: Transaction): PublicKey[] {
  const message = tx.compileMessage();
  return message.accountKeys.slice(0, message.header.numRequiredSignatures);
}

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Decodes a System Program `Transfer` (u32 index 2 + u64 lamports); null for anything else. */
export function decodeSystemTransfer(
  ix: TransactionInstruction,
): { from: PublicKey; to: PublicKey; lamports: bigint } | null {
  if (!ix.programId.equals(SystemProgram.programId)) return null;
  const data = Buffer.from(ix.data);
  if (data.length !== 12 || data.readUInt32LE(0) !== 2 || ix.keys.length !== 2) return null;
  const [from, to] = ix.keys;
  if (!from || !to) return null;
  return { from: from.pubkey, to: to.pubkey, lamports: data.readBigUInt64LE(4) };
}

/** Highest priority fee price accepted in a transaction built by core (micro-lamports per CU). */
export const MAX_COMPUTE_UNIT_PRICE = 1_000_000n;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

function checkComputeBudget(ix: TransactionInstruction): void {
  const data = Buffer.from(ix.data);
  const kind = data[0];
  if (kind === 2 && data.length === 5) {
    if (data.readUInt32LE(1) > MAX_COMPUTE_UNIT_LIMIT) policy('compute unit limit too high');
    return;
  }
  if (kind === 3 && data.length === 9) {
    if (data.readBigUInt64LE(1) > MAX_COMPUTE_UNIT_PRICE) policy('compute unit price too high');
    return;
  }
  policy('compute budget instruction not allowed');
}

function policy(rule: string): never {
  throw new JobError('TX_POLICY', rule);
}

function sameKey(a: PublicKey | undefined | null, b: PublicKey): boolean {
  return !!a && a.equals(b);
}

function assertSigners(tx: Transaction, feePayer: PublicKey, allowed: PublicKey[]): void {
  if (!sameKey(tx.feePayer, feePayer)) policy('unexpected fee payer');
  if (!tx.recentBlockhash) policy('missing recent blockhash');
  const signers = requiredSigners(tx);
  for (const s of signers) {
    if (!allowed.some((a) => a.equals(s))) policy('unexpected required signer');
  }
}

export interface SolTransferExpectation {
  from: PublicKey;
  to: PublicKey;
  lamports: bigint;
  memo?: string;
}

/**
 * A SOL transfer transaction must be exactly: one System transfer `from` -> `to` of `lamports`,
 * an optional memo equal to `memo` (no signer keys), optional bounded compute budget; fee payer
 * and only signer = `from`.
 */
export function assertSolTransferTx(tx: Transaction, expected: SolTransferExpectation): void {
  if (expected.lamports <= 0n) policy('transfer amount must be positive');
  if (expected.from.equals(expected.to)) policy('transfer to self');
  assertSigners(tx, expected.from, [expected.from]);
  let transfers = 0;
  let memos = 0;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(SystemProgram.programId)) {
      const t = decodeSystemTransfer(ix);
      if (!t) policy('system instruction other than a transfer');
      if (!t.from.equals(expected.from) || !t.to.equals(expected.to)) {
        policy('transfer between unexpected accounts');
      }
      if (t.lamports !== expected.lamports) policy('transfer amount mismatch');
      transfers++;
    } else if (ix.programId.equals(MEMO_PROGRAM_ID)) {
      if (expected.memo === undefined) policy('unexpected memo');
      if (ix.keys.length !== 0) policy('memo with signer keys');
      if (Buffer.from(ix.data).toString('utf8') !== expected.memo) policy('memo mismatch');
      memos++;
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      checkComputeBudget(ix);
    } else {
      policy('program not allowed in a transfer');
    }
  }
  if (transfers !== 1) policy('exactly one transfer expected');
  if (expected.memo !== undefined && memos !== 1) policy('memo missing');
}

/** Anchor discriminators of the DBC creator claim instructions (sha256("global:<name>")[0..8]). */
export const DBC_CREATOR_CLAIM_DISCRIMINATORS = [
  Buffer.from([82, 220, 250, 189, 3, 85, 107, 45]), // claim_creator_trading_fee
  Buffer.from([238, 247, 213, 94, 110, 145, 88, 142]), // claim_creator_trading_fee2
];

/** Account indexes of `claim_creator_trading_fee(2)` (SDK 1.5.13 IDL). */
const CLAIM_IX = {
  pool: 1,
  tokenA: 2,
  tokenB: 3,
  baseMint: 6,
  quoteMint: 7,
  creator: 8,
  tokenBaseProgram: 9,
  tokenQuoteProgram: 10,
} as const;

export interface CreatorClaimExpectation {
  dbcProgramId: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  creator: PublicKey;
  /** Fee payer: the signer's payer wallet, or the creator itself. */
  feePayer: PublicKey;
  /** FORGE multisig vault: every claimed lamport and token must end up there. */
  receiver: PublicKey;
  /**
   * Quote fees (lamports) the claim reports (core `summary.claimable.quote`). Required when the
   * transaction forwards the SOL with a System transfer from the creator: that transfer must be
   * exactly this amount.
   */
  claimedQuoteLamports?: bigint;
}

function isTokenProgram(id: PublicKey): boolean {
  return id.equals(TOKEN_PROGRAM_ID) || id.equals(TOKEN_2022_PROGRAM_ID);
}

/**
 * Creator claim policy (defense in depth against a wrong transaction from core):
 * - fee payer = expected payer; required signers within {creator, payer};
 * - programs: DBC (exactly one creator-claim instruction, on the expected pool, base mint,
 *   SOL quote and creator), Associated Token (create / create-idempotent, funded by a signer,
 *   owned by the receiver or by the creator), SPL Token (CloseAccount of the creator's temporary
 *   WSOL account, SyncNative), System (at most one transfer, see below), bounded compute budget.
 *   Nothing else: no `transfer_pool_creator`, no approve/setAuthority, no other System call;
 * - the claimed base fees go to the receiver's ATA;
 * - the claimed quote fees go to one of:
 *   a. the receiver's WSOL ATA (no close, no transfer);
 *   b. the creator's temporary WSOL ATA, closed (after the claim) to the receiver, no transfer
 *      (core when the receiver pays: the claim is uncapped);
 *   c. the creator's temporary WSOL ATA, closed (after the claim) to the creator OR to the fee
 *      payer, then exactly one System transfer from that close destination to the receiver of
 *      exactly `claimedQuoteLamports`, after the close (core's "exact" layout when the receiver
 *      is not the payer: on devnet the signer's payer wallet pays, so the close goes to it). At
 *      most one SPL Token transfer is allowed, between the claim and the close: core's
 *      self-transfer of exactly `claimedQuoteLamports` on the temporary account (source,
 *      destination = that account, authority = creator), which makes the claim fail on-chain
 *      unless the full amount was collected.
 */
export function assertCreatorClaimTx(tx: Transaction, expected: CreatorClaimExpectation): void {
  const signerSet = [expected.creator, expected.feePayer];
  assertSigners(tx, expected.feePayer, signerSet);
  if (!requiredSigners(tx).some((s) => s.equals(expected.creator))) {
    policy('creator must sign');
  }
  let claimIndex = -1;
  let tokenB: PublicKey | undefined;
  let tokenBProgram: PublicKey | undefined;
  const closes: Array<{ index: number; account: PublicKey; destination: PublicKey }> = [];
  const transfers: Array<{ index: number; from: PublicKey; to: PublicKey; lamports: bigint }> = [];
  const tokenTransfers: Array<{
    index: number;
    source: PublicKey;
    destination: PublicKey;
    authority: PublicKey;
    amount: bigint;
  }> = [];

  tx.instructions.forEach((ix, index) => {
    const data = Buffer.from(ix.data);
    const key = (i: number): PublicKey => {
      const meta = ix.keys[i];
      if (!meta) policy('instruction is missing accounts');
      return meta.pubkey;
    };
    if (ix.programId.equals(expected.dbcProgramId)) {
      const disc = data.subarray(0, 8);
      if (!DBC_CREATOR_CLAIM_DISCRIMINATORS.some((d) => d.equals(disc))) {
        policy('DBC instruction other than a creator claim');
      }
      if (claimIndex !== -1) policy('more than one claim instruction');
      claimIndex = index;
      if (!key(CLAIM_IX.pool).equals(expected.pool)) policy('claim on an unexpected pool');
      if (!key(CLAIM_IX.baseMint).equals(expected.baseMint)) policy('unexpected base mint');
      if (!key(CLAIM_IX.quoteMint).equals(NATIVE_MINT)) policy('quote mint is not SOL');
      if (!key(CLAIM_IX.creator).equals(expected.creator)) policy('unexpected creator account');
      const baseProgram = key(CLAIM_IX.tokenBaseProgram);
      const quoteProgram = key(CLAIM_IX.tokenQuoteProgram);
      if (!isTokenProgram(baseProgram) || !isTokenProgram(quoteProgram)) {
        policy('unexpected token program');
      }
      const receiverBase = getAssociatedTokenAddressSync(
        expected.baseMint,
        expected.receiver,
        true,
        baseProgram,
      );
      if (!key(CLAIM_IX.tokenA).equals(receiverBase)) policy('base fees not sent to the receiver');
      tokenB = key(CLAIM_IX.tokenB);
      tokenBProgram = quoteProgram;
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) {
        policy('associated token instruction not allowed');
      }
      if (!signerSet.some((s) => s.equals(key(0)))) policy('token account funded by a non-signer');
      const owner = key(2);
      if (!owner.equals(expected.receiver) && !owner.equals(expected.creator)) {
        policy('token account for an unexpected owner');
      }
    } else if (isTokenProgram(ix.programId)) {
      if (data[0] === 9 && data.length === 1) {
        const destination = key(1);
        if (
          !destination.equals(expected.receiver) &&
          !destination.equals(expected.creator) &&
          !destination.equals(expected.feePayer)
        ) {
          policy('account closed to a non-receiver');
        }
        if (!key(2).equals(expected.creator)) policy('unexpected close authority');
        closes.push({ index, account: key(0), destination });
      } else if (data[0] === 3 && data.length === 9) {
        // SPL Token Transfer: only core's exact-amount self-transfer is accepted (checked below).
        tokenTransfers.push({
          index,
          source: key(0),
          destination: key(1),
          authority: key(2),
          amount: data.readBigUInt64LE(1),
        });
      } else if (!(data[0] === 17 && data.length === 1)) {
        policy('token instruction not allowed');
      }
    } else if (ix.programId.equals(SystemProgram.programId)) {
      const t = decodeSystemTransfer(ix);
      if (!t) policy('system instruction other than a transfer');
      if (
        !(t.from.equals(expected.creator) || t.from.equals(expected.feePayer)) ||
        !t.to.equals(expected.receiver)
      ) {
        policy('transfer between unexpected accounts');
      }
      transfers.push({ index, ...t });
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      checkComputeBudget(ix);
    } else {
      policy('program not allowed in a claim');
    }
  });

  if (claimIndex === -1 || !tokenB || !tokenBProgram) policy('no claim instruction');
  if (transfers.length > 1) policy('more than one transfer in a claim');
  if (tokenTransfers.length > 1) policy('more than one token transfer in a claim');
  const transfer = transfers[0];
  const selfTransfer = tokenTransfers[0];
  const receiverQuote = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    expected.receiver,
    true,
    tokenBProgram,
  );
  if (tokenB.equals(receiverQuote)) {
    // a. Straight to the receiver's WSOL account: nothing to close or forward.
    if (transfer) policy('unexpected transfer in a claim');
    if (selfTransfer) policy('unexpected token transfer in a claim');
    if (closes.length > 0) policy('unexpected token account close');
    return;
  }
  const creatorTemp = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    expected.creator,
    true,
    tokenBProgram,
  );
  if (!tokenB.equals(creatorTemp)) policy('quote fees not sent to the receiver');
  if (closes.length !== 1) policy('exactly one token account close expected');
  const close = closes[0]!;
  if (!close.account.equals(creatorTemp) || close.index < claimIndex) {
    policy('temporary WSOL account not closed after the claim');
  }
  if (close.destination.equals(expected.receiver)) {
    // b. Closed to the receiver: the vault gets the fees plus the account rent.
    if (transfer) policy('unexpected transfer in a claim');
    if (selfTransfer) policy('unexpected token transfer in a claim');
    return;
  }
  // c. Closed to the creator or to the fee payer, which forwards the claimed lamports to the
  //    receiver; the optional self-transfer pins the claimed amount on-chain.
  if (expected.claimedQuoteLamports === undefined) policy('claimed amount unknown');
  const claimed = expected.claimedQuoteLamports;
  if (selfTransfer) {
    if (!selfTransfer.source.equals(creatorTemp) || !selfTransfer.destination.equals(creatorTemp)) {
      policy('token transfer between unexpected accounts');
    }
    if (!selfTransfer.authority.equals(expected.creator))
      policy('unexpected token transfer authority');
    if (claimed <= 0n || selfTransfer.amount !== claimed) {
      policy('token transfer amount differs from the claimed amount');
    }
    if (selfTransfer.index < claimIndex || selfTransfer.index > close.index) {
      policy('token transfer outside the claim and the close');
    }
  }
  if (!transfer) policy('claimed SOL not forwarded to the receiver');
  if (!transfer.from.equals(close.destination)) {
    policy('claimed SOL forwarded from an account other than the close destination');
  }
  if (transfer.index < close.index) policy('transfer before the temporary account is closed');
  if (claimed <= 0n || transfer.lamports !== claimed) {
    policy('forwarded amount differs from the claimed amount');
  }
}

export interface KeystoreSignerRef {
  ref: string;
  /** The public key the ref must decrypt to (refuses to sign otherwise). */
  expected: PublicKey;
}

/** The part of the keystore the jobs use. Signing only happens inside `withSigner`. */
export type KeystoreLike = Pick<Keystore, 'withSigner' | 'getPublicKey' | 'findRef'>;

/** Signs in place with each keystore ref, then checks every required signature is valid. */
export async function signWithKeystore(
  keystore: KeystoreLike,
  tx: Transaction,
  signers: KeystoreSignerRef[],
): Promise<{ raw: Buffer; signature: string }> {
  const seen = new Set<string>();
  for (const s of signers) {
    const id = s.expected.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    await keystore.withSigner(s.ref, (signer) => {
      if (!signer.publicKey.equals(s.expected)) throw new JobError('SIGNER_MISMATCH');
      signer.signTransaction(tx);
    });
  }
  const raw = serializeSigned(tx);
  return { raw, signature: transactionSignature(tx) };
}

/** Ref of a fixed keystore role whose key must be `expected`. Throws CONFIG otherwise. */
export async function requireRoleRef(
  keystore: KeystoreLike,
  role: 'payer' | 'cashbox' | 'buyback',
  expected?: PublicKey,
): Promise<{ ref: string; publicKey: PublicKey }> {
  const ref = await keystore.findRef(role);
  if (!ref) throw new JobError('CONFIG', `no ${role} key in the keystore`);
  const publicKey = await keystore.getPublicKey(ref);
  if (expected && !publicKey.equals(expected)) {
    throw new JobError('CONFIG', `${role} key does not match the configured address`);
  }
  return { ref, publicKey };
}

// ---------------------------------------------------------------------------------------
// Kill switches

export interface FlagsReader {
  /** Current flags (key -> value). Read fresh on every job run. */
  read(): Promise<ReadonlyMap<string, boolean>>;
}

/**
 * Kill switches of these jobs (`flags` table, seeded by migration 0005 with `false`). A missing
 * row pauses the job: the switch must exist for an operator to be able to use it.
 */
export const JOB_FLAGS = {
  claims: 'claims_paused',
  cashbox: 'cashbox_sweep_paused',
  refunds: 'refunds_paused',
} as const satisfies Record<string, FlagKey>;

export type PauseReason = 'config' | 'flag' | 'flag_missing' | 'flags_unavailable';

export type PauseCheck = { paused: false } | { paused: true; reason: PauseReason };

/** Fail closed: a job that cannot read its flag, or whose flag row is missing, does not run. */
export async function checkPaused(
  flags: FlagsReader,
  key: FlagKey,
  localPaused: boolean | undefined,
  logger: JobLogger,
): Promise<PauseCheck> {
  if (localPaused) return { paused: true, reason: 'config' };
  let values: ReadonlyMap<string, boolean>;
  try {
    values = await flags.read();
  } catch (err) {
    logger.warn({ flag: key, err: describeError(err) }, 'flags unavailable: job paused');
    return { paused: true, reason: 'flags_unavailable' };
  }
  const value = values.get(key);
  if (value === undefined) {
    logger.warn({ flag: key }, 'kill switch row missing: job paused');
    return { paused: true, reason: 'flag_missing' };
  }
  return value ? { paused: true, reason: 'flag' } : { paused: false };
}

/** Alerts for a pause that is not an operator decision (missing row, unreadable flags). */
export async function alertAbnormalPause(
  alerter: JobAlerter,
  logger: JobLogger,
  job: string,
  key: FlagKey,
  reason: PauseReason,
): Promise<void> {
  if (reason !== 'flag_missing' && reason !== 'flags_unavailable') return;
  await sendAlert(
    alerter,
    logger,
    'high',
    `${job}_paused_${reason}`,
    reason === 'flag_missing'
      ? `The ${job} job is paused: its kill switch row "${key}" is missing from the flags table`
      : `The ${job} job is paused: the flags table cannot be read`,
    { flag: key },
    `${job}_paused_${reason}`,
  );
}

// ---------------------------------------------------------------------------------------
// Concurrency and scheduling

/** FIFO async mutex. Used to serialize the jobs that spend from the same wallet. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  #held = false;

  get held(): boolean {
    return this.#held;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    this.#held = true;
    try {
      return await fn();
    } finally {
      this.#held = false;
      release();
    }
  }
}

export interface IntervalJobOptions {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  logger: JobLogger;
  /** Run once right away (default true). */
  runOnStart?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface IntervalJobHandle {
  /** Stops scheduling and waits for a run in progress. */
  stop(): Promise<void>;
}

/**
 * Runs `run` every `intervalMs`, never overlapping (the next run is scheduled when the current
 * one ends). A failing run is logged and does not stop the schedule.
 */
export function startIntervalJob(options: IntervalJobOptions): IntervalJobHandle {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1_000) {
    throw new JobError('CONFIG', 'interval must be an integer of at least 1000 ms');
  }
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let stopped = false;
  let handle: unknown;
  let current: Promise<void> | undefined;

  const tick = () => {
    handle = undefined;
    if (stopped) return;
    current = (async () => {
      try {
        await options.run();
      } catch (err) {
        options.logger.error({ job: options.name, err: describeError(err) }, 'job run failed');
      }
    })().finally(() => {
      current = undefined;
      if (!stopped) handle = setTimer(tick, options.intervalMs);
    });
  };

  if (options.runOnStart ?? true) tick();
  else handle = setTimer(tick, options.intervalMs);

  return {
    async stop() {
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
      handle = undefined;
      if (current) await current;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Supabase (PostgREST) access with the service role key

export interface PostgrestOptions {
  /** SUPABASE_URL. */
  url: string;
  /** SUPABASE_SERVICE_ROLE_KEY. Only ever sent in request headers; never logged. */
  serviceRoleKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryOptions;
}

export interface PostgrestClient {
  select(table: string, params: Record<string, string>): Promise<unknown[]>;
  /** Conditional update; returns the updated rows (Prefer: return=representation). */
  update(
    table: string,
    filters: Record<string, string>,
    patch: Record<string, unknown>,
  ): Promise<unknown[]>;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
}

const TABLE_RE = /^[a-z_]{1,40}$/;

export function createPostgrestClient(options: PostgrestOptions): PostgrestClient {
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw new JobError('CONFIG', 'SUPABASE_URL is not a valid URL');
  }
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) {
    throw new JobError('CONFIG', 'SUPABASE_URL must use https');
  }
  if (typeof options.serviceRoleKey !== 'string' || options.serviceRoleKey.length < 20) {
    throw new JobError('CONFIG', 'SUPABASE_SERVICE_ROLE_KEY is missing');
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retry = options.retry ?? DEFAULT_RETRY;
  const root = base.toString().replace(/\/+$/, '');

  const request = async (
    method: 'GET' | 'PATCH' | 'POST',
    table: string,
    params: Record<string, string>,
    body: unknown,
    prefer: string | undefined,
  ): Promise<unknown> => {
    if (!TABLE_RE.test(table)) throw new JobError('DB', 'invalid table name');
    const query = new URLSearchParams(params).toString();
    const target = `${root}/rest/v1/${table}${query ? `?${query}` : ''}`;
    return withRetry(async () => {
      let res: Response;
      try {
        res = await doFetch(target, {
          method,
          headers: {
            apikey: options.serviceRoleKey,
            authorization: `Bearer ${options.serviceRoleKey}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(prefer ? { prefer } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Only the error name/code: a fetch error message may contain the request URL.
        const summary = describeError(err);
        throw new JobError('DB', `request failed (${summary.code ?? summary.name})`, {
          transient: true,
        });
      }
      if (!res.ok) {
        let pgCode = '';
        try {
          const parsed = (await res.json()) as { code?: unknown };
          if (typeof parsed.code === 'string') pgCode = ` ${parsed.code.slice(0, 16)}`;
        } catch {
          // ignore: error body is optional
        }
        throw new JobError('DB', `HTTP ${res.status}${pgCode} on ${method} ${table}`, {
          transient: res.status >= 500 || res.status === 429,
        });
      }
      if (prefer === 'return=minimal') return undefined;
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new JobError('DB_RESPONSE', `invalid JSON from ${table}`);
      }
    }, retry);
  };

  const asRows = (value: unknown, table: string): unknown[] => {
    if (!Array.isArray(value)) throw new JobError('DB_RESPONSE', `expected rows from ${table}`);
    return value;
  };

  return {
    async select(table, params) {
      return asRows(await request('GET', table, params, undefined, undefined), table);
    },
    async update(table, filters, patch) {
      if (Object.keys(filters).length === 0) throw new JobError('DB', 'update without filter');
      return asRows(await request('PATCH', table, filters, patch, 'return=representation'), table);
    },
    async insert(table, row) {
      await request('POST', table, {}, row, 'return=minimal');
    },
  };
}

const FlagRows = z.array(z.object({ key: z.string(), value: z.boolean() }));

/** Reads the `flags` table on every call. */
export function createPostgrestFlagsReader(client: PostgrestClient): FlagsReader {
  return {
    async read() {
      const parsed = FlagRows.safeParse(await client.select('flags', { select: 'key,value' }));
      if (!parsed.success) throw new JobError('DB_RESPONSE', 'invalid flags rows');
      return new Map(parsed.data.map((r) => [r.key, r.value]));
    },
  };
}

/** PostgREST filter value for equality (`eq.<value>`), refusing characters that change meaning. */
export function eq(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new JobError('DB', 'unsafe filter value');
  return `eq.${value}`;
}
