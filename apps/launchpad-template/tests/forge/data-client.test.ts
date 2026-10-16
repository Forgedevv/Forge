import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  post: vi.fn(() => ({ json: async () => ({ recent: { pools: [] } }) })),
}));
vi.mock('ky', () => ({ default: { post: http.post, get: vi.fn() } }));

const state = vi.hoisted(() => ({
  onchain: undefined as { launchpadConfig?: string; launchpadCoinConfig?: string } | undefined,
}));
vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
}));

import { ApeClient, launchpadGemsRequest } from '../../src/forge/data/client';

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
