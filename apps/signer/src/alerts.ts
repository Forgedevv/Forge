/// <reference types="node" />
/*
 * Telegram alerts for the signer (docs/OPERATIONS.md, "Alerts").
 *
 * Same contract as the builder's alerter (not imported: apps do not share code), with a few
 * additions for a service that can raise many alerts in a row:
 * - a dedup key per alert (default: the code), so "low balance" on two different wallets are
 *   two different alerts while the same one is sent at most once per window;
 * - one dedup window per level (immediate alerts are repeated sooner than normal ones);
 * - an alert counts as sent (for dedup) only once Telegram accepted it: a failed send is never
 *   deduplicated away;
 * - one-shot alerts (immediate ones, and any alert sent with `oneShot: true`, e.g. an outflow the
 *   watcher will not detect again) that fail or are rate-limited go to a bounded retry queue,
 *   retried with backoff before each new alert and by `flushPending()`;
 * - a global cap per window: past it, alerts are only logged and the count of suppressed alerts
 *   is appended to the next message sent. Immediate alerts are exempt from the cap;
 * - secrets never leave the process: sensitive detail keys are dropped, and the message, the
 *   values and the logged text are scrubbed of bot tokens and 64-byte key arrays. Base58 secret
 *   keys cannot be told from transaction signatures (both ~88 chars) and signatures must stay
 *   readable, so those are never scrubbed by pattern: no code path may put one in an alert.
 *
 * Without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID the alerter only logs: allowed in development
 * and tests on devnet only, the runtime refuses to start without them on mainnet-beta and in
 * production (runtime/env.ts).
 */

export type AlertLevel = 'immediate' | 'high' | 'normal';

/** Minimal logger shape, compatible with pino. */
export interface AlertLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AlertOptions {
  /** Alerts with the same dedup key are sent at most once per window. Default: the code. */
  dedupKey?: string;
  /**
   * The event will not be raised again (a detection whose cursor moved on): a failed or
   * rate-limited send is queued and retried until delivered. Default: true for `immediate`.
   */
  oneShot?: boolean;
}

export interface Alerter {
  alert(
    level: AlertLevel,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options?: AlertOptions,
  ): Promise<void>;
  /** Retries the queued one-shot alerts that are due. Never throws. */
  flushPending?(): Promise<void>;
}

export interface AlerterOptions {
  botToken?: string | undefined;
  chatId?: string | undefined;
  fetch?: typeof fetch;
  logger: AlertLogger;
  /** Dedup window per level, in ms. */
  minIntervalMs?: Partial<Record<AlertLevel, number>>;
  /** Maximum number of non-immediate messages sent per `windowMs`. */
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
  /** Per-request timeout for the Telegram call. */
  timeoutMs?: number;
  /** Most one-shot alerts kept for retry (oldest non-immediate dropped first). */
  maxPending?: number;
  /** First retry delay of a queued alert, doubled per failure up to `maxRetryDelayMs`. */
  retryBaseMs?: number;
  maxRetryDelayMs?: number;
}

export const DEFAULT_MAX_PENDING = 200;
export const DEFAULT_RETRY_BASE_MS = 30_000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 15 * 60_000;

export const DEFAULT_MIN_INTERVAL_MS: Record<AlertLevel, number> = {
  immediate: 5 * 60_000,
  high: 30 * 60_000,
  normal: 6 * 60 * 60_000,
};
export const DEFAULT_MAX_PER_WINDOW = 20;
export const DEFAULT_WINDOW_MS = 10 * 60_000;

const SENSITIVE_KEY = /key|secret|token|private|passphrase|password|mnemonic|seed|credential|auth/i;
/** Telegram bot token: `<digits>:<35 chars>`. */
const BOT_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g;
/** A JSON byte array of 64 numbers (the usual keypair file format). */
const KEY_ARRAY_RE = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

