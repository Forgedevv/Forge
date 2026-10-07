import { CLIENT_ERROR_CODES, type ChatStreamEvent } from '@forge/shared';
import { z } from 'zod';

const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), conversationId: z.string().min(1) }),
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({
    type: z.literal('spec'),
    spec: z.record(z.string(), z.unknown()),
    validation: z.object({
      complete: z.boolean(),
      errors: z.record(z.string(), z.string()),
    }),
  }),
  z.object({
    type: z.literal('error'),
    code: z.enum(CLIENT_ERROR_CODES),
    message: z.string(),
  }),
  z.object({ type: z.literal('done') }),
]);

/** Parses one `data:` payload. Returns null for malformed or unknown events. */
export function parseChatEvent(payload: string): ChatStreamEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = EventSchema.safeParse(json);
  return parsed.success ? (parsed.data as ChatStreamEvent) : null;
}

const SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

/**
 * Incremental text/event-stream parser: feed it arbitrary chunks (split anywhere, even
 * mid-line) and it returns the complete events found so far.
 */
export class ChatStreamParser {
  private buffer = '';

  push(chunk: string): ChatStreamEvent[] {
    this.buffer += chunk;
    const events: ChatStreamEvent[] = [];
    for (;;) {
      const match = SEPARATOR.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const ev = this.parseBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Flushes a trailing event that was not terminated by a blank line. */
  end(): ChatStreamEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    if (!rest.trim()) return [];
    const ev = this.parseBlock(rest);
    return ev ? [ev] : [];
  }

  private parseBlock(block: string): ChatStreamEvent | null {
    const data: string[] = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) return null;
    return parseChatEvent(data.join('\n'));
  }
}

/** Reads a fetch body and yields the chat events in order. */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new ChatStreamParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.end();
  } finally {
    reader.releaseLock();
  }
}
