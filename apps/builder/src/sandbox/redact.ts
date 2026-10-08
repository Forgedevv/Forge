/**
 * Redaction and size capping of everything a sandbox prints. Output of a sandboxed
 * process is hostile: it may try to print a secret, flood the logs or inject terminal
 * control sequences.
 */

export const REDACTED = '[REDACTED]';

/** Exact secrets shorter than this are not redacted (too many false positives). */
const MIN_SECRET_LENGTH = 6;
/**
 * Chars dropped at each truncation edge, after redaction: a secret cut in half by the
 * truncation is never partially shown. Must exceed the longest exact secret.
 */
export const TRUNCATION_MARGIN = 1024;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/forge_gw_[A-Za-z0-9_-]+/g, REDACTED],
  [/sk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bsb_secret_[A-Za-z0-9_-]+/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    REDACTED,
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)?\s*)[^\s"',;]+/gi, `$1${REDACTED}`],
  [/((?:x-api-key|api[-_]?key)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, `$1${REDACTED}`],
  [/(_auth(?:Token)?\s*=\s*)\S+/g, `$1${REDACTED}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The forms a secret is likely to be printed in. */
function variants(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  return [
    secret,
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    encodeURIComponent(secret),
  ];
}

/** Removes ANSI escape sequences and control characters (tab and newline kept). */
export function stripControl(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, '')
  );
}

export type Redactor = (text: string) => string;

/** Builds a redactor for exact secret values plus well-known secret formats. */
export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const exact = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) continue;
    for (const v of variants(secret)) if (v.length >= MIN_SECRET_LENGTH) exact.add(v);
  }
  const sorted = [...exact].sort((a, b) => b.length - a.length);
  const exactRe = sorted.length > 0 ? new RegExp(sorted.map(escapeRegExp).join('|'), 'g') : null;
  return (text: string) => {
    let out = stripControl(text);
    if (exactRe) out = out.replace(exactRe, REDACTED);
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
    return out;
  };
}

/**
 * Keeps the head and the tail of a stream within `maxBytes` and counts the rest.
 * Raw bytes are kept with a margin so redaction runs on complete secrets before the
 * edges are cut.
 */
export class OutputCollector {
  readonly maxBytes: number;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 64) throw new Error('maxBytes must be >= 64');
    this.maxBytes = maxBytes;
    this.headLimit = Math.ceil(maxBytes / 2) + TRUNCATION_MARGIN;
    this.tailLimit = Math.floor(maxBytes / 2) + TRUNCATION_MARGIN;
  }

  get totalBytes(): number {
    return this.total;
  }

  /** True if bytes were dropped. */
  get truncated(): boolean {
    return this.total > this.headLimit + this.tailLimit;
  }

  push(chunk: Uint8Array): void {
    let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.total += buf.length;
    if (this.headBytes < this.headLimit) {
      const take = Math.min(buf.length, this.headLimit - this.headBytes);
      this.head.push(Buffer.from(buf.subarray(0, take)));
      this.headBytes += take;
      buf = buf.subarray(take);
    }
    if (buf.length === 0) return;
    this.tail.push(Buffer.from(buf));
    this.tailBytes += buf.length;
    // Compact once the tail holds twice its limit.
    if (this.tailBytes > 2 * this.tailLimit) {
      const joined = Buffer.concat(this.tail);
      const kept = joined.subarray(joined.length - this.tailLimit);
      this.tail = [Buffer.from(kept)];
      this.tailBytes = kept.length;
    }
  }

  /** Redacted text; the middle is replaced by a marker when the stream was too long. */
  text(redact: Redactor): string {
    const head = Buffer.concat(this.head);
    let tail = Buffer.concat(this.tail);
    if (!this.truncated) return redact(Buffer.concat([head, tail]).toString('utf8'));
    tail = tail.subarray(Math.max(0, tail.length - this.tailLimit));
    const headText = redact(head.toString('utf8'));
    const tailText = redact(tail.toString('utf8'));
    const keptHead = headText.slice(0, Math.max(0, headText.length - TRUNCATION_MARGIN));
    const keptTail = tailText.slice(Math.min(tailText.length, TRUNCATION_MARGIN));
    const omitted = this.total - head.length - tail.length + 2 * TRUNCATION_MARGIN;
    return `${keptHead}\n[... about ${omitted} bytes omitted ...]\n${keptTail}`;
  }
}

/** Caps an already redacted text to `maxChars`, keeping its head and tail. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[... ${text.length - 2 * half} chars omitted ...]\n${text.slice(text.length - half)}`;
}
