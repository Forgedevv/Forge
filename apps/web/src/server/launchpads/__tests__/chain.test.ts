// @vitest-environment node
import * as core from '@forge/core';
import { Keypair, type Connection } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClusterMismatchError, RpcUnavailableError } from '../../jobs/chain';
import { createCoreClaimsChain } from '../chain';

vi.mock('@forge/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forge/core')>();
  return {
    ...actual,
    listCoinsOfConfig: vi.fn(),
    buildPartnerClaimTx: vi.fn(),
    buildPartnerPoolCreationFeeClaimTx: vi.fn(),
  };
});

const listCoins = vi.mocked(core.listCoinsOfConfig);
const partner = vi.mocked(core.buildPartnerClaimTx);
const pcf = vi.mocked(core.buildPartnerPoolCreationFeeClaimTx);

function connection(genesis: string = core.CLUSTER_GENESIS_HASH.devnet): Connection {
  return { getGenesisHash: async () => genesis } as unknown as Connection;
}

const owner = Keypair.generate().publicKey;
const pool = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;

beforeEach(() => {
  listCoins.mockReset();
  partner.mockReset();
  pcf.mockReset();
});

describe('createCoreClaimsChain', () => {
  it('builds both claims with the owner as fee claimer, receiver and payer', async () => {
    partner.mockResolvedValue({} as never);
    pcf.mockResolvedValue({} as never);
    const chain = createCoreClaimsChain({ connection: connection(), cluster: 'devnet' });
    await chain.buildPartnerClaim(pool, owner);
    await chain.buildPoolCreationFeeClaim(pool, owner);
    expect(partner.mock.calls[0]![1]).toEqual({
      pool,
      feeClaimer: owner,
      receiver: owner,
      payer: owner,
    });
    expect(partner.mock.calls[0]![2]).toMatchObject({ minNetLamports: 0n });
    expect(pcf.mock.calls[0]![1]).toEqual({
      pool,
      feeClaimer: owner,
      receiver: owner,
      payer: owner,
    });
  });

  it('caches coin lists briefly and treats an unknown config as empty', async () => {
    let now = 0;
    listCoins
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new core.DbcReadError('config_not_found', 'missing'));
    const chain = createCoreClaimsChain({
      connection: connection(),
      cluster: 'devnet',
      now: () => now,
    });
    await chain.listCoins(config);
    await chain.listCoins(config);
    expect(listCoins).toHaveBeenCalledTimes(1);
    now = 31_000;
    expect(await chain.listCoins(config)).toEqual([]);
    expect(listCoins).toHaveBeenCalledTimes(2);
  });

  it('passes core business errors through and hides RPC errors', async () => {
    partner.mockRejectedValueOnce(new core.ClaimError('not_fee_claimer', 'x'));
    partner.mockRejectedValueOnce(new Error('429 https://rpc/?api-key=SECRET'));
    const chain = createCoreClaimsChain({ connection: connection(), cluster: 'devnet' });
    await expect(chain.buildPartnerClaim(pool, owner)).rejects.toBeInstanceOf(core.ClaimError);
    const hidden = await chain.buildPartnerClaim(pool, owner).catch((e: unknown) => e);
    expect(hidden).toBeInstanceOf(RpcUnavailableError);
    expect((hidden as Error).message).not.toContain('SECRET');
  });

  it('refuses another cluster', async () => {
    const chain = createCoreClaimsChain({
      connection: connection(core.CLUSTER_GENESIS_HASH['mainnet-beta']),
      cluster: 'devnet',
    });
    await expect(chain.assertCluster()).rejects.toBeInstanceOf(ClusterMismatchError);
  });
});
