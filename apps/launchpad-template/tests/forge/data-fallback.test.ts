import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = () => Promise<unknown>;
const http = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));
vi.mock('ky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ky')>();
  return { ...actual, default: { post: http.post, get: http.get } };
});

const state = vi.hoisted(() => ({
  cluster: 'mainnet-beta' as string,
  onchain: undefined as { launchpadConfig?: string } | undefined,
}));
vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
  get cluster() {
    return state.cluster;
  },
}));

import { HTTPError } from 'ky';
import { ApeClient } from '../../src/forge/data/client';
import {
  DataUnavailableError,
  JUPITER_COOLDOWN_MS,
  JUPITER_TIMEOUT_MS,
  primarySource,
  resetDataSource,
} from '../../src/forge/data/source';
import { dbcPoolAddress } from '../../src/forge/tx/programs';

const key = () => Keypair.generate().publicKey.toBase58();
const USERS = key();
const pool = (mint = key()) => ({ id: dbcPoolAddress(USERS, mint), baseAsset: { id: mint } });

const reply = (body: unknown): { json: Answer } => ({ json: async () => body });
const failWith = (error: unknown): { json: Answer } => ({
  json: async () => {
    throw error;
  },
});
const networkError = () => new TypeError('Failed to fetch');
const timeoutError = () => Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
const httpError = (status: number) =>
  new HTTPError(
    new Response(null, { status }),
    new Request('https://datapi.jup.ag/x'),
    {} as never,
  );

const REQ = { recent: { timeframe: '24h' as const }, graduated: { timeframe: '24h' as const } };

/** `/api/coins` answers: the lists, or one coin for `?mint=`. */
function serveChain(lists: Record<string, unknown>, coin?: unknown) {
  http.get.mockImplementation((url: string, options?: { searchParams?: { mint?: string } }) => {
    if (url !== '/api/coins') return failWith(networkError());
    return reply(options?.searchParams?.mint ? coin : lists);
  });
}

const chainCalls = () => http.get.mock.calls.filter(([url]) => url === '/api/coins');

let debug: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.cluster = 'mainnet-beta';
  state.onchain = { launchpadConfig: USERS };
  resetDataSource();
  debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});
afterEach(() => {
  http.post.mockReset();
  http.get.mockReset();
  debug.mockRestore();
  vi.useRealTimers();
});

describe('data source', () => {
  it('is the data API on mainnet and the chain on devnet', () => {
    expect(primarySource('mainnet-beta')).toBe('jupiter');
    expect(primarySource('devnet')).toBe('chain');
    expect(primarySource('anything')).toBe('chain');
  });
});

