/**
 * Devnet smoke test of the apps/web payment flow (POST /api/payments/quote + /confirm logic).
 *
 * Runs the real payment service of apps/web (src/server/payments) with an in-memory database and
 * the real on-chain gateway, then pays ONE quote of exactly 0.001 SOL from the `client` wallet to a
 * stand-in cashbox (the `multisigStandIn` wallet's public key), and checks:
 *   - quote -> unsigned transaction -> signed by the client -> confirmed -> job `paid`;
 *   - a retry is idempotent; the same signature is refused on another quote;
 *   - verification refuses another job, another payer and another amount on the real transaction;
 *   - the genesis check refuses a mainnet cluster.
 *
 * Devnet only: refuses to run unless RPC_URL contains "devnet". Nothing secret is printed.
 *
 *   FORGE_DEVNET_WALLETS_DIR=<dir with client.json, multisigStandIn.json> \
 *     pnpm --filter @forge/devnet-tests exec tsx src/web-payments.ts
 *
 * Wallet files are only read (never created); the default directory is `.state/wallets`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair, PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import { PACKAGE_DIR, STATE_DIR } from './lib/env.js';
import { confirmBySignature, formatSol, getConnection, solscanTx } from './lib/solana.js';

/** $5.50 at 5,500 $/SOL = exactly 0.001 SOL: the smoke spends the same amount whatever the market. */
const SMOKE_SOL_USD = 5_500;
const EXPECTED_LAMPORTS = 1_000_000n;
const MIN_CLIENT_BALANCE = 10_000_000n;

// ---------------------------------------------------------------------------------------------
// apps/web modules, loaded at runtime by tsx (typed locally: apps/web is not a dependency here)
// ---------------------------------------------------------------------------------------------

type Verification = { status: string; reason?: string; blockTime?: number | null };
interface Gateway {
  verify(
    signature: string,
    expected: { payer: PublicKey; lamports: bigint; jobId: string },
  ): Promise<Verification>;
}
interface MemoryStore {
  jobs: Map<string, { status: string }>;
  transitions: unknown[];
  addLaunchpad(row: { ownerWallet: string; includedModificationsLeft: number; status: string }): {
    id: string;
  };
  addJob(row: { launchpadId: string; type: string }): { id: string };
}
interface Quote {
  paymentId: string;
  lamports: string;
  transaction: string | null;
  expiresAt: string;
}
interface Service {
  createQuote(input: { wallet: string; jobId: string; kind: string }): Promise<Quote>;
  confirmPayment(input: {
    wallet: string;
    paymentId: string;
    signature: string;
  }): Promise<{ httpStatus: number; status: string }>;
}

const WEB_PAYMENTS_DIR = resolve(
  PACKAGE_DIR,
  '..',
  '..',
  'apps',
  'web',
  'src',
  'server',
  'payments',
);

async function webModule<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(resolve(WEB_PAYMENTS_DIR, `${name}.ts`)).href)) as T;
}

// ---------------------------------------------------------------------------------------------

