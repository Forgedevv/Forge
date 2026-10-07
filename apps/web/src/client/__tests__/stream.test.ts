import type { ChatStreamEvent } from '@forge/shared';
import { describe, expect, it } from 'vitest';
import { ChatStreamParser, parseChatEvent, readChatStream } from '../stream';

const ID = '3f9c1e2a-5b7d-4c8e-9a1b-2d3e4f5a6b7c';
const line = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe('ChatStreamParser', () => {
  it('parses multiple events in one chunk', () => {
    const p = new ChatStreamParser();
    const events = p.push(
      line({ type: 'conversation', conversationId: ID }) +
        line({ type: 'text', delta: 'Hel' }) +
        line({ type: 'text', delta: 'lo' }) +
        line({ type: 'done' }),
    );
    expect(events.map((e) => e.type)).toEqual(['conversation', 'text', 'text', 'done']);
  });

  it('handles chunks split mid-line and mid-separator', () => {
    const full = line({ type: 'text', delta: 'abc' }) + line({ type: 'done' });
    for (let cut = 1; cut < full.length; cut++) {
      const p = new ChatStreamParser();
      const events = [...p.push(full.slice(0, cut)), ...p.push(full.slice(cut)), ...p.end()];
      expect(events).toEqual([{ type: 'text', delta: 'abc' }, { type: 'done' }]);
    }
  });

  it('supports CRLF separators and ignores comments and unknown events', () => {
    const p = new ChatStreamParser();
    const events = p.push(
      ': keep-alive\r\n\r\n' +
        'data: {"type":"nope"}\r\n\r\n' +
        'data: not json\r\n\r\n' +
        'data: {"type":"text","delta":"x"}\r\n\r\n',
    );
    expect(events).toEqual([{ type: 'text', delta: 'x' }]);
  });

  it('flushes a last event with no trailing blank line', () => {
    const p = new ChatStreamParser();
    expect(p.push('data: {"type":"done"}\n')).toEqual([]);
    expect(p.end()).toEqual([{ type: 'done' }]);
  });

  it('parses spec and error events', () => {
    const p = new ChatStreamParser();
    const events = p.push(
      line({
        type: 'spec',
        spec: { name: 'Acme' },
        validation: { complete: false, errors: { slug: 'Required' } },
      }) + line({ type: 'error', code: 'RATE_LIMITED', message: 'Slow down' }),
    );
    expect(events[0]).toMatchObject({ type: 'spec', spec: { name: 'Acme' } });
    expect(events[1]).toEqual({ type: 'error', code: 'RATE_LIMITED', message: 'Slow down' });
  });

  it('rejects an error event with an unknown code', () => {
    expect(parseChatEvent('{"type":"error","code":"BOOM","message":"x"}')).toBeNull();
  });
});

describe('readChatStream', () => {
  it('reads events from a byte stream split at arbitrary points', async () => {
    const text =
      line({ type: 'conversation', conversationId: ID }) +
      line({ type: 'text', delta: 'héllo' }) +
      line({ type: 'done' });
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const out: ChatStreamEvent[] = [];
    for await (const ev of readChatStream(body)) out.push(ev);
    expect(out).toEqual([
      { type: 'conversation', conversationId: ID },
      { type: 'text', delta: 'héllo' },
      { type: 'done' },
    ]);
  });
});
