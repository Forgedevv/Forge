// @vitest-environment node
import { encodeBase58 } from '@forge/core';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { RpcUnavailableError } from '../chain';
import { createJobsHandlers, type JobsHandlers } from '../handlers';
import { createOwnerTransactionService } from '../owner-transaction';
import { createJobsService } from '../service';
import { ctx, harness, launchTransaction, ownerSign, request, spec } from './fakes';
import { coinLaunch, type CoinLaunchOptions } from './launch-fixture';

const ownerKey = Keypair.generate();
const owner = ownerKey.publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();

let h: ReturnType<typeof harness>;
let handlers: JobsHandlers;

beforeEach(() => {
  h = harness();
  handlers = createJobsHandlers({
    jobs: createJobsService({ store: h.store, logger: h.logger }),
    ownerTransactions: createOwnerTransactionService({
      store: h.store,
      chain: h.chain,
      logger: h.logger,
    }),
    rateLimiter: h.rateLimiter,
    logger: h.logger,
  });
});

/** A job waiting for the owner's signature of the launch core builds for its launchpad. */
function seed(
  overrides: Parameters<typeof h.store.addJob>[1] = {},
  options: CoinLaunchOptions = {},
) {
  const launch = coinLaunch(ownerKey, options);
  const launchpad = h.store.addLaunchpad(owner, {
    status: 'draft',
    launchpadCoinConfig: launch.config.toBase58(),
    launchpadCoinMint: launch.mint.publicKey.toBase58(),
  });
  const job = h.store.addJob(launchpad.id, {
    status: 'awaiting_owner_signature',
    ownerTx: launch.base64,
    ...overrides,
  });
  return { launchpad, job, launch };
}

const get = (jobId: string, wallet: string | null = owner) =>
  handlers.getOwnerTransaction(
    request('GET', `/api/jobs/${jobId}/owner-transaction`, { wallet }),
    ctx(jobId),
  );

const post = (jobId: string, signedTransaction: unknown, wallet: string | null = owner) =>
  handlers.submitOwnerTransaction(
    request('POST', `/api/jobs/${jobId}/owner-transaction`, {
      wallet,
      body: typeof signedTransaction === 'string' ? { signedTransaction } : signedTransaction,
    }),
    ctx(jobId),
  );

function signatureOf(base64: string): string {
  return encodeBase58(Transaction.from(Buffer.from(base64, 'base64')).signature!);
}

describe('GET /api/jobs/:id/owner-transaction', () => {
  it('returns the stored transaction byte for byte with the summary', async () => {
    const { job, launch } = seed();
    const res = await get(job.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.transaction).toBe(launch.base64);
    // 0.5 SOL first buy; simulated debit 0.52 SOL; network fee added on top (upper bound).
    expect(body.summary).toEqual({
      coinName: 'Moon',
      coinSymbol: 'MOON',
      firstBuyLamports: '500000000',
      estimatedNetworkFeeLamports: '20015000',
      ownerWallet: owner,
    });
    expect(body.simulation).toBe('ok');
  });

  it('falls back to the network fee when the simulation fails', async () => {
    const { job } = seed();
    h.chain.estimate = {
      networkFeeLamports: 15_000n,
      ownerDebitLamports: null,
      simulationFailed: true,
    };
    const body = (await (await get(job.id)).json()) as {
      summary: { estimatedNetworkFeeLamports: string };
      simulation: string;
    };
    expect(body.summary.estimatedNetworkFeeLamports).toBe('15000');
    expect(body.simulation).toBe('failed');
  });

  it('answers 404 to another wallet', async () => {
    const { job } = seed();
    const res = await get(job.id, other);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('transaction');
  });

  it('refuses a job that is not waiting for the signature', async () => {
    const early = seed({ status: 'onchain_setup', ownerTx: null });
    expect((await get(early.job.id)).status).toBe(409);
    const signed = seed({ status: 'owner_signed' });
    const res = await get(signed.job.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ALREADY_SIGNED' });
  });

  it('refuses a modification job', async () => {
    const { job } = seed({ type: 'modify_launchpad' });
    expect((await get(job.id)).status).toBe(409);
  });

  it('never hands out a stored transaction the owner does not pay or that lacks FORGE signatures', async () => {
    const stranger = launchTransaction(Keypair.generate());
    const wrongPayer = seed({ ownerTx: stranger.base64 });
    const res = await get(wrongPayer.job.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'OWNER_TX_UNAVAILABLE' });

    const unsigned = new Transaction({
      feePayer: ownerKey.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    }).add(
      SystemProgram.transfer({
        fromPubkey: Keypair.generate().publicKey,
        toPubkey: ownerKey.publicKey,
        lamports: 1,
      }),
    );
    const incomplete = seed({
      ownerTx: unsigned
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
    });
    expect((await get(incomplete.job.id)).status).toBe(503);
    expect(h.logger.events()).toContain('owner_tx.unusable');
  });

  it('refuses when the stored spec names another owner', async () => {
    const { launchpad, job } = seed();
    h.store.launchpads.set(launchpad.id, { ...launchpad, spec: spec(other) });
    const res = await get(job.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'WRONG_WALLET' });
  });

  // Before: only the fee payer and the missing signer were checked, so any transaction paid by the
  // owner and pre-signed by two keys was handed out for signature.
  it.each<
    [string, CoinLaunchOptions, ((lp: { launchpadCoinMint: string | null }) => object) | null]
  >([
    ['a first buy other than the spec', { firstBuyLamports: 1n }, null],
    ['another coin name', { name: 'Mars' }, null],
    [
      'SOL sent to someone else',
      {
        extra: (payer) => [
          SystemProgram.transfer({
            fromPubkey: payer,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1,
          }),
        ],
      },
      null,
    ],
    ['another mint than the launchpad row', {}, () => ({ launchpadCoinMint: other })],
    ['no coin config or mint on the row yet', {}, () => ({ launchpadCoinConfig: null })],
  ])('never hands out a stored launch with %s', async (_label, options, rowChange) => {
    const { launchpad, job, launch } = seed({}, options);
    if (rowChange) h.store.launchpads.set(launchpad.id, { ...launchpad, ...rowChange(launchpad) });
    const res = await get(job.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'OWNER_TX_UNAVAILABLE' });
    expect(h.logger.entries.find((e) => e.event === 'owner_tx.unusable')?.fields.reason).toMatch(
      /^launch_(check_mismatch|addresses_missing)$/,
    );
    // Nor accepted signed: nothing is sent.
    expect((await post(job.id, ownerSign(launch.base64, ownerKey))).status).toBe(503);
    expect(h.chain.calls).not.toContain('send');
  });
});

