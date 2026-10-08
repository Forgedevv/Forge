// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGatingCheck, GatingError } from '../gating';
import { buildModelMessages } from '../history';
import { clientIp, MemoryRateLimiter } from '../rate-limit';
import { loadChatConfig, ChatConfigError, costUsd } from '../config';
import { WALLET } from './helpers';

describe('MemoryRateLimiter', () => {
  it('allows up to the limit inside the window, then reports when to retry', async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i++) expect((await limiter.consume('k', 3, 60_000)).allowed).toBe(true);
    now += 10_000;
    const blocked = await limiter.consume('k', 3, 60_000);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 50 });
    now += 50_001;
    expect((await limiter.consume('k', 3, 60_000)).allowed).toBe(true);
  });

  it('keeps keys independent', async () => {
    const limiter = new MemoryRateLimiter();
    await limiter.consume('a', 1, 1000);
    expect((await limiter.consume('a', 1, 1000)).allowed).toBe(false);
    expect((await limiter.consume('b', 1, 1000)).allowed).toBe(true);
  });

  it('hands out one in-flight slot per key, released once', async () => {
    const limiter = new MemoryRateLimiter();
    const release = await limiter.acquire('w');
    expect(release).not.toBeNull();
    expect(await limiter.acquire('w')).toBeNull();
    release!();
    release!();
    const again = await limiter.acquire('w');
    expect(again).not.toBeNull();
    expect(await limiter.acquire('w')).toBeNull();
  });
});

describe('clientIp', () => {
  it('prefers the first forwarded address, then x-real-ip, then unknown', () => {
    const req = (h: Record<string, string>) => new Request('https://x.test', { headers: h });
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientIp(req({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(req({}))).toBe('unknown');
  });
});

describe('buildModelMessages', () => {
  it('starts with a user turn, merges same-role turns and ends with the new message', () => {
    const out = buildModelMessages(
      [
        { role: 'assistant', content: 'orphan answer' },
        { role: 'user', content: 'q1' },
        { role: 'user', content: 'q1b' },
        { role: 'assistant', content: 'a1' },
        { role: 'assistant', content: '   ' },
      ],
      'q2',
      10_000,
    );
    expect(out).toEqual([
      { role: 'user', content: 'q1\n\nq1b' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('keeps the most recent turns that fit the budget', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `${i}`.padEnd(30, 'x'),
    }));
    const out = buildModelMessages(history, 'now', 40);
    expect(out.at(-1)).toEqual({ role: 'user', content: 'now' });
    expect(out.length).toBeLessThan(history.length);
    expect(JSON.stringify(out)).not.toContain('0xxx');
  });
});

describe('loadChatConfig', () => {
  it('requires the API key and never echoes it', () => {
    expect(() => loadChatConfig({})).toThrow(ChatConfigError);
    const cfg = loadChatConfig({ ANTHROPIC_API_KEY: 'k' });
    expect(cfg.model).toBe('claude-sonnet-5-5');
    expect(cfg.limits.maxOutputTokens).toBeLessThanOrEqual(2000);
  });

  it('accepts numeric overrides and ignores invalid ones', () => {
    const cfg = loadChatConfig({
      ANTHROPIC_API_KEY: 'k',
      CHAT_CONVERSATION_COST_CAP_USD: '0.25',
      CHAT_WALLET_MESSAGES_PER_DAY: 'abc',
    });
    expect(cfg.limits.conversationCostCapUsd).toBe(0.25);
    expect(cfg.limits.walletPerDay).toBe(150);
  });

  it('prices tokens per million', () => {
    expect(costUsd(1_000_000, 1_000_000)).toBe(12);
  });
});

describe('createGatingCheck', () => {
  const rpc = (amounts: string[]) =>
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: amounts.map((amount) => ({
              account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
            })),
          },
        }),
      ),
    );

  it('is disabled without FORGE_MINT', async () => {
    const fetchImpl = vi.fn();
    const check = createGatingCheck({}, fetchImpl as never);
    expect(await check(WALLET)).toEqual({ enabled: false, ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const env = {
    FORGE_MINT: 'ES4otaE7FckJGJEKwpk3noaCZBt4FQZhuhWqUDdhuBEF',
    FORGE_GATING_AMOUNT: '1000',
    RPC_URL: 'https://rpc.devnet.example',
  };

  it('sums token accounts against the required amount and caches the balance', async () => {
    let now = 0;
    const fetchImpl = rpc(['400', '600']);
    const check = createGatingCheck(env, fetchImpl as never, () => now);
    expect(await check(WALLET)).toEqual({ enabled: true, ok: true });
    await check(WALLET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 31_000;
    await check(WALLET);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a short balance', async () => {
    const check = createGatingCheck(env, rpc(['999']) as never);
    expect(await check(WALLET)).toEqual({ enabled: true, ok: false });
  });

  it('fails closed when the RPC fails', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('x', { status: 500 })));
    await expect(createGatingCheck(env, fetchImpl as never)(WALLET)).rejects.toBeInstanceOf(
      GatingError,
    );
    const err = vi.fn(() => Promise.resolve(Response.json({ error: { code: -1 } })));
    await expect(createGatingCheck(env, err as never)(WALLET)).rejects.toBeInstanceOf(GatingError);
  });
});
