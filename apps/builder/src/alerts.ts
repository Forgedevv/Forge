/// <reference types="node" />
export type AlertLevel = 'immediate' | 'high' | 'normal';

/** Minimal logger shape, compatible with pino. */
export interface AlertLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AlerterOptions {
  botToken?: string | undefined;
  chatId?: string | undefined;
  fetch?: typeof fetch;
  logger: AlertLogger;
  /** Identical codes are sent at most once per this window. */
  minIntervalMs: number;
  now?: () => number;
  /** Per-request timeout for the Telegram call. */
  timeoutMs?: number;
}

export interface Alerter {
  alert(
    level: AlertLevel,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
}

const SENSITIVE_KEY = /key|secret|token|private|passphrase|password|mnemonic|seed|credential|auth/i;
const MAX_DETAIL_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 3000;
const PREFIX: Record<AlertLevel, string> = {
  immediate: '[IMMEDIATE]',
  high: '[HIGH]',
  normal: '[NORMAL]',
};

function sanitizeNested(v: unknown, depth = 0): unknown {
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

/** Drops sensitive keys (recursively) and flattens values to short strings. */
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
    out[k] = s.length > MAX_DETAIL_LENGTH ? `${s.slice(0, MAX_DETAIL_LENGTH)}...` : s;
  }
  return out;
}

export function createAlerter(opts: AlerterOptions): Alerter {
  const { botToken, chatId, logger, minIntervalMs } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const configured = Boolean(botToken) && Boolean(chatId);
  const lastSent = new Map<string, number>();

  return {
    async alert(level, code, message, details) {
      try {
        const t = now();
        const prev = lastSent.get(code);
        if (prev !== undefined && t - prev < minIntervalMs) {
          logger.info({ code }, 'alert deduplicated');
          return;
        }
        lastSent.set(code, t);

        const safe = sanitizeDetails(details);
        logger.warn({ alert: { level, code, message, details: safe } }, 'alert');
        if (!configured) return;

        // Plain text (no parse_mode): nothing to escape.
        const lines = [`${PREFIX[level]} ${code}`, message];
        for (const [k, v] of Object.entries(safe)) lines.push(`${k}: ${v}`);
        const text = lines.join('\n').slice(0, MAX_MESSAGE_LENGTH);

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
