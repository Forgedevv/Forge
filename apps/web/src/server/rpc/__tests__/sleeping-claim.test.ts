// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { buildCreatorClaimTx, listCoinsOfCreator } from '@forge/core';
import { describe, expect, it } from 'vitest';
import type { RelayConfig } from '../config';
import { createRelayHandler } from '../handler';
import { DEFAULT_LIMITS, MemoryRateLimitStore } from '../limits';
import { MemoryLogger } from '../log';
import { decodeBase58, SLEEPING_SITE_METHODS } from '../methods';
import type { DirectorySnapshot } from '../origins';
import { secretFragments } from '../redact';
import { createUpstream, type FetchLike } from '../upstream';
import { DEVNET_GENESIS, SIG, UPSTREAM_URL } from './helpers';

/*
 * The creator fee claim of a sleeping site (decision D29), end to end through the relay: the real
 * @forge/core reads and claim build (SDK getPoolsByCreator included) on a web3.js Connection whose
 * requests go through the relay handler with the sleeping site's Origin, then the three calls the
 * template's chain client sends (balance, send, status polling), with the exact bodies of
 * apps/launchpad-template/src/forge/create/chain.ts. The upstream serves real devnet DBC accounts.
 */

interface FixtureAccount {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/dbc-claim-accounts.json', import.meta.url), 'utf8'),
) as { accounts: { pool: FixtureAccount; config: FixtureAccount } };
const POOL = FIXTURE.accounts.pool;
const CONFIG = FIXTURE.accounts.config;
const ACCOUNTS = [POOL, CONFIG];
const CREATOR = new PublicKey(Buffer.from(POOL.data, 'base64').subarray(104, 136));

const SLEEPING_SITE = 'https://sleepy-pad.forge-sites.app';
const SITE_IP = '198.51.100.20';

type UpstreamCall = { jsonrpc: string; id: number; method: string; params?: unknown[] };
type Filter = { memcmp?: { offset: number; bytes: string }; dataSize?: number };

function rpcAccount(a: FixtureAccount) {
  const data = Buffer.from(a.data, 'base64');
  return {
    data: [a.data, 'base64'],
    executable: false,
    lamports: a.lamports,
    owner: a.owner,
    rentEpoch: 0,
    space: data.length,
  };
}

function matches(a: FixtureAccount, filters: Filter[]): boolean {
  const data = Buffer.from(a.data, 'base64');
  return filters.every((f) => {
    if (f.dataSize !== undefined) return data.length === f.dataSize;
    if (!f.memcmp) return false;
    const bytes = decodeBase58(f.memcmp.bytes);
    if (!bytes) return false;
    return data.subarray(f.memcmp.offset, f.memcmp.offset + bytes.length).equals(bytes);
  });
}

/** A devnet RPC provider serving the fixture accounts; any other account does not exist. */
function answer(c: UpstreamCall): unknown {
  const context = { slot: 1 };
  const params = c.params ?? [];
  switch (c.method) {
    case 'getProgramAccounts': {
      const [program, config] = params as [string, { filters: Filter[] }];
      return ACCOUNTS.filter((a) => a.owner === program && matches(a, config.filters)).map((a) => ({
        pubkey: a.address,
        account: rpcAccount(a),
      }));
    }
    case 'getAccountInfo': {
      const found = ACCOUNTS.find((a) => a.address === params[0]);
      return { context, value: found ? rpcAccount(found) : null };
    }
    case 'getMultipleAccounts': {
      const keys = params[0] as string[];
      return {
        context,
        value: keys.map((k) => {
          if (k === CREATOR.toBase58()) {
            return {
              data: ['', 'base64'],
              executable: false,
              lamports: 1_000_000_000,
              owner: '11111111111111111111111111111111',
              rentEpoch: 0,
              space: 0,
            };
          }
          const found = ACCOUNTS.find((a) => a.address === k);
          return found ? rpcAccount(found) : null;
        }),
      };
    }
    case 'getMinimumBalanceForRentExemption':
      return 2_039_280;
    case 'getLatestBlockhash':
      return { context, value: { blockhash: DEVNET_GENESIS, lastValidBlockHeight: 1_000 } };
    case 'getBalance':
      return { context, value: 1_000_000_000 };
    case 'sendTransaction':
      return SIG;
    case 'getSignatureStatuses':
      return {
        context,
        value: [{ slot: 2, confirmations: null, err: null, confirmationStatus: 'confirmed' }],
      };
    default:
      throw new Error(`unexpected upstream method ${c.method}`);
  }
}

