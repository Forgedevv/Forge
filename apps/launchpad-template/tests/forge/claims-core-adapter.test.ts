import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  listCoinsOfConfig: vi.fn(),
  listCoinsOfCreator: vi.fn(),
  buildCreatorClaimTx: vi.fn(),
}));

vi.mock('@forge/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forge/core')>()),
  ...core,
}));

import { ClaimError } from '@forge/core';
import { createCoreClaimsCore } from '../../src/forge/claims/core-adapter';

const connection = {} as Connection;
const config = Keypair.generate().publicKey;
const creator = Keypair.generate();
const other = Keypair.generate().publicKey;

afterEach(() => {
  for (const fn of Object.values(core)) fn.mockReset();
});

const coin = (overrides: Record<string, unknown> = {}) => ({
  pool: Keypair.generate().publicKey,
  config,
  baseMint: Keypair.generate().publicKey,
  creator: creator.publicKey,
  graduation: 'trading',
  fees: {
    claimable: {
      creator: { base: BigInt(0), quote: BigInt(1_500_000_000) },
      partner: { base: BigInt(0), quote: BigInt(9) },
    },
  },
  ...overrides,
});

function adapter(configs: string[] = [config.toBase58()], conn: Connection | null = connection) {
  return createCoreClaimsCore({ getConnection: () => conn, launchpadConfigs: configs });
}

describe('claims core backed by @forge/core', () => {
  it('lists only the coins of the wallet on this launchpad, with their creator share', async () => {
    const mine = coin();
    const migrated = coin({ graduation: 'migrated' });
    // Re-checked here too: a coin of another creator or another config is never shown.
    const notMine = coin({ creator: other });
    const otherConfig = coin({ config: Keypair.generate().publicKey });
    core.listCoinsOfCreator.mockResolvedValue([mine, notMine, migrated, otherConfig]);

    const coins = await adapter().listCreatorCoins(creator.publicKey.toBase58());

    expect(core.listCoinsOfCreator).toHaveBeenCalledTimes(1);
    const [conn, owner, configs] = core.listCoinsOfCreator.mock.calls[0] as [
      Connection,
      PublicKey,
      PublicKey[],
    ];
    expect(conn).toBe(connection);
    expect(owner.equals(creator.publicKey)).toBe(true);
    expect(configs.map((c) => c.toBase58())).toEqual([config.toBase58()]);
    expect(coins).toEqual([
      {
        pool: mine.pool.toBase58(),
        mint: mine.baseMint.toBase58(),
        graduated: false,
        claimableQuoteLamports: BigInt(1_500_000_000),
        claimableBaseRaw: BigInt(0),
        baseDecimals: 6,
      },
      expect.objectContaining({ pool: migrated.pool.toBase58(), graduated: true }),
    ]);
  });

  it('regression: never lists a whole config (the relay refuses that program scan)', async () => {
    core.listCoinsOfCreator.mockResolvedValue([]);
    await adapter().listCreatorCoins(creator.publicKey.toBase58());
    expect(core.listCoinsOfConfig).not.toHaveBeenCalled();
  });

  it('reads every configured launchpad config in one creator query', async () => {
    const second = Keypair.generate().publicKey;
    const onSecond = coin({ config: second });
    core.listCoinsOfCreator.mockResolvedValue([onSecond]);
    const coins = await adapter([config.toBase58(), second.toBase58()]).listCreatorCoins(
      creator.publicKey.toBase58(),
    );
    expect(core.listCoinsOfCreator).toHaveBeenCalledTimes(1);
    const configs = (core.listCoinsOfCreator.mock.calls[0] as [unknown, unknown, PublicKey[]])[2];
    expect(configs.map((c) => c.toBase58())).toEqual([config.toBase58(), second.toBase58()]);
    expect(coins.map((c) => c.pool)).toEqual([onSecond.pool.toBase58()]);
  });

  it('fails on read errors', async () => {
    core.listCoinsOfCreator.mockRejectedValueOnce(new Error('rpc down'));
    await expect(adapter().listCreatorCoins(creator.publicKey.toBase58())).rejects.toThrow(
      'rpc down',
    );
  });

  it('does not call the chain without a launchpad config', async () => {
    await expect(adapter([]).listCreatorCoins(creator.publicKey.toBase58())).resolves.toEqual([]);
    expect(core.listCoinsOfCreator).not.toHaveBeenCalled();
  });

  it('fails loudly when the RPC relay is not configured', async () => {
    await expect(adapter([config.toBase58()], null).listCreatorCoins('x')).rejects.toThrow(
      /not configured/,
    );
  });

  it('builds the claim to the wallet and returns a versioned, unsigned transaction', async () => {
    const poolKey = Keypair.generate().publicKey;
    const legacy = new Transaction({
      feePayer: creator.publicKey,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 10,
    }).add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: other, lamports: 1 }));
    const costs = {
      networkFeeLamports: BigInt(5000),
      receiverTokenAccountRentLamports: BigInt(2039280),
      temporaryLamports: BigInt(2039280),
      payerTotalLamports: BigInt(2044280),
      payerRequiredBalanceLamports: BigInt(4083560),
    };
    core.buildCreatorClaimTx.mockResolvedValue({
      transaction: legacy,
      lastValidBlockHeight: 10,
      skipReason: null,
      summary: { costs, netLamports: BigInt(1) },
    });

    const { tx, costs: returned } = await adapter().buildCreatorClaimTx({
      pool: poolKey.toBase58(),
      creator: creator.publicKey.toBase58(),
      receiver: creator.publicKey.toBase58(),
    });

    expect(core.buildCreatorClaimTx).toHaveBeenCalledTimes(1);
    const [, params] = core.buildCreatorClaimTx.mock.calls[0] as [
      unknown,
      Record<string, PublicKey>,
    ];
    expect(params.pool.equals(poolKey)).toBe(true);
    expect(params.creator.equals(creator.publicKey)).toBe(true);
    expect(params.receiver.equals(creator.publicKey)).toBe(true);
    expect(tx).toBeInstanceOf(VersionedTransaction);
    expect(tx.message.staticAccountKeys[0]?.equals(creator.publicKey)).toBe(true);
    expect(tx.signatures.every((s) => s.every((byte) => byte === 0))).toBe(true);
    // The core's costs (coin account rent and temporary WSOL rent included) are handed over.
    expect(returned).toEqual(costs);
  });

  it('refuses to hand over an empty claim', async () => {
    core.buildCreatorClaimTx.mockResolvedValue({
      transaction: null,
      lastValidBlockHeight: null,
      skipReason: 'nothing_to_claim',
    });
    await expect(
      adapter().buildCreatorClaimTx({
        pool: Keypair.generate().publicKey.toBase58(),
        creator: creator.publicKey.toBase58(),
        receiver: creator.publicKey.toBase58(),
      }),
    ).rejects.toThrow(/nothing to claim/);
  });

  it('keeps the core refusal message', async () => {
    core.buildCreatorClaimTx.mockRejectedValue(
      new ClaimError('not_pool_creator', 'This wallet is not the creator of the pool'),
    );
    await expect(
      adapter().buildCreatorClaimTx({
        pool: Keypair.generate().publicKey.toBase58(),
        creator: creator.publicKey.toBase58(),
        receiver: creator.publicKey.toBase58(),
      }),
    ).rejects.toThrow('This wallet is not the creator of the pool');
  });
});
