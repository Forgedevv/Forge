// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PriceUnavailableError } from './errors';
import {
  JUPITER_LITE_PRICE_URL,
  JUPITER_PRICE_URL,
  JupiterPriceSource,
  WSOL_MINT,
} from './price-source';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const OK = { [WSOL_MINT]: { usdPrice: 152.25, blockId: 1, decimals: 9 } };
const noSleep = async () => {};

function call(fetchImpl: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  return fetchImpl.mock.calls[index] as unknown as [string, RequestInit];
}

describe('JupiterPriceSource', () => {
  it('reads the SOL price from the keyed endpoint with the API key header', async () => {
    const fetchImpl = vi.fn(async () => response(OK));
    const source = new JupiterPriceSource({ apiKey: 'k', fetchImpl, sleep: noSleep });
    await expect(source.getSolUsdPrice()).resolves.toBe(152.25);
    const [url, init] = call(fetchImpl);
    expect(url).toBe(`${JUPITER_PRICE_URL}?ids=${WSOL_MINT}`);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('uses the free endpoint without a key', async () => {
    const fetchImpl = vi.fn(async () => response(OK));
    await new JupiterPriceSource({ fetchImpl, sleep: noSleep }).getSolUsdPrice();
    const [url, init] = call(fetchImpl);
    expect(url.startsWith(JUPITER_LITE_PRICE_URL)).toBe(true);
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('caches the price for a short time', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => response(OK));
    const source = new JupiterPriceSource({ fetchImpl, cacheMs: 1000, now: () => now });
    await source.getSolUsdPrice();
    now = 999;
    await source.getSolUsdPrice();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 1000;
    await source.getSolUsdPrice();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries network errors and bad statuses, then fails closed', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response(OK));
    const source = new JupiterPriceSource({ fetchImpl, sleep: noSleep });
    await expect(source.getSolUsdPrice()).resolves.toBe(152.25);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const down = new JupiterPriceSource({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      sleep: noSleep,
    });
    await expect(down.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it.each([
    ['a missing SOL entry', {}],
    ['a null SOL entry', { [WSOL_MINT]: null }],
    ['an insane price', { [WSOL_MINT]: { usdPrice: 0 } }],
    ['a malformed price', { [WSOL_MINT]: { usdPrice: '152' } }],
  ])('rejects %s', async (_label, body) => {
    const source = new JupiterPriceSource({
      fetchImpl: async () => response(body),
      sleep: noSleep,
    });
    await expect(source.getSolUsdPrice()).rejects.toBeInstanceOf(PriceUnavailableError);
  });
});
