import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { deserializeTransactionBase64, missingSigners } from '@forge/core';
import { creatorRole } from '../keystore.js';
import { createSignerServer, signRequest } from '../server.js';
import { dbcAccounts, ok, refused, setup, useTestKeystore, type Harness } from './harness.js';
import { createSignerRoutes } from './index.js';
import type { SignerLaunchPrepareResult } from './schemas.js';
import { randomKey } from './testing.js';

// Every FORGE signature decrypts a keystore key (scrypt): slow under a parallel test run.
vi.setConfig({ testTimeout: 60_000 });

const ks = useTestKeystore();

// ---------------------------------------------------------------------------------------
// POST /v1/launch-coin/prepare

async function prepared(h: Harness): Promise<SignerLaunchPrepareResult> {
  ok(await h.routes.configs({ jobId: h.jobId }));
  return ok(await h.routes.launchCoinPrepare({ jobId: h.jobId }));
}

/** The client signs the prepared transaction and sends it (what apps/web relays). */
async function clientSends(h: Harness, base64: string): Promise<string> {
  const tx = deserializeTransactionBase64(base64);
  tx.partialSign(h.owner);
  return h.chain.sendRawTransaction(tx.serialize({ requireAllSignatures: true }));
}

describe('POST /v1/launch-coin/prepare', () => {
  it('returns a durable-nonce launch signed by the creator and the mint, for the client to sign', async () => {
    const h = await setup(ks.keystore);
    const body = await prepared(h);
    const tx = deserializeTransactionBase64(body.partiallySignedTx);
    const creatorRef = (await ks.keystore.findRef(creatorRole(h.launchpadId)))!;
    const creator = await ks.keystore.getPublicKey(creatorRef);

    expect(missingSigners(tx).map((k) => k.toBase58())).toEqual([h.owner.publicKey.toBase58()]);
    expect(tx.feePayer!.equals(h.owner.publicKey)).toBe(true);
    expect(tx.signatures.find((s) => s.publicKey.equals(creator))?.signature).not.toBeNull();
    expect(
      tx.signatures.find((s) => s.publicKey.toBase58() === body.mint)?.signature,
    ).not.toBeNull();
    expect(body.details).toMatchObject({
      creator: creator.toBase58(),
      config: h.store.launchpads.get(h.launchpadId)!.launchpadCoinConfig,
      metadataUri: 'https://meta.forge.test/coins/moonpad.json',
    });
    // Nonce account: created once by the payer, authority = the creator wallet.
    const nonce = h.chain.accounts.get(body.details!.nonceAccount)!;
    expect(nonce.nonce!.authority.equals(creator)).toBe(true);
    expect(tx.recentBlockhash).toBe(nonce.nonce!.value);
    expect(body.summary).toEqual({
      coinName: 'Moon',
      coinSymbol: 'MOON',
      firstBuyLamports: '10000000',
      estimatedNetworkFeeLamports: '22054280',
      ownerRequiredBalanceLamports: '34093560',
      ownerWallet: h.owner.publicKey.toBase58(),
    });
    expect(h.store.launchpads.get(h.launchpadId)!.launchpadCoinMint).toBe(body.mint);

    // The client's signature completes it, and it lands.
    await clientSends(h, body.partiallySignedTx);
    expect(h.chain.accounts.has(body.mint)).toBe(true);
  });

  it('is idempotent: the same transaction while the nonce is unused, nothing rebuilt', async () => {
    const h = await setup(ks.keystore);
    const first = await prepared(h);
    const again = ok(await h.routes.launchCoinPrepare({ jobId: h.jobId }));
    const afterRestart = ok(await h.restart().launchCoinPrepare({ jobId: h.jobId }));
    expect(again).toEqual(first);
    expect(afterRestart).toEqual(first);
    expect(h.chain.built.launch).toBe(1);
    expect(h.chain.built.nonce).toBe(1);
  });

  it('refuses before the configs exist', async () => {
    const h = await setup(ks.keystore);
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'configs_not_ready',
    });
    expect(h.chain.built.nonce).toBe(0);
  });

  it('never prepares a coin twice once the launch landed', async () => {
    const h = await setup(ks.keystore);
    const body = await prepared(h);
    await clientSends(h, body.partiallySignedTx);
    h.chain.advance(100); // finalized
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'coin_already_launched',
    });
    expect(h.chain.built.launch).toBe(1);
  });

  it('rebuilds with a new mint once the nonce advanced without a launch', async () => {
    const h = await setup(ks.keystore);
    const first = await prepared(h);
    h.chain.advanceNonce(new PublicKey(first.details!.nonceAccount));
    h.chain.advance(100);
    const second = ok(await h.routes.launchCoinPrepare({ jobId: h.jobId }));
    expect(second.mint).not.toBe(first.mint);
    expect(second.partiallySignedTx).not.toBe(first.partiallySignedTx);
    expect(second.details!.nonceAccount).toBe(first.details!.nonceAccount);
    const entry = (await h.journals.launches.get(h.jobId))!;
    expect(entry).toMatchObject({ builds: 2, replacedMints: [first.mint] });
    expect(h.store.launchpads.get(h.launchpadId)!.launchpadCoinMint).toBe(second.mint);
    // The old transaction can no longer land; the new one does.
    await expect(clientSends(h, first.partiallySignedTx)).rejects.toThrow(/Blockhash not found/);
    await clientSends(h, second.partiallySignedTx);
    expect(h.chain.accounts.has(second.mint)).toBe(true);
    expect(h.chain.built.nonce).toBe(1);
  });

  it('rebuilds after a failed launch (nonce advanced, no coin)', async () => {
    const h = await setup(ks.keystore);
    const first = await prepared(h);
    h.chain.behaviors.push('fail_onchain');
    await clientSends(h, first.partiallySignedTx);
    h.chain.advance(100);
    const second = ok(await h.routes.launchCoinPrepare({ jobId: h.jobId }));
    expect(second.mint).not.toBe(first.mint);
  });

  it('waits for finality before rebuilding (lagging nodes)', async () => {
    const h = await setup(ks.keystore);
    const first = await prepared(h);
    const nonceAccount = new PublicKey(first.details!.nonceAccount);
    const old = h.chain.accounts.get(nonceAccount.toBase58())!.nonce!.value;
    h.chain.advanceNonce(nonceAccount);
    const real = h.chain.readNonce.bind(h.chain);
    vi.spyOn(h.chain, 'readNonce').mockImplementation(async (account, authority, commitment) => {
      const state = await real(account, authority, commitment);
      return commitment === 'finalized' && state ? { ...state, nonce: old } : state;
    });
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'launch_settling',
    });
    expect(h.chain.built.launch).toBe(1);
  });

  it('refuses changed launch inputs while the prepared transaction is still valid', async () => {
    const h = await setup(ks.keystore);
    await prepared(h);
    (
      h.store.launchpads.get(h.launchpadId)!.spec as { launchpadCoin: { name: string } }
    ).launchpadCoin.name = 'Other';
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'launch_inputs_changed',
    });
  });

  it('refuses a launch transaction that lets the creator signature do anything else', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    const original = h.chain.buildLaunchCoinTx.bind(h.chain);
    vi.spyOn(h.chain, 'buildLaunchCoinTx').mockImplementation(async (params) => {
      const built = await original(params);
      built.transaction.add(
        SystemProgram.nonceWithdraw({
          noncePubkey: params.nonceAccount,
          authorizedPubkey: params.creator,
          toPubkey: params.owner,
          lamports: 1,
        }),
      );
      return built;
    });
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 500,
      error: 'tx_policy_violation',
    });
    expect(await h.journals.launches.get(h.jobId)).toBeUndefined();
    expect(h.store.launchpads.get(h.launchpadId)!.launchpadCoinMint).toBeNull();
  });

  it('refuses a nonce that moved while core was building', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    h.chain.launchNonceOverride = randomKey().toBase58();
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'nonce_moved',
    });
  });

  it('refuses to build blind when the row has a mint the journals do not know', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    h.store.launchpads.get(h.launchpadId)!.launchpadCoinMint = randomKey().toBase58();
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'nonce_journal_missing',
    });
    expect(h.chain.built.nonce).toBe(0);
  });

  it('respects deploys_paused', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    h.flags.values.deploys_paused = true;
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'deploys_paused',
    });
    expect(h.chain.built.nonce).toBe(0);
  });

  it('creates the nonce account once even when the first prepare does not finish', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    h.chain.defaultBehavior = 'drop';
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'confirmation_pending',
    });
    h.chain.defaultBehavior = 'land';
    const body = ok(await h.restart().launchCoinPrepare({ jobId: h.jobId }));
    expect(h.chain.built.nonce).toBe(1);
    expect(h.chain.accounts.get(body.details!.nonceAccount)?.nonce).toBeDefined();
  });

  it('builds a launch without a first buy when the spec has none', async () => {
    const h = await setup(ks.keystore);
    const lp = h.store.launchpads.get(h.launchpadId)!;
    (lp.spec as { launchpadCoin: { firstBuySol: number } }).launchpadCoin.firstBuySol = 0;
    const body = await prepared(h);
    expect(body.summary!.firstBuyLamports).toBe('0');
    const tx = deserializeTransactionBase64(body.partiallySignedTx);
    expect(tx.instructions).toHaveLength(4);
  });
});

