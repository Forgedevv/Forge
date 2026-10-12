import { readFileSync } from 'node:fs';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  CURVE_PROGRESS_FULL_BPS,
  DBC_POOL_CONFIG_OFFSET,
  DBC_POOL_CREATOR_OFFSET,
  DbcReadError,
  PARTNER_POOL_CREATION_FEE_CLAIMED_BIT,
  PROTOCOL_POOL_CREATION_FEE_CLAIMED_BIT,
  curveProgress,
  feeMetrics,
  getDbcPoolState,
  graduationStatus,
  isGraduated,
  isTransientRpcError,
  listCoinsOfConfig,
  listCoinsOfCreator,
  partnerPoolCreationFeeShare,
  poolCreationFeeStatus,
  readCoin,
  retryRpc,
  type DbcPoolState,
} from './reads.js';

/** Real devnet accounts (wave-1 test pools), captured once: see __fixtures__/dbc-devnet-accounts.json. */
interface FixtureAccount {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/dbc-devnet-accounts.json', import.meta.url), 'utf8'),
) as { accounts: Record<string, FixtureAccount> };
const fx = (name: string): FixtureAccount => {
  const a = FIXTURES.accounts[name];
  if (!a) throw new Error(`fixture ${name} missing`);
  return a;
};
const key = (name: string) => new PublicKey(fx(name).address);

