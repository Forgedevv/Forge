/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { createAlerter, createAlerterFromEnv, sanitizeDetails, scrubSecrets } from './alerts.js';

const TOKEN = '123456789:AAEhBP0av28KpBMGhS3sIEXAMPLEtokenvalue_xyz';
const SIGNATURE = '5'.repeat(44) + '4'.repeat(44);

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function okFetch() {
  return vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
}

function bodyOf(
  fetchMock: ReturnType<typeof okFetch>,
  call = 0,
): { text: string; chat_id: string } {
  const init = (fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1];
  return JSON.parse(init.body as string) as { text: string; chat_id: string };
}

describe('createAlerter', () => {
  it('calls the Telegram sendMessage endpoint with the expected shape', async () => {
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '-100',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
    });
    await alerter.alert('high', 'LOW_BALANCE', 'Low balance', { balance: '0.1 SOL' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    const body = bodyOf(fetchMock);
    expect(body.chat_id).toBe('-100');
    expect(body.text).toContain('[HIGH] LOW_BALANCE');
    expect(body.text).toContain('balance: 0.1 SOL');
  });

  it('is a log-only no-op when unconfigured', async () => {
    const fetchMock = okFetch();
    const logger = makeLogger();
    const alerter = createAlerter({ fetch: fetchMock as unknown as typeof fetch, logger });
    await alerter.alert('normal', 'X', 'hello');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when only one of token and chat id is set', async () => {
    const fetchMock = okFetch();
    const alerter = createAlerterFromEnv(
      makeLogger(),
      { TELEGRAM_BOT_TOKEN: TOKEN },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await alerter.alert('high', 'X', 'hello');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the bot from the environment', async () => {
    const fetchMock = okFetch();
    const alerter = createAlerterFromEnv(
      makeLogger(),
      { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await alerter.alert('high', 'X', 'hello');
    expect(bodyOf(fetchMock).chat_id).toBe('42');
  });

  it('deduplicates identical alerts within the level window', async () => {
    let t = 1_000_000;
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
      minIntervalMs: { high: 1000 },
      now: () => t,
    });
    await alerter.alert('high', 'A', 'm');
    t += 500;
    await alerter.alert('high', 'A', 'm');
    await alerter.alert('high', 'B', 'm');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    t += 1000;
    await alerter.alert('high', 'A', 'm');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps separate dedup keys for the same code', async () => {
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
    });
    await alerter.alert('high', 'LOW_BALANCE', 'a', {}, { dedupKey: 'low:walletA' });
    await alerter.alert('high', 'LOW_BALANCE', 'b', {}, { dedupKey: 'low:walletB' });
    await alerter.alert('high', 'LOW_BALANCE', 'a again', {}, { dedupKey: 'low:walletA' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a shorter window for immediate alerts than for normal ones', async () => {
    let t = 1_000_000;
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
      minIntervalMs: { immediate: 1000, normal: 100_000 },
      now: () => t,
    });
    await alerter.alert('immediate', 'I', 'm');
    await alerter.alert('normal', 'N', 'm');
    t += 2000;
    await alerter.alert('immediate', 'I', 'm');
    await alerter.alert('normal', 'N', 'm');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caps non-immediate messages per window, exempts immediate ones, and reports the count', async () => {
    let t = 1_000_000;
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
      maxPerWindow: 2,
      windowMs: 10_000,
      now: () => t,
    });
    await alerter.alert('high', 'A', 'm');
    await alerter.alert('high', 'B', 'm');
    await alerter.alert('high', 'C', 'm'); // capped
    await alerter.alert('normal', 'D', 'm'); // capped
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await alerter.alert('immediate', 'E', 'm'); // exempt, carries the suppressed count
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchMock, 2).text).toContain('2 other alerts suppressed');
    t += 11_000;
    await alerter.alert('high', 'C', 'm'); // the capped alert was not marked as sent
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(bodyOf(fetchMock, 3).text).not.toContain('suppressed');
  });

  it('drops sensitive detail keys and scrubs tokens and key arrays', async () => {
    const fetchMock = okFetch();
    const logger = makeLogger();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger,
    });
    const secretArray = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
    await alerter.alert('high', 'A', `see ${TOKEN}`, {
      account: 'So11111111111111111111111111111111111111112',
      signature: SIGNATURE,
      apiKey: 'sk-1',
      client_secret: 'abc',
      nested: { privateKey: 'pk', ok: 'fine' },
      passphrase: 'pp',
      authToken: 't',
      leak: secretArray,
      amount: 5n,
    });
    const text = bodyOf(fetchMock).text;
    for (const leaked of ['sk-1', 'abc', 'pk', 'pp', 'apiKey', 'authToken', TOKEN]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).not.toContain('[0,1,2,3');
    expect(text).toContain('account: So11111111111111111111111111111111111111112');
    expect(text).toContain(`signature: ${SIGNATURE}`);
    expect(text).toContain('fine');
    expect(text).toContain('amount: 5');
    const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls]);
    expect(logged).not.toContain('sk-1');
    expect(logged).not.toContain(TOKEN);
  });

  it('never throws and never logs the token or URL on failure', async () => {
    const logger = makeLogger();
    const failing = vi.fn(async () => {
      throw new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: failing as unknown as typeof fetch,
      logger,
    });
    await expect(alerter.alert('immediate', 'A', 'm')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('api.telegram.org');
  });

  it('logs a failed Telegram status without the token', async () => {
    const logger = makeLogger();
    const bad = vi.fn(async () => new Response('nope', { status: 429 }));
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: bad as unknown as typeof fetch,
      logger,
    });
    await alerter.alert('high', 'A', 'm');
    expect(logger.error).toHaveBeenCalledWith({ code: 'A', status: 429 }, 'telegram alert failed');
  });

  it('truncates long values and messages', async () => {
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
    });
    await alerter.alert('high', 'A', 'x'.repeat(5000), { big: 'y'.repeat(1000) });
    expect(bodyOf(fetchMock).text.length).toBeLessThanOrEqual(3000);
  });
});

describe('sanitizeDetails / scrubSecrets', () => {
  it('drops values nested past the depth limit instead of leaking them', () => {
    const out = sanitizeDetails({ deep: { a: { b: { c: { d: { secret: 'x' } } } } } });
    expect(out.deep).not.toContain('"x"');
  });

  it('leaves public keys and signatures untouched', () => {
    const pubkey = 'So11111111111111111111111111111111111111112';
    expect(scrubSecrets(`${pubkey} ${SIGNATURE}`)).toBe(`${pubkey} ${SIGNATURE}`);
  });
});
