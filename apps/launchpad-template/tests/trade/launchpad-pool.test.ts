import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  onchain: undefined as
    | {
        launchpadConfig?: string;
        launchpadCoinConfig?: string;
        launchpadCoinMint?: string;
        cluster?: string;
      }
    | undefined,
}));

vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
}));

import {
  candidatePools,
  configsForMint,
  findLaunchpadPool,
  isLaunchpadPool,
  isListedLaunchpadCoin,
  launchpadCoinMint,
  launchpadConfigs,
  launchpadPoolKey,
  listedConfigs,
} from '../../src/forge/trade/launchpad-pool';
import { DBC_PROGRAM_ID, dbcPoolAddress } from '../../src/forge/tx/programs';

const key = () => Keypair.generate().publicKey.toBase58();
const users = key();
const coin = key();
const mint = key();
const official = key();
const launched = () => ({
  launchpadConfig: users,
  launchpadCoinConfig: coin,
  launchpadCoinMint: official,
});

function connectionWith(existing: Record<string, string>) {
  const getAccountInfo = vi.fn(async (address: PublicKey) => {
    const owner = existing[address.toBase58()];
    return owner
      ? { owner: new PublicKey(owner), data: Buffer.alloc(8), lamports: 1, executable: false }
      : null;
  });
  return { getAccountInfo };
}

afterEach(() => {
  state.onchain = undefined;
  vi.unstubAllEnvs();
});

describe('launchpadConfigs', () => {
  it('lists the users config then the launchpad coin config, valid and distinct', () => {
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: coin };
    expect(launchpadConfigs()).toEqual([users, coin]);
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: users };
    expect(launchpadConfigs()).toEqual([users]);
    state.onchain = { launchpadConfig: 'not-a-key', launchpadCoinConfig: coin };
    expect(launchpadConfigs()).toEqual([coin]);
  });

  it('is empty before the on-chain setup', () => {
    expect(launchpadConfigs()).toEqual([]);
  });
});

describe('listedConfigs (coin lists)', () => {
  it("uses the launchpad's configs, else the valid public pool config keys, else nothing", () => {
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: coin };
    vi.stubEnv('NEXT_PUBLIC_POOL_CONFIG_KEY', key());
    expect(listedConfigs()).toEqual([users, coin]);
    state.onchain = undefined;
    const fromEnv = key();
    vi.stubEnv('NEXT_PUBLIC_POOL_CONFIG_KEY', ` ${fromEnv}, nope,${fromEnv}`);
    expect(listedConfigs()).toEqual([fromEnv]);
    vi.stubEnv('NEXT_PUBLIC_POOL_CONFIG_KEY', '');
    expect(listedConfigs()).toEqual([]);
  });
});