function loadExistingKeypair(dir: string, name: string): Keypair {
  const path = resolve(dir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing wallet file ${name}.json in the wallets directory (not created).`);
  }
  const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`FAILED: ${label}`);
  console.log(`  ok   ${label}`);
}

async function expectCode(promise: Promise<unknown>, code: string, label: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    check((error as { code?: string }).code === code, `${label} (${code})`);
    return;
  }
  throw new Error(`FAILED: ${label}: expected ${code}`);
}

async function main(): Promise<void> {
  const connection: Connection = getConnection(); // refuses unless RPC_URL contains "devnet"
  const walletsDir = process.env.FORGE_DEVNET_WALLETS_DIR ?? resolve(STATE_DIR, 'wallets');
  const client = loadExistingKeypair(walletsDir, 'client');
  const cashbox = loadExistingKeypair(walletsDir, 'multisigStandIn').publicKey;
  const wallet = client.publicKey.toBase58();
  console.log(`client (payer):       ${wallet}`);
  console.log(`stand-in cashbox:     ${cashbox.toBase58()}`);

  const balance = BigInt(await connection.getBalance(client.publicKey, 'confirmed'));
  console.log(`client balance:       ${formatSol(balance)}`);
  if (balance < MIN_CLIENT_BALANCE) {
    throw new Error('The client wallet needs at least 0.01 devnet SOL: fund it and rerun.');
  }

  const { createCorePaymentGateway } = await webModule<{
    createCorePaymentGateway(o: {
      connection: Connection;
      cluster: 'devnet' | 'mainnet-beta';
      env: Record<string, string>;
    }): Gateway & object;
  }>('gateway');
  const { MemoryPaymentsStore } = await webModule<{ MemoryPaymentsStore: new () => MemoryStore }>(
    'memory-store',
  );
  const { MemoryLogger } = await webModule<{ MemoryLogger: new () => object }>('log');
  const { FixedPriceSource } = await webModule<{ FixedPriceSource: new (p: number) => object }>(
    'price-source',
  );
  const { createPaymentsService } = await webModule<{
    createPaymentsService(deps: Record<string, unknown>): Service;
  }>('service');
  const { assertCluster } = await webModule<{
    assertCluster(c: Connection, cluster: 'devnet' | 'mainnet-beta'): Promise<void>;
  }>('core-adapter');

  // The stand-in cashbox is passed explicitly: process.env is not modified.
  const env = { FORGE_CASHBOX_WALLET: cashbox.toBase58(), SOLANA_CLUSTER: 'devnet' };
  const gateway = createCorePaymentGateway({ connection, cluster: 'devnet', env });
  const store = new MemoryPaymentsStore();
  const service = createPaymentsService({
    store,
    gateway,
    prices: new FixedPriceSource(SMOKE_SOL_USD),
    logger: new MemoryLogger(),
    confirmWaitMs: 30_000,
    confirmPollMs: 1_500,
  });
  const launchpad = store.addLaunchpad({
    ownerWallet: wallet,
    includedModificationsLeft: 0,
    status: 'live',
  });
  const job = store.addJob({ launchpadId: launchpad.id, type: 'modify_launchpad' });

  console.log('\n1. Quote');
  const quote = await service.createQuote({ wallet, jobId: job.id, kind: 'modification' });
  check(quote.lamports === EXPECTED_LAMPORTS.toString(), 'quote is 0.001 SOL, priced server-side');
  check(quote.transaction !== null, 'quote carries an unsigned transaction');

  console.log('\n2. Client signs and sends');
  const tx = VersionedTransaction.deserialize(Buffer.from(quote.transaction!, 'base64'));
  check(tx.message.staticAccountKeys[0]!.equals(client.publicKey), 'fee payer is the client');
  tx.sign([client]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  console.log(`  signature ${signature}`);
  console.log(`  ${solscanTx(signature)}`);
  const { lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await confirmBySignature(signature, lastValidBlockHeight + 300);

  console.log('\n3. Confirm');
  const confirmed = await service.confirmPayment({ wallet, paymentId: quote.paymentId, signature });
  check(confirmed.status === 'confirmed' && confirmed.httpStatus === 200, 'payment confirmed');
  check(store.jobs.get(job.id)?.status === 'paid', 'job moved spec_ready -> paid');
  const retry = await service.confirmPayment({ wallet, paymentId: quote.paymentId, signature });
  check(retry.status === 'confirmed', 'retry is idempotent');
  check(store.transitions.length === 1, 'job transitioned exactly once');

  console.log('\n4. Replays and mismatches on the real transaction');
  const job2 = store.addJob({ launchpadId: launchpad.id, type: 'modify_launchpad' });
  const quote2 = await service.createQuote({ wallet, jobId: job2.id, kind: 'modification' });
  await expectCode(
    service.confirmPayment({ wallet, paymentId: quote2.paymentId, signature }),
    'SIGNATURE_ALREADY_USED',
    'same signature refused on another quote',
  );
  const exact = { payer: client.publicKey, lamports: EXPECTED_LAMPORTS, jobId: job.id };
  const direct = await gateway.verify(signature, exact);
  check(
    direct.status === 'confirmed' && typeof direct.blockTime === 'number',
    'core verify: confirmed',
  );
  const otherJob = await gateway.verify(signature, { ...exact, jobId: job2.id });
  check(otherJob.reason === 'memo_mismatch', 'another job is refused (memo_mismatch)');
  const otherPayer = await gateway.verify(signature, { ...exact, payer: cashbox });
  check(otherPayer.reason === 'payer_not_signer', 'another payer is refused (payer_not_signer)');
  const otherAmount = await gateway.verify(signature, {
    ...exact,
    lamports: EXPECTED_LAMPORTS + 1n,
  });
  check(otherAmount.reason === 'amount_mismatch', 'another amount is refused (amount_mismatch)');
  await expectCode(
    assertCluster(connection, 'mainnet-beta'),
    'wrong_cluster',
    'wrong cluster refused',
  );

  console.log('\nweb-payments smoke: PASS');
  console.log(`signature: ${signature}`);
}

main().catch((error: unknown) => {
  // URLs are masked: an RPC error could echo the endpoint, which embeds an API key.
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  console.error(`web-payments smoke: FAIL (${message.replace(/https?:\/\/\S+/g, '<url>')})`);
  process.exitCode = 1;
});