describe('route wiring', () => {
  it('refuses an invalid metadata URL template at startup', async () => {
    const h = await setup(ks.keystore);
    for (const template of [
      'http://meta.forge.test/{slug}.json',
      'https://meta.forge.test/coin.json',
      'https://meta.forge.test/{slug}/{launchpadId}.json',
    ]) {
      expect(() =>
        createSignerRoutes({ ...h.deps, config: { metadataUriTemplate: template } }),
      ).toThrow(/SIGNER_COIN_METADATA_URL/);
    }
  });

  it('answers health without secrets', async () => {
    const h = await setup(ks.keystore);
    const routes = createSignerRoutes(h.deps, {
      health: () => ({ ok: true, jobs: {} }),
    });
    expect(ok(await routes.health())).toEqual({ ok: true, jobs: {} });
    const failing = createSignerRoutes(h.deps, {
      health: () => {
        throw new Error('boom');
      },
    });
    expect(ok(await failing.health())).toEqual({ ok: false });
  });

  it('keeps an unsigned owner slot only: the serialized launch is a valid partial signature set', async () => {
    const h = await setup(ks.keystore);
    const body = await prepared(h);
    const tx = Transaction.from(Buffer.from(body.partiallySignedTx, 'base64'));
    expect(tx.verifySignatures(false)).toBe(true);
    expect(tx.verifySignatures(true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Behind the HMAC server (server.ts): the real handlers, authenticated requests only

const SECRET = 'route-test-secret-0123456789-abcdefghijkl';

interface Reply {
  status: number;
  body: unknown;
}

async function listen(
  h: Harness,
  clock: { now: number },
): Promise<{ port: number; server: Server }> {
  const server = createSignerServer({
    hmacSecret: SECRET,
    routes: h.routes,
    now: () => clock.now,
    production: false,
    logger: pino({ level: 'silent' }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

function post(port: number, path: string, headers: Record<string, string>, body: string) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('signing routes over HTTP', () => {
  it('runs only authenticated, fresh, unreplayed requests', async () => {
    const h = await setup(ks.keystore);
    const clock = { now: Date.UTC(2026, 9, 11, 12) };
    const { port, server } = await listen(h, clock);
    try {
      const body = JSON.stringify({ jobId: h.jobId });
      // Bad signature, stale and future timestamps: refused before any handler work.
      const wrong = signRequest('another-secret-0123456789-abcdefghijklmn', body, clock.now);
      expect((await post(port, '/v1/configs', wrong, body)).status).toBe(401);
      const stale = signRequest(SECRET, body, clock.now - 61_000);
      expect((await post(port, '/v1/configs', stale, body)).status).toBe(401);
      const future = signRequest(SECRET, body, clock.now + 61_000);
      expect((await post(port, '/v1/configs', future, body)).status).toBe(401);
      // An extra key in the body (an address) is refused, even when signed.
      const extra = JSON.stringify({ jobId: h.jobId, ownerWallet: randomKey().toBase58() });
      expect(
        (await post(port, '/v1/configs', signRequest(SECRET, extra, clock.now), extra)).status,
      ).toBe(400);
      expect(h.chain.built.config).toBe(0);

      const headers = signRequest(SECRET, body, clock.now);
      const first = await post(port, '/v1/configs', headers, body);
      expect(first.status).toBe(200);
      const configs = first.body as { launchpadConfig: string; launchpadCoinConfig: string };
      expect(dbcAccounts(h).sort()).toEqual(
        [configs.launchpadConfig, configs.launchpadCoinConfig].sort(),
      );
      // The same signed request again: replay, refused.
      expect((await post(port, '/v1/configs', headers, body)).status).toBe(401);
      // A fresh signature on the same job: idempotent, same configs.
      const again = await post(
        port,
        '/v1/configs',
        signRequest(SECRET, body, clock.now - 1_000),
        body,
      );
      expect(again).toEqual(first);

      const launch = await post(
        port,
        '/v1/launch-coin/prepare',
        signRequest(SECRET, body, clock.now - 2_000),
        body,
      );
      expect(launch.status).toBe(200);
      expect(launch.body).toMatchObject({
        mint: expect.any(String),
        partiallySignedTx: expect.any(String),
        summary: { coinSymbol: 'MOON', ownerWallet: h.owner.publicKey.toBase58() },
      });
      // A refusal carries only a short code.
      h.flags.values.deploys_paused = true;
      const paused = await post(
        port,
        '/v1/launch-coin/prepare',
        signRequest(SECRET, body, clock.now - 3_000),
        body,
      );
      expect(paused).toEqual({ status: 503, body: { error: 'deploys_paused' } });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