describe('coin lists fallback', () => {
  it('keeps the data API when it answers, with a timeout and no retry', async () => {
    const coin = pool();
    http.post.mockReturnValue(reply({ recent: { pools: [coin] }, graduated: { pools: [] } }));
    const lists = await ApeClient.getGemsTokenList(REQ);
    expect(lists.recent.pools).toEqual([coin]);
    expect(chainCalls()).toHaveLength(0);
    const [, options] = http.post.mock.calls[0] as [string, { timeout: number; retry: number }];
    expect(options).toMatchObject({ timeout: JUPITER_TIMEOUT_MS, retry: 0 });
  });

  it('falls back to the chain on an error, then skips the data API during the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const onchain = pool();
    http.post.mockReturnValue(failWith(networkError()));
    serveChain({ recent: { pools: [onchain] }, graduated: { pools: [] } });
    const lists = await ApeClient.getGemsTokenList(REQ);
    expect(lists.recent.pools).toEqual([onchain]);
    expect(lists.graduated.pools).toEqual([]);
    expect(debug).toHaveBeenCalledWith('[forge data] coin lists: on-chain (data API unreachable)');

    await ApeClient.getGemsTokenList(REQ);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(chainCalls()).toHaveLength(2);

    // After the cooldown the data API is the primary source again.
    vi.setSystemTime(Date.now() + JUPITER_COOLDOWN_MS);
    const back = pool();
    http.post.mockReturnValue(reply({ recent: { pools: [back] } }));
    expect((await ApeClient.getGemsTokenList(REQ)).recent.pools).toEqual([back]);
    expect(debug).toHaveBeenLastCalledWith('[forge data] coin lists: Jupiter data API');
  });

  it('falls back on a timeout and on a 5xx', async () => {
    for (const error of [timeoutError(), httpError(503)]) {
      resetDataSource();
      http.post.mockReturnValue(failWith(error));
      serveChain({ recent: { pools: [pool()] } });
      const lists = await ApeClient.getGemsTokenList(REQ);
      expect(lists.recent.pools).toHaveLength(1);
    }
    expect(debug).toHaveBeenCalledWith('[forge data] coin lists: on-chain (data API timeout)');
    expect(debug).toHaveBeenCalledWith('[forge data] coin lists: on-chain (data API HTTP 503)');
  });

  it('falls back when the data API returns nothing, without a cooldown', async () => {
    const onchain = pool();
    http.post.mockReturnValue(reply({ recent: { pools: [] }, graduated: { pools: [] } }));
    serveChain({ recent: { pools: [onchain] } });
    expect((await ApeClient.getGemsTokenList(REQ)).recent.pools).toEqual([onchain]);
    await ApeClient.getGemsTokenList(REQ);
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('keeps an empty answer when the chain cannot be read either', async () => {
    http.post.mockReturnValue(reply({ recent: { pools: [] }, graduated: { pools: [] } }));
    http.get.mockReturnValue(failWith(httpError(503)));
    const lists = await ApeClient.getGemsTokenList(REQ);
    expect(lists.recent.pools).toEqual([]);
  });

  it('throws DataUnavailableError when neither source answers', async () => {
    http.post.mockReturnValue(failWith(networkError()));
    http.get.mockReturnValue(failWith(httpError(503)));
    await expect(ApeClient.getGemsTokenList(REQ)).rejects.toBeInstanceOf(DataUnavailableError);
  });

  it('filters the on-chain lists to this launchpad too', async () => {
    http.post.mockReturnValue(failWith(networkError()));
    const mine = pool();
    // Another launchpad coin config is not set here: only the users config pools pass.
    state.onchain = { launchpadConfig: USERS, launchpadCoinConfig: key() } as never;
    serveChain({ recent: { pools: [mine, { id: key(), baseAsset: { id: key() } }] } });
    expect((await ApeClient.getGemsTokenList(REQ)).recent.pools).toEqual([mine]);
  });

  it('rethrows a request cancelled by its caller', async () => {
    const controller = new AbortController();
    controller.abort();
    http.post.mockReturnValue(
      failWith(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    await expect(
      ApeClient.getGemsTokenList(REQ, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(chainCalls()).toHaveLength(0);
  });
});

describe('coin info fallback', () => {
  it('reads the coin on-chain when the data API has no pool for it', async () => {
    const coin = pool();
    http.get.mockImplementation((url: string, options?: { searchParams?: { mint?: string } }) =>
      url === '/api/coins'
        ? reply({ pool: coin, description: 'From storage' })
        : url.endsWith('/description')
          ? failWith(networkError())
          : reply({ pools: [] }),
    );
    expect(await ApeClient.getToken({ id: coin.baseAsset.id })).toEqual({ pools: [coin] });
    expect(await ApeClient.getTokenDescription(coin.baseAsset.id)).toEqual({
      description: 'From storage',
    });
    // Coin info and description share one on-chain read.
    expect(chainCalls()).toHaveLength(1);
    expect(chainCalls()[0]![1]).toMatchObject({ searchParams: { mint: coin.baseAsset.id } });
  });

  it('answers no pool for a mint that is not a coin of this launchpad', async () => {
    http.get.mockImplementation((url: string) =>
      url === '/api/coins' ? reply({ pool: null, description: null }) : failWith(networkError()),
    );
    expect(await ApeClient.getToken({ id: key() })).toEqual({ pools: [] });
  });
});

describe('chart, holders and transactions', () => {
  it('fail with DataUnavailableError when the data API is down', async () => {
    http.get.mockReturnValue(failWith(networkError()));
    await expect(ApeClient.getTokenHolders(key())).rejects.toBeInstanceOf(DataUnavailableError);
    // The cooldown started: nothing more is requested from the data API.
    const calls = http.get.mock.calls.length;
    await expect(ApeClient.getTokenTxs(key(), {})).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(
      ApeClient.getChart(key(), {
        interval: '1_MINUTE',
        baseAsset: key(),
        from: 0,
        to: 1,
        candles: 10,
        type: 'price',
      }),
    ).rejects.toBeInstanceOf(DataUnavailableError);
    expect(http.get.mock.calls.length).toBe(calls);
  });

  it('a 4xx about one request does not start the cooldown', async () => {
    http.get.mockReturnValue(failWith(httpError(404)));
    await expect(ApeClient.getTokenHolders(key())).rejects.toBeInstanceOf(DataUnavailableError);
    http.post.mockReturnValue(reply({ recent: { pools: [pool()] } }));
    await ApeClient.getGemsTokenList(REQ);
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

describe('devnet', () => {
  beforeEach(() => {
    state.cluster = 'devnet';
  });

  it('always reads the chain and never calls the data API', async () => {
    const coin = pool();
    serveChain(
      { recent: { pools: [coin] }, graduated: { pools: [] } },
      { pool: coin, description: null },
    );
    expect((await ApeClient.getGemsTokenList(REQ)).recent.pools).toEqual([coin]);
    expect(await ApeClient.getToken({ id: coin.baseAsset.id })).toEqual({ pools: [coin] });
    await expect(ApeClient.getTokenHolders(coin.baseAsset.id)).rejects.toBeInstanceOf(
      DataUnavailableError,
    );
    await expect(ApeClient.getTokenTxs(coin.baseAsset.id, {})).rejects.toBeInstanceOf(
      DataUnavailableError,
    );
    expect(http.post).not.toHaveBeenCalled();
    expect(http.get.mock.calls.every(([url]) => url === '/api/coins')).toBe(true);
    expect(debug).toHaveBeenCalledWith('[forge data] coin lists: on-chain (devnet)');
  });
});
