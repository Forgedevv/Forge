import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { LaunchApiError, createHttpLaunchApi, type PrepareLaunchRequest } from '@/forge/create/api';
import { buildFixtureLaunch } from '@/forge/create/test-fixtures';

const request: PrepareLaunchRequest = {
  tokenName: 'Moon Coin',
  tokenSymbol: 'MOON',
  description: '',
  tokenLogo: 'data:image/png;base64,AAAA',
  userWallet: Keypair.generate().publicKey.toBase58(),
  firstBuyLamports: '0',
};

function res(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe('createHttpLaunchApi', () => {
  it('posts to /api/upload and parses the answer', async () => {
    const { response } = buildFixtureLaunch({
      wallet: Keypair.generate().publicKey,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(0),
    });
    const fetch = vi.fn().mockResolvedValue(res({ success: true, ...response }));
    const answer = await createHttpLaunchApi(fetch).prepare(request);
    expect(answer.mint).toBe(response.mint);
    expect(fetch.mock.calls[0][0]).toBe('/api/upload');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
  });

  it('surfaces the server error message', async () => {
    const fetch = vi.fn().mockResolvedValue(res({ error: 'Failed to upload image' }, 400));
    await expect(createHttpLaunchApi(fetch).prepare(request)).rejects.toThrow(
      'Failed to upload image',
    );
  });

  it('rejects an answer in an unexpected format', async () => {
    const fetch = vi.fn().mockResolvedValue(res({ success: true, poolTx: 'x' }));
    await expect(createHttpLaunchApi(fetch).prepare(request)).rejects.toThrow(/expected format/);
  });

  it('rejects a malformed amount in the summary', async () => {
    const { response } = buildFixtureLaunch({
      wallet: Keypair.generate().publicKey,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(0),
    });
    const bad = { ...response, summary: { ...response.summary, firstBuyLamports: '-5' } };
    const fetch = vi.fn().mockResolvedValue(res(bad));
    await expect(createHttpLaunchApi(fetch).prepare(request)).rejects.toBeInstanceOf(
      LaunchApiError,
    );
  });

  it('reports an unreachable server', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createHttpLaunchApi(fetch).prepare(request)).rejects.toThrow(/Could not reach/);
  });
});
