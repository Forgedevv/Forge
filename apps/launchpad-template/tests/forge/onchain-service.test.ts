import { poolSpotPrice } from '@forge/core';
import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  onchain: undefined as
    | { launchpadConfig?: string; launchpadCoinConfig?: string; launchpadCoinMint?: string }
    | undefined,
}));
vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
}));

import {
  decodeMetadata,
  decodeMint,
  decodeSolUsdPrice,
  metadataAddress,
  PYTH_SOL_USD_ACCOUNT,
} from '../../src/forge/data/onchain/accounts';
import {
  COIN_TTL_MS,
  LIST_TTL_MS,
  MAX_KEYS_PER_CALL,
  OnchainUnavailableError,
  READ_BUDGET,
  STALE_MS,
  createOnchainCoinService,
  forgeAppOrigin,
} from '../../src/forge/data/onchain/service';
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM, dbcPoolAddress } from '../../src/forge/tx/programs';
import {
  PYTH_PUBLISH_MS,
  PYTH_SOL_USD_PRICE,
  STORAGE,
  coinAccounts,
  fixture,
  fixtureRaw,
  metadataAccount,
  mintAccount,
  mockChain,
  poolConfig,
  poolMint,
  pythAccount,
  withPyth,
  type RawFixture,
} from '../helpers/onchain';

const USERS = poolConfig('test1Pool');
const COIN_CONFIG = poolConfig('test2Pool');
const USER_COIN = poolMint('test1Pool');
const LAUNCHPAD_COIN = poolMint('test2Pool');

function launchedChain(extra: [string, RawFixture][] = []) {
  const accounts = withPyth(
    new Map([
      [USERS, fixtureRaw('test1Config')],
      [COIN_CONFIG, fixtureRaw('test2Config')],
      ...coinAccounts('test1Pool', 'Moon Coin', 'MOON'),
      ...coinAccounts('test2Pool', 'Pad Coin', 'PAD'),
      ...extra,
    ]),
  );
  return { accounts, ...mockChain(accounts) };
}