describe('POST /api/jobs/:id/owner-transaction', () => {
  it('sends the owner-signed copy, confirms it and moves the job to owner_signed', async () => {
    const { job, launch } = seed();
    const signed = ownerSign(launch.base64, ownerKey);
    const res = await post(job.id, signed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: signatureOf(signed) });
    expect(h.store.status(job.id)).toBe('owner_signed');
    expect(h.chain.calls).toEqual(['assertCluster', 'status', 'send', 'confirm']);
    expect(h.chain.sent[0]!.serialize().toString('base64')).toBe(signed);
    expect(h.store.events.map((e) => e.message)).toEqual([
      'Launch transaction confirmed on-chain.',
    ]);
  });

  it('is idempotent: a replay after success sends nothing and returns the same signature', async () => {
    const { job, launch } = seed();
    const signed = ownerSign(launch.base64, ownerKey);
    await post(job.id, signed);
    h.chain.calls = [];
    const again = await post(job.id, signed);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ signature: signatureOf(signed) });
    expect(h.chain.calls).toEqual([]);
    expect(h.store.events).toHaveLength(1);
  });

  it('never accepts a substitute transaction, even one the owner signed', async () => {
    const { job } = seed();
    const substitute = launchTransaction(ownerKey, { lamports: 1 });
    const res = await post(job.id, ownerSign(substitute.base64, ownerKey));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'TRANSACTION_MISMATCH' });
    expect(h.chain.calls).toEqual([]);
    expect(h.store.status(job.id)).toBe('awaiting_owner_signature');
    expect(h.logger.events()).toContain('owner_tx.substitution_rejected');
  });

  it('refuses a substitute even after the job was signed (replay path)', async () => {
    const { job } = seed({ status: 'owner_signed' });
    const substitute = launchTransaction(ownerKey, { lamports: 2 });
    const res = await post(job.id, ownerSign(substitute.base64, ownerKey));
    expect(res.status).toBe(422);
    expect(h.chain.calls).toEqual([]);
  });

  it('refuses a tampered copy of the stored transaction', async () => {
    const { job, launch } = seed();
    const tx = Transaction.from(Buffer.from(launch.base64, 'base64'));
    tx.instructions[0] = SystemProgram.transfer({
      fromPubkey: ownerKey.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 500_000_000,
    });
    tx.partialSign(ownerKey);
    const tampered = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const res = await post(job.id, tampered.toString('base64'));
    expect([400, 422]).toContain(res.status);
    expect(h.chain.calls).toEqual([]);
  });

  it('refuses the stored transaction without the owner signature', async () => {
    const { job, launch } = seed();
    const res = await post(job.id, launch.base64);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'TRANSACTION_INVALID' });
    expect(h.chain.calls).toEqual([]);
  });

  it('refuses another wallet and wrong statuses without sending', async () => {
    const { job, launch } = seed();
    const signed = ownerSign(launch.base64, ownerKey);
    expect((await post(job.id, signed, other)).status).toBe(404);
    expect((await post(job.id, signed, null)).status).toBe(401);
    const early = seed({ status: 'approved' });
    expect((await post(early.job.id, ownerSign(early.launch.base64, ownerKey))).status).toBe(409);
    expect(h.chain.calls).toEqual([]);
  });

  it('rejects malformed bodies', async () => {
    const { job, launch } = seed();
    const signed = ownerSign(launch.base64, ownerKey);
    expect((await post(job.id, { signedTransaction: signed, extra: 1 })).status).toBe(400);
    expect((await post(job.id, { signedTransaction: 'not base64!' })).status).toBe(400);
    expect((await post(job.id, { signedTransaction: 'A'.repeat(5000) })).status).toBe(400);
    expect(h.chain.calls).toEqual([]);
  });

  it('does not send again a transaction the cluster already confirmed', async () => {
    const { job, launch } = seed();
    h.chain.states = ['confirmed'];
    const res = await post(job.id, ownerSign(launch.base64, ownerKey));
    expect(res.status).toBe(200);
    expect(h.chain.calls).toEqual(['assertCluster', 'status']);
    expect(h.store.status(job.id)).toBe('owner_signed');
  });

  it('reports a pending confirmation, then completes on the retry without a second send', async () => {
    const { job, launch } = seed();
    const signed = ownerSign(launch.base64, ownerKey);
    h.chain.confirmOutcome = 'timeout';
    const first = await post(job.id, signed);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      code: 'CONFIRMATION_PENDING',
      signature: signatureOf(signed),
    });
    expect(h.store.status(job.id)).toBe('awaiting_owner_signature');

    h.chain.calls = [];
    h.chain.states = ['pending'];
    h.chain.confirmOutcome = 'confirmed';
    const retry = await post(job.id, signed);
    expect(retry.status).toBe(200);
    expect(h.chain.calls).toEqual(['assertCluster', 'status', 'confirm']);
    expect(h.store.status(job.id)).toBe('owner_signed');
  });

  it('reports an on-chain failure and leaves the job for manual handling', async () => {
    const { job, launch } = seed();
    h.chain.confirmOutcome = 'failed';
    const res = await post(job.id, ownerSign(launch.base64, ownerKey));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(h.store.status(job.id)).toBe('awaiting_owner_signature');
    expect(h.logger.events()).toContain('owner_tx.failed_onchain');

    h.chain.calls = [];
    h.chain.states = ['failed'];
    const again = await post(job.id, ownerSign(launch.base64, ownerKey));
    expect(again.status).toBe(422);
    expect(h.chain.calls).not.toContain('send');
  });

  it('maps preflight rejections and an expired nonce', async () => {
    const a = seed();
    h.chain.sendOutcome = { status: 'rejected', reason: 'insufficient_funds' };
    const rejected = await post(a.job.id, ownerSign(a.launch.base64, ownerKey));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: 'TRANSACTION_REJECTED' });
    expect(h.store.status(a.job.id)).toBe('awaiting_owner_signature');

    const b = seed();
    h.chain.sendOutcome = { status: 'expired' };
    const expired = await post(b.job.id, ownerSign(b.launch.base64, ownerKey));
    expect(expired.status).toBe(422);
    expect(await expired.json()).toMatchObject({ code: 'TRANSACTION_EXPIRED' });
  });

  it('sends nothing on a wrong cluster and answers 503 on RPC failures', async () => {
    const { job, launch } = seed();
    const signed = ownerSign(launch.base64, ownerKey);
    h.chain.clusterOk = false;
    const wrong = await post(job.id, signed);
    expect(wrong.status).toBe(503);
    expect(await wrong.json()).toMatchObject({ code: 'WRONG_CLUSTER' });
    expect(h.chain.sent).toHaveLength(0);

    h.chain.clusterOk = true;
    h.chain.sendError = new RpcUnavailableError();
    const down = await post(job.id, signed);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: 'RPC_UNAVAILABLE' });
    expect(h.store.status(job.id)).toBe('awaiting_owner_signature');
  });

  it('accepts a concurrent request that moved the job first', async () => {
    const { job, launch } = seed();
    h.store.beforeTransition = (id) => {
      h.store.jobs.set(id, { ...h.store.jobs.get(id)!, status: 'owner_signed' });
      h.store.beforeTransition = null;
    };
    const res = await post(job.id, ownerSign(launch.base64, ownerKey));
    expect(res.status).toBe(200);
    expect(h.store.status(job.id)).toBe('owner_signed');
  });

  it('refuses a disabled launchpad before sending', async () => {
    const { launchpad, job, launch } = seed();
    h.store.launchpads.set(launchpad.id, { ...launchpad, status: 'disabled' });
    const res = await post(job.id, ownerSign(launch.base64, ownerKey));
    expect(res.status).toBe(403);
    expect(h.chain.calls).toEqual([]);
  });
});
