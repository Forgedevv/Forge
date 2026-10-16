// @vitest-environment node
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createGatingCheck, GatingError, type BalanceReader } from '../gating';
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
  const req = (h: Record<string, string>) => new Request('https://x.test', { headers: h });

  it('prefers x-vercel-forwarded-for, then x-real-ip, then the LAST x-forwarded-for entry', () => {
    expect(
      clientIp(
        req({
          'x-vercel-forwarded-for': '2001:db8::1',
          'x-real-ip': '9.9.9.9',
          'x-forwarded-for': '1.2.3.4',
        }),
      ),
    ).toBe('2001:db8:0:0::/64');
    expect(clientIp(req({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' }))).toBe('9.9.9.9');
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('5.6.7.8');
    expect(clientIp(req({}))).toBe('unknown');
  });

  it('cannot be steered by a client-supplied first x-forwarded-for entry', () => {
    const a = clientIp(req({ 'x-forwarded-for': '6.6.6.1, 203.0.113.9' }));
    const b = clientIp(req({ 'x-forwarded-for': '6.6.6.2, 203.0.113.9' }));
    expect(a).toBe('203.0.113.9');
    expect(b).toBe(a);
  });

  it('buckets IPv6 clients by /64 and IPv4-mapped addresses as IPv4', () => {
    const v6 = (value: string) => clientIp(req({ 'x-real-ip': value }));
    expect(v6('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    // Any address of the same /64 shares the bucket, whatever its spelling.
    expect(v6('2001:0DB8:00aa:00bb:ffff:ffff:ffff:ffff')).toBe('2001:db8:aa:bb::/64');
    expect(v6('2001:db8:aa:bb::9')).toBe('2001:db8:aa:bb::/64');
    expect(v6('2001:db8:aa:bc::9')).toBe('2001:db8:aa:bc::/64');
    expect(v6('::1')).toBe('0:0:0:0::/64');
    expect(v6('::')).toBe('0:0:0:0::/64');
    expect(v6('fe80::1:2:3:4')).toBe('fe80:0:0:0::/64');
    expect(v6('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(v6('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(v6('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2001:db8::1:2' }))).toBe(
      '2001:db8:0:0::/64',
    );
  });

  it('ignores values that are not IP addresses', () => {
    expect(clientIp(req({ 'x-real-ip': '2001:db8::1::2' }))).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': '1.2.3.256' }))).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': 'fe80::1%eth0' }))).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': '::ffff:1.2.3' }))).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': 'evil<script>' }))).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': 'x'.repeat(100), 'x-forwarded-for': '7.7.7.7' }))).toBe(
      '7.7.7.7',
    );
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
  const MINT = Keypair.generate().publicKey;
  const balanceOf = (raw: bigint) =>
    vi.fn<BalanceReader>(() =>
      Promise.resolve({
        enabled: true,
        mint: MINT,
        tokenAccount: PublicKey.unique(),
        tokenProgram: PublicKey.unique(),
        balance: raw,
        decimals: 6,
      }),
    );

  it('is disabled without FORGE_MINT', async () => {
    const read = balanceOf(0n);
    const check = createGatingCheck({}, read);
    expect(await check(WALLET)).toEqual({ enabled: false, ok: true, required: 0n, balance: 0n });
    expect(read).not.toHaveBeenCalled();
  });

  const env = {
    FORGE_MINT: MINT.toBase58(),
    FORGE_GATING_AMOUNT: '1000',
    RPC_URL: 'https://rpc.devnet.example',
  };

  it('compares the core balance with the required amount and caches it', async () => {
    let now = 0;
    const read = balanceOf(1000n);
    const check = createGatingCheck(env, read, () => now);
    expect(await check(WALLET)).toEqual({
      enabled: true,
      ok: true,
      required: 1000n,
      balance: 1000n,
      decimals: 6,
    });
    await check(WALLET);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual(new PublicKey(WALLET));
    now += 31_000;
    await check(WALLET);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses a short balance', async () => {
    const check = createGatingCheck(env, balanceOf(999n));
    expect(await check(WALLET)).toEqual({
      enabled: true,
      ok: false,
      required: 1000n,
      balance: 999n,
      decimals: 6,
    });
  });

  it('requires nothing (and reads nothing) when FORGE_GATING_AMOUNT is 0', async () => {
    const read = balanceOf(0n);
    const check = createGatingCheck({ ...env, FORGE_GATING_AMOUNT: '0' }, read);
    expect(await check(WALLET)).toEqual({ enabled: true, ok: true, required: 0n, balance: 0n });
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed when FORGE_GATING_AMOUNT is missing', async () => {
    const check = createGatingCheck({ ...env, FORGE_GATING_AMOUNT: undefined }, balanceOf(1n));
    await expect(check(WALLET)).rejects.toThrow('FORGE_GATING_AMOUNT is not configured');
  });

  it('fails closed when the RPC fails, without echoing the error', async () => {
    const read = vi.fn(() => Promise.reject(new Error('https://rpc/?api-key=SECRET down')));
    const error = await createGatingCheck(env, read)(WALLET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatingError);
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('reads the balance through getForgeBalance of @forge/core by default', async () => {
    // The core asks for the mint and both possible token accounts in one call.
    const getMultipleAccountsInfo = vi.fn(() => Promise.resolve([null, null, null]));
    vi.spyOn(Connection.prototype, 'getMultipleAccountsInfo').mockImplementation(
      getMultipleAccountsInfo as never,
    );
    try {
      // Unknown mint: a configuration error, reported as a gating failure (fail closed).
      await expect(createGatingCheck(env)(WALLET)).rejects.toThrow('FORGE_MINT: mint_not_found');
      expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      const [keys] = getMultipleAccountsInfo.mock.calls[0] as unknown as [PublicKey[]];
      expect(keys[0]?.equals(MINT)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('fails closed on an invalid FORGE_MINT', async () => {
    await expect(createGatingCheck({ ...env, FORGE_MINT: 'nope' })(WALLET)).rejects.toThrow(
      'FORGE_MINT is invalid',
    );
  });
});
