// @vitest-environment node
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { readRelayConfig } from '../config';
import { createRelayHandler } from '../handler';
import { DEFAULT_LIMITS, MemoryRateLimitStore } from '../limits';
import { MemoryLogger } from '../log';
import { containsSecret, secretFragments } from '../redact';
import { createUpstream } from '../upstream';

/*
 * Opt-in, read-only smoke test of the relay against the real devnet provider:
 *   RPC_RELAY_LIVE=1 with RPC_URL (devnet) in the environment.
 * A web3.js Connection talks to the relay handler (as the FORGE site would); nothing is sent to
 * the chain (no sendTransaction). Refuses to run unless the RPC host is a devnet host.
 */

const rpcUrl = process.env.RPC_URL ?? '';
const enabled =
  process.env.RPC_RELAY_LIVE === '1' &&
  (() => {
    try {
      return new URL(rpcUrl).hostname.includes('devnet');
    } catch {
      return false;
    }
  })();

const ORIGIN = 'https://forge.example';

describe.skipIf(!enabled)('relay live smoke (devnet, read-only)', () => {
  it('serves web3.js through the relay and never returns the provider key', async () => {
    // Production requires the relay's own upstream: the devnet RPC_URL stands in for it here.
    const config = readRelayConfig({
      SOLANA_CLUSTER: 'devnet',
      RPC_RELAY_UPSTREAM_URL: rpcUrl,
      NEXT_PUBLIC_APP_URL: ORIGIN,
      NODE_ENV: 'production',
    });
    const fragments = secretFragments(config.upstreamUrl);
    const logger = new MemoryLogger();
    const handler = createRelayHandler({
      config: { ...config, limits: DEFAULT_LIMITS },
      directory: null,
      limiter: new MemoryRateLimitStore(),
      upstream: createUpstream({
        url: config.upstreamUrl,
        cluster: 'devnet',
        secretFragments: fragments,
      }),
      logger,
    });
    const bodies: string[] = [];
    const relayFetch = async (_url: unknown, init?: RequestInit) => {
      const res = await handler.post(
        new Request(`${ORIGIN}/api/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: String(init?.body),
        }),
      );
      const text = await res.text();
      bodies.push(text);
      return new Response(text, { status: res.status, headers: res.headers });
    };
    const connection = new Connection(`${ORIGIN}/api/rpc`, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: relayFetch as unknown as typeof fetch,
    });

    const slot = await connection.getSlot();
    expect(slot).toBeGreaterThan(0);
    const latest = await connection.getLatestBlockhash();
    expect(latest.blockhash.length).toBeGreaterThan(30);
    expect(await connection.getBlockHeight()).toBeGreaterThan(0);
    expect(await connection.getMinimumBalanceForRentExemption(165)).toBeGreaterThan(0);
    const system = await connection.getAccountInfo(SystemProgram.programId);
    expect(system?.executable).toBe(true);
    const infos = await connection.getMultipleAccountsInfo([
      SystemProgram.programId,
      Keypair.generate().publicKey,
    ]);
    expect(infos[1]).toBeNull();
    expect(await connection.getBalance(Keypair.generate().publicKey)).toBe(0);
    const statuses = await connection.getSignatureStatuses(['1'.repeat(64)]);
    expect(statuses.value[0]).toBeNull();
    const epoch = await connection.getEpochInfo();
    expect(epoch.epoch).toBeGreaterThanOrEqual(0);

    // Simulation of an unfunded transfer: answered with an on-chain error, not a relay error.
    const payer = Keypair.generate();
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    tx.sign(payer);
    const sim = await connection.simulateTransaction(
      VersionedTransaction.deserialize(tx.serialize()),
      { sigVerify: false },
    );
    expect(sim.value.err).not.toBeNull();

    // Refused method: answered by the relay itself.
    await expect(connection.getProgramAccounts(SystemProgram.programId)).rejects.toThrow(
      /not allowed/i,
    );

    for (const body of bodies) expect(containsSecret(body, fragments)).toBe(false);
    for (const entry of logger.entries) {
      expect(containsSecret(JSON.stringify(entry), fragments)).toBe(false);
    }
  }, 60_000);
});
