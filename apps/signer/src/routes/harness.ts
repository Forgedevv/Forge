/**
 * Test harness of the signing routes: a real keystore in a temporary directory (FORGE keys only
 * ever sign through it), the in-memory chain and store of testing.ts, recording alerts and logs.
 * The client wallet is a throwaway in-memory keypair (it signs only in tests, as the client).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach } from 'vitest';
import { openKeystore, type Keystore } from '../keystore.js';
import { RecordingAlerter, RecordingLogger, memoryFlags } from '../jobs/testing.js';
import type { SignerRouteHandlers, SignerRouteResult } from '../server.js';
import { createSignerRoutes, type SignerRoutesDeps } from './index.js';
import { createMemoryRouteJournals, type RouteJournals } from './journal.js';
import { FakeRouteChain, MemoryRouteStore, chainSleep, testSpec, uuid } from './testing.js';

const PASSPHRASE = 'correct horse battery staple correct horse battery staple';
const FAST = { N: 1 << 14, r: 8, p: 1 };
export const METADATA = 'https://meta.forge.test/coins/{slug}.json';

/** A keystore opened before each test in a fresh directory, closed and removed after it. */
export function useTestKeystore(): { readonly keystore: Keystore } {
  let dir = '';
  let current: Keystore | undefined;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-routes-'));
    current = await openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST });
  });
  afterEach(async () => {
    await current?.close();
    current = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    get keystore() {
      if (!current) throw new Error('keystore not open');
      return current;
    },
  };
}

export interface Harness {
  chain: FakeRouteChain;
  store: MemoryRouteStore;
  flags: ReturnType<typeof memoryFlags>;
  journals: RouteJournals;
  alerter: RecordingAlerter;
  logger: RecordingLogger;
  expected: string[];
  owner: Keypair;
  jobId: string;
  launchpadId: string;
  payer: PublicKey;
  deps: SignerRoutesDeps;
  routes: SignerRouteHandlers;
  /** A new routes instance over the same chain, store, journals and keystore (a restart). */
  restart(overrides?: Partial<SignerRoutesDeps>): SignerRouteHandlers;
  /** Seeds another paid creation job (another launchpad, same client wallet). */
  addJob(): { jobId: string; launchpadId: string };
}

/** Seeds a creation job whose confirmed payment row is also a finalized payment on the chain. */
export function seedPaidJob(
  chain: FakeRouteChain,
  store: MemoryRouteStore,
  owner: PublicKey,
  slug = 'moonpad',
): { jobId: string; launchpadId: string } {
  const jobId = uuid();
  const launchpadId = uuid();
  const payment = store.seed({
    jobId,
    launchpadId,
    spec: testSpec(owner.toBase58(), { slug }),
  });
  chain.recordPayment(payment.txSignature!, { payer: owner, lamports: payment.lamports, jobId });
  return { jobId, launchpadId };
}

export async function setup(
  keystore: Keystore,
  overrides: Partial<SignerRoutesDeps> = {},
): Promise<Harness> {
  const chain = new FakeRouteChain();
  const store = new MemoryRouteStore();
  const owner = Keypair.generate(); // the client wallet (test only)
  const { jobId, launchpadId } = seedPaidJob(chain, store, owner.publicKey);
  const payer = (await keystore.createKey('payer')).publicKey;
  chain.setBalance(payer, 1_000_000_000n);
  chain.setBalance(owner.publicKey, 1_000_000_000n);
  const flags = memoryFlags({ deploys_paused: false });
  const journals = createMemoryRouteJournals();
  const alerter = new RecordingAlerter();
  const logger = new RecordingLogger();
  const expected: string[] = [];
  const clock = { t: Date.UTC(2026, 9, 11) };
  const deps: SignerRoutesDeps = {
    store,
    core: chain,
    rpc: chain,
    keystore,
    payments: chain,
    flags,
    journals,
    alerter,
    logger,
    config: {
      metadataUriTemplate: METADATA,
      settle: { timeoutMs: 30_000, pollMs: 2_000, rebroadcastMs: 6_000 },
    },
    onBeforeSend: (signature) => void expected.push(signature),
    sleep: chainSleep(chain, clock),
    now: () => clock.t,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
    ...overrides,
  };
  const routes = createSignerRoutes(deps);
  let jobs = 0;
  return {
    chain,
    store,
    flags,
    journals,
    alerter,
    logger,
    expected,
    owner,
    jobId,
    launchpadId,
    payer,
    deps,
    routes,
    restart: (more = {}) => createSignerRoutes({ ...deps, ...more }),
    addJob: () => {
      jobs++;
      return seedPaidJob(chain, store, owner.publicKey, `moonpad-${jobs}`);
    },
  };
}

export function ok<T>(result: SignerRouteResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.status} ${result.error}`);
  return result.body;
}

export function refused<T>(result: SignerRouteResult<T>): { status: number; error: string } {
  if (result.ok) throw new Error('expected a refusal');
  return { status: result.status, error: result.error };
}

export const dbcAccounts = (h: Harness) => h.chain.accountsOwnedBy(h.chain.dbcProgramId);