function storageFetch() {
  return vi.fn(async (url: string) => {
    const mint = /metadata\/([^/]+)\.json$/.exec(url)?.[1];
    return new Response(
      JSON.stringify({
        name: 'x',
        symbol: 'x',
        description: `About ${mint}`,
        image: `${STORAGE}/launchpads/moon/images/${mint}.png`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

function clock(start = PYTH_PUBLISH_MS + 60_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const launch = () => {
  state.onchain = {
    launchpadConfig: USERS,
    launchpadCoinConfig: COIN_CONFIG,
    launchpadCoinMint: LAUNCHPAD_COIN,
  };
};

afterEach(() => {
  state.onchain = undefined;
});

describe('fixtures', () => {
  it('are pools at the PDA of their config and mint', () => {
    expect(dbcPoolAddress(USERS, USER_COIN)).toBe(fixture('test1Pool').address);
    expect(dbcPoolAddress(COIN_CONFIG, LAUNCHPAD_COIN)).toBe(fixture('test2Pool').address);
  });
});

describe('account decoders', () => {
  it('decode a mint, its metadata and the Pyth SOL/USD price', () => {
    expect(decodeMint(mintAccount(BigInt(42), 6))).toMatchObject({
      supply: BigInt(42),
      decimals: 6,
    });
    const meta = metadataAccount(USER_COIN, { name: 'Moon Coin', symbol: 'MOON', uri: 'u' });
    expect(decodeMetadata(meta, USER_COIN)).toEqual({
      name: 'Moon Coin',
      symbol: 'MOON',
      uri: 'u',
    });
    expect(decodeSolUsdPrice(pythAccount(), PYTH_PUBLISH_MS / 1000 + 60)).toBeCloseTo(
      PYTH_SOL_USD_PRICE,
      8,
    );
  });

  it('decode the mint and freeze authorities of real devnet mints', () => {
    // Devnet, slot 512138531: a FORGE DBC coin (both authorities revoked by the DBC program; the
    // old key bytes stay behind a `None` tag) and devnet USDC (both authorities set).
    const dbcCoin = {
      owner: TOKEN_PROGRAM,
      data: Buffer.from(
        'AAAAANpjaB9yhrzIBnGeLCtQogFXJDv8lmixFSC8U4Q+3NsIAIDGpH6NAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        'base64',
      ),
    };
    const usdc = {
      owner: TOKEN_PROGRAM,
      data: Buffer.from(
        'AQAAAOuFRM+RGCd6ljLpmVBmZRu/sUCLhXPrwC5T76tavw4LMVMEabU4BuIGAQEAAACoBjP/Bn2I36XUNXv0TibOzM8IZmiBA8a6YJ+kTBjSCA==',
        'base64',
      ),
    };
    expect(decodeMint(dbcCoin)).toMatchObject({
      decimals: 6,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
    });
    expect(decodeMint(usdc)).toMatchObject({
      decimals: 6,
      mintAuthorityDisabled: false,
      freezeAuthorityDisabled: false,
    });
    // Only one of them set.
    const mixed = Buffer.from(dbcCoin.data);
    mixed.writeUInt32LE(1, 46);
    expect(decodeMint({ owner: TOKEN_PROGRAM, data: mixed })).toMatchObject({
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: false,
    });
    // A tag that is neither None nor Some is not a mint.
    const bad = Buffer.from(dbcCoin.data);
    bad.writeUInt32LE(2, 0);
    expect(decodeMint({ owner: TOKEN_PROGRAM, data: bad })).toBeNull();
  });

  it('refuse foreign, malformed or stale accounts', () => {
    const mint = mintAccount(BigInt(1), 6);
    expect(decodeMint({ ...mint, owner: PYTH_SOL_USD_ACCOUNT })).toBeNull();
    expect(decodeMint({ ...mint, data: mint.data.subarray(0, 40) })).toBeNull();
    const meta = metadataAccount(USER_COIN, { name: 'a', symbol: 'b', uri: 'c' });
    expect(decodeMetadata(meta, LAUNCHPAD_COIN)).toBeNull();
    expect(decodeMetadata({ ...meta, data: meta.data.subarray(0, 90) }, USER_COIN)).toBeNull();
    expect(decodeSolUsdPrice(pythAccount(), PYTH_PUBLISH_MS / 1000 + 3600)).toBeNull();
    expect(
      decodeSolUsdPrice({ ...pythAccount(), owner: USERS }, PYTH_PUBLISH_MS / 1000),
    ).toBeNull();
    expect(decodeMetadata(null, USER_COIN)).toBeNull();
  });
});

describe('on-chain coin lists', () => {
  it('lists the users config coins and the launchpad coin from fixture pool accounts', async () => {
    launch();
    const chain = launchedChain();
    const fetch = storageFetch();
    const t = clock();
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: STORAGE,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: t.now,
    });
    const lists = await service.lists();

    // test1 is trading at 1.98%: a new coin, not near graduation. test2 (the launchpad coin)
    // migrated: graduated.
    expect(lists.recent.pools.map((p) => p.baseAsset.id)).toEqual([USER_COIN]);
    expect(lists.aboutToGraduate.pools).toEqual([]);
    expect(lists.graduated.pools.map((p) => p.baseAsset.id)).toEqual([LAUNCHPAD_COIN]);

    const coin = lists.recent.pools[0]!;
    expect(coin.id).toBe(fixture('test1Pool').address);
    expect(coin.bondingCurve).toBeCloseTo(1.98, 10);
    expect(coin.baseAsset).toMatchObject({
      name: 'Moon Coin',
      symbol: 'MOON',
      decimals: 6,
      totalSupply: 1_000_000_000,
      icon: `${STORAGE}/launchpads/moon/images/${USER_COIN}.png`,
      launchpad: 'met-dbc',
    });
    const sqrtPrice =
      fixtureRaw('test1Pool').data.readBigUInt64LE(280) +
      (fixtureRaw('test1Pool').data.readBigUInt64LE(288) << BigInt(64));
    const usd = poolSpotPrice(sqrtPrice, 6) * PYTH_SOL_USD_PRICE;
    expect(coin.baseAsset.usdPrice).toBeCloseTo(usd, 12);
    expect(coin.baseAsset.mcap).toBeCloseTo(usd * 1_000_000_000, 4);
    // Timestamp activation: the creation time is the activation point.
    const activation = Number(fixtureRaw('test1Pool').data.readBigUInt64LE(296));
    expect(coin.createdAt).toBe(new Date(activation * 1000).toISOString());
    expect(lists.graduated.pools[0]!.bondingCurve).toBe(100);

    // One config scan (both pool variants), the coin config never scanned.
    expect(chain.getProgramAccounts).toHaveBeenCalledTimes(2);
    for (const [, config] of chain.getProgramAccounts.mock.calls) {
      expect(
        (config as { filters: { memcmp: { bytes: string } }[] }).filters[1]!.memcmp.bytes,
      ).toBe(USERS);
    }
    // Mints, metadata and the price in one batch; metadata JSON from the storage only.
    expect(chain.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url] of fetch.mock.calls) expect(String(url).startsWith(`${STORAGE}/`)).toBe(true);
  });

  it('drops look-alikes and coins whose mint cannot be read', async () => {
    launch();
    // A pool on the users config that is not the PDA of its mint (a wrong RPC answer).
    const fake = Buffer.from(fixtureRaw('test3Pool').data);
    Buffer.from(new PublicKey(USERS).toBytes()).copy(fake, 72);
    const chain = launchedChain([
      [fixture('test3Pool').address, { owner: fixture('test3Pool').owner, data: fake }],
    ]);
    chain.accounts.delete(LAUNCHPAD_COIN);
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: STORAGE,
      fetch: storageFetch() as unknown as typeof fetch,
      now: clock().now,
    });
    const lists = await service.lists();
    const ids = [
      ...lists.recent.pools,
      ...lists.aboutToGraduate.pools,
      ...lists.graduated.pools,
    ].map((p) => p.baseAsset.id);
    expect(ids).toEqual([USER_COIN]);
  });

  it('never fetches metadata JSON from another host, and lists the coin without its icon', async () => {
    launch();
    const chain = launchedChain();
    const fetch = storageFetch();
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: 'https://other-storage.example',
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: clock().now,
    });
    const lists = await service.lists();
    expect(fetch).not.toHaveBeenCalled();
    expect(lists.recent.pools[0]!.baseAsset).toMatchObject({ symbol: 'MOON', icon: undefined });
  });

  it('reads accounts in batches the relay accepts', async () => {
    launch();
    const chain = launchedChain();
    // 15 more coins on the users config: 2 keys each.
    const extra: [string, RawFixture][] = [];
    for (let i = 0; i < 15; i++) {
      const mint = PublicKey.unique().toBase58();
      const pool = dbcPoolAddress(USERS, mint);
      const data = Buffer.from(fixtureRaw('test1Pool').data);
      Buffer.from(new PublicKey(mint).toBytes()).copy(data, 136);
      extra.push([pool, { owner: fixture('test1Pool').owner, data }]);
      extra.push([mint, mintAccount(BigInt(10) ** BigInt(15), 6)]);
      extra.push([
        metadataAddress(mint),
        metadataAccount(mint, { name: `C${i}`, symbol: `C${i}`, uri: '' }),
      ]);
    }
    for (const [k, v] of extra) chain.accounts.set(k, v);
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: null,
      now: clock().now,
    });
    const lists = await service.lists();
    expect(lists.recent.pools).toHaveLength(16);
    for (const [keys] of chain.getMultipleAccountsInfo.mock.calls) {
      expect((keys as PublicKey[]).length).toBeLessThanOrEqual(MAX_KEYS_PER_CALL);
    }
    expect(chain.getMultipleAccountsInfo.mock.calls.length).toBeGreaterThan(1);
  });

  it('caches the lists, serves them stale when the chain fails, then gives up', async () => {
    launch();
    const chain = launchedChain();
    const t = clock();
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: null,
      now: t.now,
    });
    const first = await service.lists();
    expect(await service.lists()).toBe(first);
    expect(chain.getProgramAccounts).toHaveBeenCalledTimes(2);

    // Concurrent requests share one read.
    t.advance(LIST_TTL_MS);
    const [second] = await Promise.all([service.lists(), service.lists(), service.lists()]);
    expect(chain.getProgramAccounts).toHaveBeenCalledTimes(4);

    t.advance(LIST_TTL_MS);
    chain.getProgramAccounts.mockRejectedValue(new Error('relay down'));
    expect(await service.lists()).toBe(second);
    t.advance(STALE_MS + LIST_TTL_MS);
    await expect(service.lists()).rejects.toBeInstanceOf(OnchainUnavailableError);
  });

  it('stops reading past its budget', async () => {
    launch();
    const chain = launchedChain();
    chain.getProgramAccounts.mockRejectedValue(new Error('relay down'));
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: null,
      now: clock().now,
    });
    for (let i = 0; i < READ_BUDGET.lists.capacity + 3; i++) {
      await expect(service.lists()).rejects.toBeInstanceOf(OnchainUnavailableError);
    }
    // Each failed refresh scans the two pool variants once; past the budget nothing is read.
    expect(chain.getProgramAccounts.mock.calls.length).toBeLessThanOrEqual(
      READ_BUDGET.lists.capacity * 2,
    );
  });

  it('scans the configs of NEXT_PUBLIC_POOL_CONFIG_KEY before the on-chain setup', async () => {
    vi.stubEnv('NEXT_PUBLIC_POOL_CONFIG_KEY', USERS);
    const chain = launchedChain();
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: null,
      now: clock().now,
    });
    const lists = await service.lists();
    expect(lists.recent.pools.map((p) => p.baseAsset.id)).toEqual([USER_COIN]);
    vi.unstubAllEnvs();
  });
});

