/// <reference types="node" />
/*
 * Telegram alerts for the signer (docs/OPERATIONS.md, "Alerts").
 *
 * Same contract as the builder's alerter (not imported: apps do not share code), with a few
 * additions for a service that can raise many alerts in a row:
 * - a dedup key per alert (default: the code), so "low balance" on two different wallets are
 *   two different alerts while the same one is sent at most once per window;
 * - one dedup window per level (immediate alerts are repeated sooner than normal ones);
 * - a global cap per window: past it, alerts are only logged and the count of suppressed alerts
 *   is appended to the next message sent. Immediate alerts are exempt from the cap;
 * - secrets never leave the process: sensitive detail keys are dropped, and the message, the
 *   values and the logged text are scrubbed of bot tokens and 64-byte key arrays. Base58 secret
 *   keys cannot be told from transaction signatures (both ~88 chars) and signatures must stay
 *   readable, so those are never scrubbed by pattern: no code path may put one in an alert.
 *
 * Without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID the alerter only logs.
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
}

export interface Alerter {
  alert(
    level: AlertLevel,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options?: AlertOptions,
  ): Promise<void>;
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
}

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

export function createAlerter(opts: AlerterOptions): Alerter {
  const { botToken, chatId, logger } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervals = { ...DEFAULT_MIN_INTERVAL_MS, ...opts.minIntervalMs };
  const maxPerWindow = opts.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const configured = Boolean(botToken) && Boolean(chatId);

  const lastSent = new Map<string, number>();
  let windowStart = 0;
  let sentInWindow = 0;
  let suppressed = 0;

  return {
    async alert(level, code, message, details, options) {
      try {
        const t = now();
        const key = `${level}:${options?.dedupKey ?? code}`;
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
        // A capped alert is not marked as sent, so it can still go out once the window rolls over.
        if (!capped) lastSent.set(key, t);

        const safe = sanitizeDetails(details);
        const safeMessage = scrubSecrets(message);
        logger.warn({ alert: { level, code, message: safeMessage, details: safe } }, 'alert');
        if (capped) {
          suppressed += 1;
          logger.warn({ code }, 'alert rate limited');
          return;
        }
        if (!configured) return;

        // Plain text (no parse_mode): nothing to escape.
        const lines = [`${PREFIX[level]} ${code}`, safeMessage];
        for (const [k, v] of Object.entries(safe)) lines.push(`${k}: ${v}`);
        if (suppressed > 0) lines.push(`(${suppressed} other alerts suppressed by the rate limit)`);
        const text = lines.join('\n').slice(0, MAX_MESSAGE_LENGTH);

        sentInWindow += 1;
        suppressed = 0;
        const res = await doFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            disable_notification: level === 'normal',
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) logger.error({ code, status: res.status }, 'telegram alert failed');
      } catch (err) {
        // Log only the error name: network errors can embed the request URL (which has the token).
        try {
          logger.error(
            { code, errorName: err instanceof Error ? err.name : 'unknown' },
            'telegram alert failed',
          );
        } catch {
          /* logging must never throw */
        }
      }
    },
  };
}

/** Builds the alerter from TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (log-only when absent). */
export function createAlerterFromEnv(
  logger: AlertLogger,
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<AlerterOptions> = {},
): Alerter {
  return createAlerter({
    botToken: env.TELEGRAM_BOT_TOKEN || undefined,
    chatId: env.TELEGRAM_CHAT_ID || undefined,
    logger,
    ...overrides,
  });
}
