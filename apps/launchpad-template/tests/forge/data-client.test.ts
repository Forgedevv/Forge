import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  post: vi.fn(() => ({ json: async () => ({ recent: { pools: [] } }) })),
}));
vi.mock('ky', () => ({
  default: { post: http.post, get: vi.fn() },
  HTTPError: class HTTPError extends Error {},
}));

const state = vi.hoisted(() => ({
  onchain: undefined as
    | { launchpadConfig?: string; launchpadCoinConfig?: string; launchpadCoinMint?: string }
    | undefined,
}));
vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
  // Mainnet: the data API is the primary source (data-fallback.test.ts covers the fallback).
  cluster: 'mainnet-beta',
}));

import {
  ApeClient,
  launchpadGemsRequest,
  launchpadStreamMessage,
} from '../../src/forge/data/client';
import { dbcPoolAddress } from '../../src/forge/tx/programs';

const key = () => Keypair.generate().publicKey.toBase58();

afterEach(() => {
  state.onchain = undefined;
  http.post.mockClear();
  vi.unstubAllEnvs();
});

describe('coin lists are filtered to this launchpad', () => {
  it("replaces any requested partner config with the launchpad's configs", () => {
    const configs = [key(), key()];
    const request = {
      recent: { timeframe: '24h' as const, partnerConfigs: [key()] },
      graduated: { timeframe: '24h' as const },
      aboutToGraduate: undefined,
    };
    expect(launchpadGemsRequest(request, configs)).toEqual({
      recent: { timeframe: '24h', partnerConfigs: configs },
      graduated: { timeframe: '24h', partnerConfigs: configs },
      aboutToGraduate: undefined,
    });
    expect(launchpadGemsRequest(request, [])).toBeNull();
  });

  it('queries the data API with the launchpad configs only', async () => {
    const users = key();
    const coin = key();
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: coin };
    await ApeClient.getGemsTokenList({ recent: { timeframe: '24h', partnerConfigs: [] } });
    const body = (http.post.mock.calls[0] as unknown as [string, { json: unknown }])[1].json;
    expect(body).toEqual({ recent: { timeframe: '24h', partnerConfigs: [users, coin] } });
  });

  it('drops the look-alikes created on the launchpad coin config from the lists', async () => {
    const users = key();
    const coin = key();
    const official = key();
    const userCoin = key();
    const fake = key();
    state.onchain = {
      launchpadConfig: users,
      launchpadCoinConfig: coin,
      launchpadCoinMint: official,
    };
    const pools = [
      { id: dbcPoolAddress(coin, official), baseAsset: { id: official } },
      { id: dbcPoolAddress(users, userCoin), baseAsset: { id: userCoin } },
      { id: dbcPoolAddress(coin, fake), baseAsset: { id: fake } },
    ];
    http.post.mockImplementationOnce(() => ({
      json: async () => ({ recent: { pools }, graduated: { pools: [pools[2]] } }),
    }));
    const lists = await ApeClient.getGemsTokenList({
      recent: { timeframe: '24h' },
      graduated: { timeframe: '24h' },
    });
    expect(lists.recent.pools.map((pool) => pool.baseAsset.id)).toEqual([official, userCoin]);
    expect(lists.graduated.pools).toEqual([]);
  });

  it('drops the look-alike pool updates from the data stream', () => {
    const users = key();
    const coin = key();
    const official = key();
    const fake = key();
    state.onchain = {
      launchpadConfig: users,
      launchpadCoinConfig: coin,
      launchpadCoinMint: official,
    };
    const ok = {
      type: 'new',
      pool: { id: dbcPoolAddress(coin, official), baseAsset: { id: official } },
    };
    const bad = { type: 'new', pool: { id: dbcPoolAddress(coin, fake), baseAsset: { id: fake } } };
    expect(launchpadStreamMessage({ type: 'updates', data: [ok, bad] })).toEqual({
      type: 'updates',
      data: [ok],
    });
    const actions = { type: 'actions', data: [{ asset: fake }] };
    expect(launchpadStreamMessage(actions)).toBe(actions);
  });

  it('never queries an unfiltered list: no config means empty lists and no request', async () => {
    vi.stubEnv('NEXT_PUBLIC_POOL_CONFIG_KEY', '');
    const lists = await ApeClient.getGemsTokenList({
      recent: { timeframe: '24h' },
      graduated: undefined,
    });
    expect(lists).toEqual({ recent: { pools: [] }, graduated: undefined });
    expect(http.post).not.toHaveBeenCalled();
  });
});