describe('one coin on-chain', () => {
  it('reads a coin of the users config, and the launchpad coin', async () => {
    launch();
    const chain = launchedChain();
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: STORAGE,
      fetch: storageFetch() as unknown as typeof fetch,
      now: clock().now,
    });
    const user = await service.coin(USER_COIN);
    expect(user?.pool?.id).toBe(fixture('test1Pool').address);
    expect(user?.pool?.baseAsset.symbol).toBe('MOON');
    expect(user?.description).toBe(`About ${USER_COIN}`);
    // Mint and freeze authorities come from the mint account; the rest of the audit is unknown.
    expect(user?.pool?.baseAsset.audit).toEqual({
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: undefined,
      lpBurnedPercentage: undefined,
    });
    const pad = await service.coin(LAUNCHPAD_COIN);
    expect(pad?.pool?.id).toBe(fixture('test2Pool').address);
  });

  it('finds nothing for another mint, refuses an invalid address, and caches', async () => {
    launch();
    const chain = launchedChain();
    const t = clock();
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: null,
      now: t.now,
    });
    // test3's mint is not a coin of this launchpad (its pool is on another config).
    expect(await service.coin(poolMint('test3Pool'))).toEqual({ pool: null, description: null });
    expect(await service.coin('not-a-mint')).toBeNull();

    await service.coin(USER_COIN);
    const reads = chain.getAccountInfoAndContext.mock.calls.length;
    await service.coin(USER_COIN);
    expect(chain.getAccountInfoAndContext.mock.calls.length).toBe(reads);
    t.advance(COIN_TTL_MS);
    await service.coin(USER_COIN);
    expect(chain.getAccountInfoAndContext.mock.calls.length).toBeGreaterThan(reads);
  });
});

