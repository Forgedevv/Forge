import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  onchain: undefined as
    { launchpadConfig?: string; launchpadCoinConfig?: string; cluster?: string } | undefined,
}));

vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
}));

import {
  candidatePools,
  findLaunchpadPool,
  isLaunchpadPool,
  launchpadConfigs,
  launchpadPoolKey,
  listedConfigs,
} from '../../src/forge/trade/launchpad-pool';
import { DBC_PROGRAM_ID, dbcPoolAddress } from '../../src/forge/tx/programs';

const key = () => Keypair.generate().publicKey.toBase58();
const users = key();
const coin = key();
const mint = key();

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
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: coin };
    const pool = dbcPoolAddress(users, mint);
    expect(candidatePools(mint)).toEqual([
      { config: users, pool },
      { config: coin, pool: dbcPoolAddress(coin, mint) },
    ]);
    const found = await findLaunchpadPool(connectionWith({ [pool]: DBC_PROGRAM_ID }), mint);
    expect(found).toEqual({ mint, config: users, pool });
    expect(isLaunchpadPool(found)).toBe(true);
    expect(Object.isFrozen(found)).toBe(true);
    expect(launchpadPoolKey(found)?.toBase58()).toBe(pool);
  });

  it("finds the launchpad's own coin on the coin config", async () => {
    state.onchain = { launchpadConfig: users, launchpadCoinConfig: coin };
    const pool = dbcPoolAddress(coin, mint);
    const found = await findLaunchpadPool(connectionWith({ [pool]: DBC_PROGRAM_ID }), mint);
    expect(found).toMatchObject({ config: coin, pool });
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

  it('never accepts a handle it did not issue', () => {
    const forged = Object.freeze({ mint, config: users, pool: dbcPoolAddress(users, mint) });
    expect(isLaunchpadPool(forged)).toBe(false);
    expect(launchpadPoolKey(forged)).toBeNull();
    expect(launchpadPoolKey(null)).toBeNull();
  });
});
