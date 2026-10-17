// @vitest-environment node
import {
  CLAIM_COMPUTE_UNITS,
  ClaimError,
  POOL_CREATION_FEE_CLAIM_COMPUTE_UNITS,
  checkComputeBudgetInstructions,
  missingSigners,
} from '@forge/core';
import { ComputeBudgetProgram, Keypair, Transaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { RpcUnavailableError } from '../../jobs/chain';
import { ctx, request, spec } from '../../jobs/__tests__/fakes';
import { officialCoinsOfCoinConfig } from '../coins';
import { coin } from './fake-chain';
import { launchpadsHarness } from './helpers';

const owner = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const launchpadConfig = Keypair.generate().publicKey;
const coinConfig = Keypair.generate().publicKey;

let h: ReturnType<typeof launchpadsHarness>;

beforeEach(() => {
  h = launchpadsHarness();
});

/** The launchpad's own coin (`launchpads.launchpad_coin_mint`), on the coin config. */
const launchpadCoinMint = Keypair.generate().publicKey.toBase58();

function seed(poolCreationFeeSol = 0) {
  return h.store.addLaunchpad(owner, {
    spec: spec(owner, { poolCreationFeeSol }),
    launchpadConfig: launchpadConfig.toBase58(),
    launchpadCoinConfig: coinConfig.toBase58(),
    launchpadCoinMint,
  });
}

const claim = (id: string, wallet: string | null = owner, query = '') =>
  h.handlers.claimTransaction(
    request('GET', `/api/launchpads/${id}/claim-transaction${query}`, { wallet }),
    ctx(id),
  );

interface ClaimBody {
  transaction: string;
  summary: {
    pool: string;
    tradingFeesLamports: string;
    poolCreationFeeLamports: string;
    ownerCostLamports: string;
    remainingPools: number;
  };
}

function decode(base64: string): Transaction {
  return Transaction.from(Buffer.from(base64, 'base64'));
}

describe('GET /api/launchpads/:id/claim-transaction', () => {
  it('returns the unsigned partner claim of the richest pool, paid and signed by the owner', async () => {
    const lp = seed();
    const small = coin(launchpadConfig, 1_000_000n);
    const rich = coin(coinConfig, 9_000_000n, { baseMint: launchpadCoinMint });
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [small, coin(launchpadConfig, 0n)]);
    h.claimsChain.coins.set(coinConfig.toBase58(), [rich]);
    const res = await claim(lp.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimBody;
    expect(body.summary).toEqual({
      pool: rich.pool.toBase58(),
      tradingFeesLamports: '9000000',
      poolCreationFeeLamports: '0',
      ownerCostLamports: '5000',
      remainingPools: 1,
    });
    const tx = decode(body.transaction);
    expect(tx.feePayer?.toBase58()).toBe(owner);
    expect(missingSigners(tx).map((k) => k.toBase58())).toEqual([owner]);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    // Pool creation fee disabled in the spec: never read.
    expect(h.claimsChain.calls.some((c) => c.startsWith('pcf:'))).toBe(false);
  });

  it('adds the pool creation fee of the same pool when it fits', async () => {
    const lp = seed(0.01);
    const pool = coin(launchpadConfig, 2_000_000n);
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [pool]);
    h.claimsChain.poolCreationFees.set(pool.pool.toBase58(), 9_000_000n);
    const body = (await (await claim(lp.id)).json()) as ClaimBody;
    expect(body.summary.tradingFeesLamports).toBe('2000000');
    expect(body.summary.poolCreationFeeLamports).toBe('9000000');
    expect(decode(body.transaction).instructions).toHaveLength(5);
  });

  it('merges priced claims under one unit limit and one bounded price', async () => {
    const lp = seed(0.01);
    const pool = coin(launchpadConfig, 2_000_000n);
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [pool]);
    h.claimsChain.poolCreationFees.set(pool.pool.toBase58(), 9_000_000n);
    const quote = (computeUnitLimit: number, microLamports: number, maxLamports = 500_000n) => ({
      computeUnitLimit,
      microLamports,
      priorityFeeLamports: BigInt(Math.ceil((computeUnitLimit * microLamports) / 1_000_000)),
      maxLamports,
      source: 'recent_fees' as const,
    });
    h.claimsChain.priorityFees = {
      trading: quote(CLAIM_COMPUTE_UNITS, 100_000),
      pcf: quote(POOL_CREATION_FEE_CLAIM_COMPUTE_UNITS, 120_000),
    };
    const body = (await (await claim(lp.id)).json()) as ClaimBody;
    expect(body.summary.poolCreationFeeLamports).toBe('9000000');
    const tx = decode(body.transaction);
    const budget = tx.instructions.filter((ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId),
    );
    expect(budget).toHaveLength(2);
    expect(tx.instructions.indexOf(budget[0]!)).toBe(0);
    expect(budget[0]!.data.readUInt32LE(1)).toBe(300_000);
    expect(budget[1]!.data.readBigUInt64LE(1)).toBe(100_000n);
    // 4 + 1 claim instructions, one compute budget.
    expect(tx.instructions).toHaveLength(7);
    // 5,000 signature fee + 20,000 trading priority fee + 10,000 for the larger limit.
    expect(body.summary.ownerCostLamports).toBe(String(5000n + 20_000n + 10_000n));
    expect(checkComputeBudgetInstructions(tx.instructions).priorityFeeLamports).toBe(30_000n);

    // The cap holds after the merge: the price goes down instead.
    h.claimsChain.priorityFees = {
      trading: quote(CLAIM_COMPUTE_UNITS, 150_000, 30_000n),
      pcf: quote(POOL_CREATION_FEE_CLAIM_COMPUTE_UNITS, 300_000, 30_000n),
    };
    const capped = decode(((await (await claim(lp.id)).json()) as ClaimBody).transaction);
    const summary = checkComputeBudgetInstructions(capped.instructions);
    expect(summary.microLamports).toBe(100_000n);
    expect(summary.priorityFeeLamports).toBe(30_000n);
  });

  it('keeps the trading claim alone when the merge would be too large', async () => {
    const lp = seed(0.01);
    const pool = coin(launchpadConfig, 2_000_000n);
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [pool]);
    h.claimsChain.poolCreationFees.set(pool.pool.toBase58(), 9_000_000n);
    h.claimsChain.pcfInstructions = 30;
    const body = (await (await claim(lp.id)).json()) as ClaimBody;
    expect(body.summary.poolCreationFeeLamports).toBe('0');
    expect(decode(body.transaction).instructions).toHaveLength(4);
  });

  it('falls back to an unclaimed pool creation fee when no trading fees are left', async () => {
    const lp = seed(0.01);
    const empty = coin(launchpadConfig, 0n);
    const withFee = coin(launchpadConfig, 0n);
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [empty, withFee]);
    h.claimsChain.poolCreationFees.set(withFee.pool.toBase58(), 900_000n);
    const body = (await (await claim(lp.id)).json()) as ClaimBody;
    expect(body.summary).toMatchObject({
      pool: withFee.pool.toBase58(),
      tradingFeesLamports: '0',
      poolCreationFeeLamports: '900000',
      ownerCostLamports: '5000',
    });
  });

  it('answers 409 when there is nothing worth claiming', async () => {
    const lp = seed();
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [coin(launchpadConfig, 0n)]);
    const none = await claim(lp.id);
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: 'NOTHING_TO_CLAIM' });

    const dust = coin(launchpadConfig, 10n);
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [dust]);
    h.claimsChain.belowCost.add(dust.pool.toBase58());
    const small = await claim(lp.id);
    expect(small.status).toBe(409);
    expect(((await small.json()) as { message: string }).message).toMatch(/smaller than the cost/);
  });

  it('answers 404 to another wallet and 409 for a launchpad without configs', async () => {
    const lp = seed();
    expect((await claim(lp.id, other)).status).toBe(404);
    expect((await claim(lp.id, null)).status).toBe(401);
    const draft = h.store.addLaunchpad(owner, { status: 'draft' });
    const res = await claim(draft.id);
    expect(res.status).toBe(409);
    expect(h.claimsChain.calls).toEqual([]);
  });

  it('targets one pool of the launchpad on request, never a foreign one', async () => {
    const lp = seed();
    const a = coin(launchpadConfig, 5_000_000n);
    const b = coin(launchpadConfig, 1_000_000n);
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [a, b]);
    const picked = (await (
      await claim(lp.id, owner, `?pool=${b.pool.toBase58()}`)
    ).json()) as ClaimBody;
    expect(picked.summary.pool).toBe(b.pool.toBase58());
    const foreign = await claim(lp.id, owner, `?pool=${Keypair.generate().publicKey.toBase58()}`);
    expect(foreign.status).toBe(404);
    expect((await claim(lp.id, owner, '?pool=nope')).status).toBe(400);
    expect((await claim(lp.id, owner, '?other=1')).status).toBe(400);
  });

  it('claims only the launchpad coin on the coin config, never a look-alike pool', async () => {
    const lp = seed();
    const official = coin(coinConfig, 1_000_000n, { baseMint: launchpadCoinMint });
    // Anyone can create a pool on the coin config: richer, but not the launchpad's coin.
    const lookalike = coin(coinConfig, 50_000_000n);
    h.claimsChain.coins.set(coinConfig.toBase58(), [lookalike, official]);
    const body = (await (await claim(lp.id)).json()) as ClaimBody;
    expect(body.summary.pool).toBe(official.pool.toBase58());
    expect(body.summary.remainingPools).toBe(0);
    expect(h.claimsChain.calls).not.toContain(`partner:${lookalike.pool.toBase58()}`);
    // Asked for by pool, the look-alike is not a coin of this launchpad.
    const asked = await claim(lp.id, owner, `?pool=${lookalike.pool.toBase58()}`);
    expect(asked.status).toBe(404);
    expect(h.logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'coin_config.lookalikes',
        fields: expect.objectContaining({ launchpadId: lp.id, count: 1 }),
      }),
    );
  });

  it('officialCoinsOfCoinConfig keeps the launchpad coin mint only', () => {
    const official = coin(coinConfig, 1n, { baseMint: launchpadCoinMint });
    const others = [coin(coinConfig, 2n), coin(coinConfig, 3n)];
    expect(
      officialCoinsOfCoinConfig([others[0]!, official, others[1]!], launchpadCoinMint),
    ).toEqual({ official: [official], lookalikes: 2 });
    expect(officialCoinsOfCoinConfig([official, ...others], null)).toEqual({
      official: [],
      lookalikes: 3,
    });
    expect(officialCoinsOfCoinConfig([], launchpadCoinMint)).toEqual({
      official: [],
      lookalikes: 0,
    });
  });

  it('has no official coin on the coin config before the launch', async () => {
    const lp = h.store.addLaunchpad(owner, {
      spec: spec(owner),
      launchpadCoinConfig: coinConfig.toBase58(),
      launchpadCoinMint: null,
    });
    h.claimsChain.coins.set(coinConfig.toBase58(), [coin(coinConfig, 7_000_000n)]);
    const res = await claim(lp.id);
    expect(res.status).toBe(409);
    expect(h.claimsChain.calls.some((c) => c.startsWith('partner:'))).toBe(false);
  });

  it('refuses a launchpad whose spec names another owner', async () => {
    const lp = h.store.addLaunchpad(owner, {
      spec: spec(other),
      launchpadConfig: launchpadConfig.toBase58(),
    });
    expect((await claim(lp.id)).status).toBe(403);
  });

  it('maps core claim refusals and RPC failures', async () => {
    const lp = seed();
    h.claimsChain.coins.set(launchpadConfig.toBase58(), [coin(launchpadConfig, 5_000_000n)]);
    h.claimsChain.claimError = new ClaimError('claimer_wsol_not_empty', 'detail with address');
    const wsol = await claim(lp.id);
    expect(wsol.status).toBe(409);
    const body = (await wsol.json()) as { code: string; message: string };
    expect(body.code).toBe('TRANSACTION_REJECTED');
    expect(body.message).not.toContain('detail');

    h.claimsChain.claimError = null;
    h.claimsChain.failList = new RpcUnavailableError();
    const down = await claim(lp.id);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });
});