describe('launchpad coin metadata on the FORGE coin-meta route', () => {
  const FORGE = 'https://app.forge.example';

  /** The launched chain, with the on-chain metadata URI of `coinMint` set to `uri`. */
  function chainWithCoinUri(uri: string, coinMint: string) {
    const name = coinMint === LAUNCHPAD_COIN ? 'Pad Coin' : 'Moon Coin';
    return launchedChain([
      [metadataAddress(coinMint), metadataAccount(coinMint, { name, symbol: 'X', uri })],
    ]);
  }

  function metaFetch(image = `${STORAGE}/coin-images/pad.png`) {
    return vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ name: 'Pad Coin', symbol: 'PAD', description: 'The pad', image }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
  }

  async function readCoin(uri: string, fetch: ReturnType<typeof metaFetch>, mint = LAUNCHPAD_COIN) {
    launch();
    const chain = chainWithCoinUri(uri, mint);
    const service = createOnchainCoinService({
      connection: chain.connection,
      storageOrigin: STORAGE,
      forgeOrigin: FORGE,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: clock().now,
    });
    return service.coin(mint);
  }

  it('reads the launchpad coin metadata from the FORGE origin, without redirects', async () => {
    const fetch = metaFetch();
    const coin = await readCoin(`${FORGE}/api/coin-meta/moon`, fetch);
    expect(coin?.pool?.baseAsset.icon).toBe(`${STORAGE}/coin-images/pad.png`);
    expect(coin?.description).toBe('The pad');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${FORGE}/api/coin-meta/moon`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('keeps the description but drops an image that is not on the storage origin', async () => {
    const coin = await readCoin(
      `${FORGE}/api/coin-meta/moon`,
      metaFetch('https://images.elsewhere.example/pad.png'),
    );
    expect(coin?.pool?.baseAsset.icon).toBeUndefined();
    expect(coin?.description).toBe('The pad');
  });

  it('refuses look-alike origins, http, other paths and credentials', async () => {
    for (const uri of [
      'https://app.forge.example.evil.example/api/coin-meta/moon',
      'https://evil.example/api/coin-meta/moon?u=https://app.forge.example',
      'https://app.forge.example:8443/api/coin-meta/moon',
      'http://app.forge.example/api/coin-meta/moon',
      'https://user:pass@app.forge.example/api/coin-meta/moon',
      'https://app.forge.example/api/rpc',
      'https://app.forge.example/api/coin-meta/',
    ]) {
      const fetch = metaFetch();
      const coin = await readCoin(uri, fetch);
      expect(fetch, uri).not.toHaveBeenCalled();
      expect(coin?.pool?.baseAsset.icon, uri).toBeUndefined();
    }
  });

  it('never reads the FORGE origin for a coin other than the launchpad coin', async () => {
    const fetch = metaFetch();
    const coin = await readCoin(`${FORGE}/api/coin-meta/moon`, fetch, USER_COIN);
    expect(coin?.pool?.id).toBe(fixture('test1Pool').address);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a redirect as a failure', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      // What `fetch` does with `redirect: 'error'` when the server answers 3xx.
      if (init?.redirect === 'error') throw new TypeError('fetch failed: redirect mode is error');
      return new Response('{}', { status: 200 });
    });
    const coin = await readCoin(`${FORGE}/api/coin-meta/moon`, fetch as never);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(coin?.pool?.baseAsset.icon).toBeUndefined();
    expect(coin?.description).toBeNull();
  });
});

describe('forgeAppOrigin', () => {
  it('takes the API URL first, else the relay origin, https only', () => {
    expect(forgeAppOrigin('https://api.forge.example/base/', 'https://relay.example/api/rpc')).toBe(
      'https://api.forge.example',
    );
    expect(forgeAppOrigin(undefined, 'https://app.forge.example/api/rpc')).toBe(
      'https://app.forge.example',
    );
    expect(forgeAppOrigin('', 'https://app.forge.example/api/rpc')).toBe(
      'https://app.forge.example',
    );
    expect(forgeAppOrigin(undefined, 'http://app.forge.example/api/rpc')).toBeNull();
    expect(forgeAppOrigin('https://u:p@app.forge.example', undefined)).toBeNull();
    expect(forgeAppOrigin('not a url', 'https://app.forge.example')).toBeNull();
    expect(forgeAppOrigin(undefined, undefined)).toBeNull();
  });
});
