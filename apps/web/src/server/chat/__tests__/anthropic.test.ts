// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createAnthropicStreamer,
  ModelError,
  type ModelEvent,
  type ModelRequest,
} from '../anthropic';

function sse(events: { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

function streamResponse(body: string, chunkSize = 17, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const TEXT_AND_TOOL = sse([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { id: 'm', usage: { input_tokens: 120, output_tokens: 1 } },
    },
  },
  { event: 'ping', data: { type: 'ping' } },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Nice ' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'name!' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_9', name: 'update_spec', input: {} },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"name":"Moo' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'nPad","tradingFeeBps":100}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 42 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-sonnet-5-5',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'update_spec', description: 'd', input_schema: { type: 'object' } }],
    maxTokens: 300,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('createAnthropicStreamer', () => {
  it('parses text, tool calls, usage and the stop reason (chunks split anywhere)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(streamResponse(TEXT_AND_TOOL, 7)));
    const stream = createAnthropicStreamer({ apiKey: 'k', apiUrl: 'https://x.test', fetchImpl });
    expect(await collect(stream(request()))).toEqual([
      { type: 'text', delta: 'Nice ' },
      { type: 'text', delta: 'name!' },
      {
        type: 'tool_use',
        id: 'toolu_9',
        name: 'update_spec',
        input: { name: 'MoonPad', tradingFeeBps: 100 },
        inputError: null,
      },
      { type: 'usage', inputTokens: 120, outputTokens: 42 },
      { type: 'stop', reason: 'tool_use' },
    ]);
  });

  it('sends the key and version as headers and a streaming request body', async () => {
    const fetchImpl = vi.fn((...args: [string, RequestInit]) => {
      void args;
      return Promise.resolve(streamResponse(TEXT_AND_TOOL));
    });
    const stream = createAnthropicStreamer({
      apiKey: 'secret-key-value',
      apiUrl: 'https://api.test/v1/messages',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await collect(stream(request()));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key-value');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 300,
      stream: true,
      system: 'sys',
      tool_choice: { type: 'auto' },
    });
    expect(JSON.stringify(body)).not.toContain('secret-key-value');
  });

  it('reports malformed tool JSON as an input error, not an exception', async () => {
    const bad = TEXT_AND_TOOL.replace('nPad\\",\\"tradingFeeBps\\":100}', 'nPad\\",\\"trad');
    const stream = createAnthropicStreamer({
      apiKey: 'k',
      apiUrl: 'https://x.test',
      fetchImpl: () => Promise.resolve(streamResponse(bad)),
    });
    const events = await collect(stream(request()));
    const tool = events.find((e) => e.type === 'tool_use');
    expect(tool).toMatchObject({ type: 'tool_use', inputError: expect.stringContaining('JSON') });
  });

  it('retries a busy provider, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 529 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(streamResponse(TEXT_AND_TOOL));
    const stream = createAnthropicStreamer({
      apiKey: 'k',
      apiUrl: 'https://x.test',
      fetchImpl,
      retryDelayMs: 1,
    });
    const events = await collect(stream(request()));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('gives up after the retries with a busy error that carries no provider body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('{"error":{"message":"leaky detail"}}', { status: 429 })),
    );
    const stream = createAnthropicStreamer({
      apiKey: 'k',
      apiUrl: 'https://x.test',
      fetchImpl,
      retries: 1,
      retryDelayMs: 1,
    });
    const err = await collect(stream(request())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('busy');
    expect((err as ModelError).message).not.toContain('leaky');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client error', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}', { status: 400 })));
    const stream = createAnthropicStreamer({ apiKey: 'k', apiUrl: 'https://x.test', fetchImpl });
    const err = await collect(stream(request())).catch((e: unknown) => e);
    expect((err as ModelError).kind).toBe('bad_request');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('turns a mid-stream error event into a ModelError', async () => {
    const body = sse([
      {
        event: 'error',
        data: { type: 'error', error: { type: 'overloaded_error', message: 'x' } },
      },
    ]);
    const stream = createAnthropicStreamer({
      apiKey: 'k',
      apiUrl: 'https://x.test',
      fetchImpl: () => Promise.resolve(streamResponse(body)),
    });
    const err = await collect(stream(request())).catch((e: unknown) => e);
    expect((err as ModelError).kind).toBe('busy');
  });

  it('fails when the stream ends without message_stop', async () => {
    const body = TEXT_AND_TOOL.split('event: message_stop')[0] ?? '';
    const stream = createAnthropicStreamer({
      apiKey: 'k',
      apiUrl: 'https://x.test',
      fetchImpl: () => Promise.resolve(streamResponse(body)),
    });
    const err = await collect(stream(request())).catch((e: unknown) => e);
    expect((err as ModelError).kind).toBe('protocol');
  });

  it('propagates an abort without retrying', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn(() => {
      ctrl.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const stream = createAnthropicStreamer({ apiKey: 'k', apiUrl: 'https://x.test', fetchImpl });
    await expect(collect(stream(request({ signal: ctrl.signal })))).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
