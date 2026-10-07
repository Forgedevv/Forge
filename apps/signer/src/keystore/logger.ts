/**
 * Redacting logger for the keystore.
 *
 * Pino's own `redact` option is path-based and only available on the root logger, which the
 * keystore does not own. So every object logged through this wrapper is deep-sanitized first:
 * - any field whose name looks like key/secret/token/private/passphrase/password/seed/
 *   mnemonic/cipher/nonce/salt is replaced by '[REDACTED]' (whatever its value);
 * - any Buffer / typed array value is replaced by '[REDACTED bytes]';
 * - errors are reduced to { name, code, details } and, for KeystoreError only, the static message.
 *
 * Public keys are logged under `address`, which does not match the pattern.
 */

import type pino from 'pino';
import { KeystoreError } from './errors.js';

export const SECRET_FIELD_RE =
  /key|secret|token|private|passphrase|password|seed|mnemonic|cipher|nonce|salt|credential|auth/i;

export const REDACTED = '[REDACTED]';
export const REDACTED_BYTES = '[REDACTED bytes]';

const MAX_DEPTH = 8;

export type LogFields = Record<string, unknown>;

export interface KeystoreLogger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
}

function summarizeError(err: Error): LogFields {
  const out: LogFields = { name: err.name };
  if (err instanceof KeystoreError) {
    out.code = err.code;
    out.message = err.message; // static text, see errors.ts
    out.details = err.details;
  } else {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') out.code = code;
  }
  return out;
}

/** Deep-copies `value` with every secret-looking field and every byte array redacted. */
export function redactSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED_BYTES;
  if (value instanceof Error) return redactSecrets(summarizeError(value), depth + 1, seen);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1, seen));
  }
  if (value instanceof Map || value instanceof Set) {
    return redactSecrets(Array.from(value.values()), depth + 1, seen);
  }
  // Any other object (including class instances) is reduced to its own enumerable fields,
  // so getters and methods that could expose bytes are never invoked.
  const out: LogFields = {};
  for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    out[field] = SECRET_FIELD_RE.test(field)
      ? REDACTED
      : redactSecrets(fieldValue, depth + 1, seen);
  }
  return out;
}

/**
 * Creates the keystore logger as a child of the signer's pino logger. Everything logged
 * through it is sanitized by `redactSecrets` before reaching pino.
 */
export function createKeystoreLogger(parent: pino.Logger): KeystoreLogger {
  const child = parent.child({ module: 'keystore' });
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (fields: LogFields, msg: string): void => {
      const safe = redactSecrets(fields) as LogFields;
      child[level](safe, msg);
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/** Logger that drops everything, for callers that pass no pino instance. */
export const silentKeystoreLogger: KeystoreLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
