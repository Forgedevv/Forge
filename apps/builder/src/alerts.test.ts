/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { createAlerter, sanitizeDetails } from './alerts.js';

const TOKEN = '123456:SECRET-BOT-TOKEN';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function okFetch() {
  return vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
}

describe('createAlerter', () => {
  it('calls the Telegram sendMessage endpoint with the expected shape', async () => {
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '-100',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
      minIntervalMs: 1000,
    });
    await alerter.alert('high', 'RPC_ERRORS', 'Repeated RPC errors', { count: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.chat_id).toBe('-100');
    expect(body.text).toContain('RPC_ERRORS');
    expect(body.text).toContain('Repeated RPC errors');
    expect(body.text).toContain('count: 5');
  });

  it('is a log-only no-op when unconfigured', async () => {
    const fetchMock = okFetch();
    const logger = makeLogger();
    const alerter = createAlerter({
      fetch: fetchMock as unknown as typeof fetch,
      logger,
      minIntervalMs: 1000,
    });
    await alerter.alert('normal', 'X', 'hello');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('deduplicates identical codes within the interval', async () => {
    let t = 0;
    const fetchMock = okFetch();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger: makeLogger(),
      minIntervalMs: 1000,
      now: () => t,
    });
    await alerter.alert('high', 'A', 'm');
    t = 500;
    await alerter.alert('high', 'A', 'm');
    await alerter.alert('high', 'B', 'm');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    t = 1500;
    await alerter.alert('high', 'A', 'm');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('drops sensitive detail keys', async () => {
    const fetchMock = okFetch();
    const logger = makeLogger();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: fetchMock as unknown as typeof fetch,
      logger,
      minIntervalMs: 0,
    });
    await alerter.alert('high', 'A', 'm', {
      jobId: 'j1',
      apiKey: 'sk-1',
      client_secret: 'abc',
      nested: { privateKey: 'pk', ok: 'fine' },
      passphrase: 'pp',
      authToken: 't',
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const text = (JSON.parse(init.body as string) as { text: string }).text;
    for (const leaked of ['sk-1', 'abc', 'pk', 'pp', 'apiKey', 'authToken']) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('jobId: j1');
    expect(text).toContain('fine');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sk-1');
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
      minIntervalMs: 0,
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

  it('logs a non-2xx status without throwing', async () => {
    const logger = makeLogger();
    const alerter = createAlerter({
      botToken: TOKEN,
      chatId: '1',
      fetch: (async () => new Response('no', { status: 400 })) as unknown as typeof fetch,
      logger,
      minIntervalMs: 0,
    });
    await alerter.alert('normal', 'A', 'm');
    expect(logger.error).toHaveBeenCalledWith({ code: 'A', status: 400 }, expect.any(String));
  });
});

describe('sanitizeDetails', () => {
  it('truncates long values', () => {
    expect(sanitizeDetails({ a: 'x'.repeat(1000) }).a?.length).toBeLessThan(400);
  });
});