describe('findLaunchpadPool', () => {
  it("finds a user coin's pool on the users config", async () => {
    state.onchain = launched();
    const pool = dbcPoolAddress(users, mint);
    expect(candidatePools(mint)).toEqual([{ config: users, pool }]);
    const found = await findLaunchpadPool(connectionWith({ [pool]: DBC_PROGRAM_ID }), mint);
    expect(found).toEqual({ mint, config: users, pool });
    expect(isLaunchpadPool(found)).toBe(true);
    expect(Object.isFrozen(found)).toBe(true);
    expect(launchpadPoolKey(found)?.toBase58()).toBe(pool);
  });

  it("finds the launchpad's own coin on the coin config", async () => {
    state.onchain = launched();
    expect(launchpadCoinMint()).toBe(official);
    expect(configsForMint(official)).toEqual([users, coin]);
    const pool = dbcPoolAddress(coin, official);
    const found = await findLaunchpadPool(connectionWith({ [pool]: DBC_PROGRAM_ID }), official);
    expect(found).toMatchObject({ mint: official, config: coin, pool });
    expect(isLaunchpadPool(found)).toBe(true);
  });

  it('refuses a look-alike: another mint on the launchpad coin config', async () => {
    state.onchain = launched();
    const lookAlike = dbcPoolAddress(coin, mint);
    expect(configsForMint(mint)).toEqual([users]);
    expect(candidatePools(mint).map((candidate) => candidate.config)).not.toContain(coin);
    const connection = connectionWith({ [lookAlike]: DBC_PROGRAM_ID });
    expect(await findLaunchpadPool(connection, mint)).toBeNull();
    const read = connection.getAccountInfo.mock.calls.map(([address]) => address.toBase58());
    expect(read).not.toContain(lookAlike);
  });

  it('accepts nothing on the coin config before the launch (no valid coin mint)', async () => {
    for (const coinMint of [undefined, 'not-a-key']) {
      state.onchain = {
        launchpadConfig: users,
        launchpadCoinConfig: coin,
        launchpadCoinMint: coinMint,
      };
      expect(launchpadCoinMint()).toBeNull();
      expect(configsForMint(official)).toEqual([users]);
      const pool = dbcPoolAddress(coin, official);
      expect(
        await findLaunchpadPool(connectionWith({ [pool]: DBC_PROGRAM_ID }), official),
      ).toBeNull();
    }
  });

  it('finds nothing for another launchpad, a non-DBC account or before the setup', async () => {
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: coin };
    const foreignConfig = key();
    const foreign = dbcPoolAddress(foreignConfig, mint);
    expect(await findLaunchpadPool(connectionWith({ [foreign]: DBC_PROGRAM_ID }), mint)).toBeNull();
    const notDbc = dbcPoolAddress(users, mint);
    expect(await findLaunchpadPool(connectionWith({ [notDbc]: key() }), mint)).toBeNull();
    expect(await findLaunchpadPool(connectionWith({}), 'not-a-key')).toBeNull();
    state.onchain = undefined;
    const connection = connectionWith({ [notDbc]: DBC_PROGRAM_ID });
    expect(await findLaunchpadPool(connection, mint)).toBeNull();
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
  });

  it('keeps the users config open to any coin when it is also the coin config', async () => {
    state.onchain = {
      launchpadConfig: users,
      launchpadCoinConfig: users,
      launchpadCoinMint: official,
    };
    const pool = dbcPoolAddress(users, mint);
    expect(await findLaunchpadPool(connectionWith({ [pool]: DBC_PROGRAM_ID }), mint)).toMatchObject(
      {
        config: users,
      },
    );
  });

  it('never accepts a handle it did not issue', () => {
    const forged = Object.freeze({ mint, config: users, pool: dbcPoolAddress(users, mint) });
    expect(isLaunchpadPool(forged)).toBe(false);
    expect(launchpadPoolKey(forged)).toBeNull();
    expect(launchpadPoolKey(null)).toBeNull();
  });
});

describe('isListedLaunchpadCoin (coin lists)', () => {
  const entry = (asset: string, id: string, firstPool?: string) => ({
    id,
    baseAsset: { id: asset, ...(firstPool ? { firstPool: { id: firstPool } } : {}) },
  });

  it("keeps the launchpad's own coin and the users config coins", () => {
    state.onchain = launched();
    expect(isListedLaunchpadCoin(entry(official, dbcPoolAddress(coin, official)))).toBe(true);
    expect(isListedLaunchpadCoin(entry(mint, dbcPoolAddress(users, mint)))).toBe(true);
    // Graduated: the entry is the new pool, the first pool is the bonding curve.
    expect(isListedLaunchpadCoin(entry(mint, key(), dbcPoolAddress(users, mint)))).toBe(true);
  });

  it('drops a look-alike on the coin config and anything not traced to the users config', () => {
    state.onchain = launched();
    expect(isListedLaunchpadCoin(entry(mint, dbcPoolAddress(coin, mint)))).toBe(false);
    expect(isListedLaunchpadCoin(entry(mint, key(), dbcPoolAddress(coin, mint)))).toBe(false);
    expect(isListedLaunchpadCoin(entry(mint, key()))).toBe(false);
    expect(isListedLaunchpadCoin(entry('not-a-key', dbcPoolAddress(users, mint)))).toBe(false);
    expect(isListedLaunchpadCoin(null)).toBe(false);
  });

  it('drops every coin config entry before the launch (no valid coin mint)', () => {
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: coin };
    expect(isListedLaunchpadCoin(entry(official, dbcPoolAddress(coin, official)))).toBe(false);
    expect(isListedLaunchpadCoin(entry(mint, dbcPoolAddress(users, mint)))).toBe(true);
  });

  it('keeps the env-filtered lists unchanged before the on-chain setup', () => {
    state.onchain = undefined;
    expect(isListedLaunchpadCoin(entry(mint, key()))).toBe(true);
  });
});
