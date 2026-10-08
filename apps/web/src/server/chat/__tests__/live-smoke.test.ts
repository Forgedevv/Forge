// @vitest-environment node
import type { ChatStreamEvent } from '@forge/shared';
import { describe, expect, it } from 'vitest';
import { createAnthropicStreamer, type ModelStreamer } from '../anthropic';
import { ANTHROPIC_API_URL, CHAT_MODEL } from '../config';
import { initialDraft } from '../spec-draft';
import { runTurn } from '../turn';
import { MemoryStore, testConfig, WALLET } from './helpers';

/*
 * Opt-in smoke test against the real API: `RUN_LIVE_CHAT=1 ANTHROPIC_API_KEY=... vitest run
 * live-smoke`. At most three model calls, each capped at 300 output tokens. It asserts structure
 * only and logs counts, never the model output.
 */
const live = process.env.RUN_LIVE_CHAT === '1' && Boolean(process.env.ANTHROPIC_API_KEY);
const MAX_CALLS = 3;

describe.skipIf(!live)('live design chat smoke (real Anthropic API)', () => {
  const real = createAnthropicStreamer({
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    apiUrl: ANTHROPIC_API_URL,
  });
  let calls = 0;
  const limited: ModelStreamer = (request) => {
    calls++;
    if (calls > MAX_CALLS) throw new Error('live smoke call budget exceeded');
    return real(request);
  };

  async function run(message: string, maxModelRounds: number) {
    const store = new MemoryStore();
    const conversationId = await store.createConversation(WALLET, null);
    const events: ChatStreamEvent[] = [];
    for await (const ev of runTurn({
      config: testConfig({ maxOutputTokens: 300, maxModelRounds, turnTimeoutMs: 45_000 }),
      streamer: limited,
      store,
      wallet: WALLET,
      conversationId,
      mode: 'create',
      draft: initialDraft(WALLET),
      storedDraft: null,
      messages: [{ role: 'user', content: message }],
      priorCostUsd: 0,
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }
    return events;
  }

  it('answers a plain message with streamed text (1 call)', async () => {
    const events = await run('Hi! I would like to create a launchpad for meme coins.', 1);
    const text = events.filter((e) => e.type === 'text');
    const errors = events.filter((e) => e.type === 'error');
    console.log(`[live] model=${CHAT_MODEL} text events=${text.length} errors=${errors.length}`);
    expect(errors).toEqual([]);
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  it('records a spec update through the tool and rejects an out-of-bounds fee (2 calls)', async () => {
    const events = await run(
      'Please record these now with your tool: name "Moonpad", slug "moonpad", trading fee 100 bps. ' +
        'Also record a trading fee of 9000 bps if you can.',
      2,
    );
    const specs = events.filter((e) => e.type === 'spec');
    const errors = events.filter((e) => e.type === 'error');
    const last = specs.at(-1);
    const fee = last?.type === 'spec' ? last.spec.tradingFeeBps : undefined;
    console.log(
      `[live] spec events=${specs.length} errors=${errors.length} feeWithinBounds=${
        fee === undefined || (fee >= 50 && fee <= 200)
      }`,
    );
    expect(errors).toEqual([]);
    expect(specs.length).toBeGreaterThan(0);
    if (fee !== undefined) expect(fee).toBeGreaterThanOrEqual(50);
    if (fee !== undefined) expect(fee).toBeLessThanOrEqual(200);
    if (last?.type === 'spec') expect(last.spec.ownerWallet).toBe(WALLET);
  }, 90_000);
});