const MAX_DETAIL_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 3000;
const PREFIX: Record<AlertLevel, string> = {
  immediate: '[IMMEDIATE]',
  high: '[HIGH]',
  normal: '[NORMAL]',
};

/** Replaces anything that looks like a bot token or a secret key. */
export function scrubSecrets(text: string): string {
  return text.replace(BOT_TOKEN_RE, '[REDACTED]').replace(KEY_ARRAY_RE, '[REDACTED]');
}

function sanitizeNested(v: unknown, depth = 0): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  // Past the depth limit, keys are no longer checked: drop the value instead of leaking it.
  if (depth > 3) return '[truncated]';
  if (Array.isArray(v)) return v.map((x) => sanitizeNested(x, depth + 1));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (SENSITIVE_KEY.test(k)) continue;
    o[k] = sanitizeNested(x, depth + 1);
  }
  return o;
}

/** Drops sensitive keys (recursively) and flattens values to short, scrubbed strings. */
export function sanitizeDetails(
  details: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!details) return out;
  for (const [k, v] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(k)) continue;
    let s: string;
    if (typeof v === 'string') s = v;
    else if (v !== null && typeof v === 'object') s = JSON.stringify(sanitizeNested(v));
    else s = String(v);
    s = scrubSecrets(s);
    out[k] = s.length > MAX_DETAIL_LENGTH ? `${s.slice(0, MAX_DETAIL_LENGTH)}...` : s;
  }
  return out;
}

/** A one-shot alert waiting for a successful send. Holds already sanitized text only. */
interface PendingAlert {
  key: string;
  level: AlertLevel;
  code: string;
  /** Sanitized, ready-to-send message lines (without the suppressed-count line). */
  lines: string[];
  attempts: number;
  nextAt: number;
}

export interface QueueingAlerter extends Alerter {
  flushPending(): Promise<void>;
  /** Number of one-shot alerts waiting for a successful send. */
  pendingCount(): number;
}