function makeSleepingRelay() {
  const forwarded: string[] = [];
  const fetchFake: FetchLike = async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as UpstreamCall | UpstreamCall[];
    const one = (c: UpstreamCall) => {
      if (c.method === 'getGenesisHash')
        return { jsonrpc: '2.0', id: c.id, result: DEVNET_GENESIS };
      forwarded.push(c.method);
      return { jsonrpc: '2.0', id: c.id, result: answer(c) };
    };
    const body = Array.isArray(payload) ? payload.map(one) : one(payload);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const snapshot: DirectorySnapshot = {
    activeSlugs: new Set(['moonpad']),
    sleepingSlugs: new Set(['sleepy-pad']),
    previewOrigins: new Map(),
    loadedAt: 0,
  };
  const config: Pick<
    RelayConfig,
    'appOrigin' | 'clientsDomain' | 'allowLocalhost' | 'tokenSecret' | 'allowAnonymous' | 'limits'
  > = {
    appOrigin: 'https://forge.example',
    clientsDomain: 'forge-sites.app',
    allowLocalhost: false,
    tokenSecret: Buffer.from('s'.repeat(48)),
    allowAnonymous: false,
    limits: DEFAULT_LIMITS,
  };
  const handler = createRelayHandler({
    config,
    directory: { snapshot: () => Promise.resolve(snapshot) },
    limiter: new MemoryRateLimitStore(),
    upstream: createUpstream({
      url: UPSTREAM_URL,
      cluster: 'devnet',
      secretFragments: secretFragments(UPSTREAM_URL),
      fetch: fetchFake,
      retryDelayMs: 1,
      sleep: () => Promise.resolve(),
    }),
    logger: new MemoryLogger(),
    clientIp: () => SITE_IP,
  });

  /** What the browser of the sleeping site sends (Origin set by the browser). */
  const post = (body: string) =>
    handler.post(
      new Request('https://forge.example/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SLEEPING_SITE },
        body,
      }),
    );
  const connection = new Connection('https://forge.example/api/rpc', {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (async (_input: unknown, init?: RequestInit) =>
      post(String(init?.body))) as unknown as typeof fetch,
  });
  /** One raw JSON-RPC call, as the template chain client sends it. */
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    const json = (await res.json()) as { result?: T; error?: { code: number } };
    if (json.error) throw new Error(`${method} refused: ${json.error.code}`);
    return json.result as T;
  }
  return { connection, rpc, forwarded };
}

describe('creator fee claim of a sleeping site, through the relay', () => {
  it('lists the coins, builds the claim, sends it and confirms it', async () => {
    const { connection, rpc, forwarded } = makeSleepingRelay();
    const noRetry = { retry: { attempts: 1, baseDelayMs: 0 } };

    // 1. The coins of the connected wallet on this launchpad (template claims core adapter).
    const coins = await listCoinsOfCreator(
      connection,
      CREATOR,
      [new PublicKey(CONFIG.address)],
      noRetry,
    );
    expect(coins.map((c) => c.pool.toBase58())).toEqual([POOL.address]);
    expect(coins[0]!.fees.claimable.creator.quote).toBe(10_000_000n);

    // 2. The claim transaction, receiver = the wallet itself.
    const built = await buildCreatorClaimTx(
      connection,
      { pool: new PublicKey(POOL.address), creator: CREATOR, receiver: CREATOR },
      noRetry,
    );
    expect(built.transaction).not.toBeNull();
    const tx = new VersionedTransaction(built.transaction!.compileMessage());
    expect(tx.message.staticAccountKeys[0]!.equals(CREATOR)).toBe(true);
    // The wallet signs (any 64 bytes: the relay does not verify signatures, the cluster does).
    tx.signatures[0] = new Uint8Array(64).fill(7);

    // 3. Balance check, send and confirmation polling (template chain client bodies).
    const balance = await rpc<{ value: number }>('getBalance', [
      CREATOR.toBase58(),
      { commitment: 'confirmed' },
    ]);
    expect(balance.value).toBe(1_000_000_000);
    const signature = await rpc<string>('sendTransaction', [
      Buffer.from(tx.serialize()).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
    expect(signature).toBe(SIG);
    const status = await rpc<{ value: { confirmationStatus: string }[] }>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: false },
    ]);
    expect(status.value[0]!.confirmationStatus).toBe('confirmed');

    // Every method the claim needs reached the provider, and nothing else is on the sleeping list.
    expect(new Set(forwarded)).toEqual(SLEEPING_SITE_METHODS);
  });

  it('refuses what a sleeping site has no use for', async () => {
    const { rpc, forwarded } = makeSleepingRelay();
    await expect(rpc('getSlot', [])).rejects.toThrow('getSlot refused: -32601');
    await expect(
      rpc('getProgramAccounts', [
        'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
        {
          encoding: 'base64',
          filters: [{ memcmp: { offset: 72, bytes: CONFIG.address } }],
        },
      ]),
    ).rejects.toThrow('getProgramAccounts refused: -32601');
    expect(forwarded).toEqual([]);
  });
});