function accountInfo(a: FixtureAccount): AccountInfo<Buffer> {
  return {
    data: Buffer.from(a.data, 'base64'),
    owner: new PublicKey(a.owner),
    lamports: a.lamports,
    executable: false,
    rentEpoch: 0,
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

type Filter = { memcmp?: { offset: number; bytes: string }; dataSize?: number };

/** Minimal Connection serving the fixture accounts (no network). */
function mockConnection(names = Object.keys(FIXTURES.accounts)) {
  const byAddress = new Map(names.map((n) => [fx(n).address, fx(n)]));
  const getAccountInfoAndContext = vi.fn(async (address: PublicKey) => {
    const a = byAddress.get(address.toBase58());
    return { context: { slot: 1 }, value: a ? accountInfo(a) : null };
  });
  const getProgramAccounts = vi.fn(
    async (programId: PublicKey, config?: { filters?: Filter[] }) => {
      const out: Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }> = [];
      for (const a of byAddress.values()) {
        if (!new PublicKey(a.owner).equals(programId)) continue;
        const info = accountInfo(a);
        const ok = (config?.filters ?? []).every((f) => {
          if (f.dataSize !== undefined) return info.data.length === f.dataSize;
          if (f.memcmp) {
            const bytes = base58Decode(f.memcmp.bytes);
            return info.data
              .subarray(f.memcmp.offset, f.memcmp.offset + bytes.length)
              .equals(bytes);
          }
          return true;
        });
        if (ok) out.push({ pubkey: new PublicKey(a.address), account: info });
      }
      return out;
    },
  );
  const connection = {
    commitment: 'confirmed',
    rpcEndpoint: 'http://mock.invalid',
    getAccountInfoAndContext,
    getProgramAccounts,
  };
  return {
    connection: connection as unknown as Connection,
    getAccountInfoAndContext,
    getProgramAccounts,
  };
}

const noRetry = { retry: { attempts: 1, baseDelayMs: 0 } };

async function state(pool: string): Promise<DbcPoolState> {
  return getDbcPoolState(mockConnection().connection, key(pool), noRetry);
}

describe('fixtures', () => {
  it('are DBC program accounts', () => {
    for (const name of ['test1Pool', 'test1Config', 'test2Pool', 'test2Config']) {
      expect(fx(name).owner).toBe(DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58());
    }
  });
});

describe('getDbcPoolState', () => {
  it('decodes a pool and its config through the SDK fetchers', async () => {
    const s = await state('test1Pool');
    expect(s.address.equals(key('test1Pool'))).toBe(true);
    expect(s.virtualPool.poolState.config.equals(key('test1Config'))).toBe(true);
    expect(s.config.quoteMint.toBase58()).toBe('So11111111111111111111111111111111111111112');
  });

  it('throws pool_not_found for an unknown pool', async () => {
    const { connection } = mockConnection();
    const err = await getDbcPoolState(connection, PublicKey.unique(), noRetry).catch((e) => e);
    expect(err).toBeInstanceOf(DbcReadError);
    expect((err as DbcReadError).code).toBe('pool_not_found');
  });

  it('throws config_not_found when the config account is missing', async () => {
    const { connection } = mockConnection(['test1Pool']);
    const err = await getDbcPoolState(connection, key('test1Pool'), noRetry).catch((e) => e);
    expect((err as DbcReadError).code).toBe('config_not_found');
  });
});

describe('graduation', () => {
  it('a trading pool is not graduated', async () => {
    const s = await state('test1Pool');
    expect(graduationStatus(s)).toBe('trading');
    expect(isGraduated(s)).toBe(false);
  });

  it('a migrated pool is graduated', async () => {
    const s = await state('test2Pool');
    expect(graduationStatus(s)).toBe('migrated');
    expect(isGraduated(s)).toBe(true);
  });

  it('a pool whose reserve reached the threshold is curve_complete before migration', async () => {
    const s = await state('test1Pool');
    s.virtualPool.poolState.quoteReserve = s.config.migrationQuoteThreshold;
    expect(graduationStatus(s)).toBe('curve_complete');
    expect(isGraduated(s)).toBe(true);
  });

  it('migrationProgress = PostBondingCurve is curve_complete', async () => {
    const s = await state('test3Pool');
    s.virtualPool.poolState.migrationProgress = 1;
    expect(graduationStatus(s)).toBe('curve_complete');
  });
});

describe('curveProgress', () => {
  it('is quoteReserve / threshold in bps, floored', async () => {
    const s = await state('test1Pool');
    // 0.198 SOL in a 10 SOL curve.
    expect(curveProgress(s)).toEqual({
      bps: 198,
      quoteReserve: 198_000_000n,
      migrationQuoteThreshold: 10_000_000_000n,
    });
    const s3 = await state('test3Pool');
    expect(curveProgress(s3).bps).toBe(50);
  });

  it('is full once graduated', async () => {
    const s = await state('test2Pool');
    expect(curveProgress(s).bps).toBe(CURVE_PROGRESS_FULL_BPS);
  });

  it('floors partial basis points', async () => {
    const s = await state('test1Pool');
    s.virtualPool.poolState.quoteReserve = s.config.migrationQuoteThreshold.subn(1);
    expect(curveProgress(s).bps).toBe(9_999);
  });
});

describe('feeMetrics', () => {
  it('reports claimable partner/creator fees and lifetime totals as bigint', async () => {
    const s = await state('test3Pool');
    expect(feeMetrics(s)).toEqual({
      claimable: {
        partner: { base: 0n, quote: 30_000_000n },
        creator: { base: 0n, quote: 10_000_000n },
      },
      protocolUnclaimed: { base: 0n, quote: 10_000_000n },
      lifetime: {
        trading: { base: 0n, quote: 40_000_000n },
        protocol: { base: 0n, quote: 10_000_000n },
      },
      creatorTradingFeePercentage: 25,
    });
  });

  it('keeps fees claimable after migration', async () => {
    const m = feeMetrics(await state('test2Pool'));
    expect(m.claimable.creator.quote).toBe(1_737_887n);
    expect(m.claimable.partner.quote).toBe(7_957_185n);
  });
});

describe('listCoinsOfConfig', () => {
  it('lists the pools of a config with their reads', async () => {
    const { connection, getProgramAccounts } = mockConnection();
    const coins = await listCoinsOfConfig(connection, key('test1Config'), noRetry);
    expect(coins).toHaveLength(1);
    const coin = coins[0]!;
    expect(coin.pool.equals(key('test1Pool'))).toBe(true);
    expect(coin.creator.toBase58()).toBe('EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u');
    expect(coin.graduation).toBe('trading');
    expect(coin.progress.bps).toBe(198);
    expect(coin.fees.claimable.partner.quote).toBe(1_600_000n);
    // Both pool account variants are queried, filtered on the config at offset 72.
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list for a config without pools', async () => {
    const { connection } = mockConnection(['test2Config']);
    expect(await listCoinsOfConfig(connection, key('test2Config'), noRetry)).toEqual([]);
  });

  it('throws config_not_found for an unknown config', async () => {
    const { connection } = mockConnection();
    const err = await listCoinsOfConfig(connection, PublicKey.unique(), noRetry).catch((e) => e);
    expect((err as DbcReadError).code).toBe('config_not_found');
  });
});

describe('listCoinsOfCreator', () => {
  // The three fixture pools share this creator, each on its own config.
  const CREATOR = new PublicKey('EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u');
  /** Account discriminators of `VirtualPool` and `TransferHookPool` (SDK 1.5.13 IDL). */
  const VIRTUAL_POOL_DISCRIMINATOR = Buffer.from([213, 224, 5, 209, 98, 69, 119, 92]);
  const TRANSFER_HOOK_POOL_DISCRIMINATOR = Buffer.from([237, 219, 184, 23, 42, 189, 169, 35]);

  it('lists the pools of the creator on the given configs only', async () => {
    const { connection } = mockConnection();
    const coins = await listCoinsOfCreator(
      connection,
      CREATOR,
      [key('test1Config'), key('test3Config')],
      noRetry,
    );
    expect(coins.map((c) => c.pool.toBase58())).toEqual(
      [key('test1Pool'), key('test3Pool')].map((k) => k.toBase58()).sort(),
    );
    const test3 = coins.find((c) => c.pool.equals(key('test3Pool')))!;
    expect(test3.creator.equals(CREATOR)).toBe(true);
    expect(test3.config.equals(key('test3Config'))).toBe(true);
    expect(test3.fees.claimable.creator.quote).toBe(10_000_000n);
  });

  it('sends the getPoolsByCreator query: discriminator at 0, creator at 104, nothing else', async () => {
    const { connection, getProgramAccounts } = mockConnection();
    await listCoinsOfCreator(connection, CREATOR, [key('test1Config')], noRetry);
    expect(DBC_POOL_CREATOR_OFFSET).toBe(104);
    expect(DBC_POOL_CONFIG_OFFSET).toBe(72);
    // One query per pool account variant (plain and transfer-hook pools).
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
    const discriminators = getProgramAccounts.mock.calls.map(([programId, config]) => {
      expect(programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)).toBe(true);
      const { filters, ...rest } = config as { filters: Filter[] };
      // No dataSlice, no dataSize, no encoding override: the relay checks this exact shape.
      expect(Object.keys(rest).sort()).toEqual(['commitment']);
      expect(filters).toHaveLength(2);
      expect(filters[0]).toEqual({ memcmp: { offset: 0, bytes: expect.any(String) } });
      expect(filters[1]).toEqual({
        memcmp: { offset: DBC_POOL_CREATOR_OFFSET, bytes: CREATOR.toBase58(), encoding: 'base58' },
      });
      return base58Decode(filters[0]!.memcmp!.bytes);
    });
    expect(discriminators).toEqual([VIRTUAL_POOL_DISCRIMINATOR, TRANSFER_HOOK_POOL_DISCRIMINATOR]);
  });

  it('re-checks the creator and the config on the decoded data', async () => {
    const { connection, getProgramAccounts } = mockConnection();
    // A wrong answer (relay or provider) hands back every pool, whatever the filters.
    const all = ['test1Pool', 'test2Pool', 'test3Pool'].map((n) => ({
      pubkey: key(n),
      account: accountInfo(fx(n)),
    }));
    getProgramAccounts.mockImplementation(async (_programId, config) => {
      const first = config?.filters?.[0]?.memcmp?.bytes ?? '';
      return base58Decode(first).equals(VIRTUAL_POOL_DISCRIMINATOR) ? all : [];
    });
    const other = PublicKey.unique();
    expect(await listCoinsOfCreator(connection, other, [key('test1Config')], noRetry)).toEqual([]);
    const coins = await listCoinsOfCreator(connection, CREATOR, [key('test2Config')], noRetry);
    expect(coins.map((c) => c.pool.toBase58())).toEqual([key('test2Pool').toBase58()]);
  });

  it('keeps one entry per pool, sorted by pool address', async () => {
    const { connection, getProgramAccounts } = mockConnection();
    const pools = ['test3Pool', 'test1Pool', 'test3Pool'].map((n) => ({
      pubkey: key(n),
      account: accountInfo(fx(n)),
    }));
    getProgramAccounts.mockResolvedValueOnce(pools).mockResolvedValueOnce([]);
    const coins = await listCoinsOfCreator(
      connection,
      CREATOR,
      [key('test1Config'), key('test3Config')],
      noRetry,
    );
    const expected = [key('test1Pool'), key('test3Pool')].map((k) => k.toBase58()).sort();
    expect(coins.map((c) => c.pool.toBase58())).toEqual(expected);
  });

  it('reads only the configs that have a pool of the creator', async () => {
    const { connection, getAccountInfoAndContext } = mockConnection();
    await listCoinsOfCreator(
      connection,
      CREATOR,
      [key('test1Config'), PublicKey.unique(), PublicKey.unique()],
      noRetry,
    );
    const read = getAccountInfoAndContext.mock.calls.map(([address]) => address.toBase58());
    expect(new Set(read)).toEqual(new Set([key('test1Config').toBase58()]));
  });

  it('makes no RPC call without a config', async () => {
    const { connection, getProgramAccounts, getAccountInfoAndContext } = mockConnection();
    expect(await listCoinsOfCreator(connection, CREATOR, [], noRetry)).toEqual([]);
    expect(getProgramAccounts).not.toHaveBeenCalled();
    expect(getAccountInfoAndContext).not.toHaveBeenCalled();
  });

  it('throws config_not_found when the config of a matching pool is missing', async () => {
    const { connection } = mockConnection(['test1Pool']);
    const err = await listCoinsOfCreator(connection, CREATOR, [key('test1Config')], noRetry).catch(
      (e) => e,
    );
    expect((err as DbcReadError).code).toBe('config_not_found');
  });
});