export function createAlerter(opts: AlerterOptions): QueueingAlerter {
  const { botToken, chatId, logger } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervals = { ...DEFAULT_MIN_INTERVAL_MS, ...opts.minIntervalMs };
  const maxPerWindow = opts.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPending = Math.max(1, opts.maxPending ?? DEFAULT_MAX_PENDING);
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const configured = Boolean(botToken) && Boolean(chatId);

  const lastSent = new Map<string, number>();
  const pending = new Map<string, PendingAlert>();
  let windowStart = 0;
  let sentInWindow = 0;
  let suppressed = 0;
  let flushing: Promise<void> | null = null;

  const safeLog = (fields: object, msg: string): void => {
    try {
      logger.error(fields, msg);
    } catch {
      /* logging must never throw */
    }
  };

  /** One Telegram call. True only when Telegram accepted the message. Never throws. */
  const post = async (level: AlertLevel, code: string, text: string): Promise<boolean> => {
    try {
      const res = await doFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, MAX_MESSAGE_LENGTH),
          disable_web_page_preview: true,
          disable_notification: level === 'normal',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        safeLog({ code, status: res.status }, 'telegram alert failed');
        return false;
      }
      return true;
    } catch (err) {
      // Log only the error name: network errors can embed the request URL (which has the token).
      safeLog(
        { code, errorName: err instanceof Error ? err.name : 'unknown' },
        'telegram alert failed',
      );
      return false;
    }
  };

  const enqueue = (entry: Omit<PendingAlert, 'attempts' | 'nextAt'>, t: number): void => {
    const previous = pending.get(entry.key);
    pending.set(entry.key, {
      ...entry,
      attempts: previous ? previous.attempts + 1 : 1,
      nextAt: t + Math.min(retryBaseMs * 2 ** (previous?.attempts ?? 0), maxRetryDelayMs),
    });
    while (pending.size > maxPending) {
      // Drop the oldest non-immediate entry first; immediate ones only when nothing else is left.
      let victim: string | undefined;
      for (const [k, v] of pending) {
        if (v.level !== 'immediate') {
          victim = k;
          break;
        }
      }
      victim ??= pending.keys().next().value;
      if (victim === undefined) break;
      const dropped = pending.get(victim);
      pending.delete(victim);
      safeLog({ code: dropped?.code ?? 'unknown' }, 'alert retry queue full: oldest alert dropped');
    }
  };

  const flushDue = async (): Promise<void> => {
    if (!configured || pending.size === 0) return;
    const t = now();
    for (const entry of [...pending.values()]) {
      if (entry.nextAt > t) continue;
      const lines = [...entry.lines, `(retried after ${entry.attempts} failed attempt(s))`];
      if (await post(entry.level, entry.code, lines.join('\n'))) {
        pending.delete(entry.key);
        lastSent.set(entry.key, now());
      } else {
        enqueue(entry, now());
      }
    }
  };

  /** Runs one flush at a time (concurrent alerts must not send a queued entry twice). */
  const flushPending = async (): Promise<void> => {
    if (flushing) return flushing;
    flushing = flushDue()
      .catch(() => undefined)
      .finally(() => {
        flushing = null;
      });
    return flushing;
  };

  return {
    flushPending,
    pendingCount: () => pending.size,
    async alert(level, code, message, details, options) {
      try {
        await flushPending();
        const t = now();
        const key = `${level}:${options?.dedupKey ?? code}`;
        const oneShot = options?.oneShot ?? level === 'immediate';
        const prev = lastSent.get(key);
        if (prev !== undefined && t - prev < intervals[level]) {
          logger.info({ code }, 'alert deduplicated');
          return;
        }

        if (t - windowStart >= windowMs) {
          windowStart = t;
          sentInWindow = 0;
        }
        const capped = level !== 'immediate' && sentInWindow >= maxPerWindow;
        // Prune expired entries so the map cannot grow without bound.
        if (lastSent.size > 1000) {
          for (const [k, at] of lastSent) {
            if (t - at >= intervals.normal) lastSent.delete(k);
          }
        }

        const safe = sanitizeDetails(details);
        const safeMessage = scrubSecrets(message);
        logger.warn({ alert: { level, code, message: safeMessage, details: safe } }, 'alert');
        if (!configured) {
          // Log-only mode: the log line above is the delivery; dedup the logs.
          lastSent.set(key, t);
          return;
        }

        // Plain text (no parse_mode): nothing to escape.
        const lines = [`${PREFIX[level]} ${code}`, safeMessage];
        for (const [k, v] of Object.entries(safe)) lines.push(`${k}: ${v}`);

        if (capped) {
          // Not marked as sent: it can still go out once the window rolls over.
          suppressed += 1;
          logger.warn({ code }, 'alert rate limited');
          if (oneShot) enqueue({ key, level, code, lines }, t);
          return;
        }

        const carried = suppressed;
        const text = [
          ...lines,
          ...(carried > 0 ? [`(${carried} other alerts suppressed by the rate limit)`] : []),
        ].join('\n');
        sentInWindow += 1;
        suppressed = 0;
        if (await post(level, code, text)) {
          lastSent.set(key, t);
          pending.delete(key);
          return;
        }
        // Failed: not marked as sent (the next identical alert goes out), counts restored.
        sentInWindow -= 1;
        suppressed += carried;
        if (oneShot) enqueue({ key, level, code, lines }, t);
      } catch (err) {
        safeLog(
          { code, errorName: err instanceof Error ? err.name : 'unknown' },
          'telegram alert failed',
        );
      }
    },
  };
}

/** Builds the alerter from TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (log-only when absent). */
export function createAlerterFromEnv(
  logger: AlertLogger,
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<AlerterOptions> = {},
): QueueingAlerter {
  return createAlerter({
    botToken: env.TELEGRAM_BOT_TOKEN || undefined,
    chatId: env.TELEGRAM_CHAT_ID || undefined,
    logger,
    ...overrides,
  });
}
