import { readFileSync } from 'node:fs';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  CURVE_PROGRESS_FULL_BPS,
  DbcReadError,
  curveProgress,
  feeMetrics,
  getDbcPoolState,
  graduationStatus,
  isGraduated,
  isTransientRpcError,
  listCoinsOfConfig,
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

describe('readCoin', () => {
  it('summarizes one pool', async () => {
    const coin = await readCoin(mockConnection().connection, key('test2Pool'), noRetry);
    expect(coin.graduation).toBe('migrated');
    expect(coin.baseMint.toBase58()).toBe('tzcZtpFfGoHVYF9TZBVm2Kaw5wRFzfomyjVABZ7YKH7');
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