describe('readCoin', () => {
  it('summarizes one pool', async () => {
    const coin = await readCoin(mockConnection().connection, key('test2Pool'), noRetry);
    expect(coin.graduation).toBe('migrated');
    expect(coin.baseMint.toBase58()).toBe('tzcZtpFfGoHVYF9TZBVm2Kaw5wRFzfomyjVABZ7YKH7');
  });

  it('includes the unclaimed partner share of the pool creation fee', async () => {
    const coin = await readCoin(mockConnection().connection, key('test2Pool'), noRetry);
    // Config fee 0.001 SOL, never claimed on this pool: the partner keeps 90%.
    expect(coin.poolCreationFee).toEqual({
      totalLamports: 1_000_000n,
      partnerShareLamports: 900_000n,
      partnerClaimed: false,
      partnerUnclaimedLamports: 900_000n,
    });
  });
});

describe('poolCreationFeeStatus', () => {
  const withBits = (s: DbcPoolState, creationFeeBits: number): DbcPoolState => ({
    ...s,
    virtualPool: { ...s.virtualPool, poolState: { ...s.virtualPool.poolState, creationFeeBits } },
  });

  it('reads the claim status from the pool creation fee bits', async () => {
    const s = await state('test2Pool');
    // Protocol claimed (0b01) only: the partner share is still there.
    expect(poolCreationFeeStatus(withBits(s, PROTOCOL_POOL_CREATION_FEE_CLAIMED_BIT))).toEqual({
      totalLamports: 1_000_000n,
      partnerShareLamports: 900_000n,
      partnerClaimed: false,
      partnerUnclaimedLamports: 900_000n,
    });
    for (const bits of [
      PARTNER_POOL_CREATION_FEE_CLAIMED_BIT,
      PARTNER_POOL_CREATION_FEE_CLAIMED_BIT | PROTOCOL_POOL_CREATION_FEE_CLAIMED_BIT,
    ]) {
      const status = poolCreationFeeStatus(withBits(s, bits));
      expect(status.partnerClaimed).toBe(true);
      expect(status.partnerUnclaimedLamports).toBe(0n);
      expect(status.partnerShareLamports).toBe(900_000n);
    }
  });

  it('is zero on a config without a creation fee', async () => {
    const status = poolCreationFeeStatus(await state('test1Pool'));
    expect(status).toEqual({
      totalLamports: 0n,
      partnerShareLamports: 0n,
      partnerClaimed: false,
      partnerUnclaimedLamports: 0n,
    });
  });

  it('leaves the protocol 10%, rounded down', () => {
    expect(partnerPoolCreationFeeShare(1_000_000n)).toBe(900_000n);
    expect(partnerPoolCreationFeeShare(1_000_009n)).toBe(900_009n);
    expect(partnerPoolCreationFeeShare(0n)).toBe(0n);
  });

  it('is listed with every coin of a config', async () => {
    const { connection } = mockConnection();
    const [coin] = await listCoinsOfConfig(connection, key('test1Config'), noRetry);
    expect(coin!.poolCreationFee.partnerUnclaimedLamports).toBe(0n);
  });
});

describe('retryRpc', () => {
  it('retries transient errors then succeeds', async () => {
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue(7);
    expect(await retryRpc(fn, { attempts: 3, baseDelayMs: 0 })).toBe(7);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-transient errors immediately', async () => {
    const fn = vi.fn<() => Promise<number>>().mockRejectedValue(new Error('custom program error'));
    await expect(retryRpc(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow('custom program');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt', async () => {
    const fn = vi.fn<() => Promise<number>>().mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(retryRpc(fn, { attempts: 2, baseDelayMs: 0 })).rejects.toThrow('ETIMEDOUT');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('classifies errors', () => {
    expect(isTransientRpcError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientRpcError(new Error('Transaction simulation failed'))).toBe(false);
  });
});
