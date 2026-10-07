import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING } from './config.js';
import { assertValidPricing, computeCostUsd, mergeUsage, parseUsage } from './pricing.js';
import { SseUsageReader } from './sse.js';

const PRICE = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, cacheWrite1hPerMTok: 6 };

describe('pricing', () => {
  it('computes cost from every usage field', () => {
    const usage = parseUsage({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    });
    expect(computeCostUsd(usage, PRICE)).toBeCloseTo(3 + 15 + 0.3 + 3.75 + 6, 10);
  });

  it('treats missing or invalid fields as zero', () => {
    expect(parseUsage(undefined)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(parseUsage({ input_tokens: -5, output_tokens: 'x' })).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('merges cumulative snapshots by max', () => {
    const merged = mergeUsage(parseUsage({ input_tokens: 10, output_tokens: 1 }), parseUsage({ output_tokens: 7 }));
    expect(merged).toMatchObject({ inputTokens: 10, outputTokens: 7 });
  });

  it('ships a valid default table', () => {
    expect(() => assertValidPricing(DEFAULT_PRICING, Object.keys(DEFAULT_PRICING))).not.toThrow();
  });
});

describe('SseUsageReader', () => {
  it('reads usage from message_start and message_delta across chunk boundaries', () => {
    const reader = new SseUsageReader();
    const text =
      'event: message_start\r\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":3,"output_tokens":1}}}\r\n\r\n' +
      'event: ping\ndata: {"type":"ping"}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 9) reader.push(bytes.slice(i, i + 9));
    reader.end();
    expect(reader.model).toBe('m');
    expect(reader.complete).toBe(true);
    expect(reader.usage).toMatchObject({ inputTokens: 5, cacheReadInputTokens: 3, outputTokens: 42 });
  });

  it('keeps input usage when the stream is cut before message_delta', () => {
    const reader = new SseUsageReader();
    reader.push(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\ndata: {"type":"content_bl'));
    reader.end();
    expect(reader.complete).toBe(false);
    expect(reader.usage.inputTokens).toBe(9);
  });
});
