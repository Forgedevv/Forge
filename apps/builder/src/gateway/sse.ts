import { EMPTY_USAGE, mergeUsage, parseUsage, type Usage } from './pricing.js';

/** Max bytes buffered for one SSE event before it is dropped (memory guard). */
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

/**
 * Incremental reader of an Anthropic Messages SSE stream that extracts usage.
 *
 * Assumptions (Anthropic streaming format):
 * - `message_start` carries `message.usage` (input and cache tokens, initial output) and `message.model`;
 * - `message_delta` carries a cumulative `usage` (at least `output_tokens`, possibly input/cache fields);
 * - `message_stop` closes the message.
 * Fields are merged by max, so a partial delta never lowers a count.
 * The bytes forwarded to the client are not touched by this reader.
 */
export class SseUsageReader {
  private readonly decoder = new TextDecoder();
  private pending = '';
  private usageValue: Usage = { ...EMPTY_USAGE };
  private modelValue: string | undefined;
  private stopped = false;
  private startSeen = false;

  push(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.drain();
  }

  end(): void {
    this.pending += this.decoder.decode();
    this.drain();
    if (this.pending.trim() !== '') this.handleEvent(this.pending);
    this.pending = '';
  }

  get usage(): Usage {
    return this.usageValue;
  }

  /** Model reported by `message_start`, if any. */
  get model(): string | undefined {
    return this.modelValue;
  }

  /** True once `message_start` was seen (its usage carries the real input counts). */
  get started(): boolean {
    return this.startSeen;
  }

  /** True once `message_stop` was seen. */
  get complete(): boolean {
    return this.stopped;
  }

  private drain(): void {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const raw = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.handleEvent(raw);
    }
    if (this.pending.length > MAX_PENDING_CHARS) this.pending = '';
  }

  private handleEvent(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    const e = event as Record<string, unknown>;
    if (e.type === 'message_start') {
      const message = e.message as Record<string, unknown> | undefined;
      this.startSeen = true;
      if (typeof message?.model === 'string') this.modelValue = message.model;
      this.usageValue = mergeUsage(this.usageValue, parseUsage(message?.usage));
    } else if (e.type === 'message_delta') {
      this.usageValue = mergeUsage(this.usageValue, parseUsage(e.usage));
    } else if (e.type === 'message_stop') {
      this.stopped = true;
    }
  }
}
