import { ANTHROPIC_VERSION } from './config';

/*
 * Minimal streaming client for the Anthropic Messages API (fetch based: no SDK dependency).
 * It turns the provider event stream into a small set of `ModelEvent`s. The API key is only
 * sent in the request header and never appears in errors or logs.
 */

export type ModelRole = 'user' | 'assistant';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ModelMessage {
  role: ModelRole;
  content: string | ContentBlock[];
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  maxTokens: number;
  signal: AbortSignal;
}

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; inputError: string | null }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'stop'; reason: string };

/** Provider call. Tests replace it; production uses `createAnthropicStreamer`. */
export type ModelStreamer = (request: ModelRequest) => AsyncIterable<ModelEvent>;

export type ModelErrorKind = 'busy' | 'auth' | 'bad_request' | 'unavailable' | 'protocol';

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | undefined;

  constructor(kind: ModelErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
  }
}

function kindForStatus(status: number): ModelErrorKind {
  if (status === 429 || status === 529) return 'busy';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'unavailable';
}

interface SseFrame {
  event: string;
  data: string;
}

/** Splits a text/event-stream body into frames. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (block: string): SseFrame | null => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length === 0 ? null : { event, data: data.join('\n') };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        if (!match) break;
        const frame = emit(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      const frame = emit(buffer);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface OpenBlock {
  kind: 'text' | 'tool_use' | 'other';
  id: string;
  name: string;
  json: string;
}

/** Converts provider frames to model events. Exported for tests. */
export async function* parseAnthropicStream(
  frames: AsyncIterable<SseFrame>,
): AsyncGenerator<ModelEvent> {
  const blocks = new Map<number, OpenBlock>();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';
  let finished = false;

  for await (const frame of frames) {
    if (frame.event === 'ping') continue;
    let payload: Json | null;
    try {
      payload = asObject(JSON.parse(frame.data));
    } catch {
      throw new ModelError('protocol', 'Malformed event from the model provider.');
    }
    if (!payload) continue;
    const type = payload.type;

    if (type === 'message_start') {
      const usage = asObject(asObject(payload.message)?.usage);
      inputTokens +=
        num(usage?.input_tokens) +
        num(usage?.cache_creation_input_tokens) +
        num(usage?.cache_read_input_tokens);
      outputTokens += num(usage?.output_tokens);
    } else if (type === 'content_block_start') {
      const index = num(payload.index);
      const block = asObject(payload.content_block);
      const kind =
        block?.type === 'text' ? 'text' : block?.type === 'tool_use' ? 'tool_use' : 'other';
      blocks.set(index, {
        kind,
        id: typeof block?.id === 'string' ? block.id : '',
        name: typeof block?.name === 'string' ? block.name : '',
        json: '',
      });
      if (kind === 'text' && typeof block?.text === 'string' && block.text !== '') {
        yield { type: 'text', delta: block.text };
      }
    } else if (type === 'content_block_delta') {
      const open = blocks.get(num(payload.index));
      const delta = asObject(payload.delta);
      if (!open || !delta) continue;
      if (delta.type === 'text_delta' && open.kind === 'text' && typeof delta.text === 'string') {
        if (delta.text !== '') yield { type: 'text', delta: delta.text };
      } else if (
        delta.type === 'input_json_delta' &&
        open.kind === 'tool_use' &&
        typeof delta.partial_json === 'string'
      ) {
        open.json += delta.partial_json;
        // A tool input is a small spec patch: refuse absurd sizes.
        if (open.json.length > 64_000) {
          throw new ModelError('protocol', 'Tool input too large.');
        }
      }
    } else if (type === 'content_block_stop') {
      const index = num(payload.index);
      const open = blocks.get(index);
      blocks.delete(index);
      if (open?.kind === 'tool_use') {
        let input: unknown = {};
        let inputError: string | null = null;
        if (open.json.trim() !== '') {
          try {
            input = JSON.parse(open.json) as unknown;
          } catch {
            inputError = 'The tool input was not valid JSON.';
          }
        }
        yield { type: 'tool_use', id: open.id, name: open.name, input, inputError };
      }
    } else if (type === 'message_delta') {
      const delta = asObject(payload.delta);
      if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
      const usage = asObject(payload.usage);
      // message_delta usage is cumulative for output tokens.
      if (usage && typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
      if (usage && typeof usage.input_tokens === 'number' && usage.input_tokens > 0) {
        inputTokens = Math.max(inputTokens, usage.input_tokens);
      }
    } else if (type === 'message_stop') {
      finished = true;
    } else if (type === 'error') {
      const err = asObject(payload.error);
      const errType = typeof err?.type === 'string' ? err.type : '';
      const busy = errType === 'overloaded_error' || errType === 'rate_limit_error';
      throw new ModelError(busy ? 'busy' : 'unavailable', `Provider stream error (${errType}).`);
    }
  }

  yield { type: 'usage', inputTokens, outputTokens };
  if (!finished) throw new ModelError('protocol', 'The model stream ended unexpectedly.');
  yield { type: 'stop', reason: stopReason };
}

export interface AnthropicClientOptions {
  apiKey: string;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  /** Extra attempts for a failure that happens before any event (429, 5xx, network). */
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createAnthropicStreamer(options: AnthropicClientOptions): ModelStreamer {
  const doFetch = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 400;

  async function connect(request: ModelRequest): Promise<Response> {
    const body = JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens,
      stream: true,
      system: request.system,
      messages: request.messages,
      ...(request.tools.length > 0 ? { tools: request.tools, tool_choice: { type: 'auto' } } : {}),
    });
    for (let attempt = 0; ; attempt++) {
      let failure: ModelError;
      try {
        const res = await doFetch(options.apiUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body,
          signal: request.signal,
        });
        if (res.ok && res.body) return res;
        // Drain so the connection is released; the body is never forwarded to the client.
        await res.body?.cancel().catch(() => undefined);
        failure = res.ok
          ? new ModelError('protocol', 'Empty response from the model provider.')
          : new ModelError(kindForStatus(res.status), `Provider error ${res.status}.`, res.status);
      } catch (error) {
        if (request.signal.aborted) throw error;
        failure = new ModelError('unavailable', 'Could not reach the model provider.');
      }
      const retryable = failure.kind === 'busy' || failure.kind === 'unavailable';
      if (!retryable || attempt >= retries) throw failure;
      await sleep(retryDelayMs * 2 ** attempt, request.signal);
      if (request.signal.aborted) throw failure;
    }
  }

  return async function* stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const response = await connect(request);
    yield* parseAnthropicStream(readSse(response.body as ReadableStream<Uint8Array>));
  };
}
