/**
 * Devnet run of the signer signing routes (apps/signer/src/routes), in process (no HTTP server:
 * the HMAC layer is covered by the unit tests), on the real cluster, through the real keystore:
 *
 *   1. POST /v1/configs: the route creates the launchpad's creator wallet and both configs (paid
 *      by the keystore payer), then a second call returns the same configs and sends nothing.
 *   2. POST /v1/launch-coin/prepare: the route creates the durable nonce account once (authority =
 *      the creator wallet) and returns the launch transaction signed by the creator and the mint;
 *      a second call returns the very same transaction.
 *   3. The `client` wallet (the launchpad owner) signs that transaction last and sends it, as
 *      apps/web would; it is confirmed by polling `getSignatureStatuses`.
 *   4. A third prepare is refused: the coin is launched, never prepared twice.
 *
 * The keystore (payer + creator) is a throwaway one GENERATED in `.state/signer-routes/keystore`
 * (devnet passphrase in `.state`), the payer is funded by the `funder` wallet. The database is an
 * in-memory stand-in (one creation job in `onchain_setup`, a confirmed payment row): no Supabase
 * row is written. The route journals live in `.state/signer-routes/journal`, so a rerun resumes
 * the same launchpad (pass `--new` to start another one once a run is complete).
 *
 * Devnet only: refuses to run unless RPC_URL contains "devnet" (lib/env.ts). Spend: about
 * 0.02 SOL (payer: config and nonce rents) + 0.04 SOL (client: pool accounts, Metaplex fee, first
 * buy of 0.01 SOL); the run stops if the total would exceed 0.1 SOL.
 *
 *   node --env-file=<secrets file> --import tsx src/signer-routes.ts   (from scripts/devnet-tests)
 *
 * Only public data is printed or reported: addresses, signatures, amounts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { LaunchpadSpec } from '@forge/shared';
import { openKeystore, creatorRole } from '../../../apps/signer/src/keystore.js';
import {
  createFileRouteJournals,
  createForgeRouteCore,
  createSignerRoutes,
} from '../../../apps/signer/src/routes/index.js';
import { MemoryRouteStore } from '../../../apps/signer/src/routes/testing.js';
import {
  rpcFromConnection,
  scrubText,
  type JobAlerter,
  type JobLogger,
} from '../../../apps/signer/src/jobs/shared.js';
import { memoryFlags } from '../../../apps/signer/src/jobs/testing.js';
import { STATE_DIR, loadEnv } from './lib/env.js';
import { runMain } from './lib/funding.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';
import { formatSol, getBalance, getConnection, sleep, transferSol } from './lib/solana.js';
import { loadWallets } from './lib/wallets.js';

const WORK_DIR = resolve(STATE_DIR, 'signer-routes');
const RUN_FILE = resolve(WORK_DIR, 'run.json');
/** Payer float: two config rents (~0.0082 SOL each), the nonce rent, fees and the fee buffer. */
const PAYER_FLOAT = 25_000_000n;
/** Client float: the launch costs and the temporary WSOL rent, with a margin. */
const CLIENT_FLOAT = 50_000_000n;
const MAX_TOTAL_SPEND = 100_000_000n;
/** Meteora referral WSOL account created by devnet test 1 (stand-in for the FORGE one). */
const DEVNET_REFERRAL = new PublicKey('6xGTA1UBAMUdBuVEV83QT7aygR4nWyN329ntQAiEDdJ1');
const METADATA_TEMPLATE = 'https://example.com/forge/devnet/{slug}.json';
/** A prepared launch discarded by hand from the devnet journal (see the report note). */
const DISCARDED_FILE = resolve(WORK_DIR, 'discarded-launch.json');

interface RunState {
  jobId: string;
  launchpadId: string;
  slug: string;
  launchSignature: string | null;
  done: boolean;
  /** Results of the fresh run, reported again by resumed runs. */
  prepareIdempotent?: boolean;
  referralFinding?: { withReferral: string; withoutReferral: string };
}

function devnetPassphrase(): string {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  const file = resolve(WORK_DIR, 'keystore-passphrase.txt');
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600 });
  }
  return readFileSync(file, 'utf8').trim();
}

function loadRun(fresh: boolean): RunState {
  if (existsSync(RUN_FILE)) {
    const run = JSON.parse(readFileSync(RUN_FILE, 'utf8')) as RunState;
    if (!run.done || !fresh) return run;
  }
  const run: RunState = {
    jobId: randomUUID(),
    launchpadId: randomUUID(),
    slug: `devnet-routes-${randomBytes(3).toString('hex')}`,
    launchSignature: null,
    done: false,
  };
  saveRun(run);
  return run;
}

function saveRun(run: RunState): void {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(RUN_FILE, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

function consoleLogger(): JobLogger {
  const out =
    (level: string) =>
    (fields: Record<string, unknown>, msg: string): void => {
      const json = JSON.stringify(fields, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      console.log(scrubText(`    [routes:${level}] ${msg} ${json}`).slice(0, 400));
    };
  return { debug: () => undefined, info: out('info'), warn: out('warn'), error: out('error') };
}

function consoleAlerter(alerts: string[]): JobAlerter {
  return {
    async alert(level, code, message) {
      alerts.push(code);
      console.log(scrubText(`    ALERT [${level}] ${code}: ${message}`));
    },
  };
}

function spec(owner: PublicKey, slug: string): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: owner.toBase58(),
    name: 'Forge Routes',
    slug,
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'Signer routes on devnet',
      designNotes: '',
    },
    launchpadCoin: {
      name: 'Forge Routes Coin',
      symbol: 'FROUTE',
      description: 'Devnet coin launched through the signer routes',
      imageUrl: 'https://example.com/forge/devnet/coin.png',
      firstBuySol: 0.01,
    },
  };
}

async function confirmByPolling(signature: string, deadlineMs = 90_000): Promise<number> {
  const connection = getConnection();
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const status = (
      await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    ).value[0];
    if (status?.err) throw new Error(`launch failed on-chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return status.slot;
    }
    if (Date.now() > deadline) throw new Error(`launch ${signature} not confirmed in time`);
    await sleep(2_000);
  }
}

function expectOk<T>(
  label: string,
  result: { ok: true; body: T } | { ok: false; status: number; error: string },
): T {
  if (!result.ok) throw new Error(`${label} refused: ${result.status} ${result.error}`);
  return result.body;
}

async function main(): Promise<void> {
  loadEnv(); // refuses anything but devnet
  const connection = getConnection();
  const wallets = loadWallets();
  const client = wallets.client;
  const fresh = process.argv.includes('--new');
  const run = loadRun(fresh);
  console.log(`launchpad ${run.launchpadId} (${run.slug}), job ${run.jobId}`);

  const keystore = await openKeystore({
    dir: resolve(WORK_DIR, 'keystore'),
    passphrase: devnetPassphrase(),
  });
  const alerts: string[] = [];
  const announced: string[] = [];
  const report = new Report('Signer routes on devnet (configs, durable-nonce launch)');
  try {
    const payer = (await keystore.createKey('payer')).publicKey;
    console.log(`payer (keystore-generated): ${payer.toBase58()}`);
    const payerBalance = await getBalance(payer);
    if (payerBalance < PAYER_FLOAT) {
      console.log(`  funding the payer with ${formatSol(PAYER_FLOAT - payerBalance)}`);
      await transferSol(wallets.funder, payer, PAYER_FLOAT - payerBalance, 'fund payer');
    }
    // The client pays the launch: ~0.037 SOL (pool accounts, Metaplex fee, 0.01 SOL first buy)
    // plus a WSOL account rent held during the transaction. Top it up from the funder if short.
    const clientBefore = await getBalance(client.publicKey);
    if (!run.done && clientBefore < CLIENT_FLOAT) {
      console.log(`  funding the client with ${formatSol(CLIENT_FLOAT - clientBefore)}`);
      await transferSol(
        wallets.funder,
        client.publicKey,
        CLIENT_FLOAT - clientBefore,
        'fund client',
      );
    }

    const store = new MemoryRouteStore();
    store.seed({
      jobId: run.jobId,
      launchpadId: run.launchpadId,
      spec: spec(client.publicKey, run.slug),
    });
    const journals = createFileRouteJournals(resolve(WORK_DIR, 'journal'));
    const routes = createSignerRoutes({
      store,
      core: createForgeRouteCore({ connection }),
      rpc: rpcFromConnection(connection),
      keystore,
      flags: memoryFlags({ deploys_paused: false }),
      journals,
      alerter: consoleAlerter(alerts),
      logger: consoleLogger(),
      config: { metadataUriTemplate: METADATA_TEMPLATE },
      onBeforeSend: (signature) => void announced.push(signature),
    });

    // 1. Configs, twice.
    console.log('\n=== 1. POST /v1/configs ===');
    const configs = expectOk('configs', await routes.configs({ jobId: run.jobId }));
    console.log(`  launchpad config      ${configs.launchpadConfig}`);
    console.log(`  launchpad coin config ${configs.launchpadCoinConfig}`);
    const sendsAfterConfigs = announced.length;
    const configsAgain = expectOk('configs (retry)', await routes.configs({ jobId: run.jobId }));
    const configsIdempotent =
      JSON.stringify(configsAgain) === JSON.stringify(configs) &&
      announced.length === sendsAfterConfigs;
    console.log(`  retry returns the same configs, nothing sent: ${configsIdempotent}`);
    const configsEntry = (await journals.configs.get(run.launchpadId))!;
    const creatorRef = (await keystore.findRef(creatorRole(run.launchpadId)))!;
    const creator = await keystore.getPublicKey(creatorRef);
    const dbc = DynamicBondingCurveClient.create(connection, 'confirmed');
    const coinConfig = await dbc.state.getPoolConfig(new PublicKey(configs.launchpadCoinConfig));
    const lpConfig = await dbc.state.getPoolConfig(new PublicKey(configs.launchpadConfig));
    const configsOk =
      !!coinConfig &&
      !!lpConfig &&
      coinConfig.feeClaimer.equals(client.publicKey) &&
      lpConfig.feeClaimer.equals(client.publicKey) &&
      coinConfig.creatorTradingFeePercentage === 25 &&
      lpConfig.creatorTradingFeePercentage === 25;

    // 2. Launch preparation, twice.
    console.log('\n=== 2. POST /v1/launch-coin/prepare ===');
    // A resumed run whose launch was already sent goes straight to its confirmation.
    const prepared =
      run.done || run.launchSignature
        ? null
        : expectOk('prepare', await routes.launchCoinPrepare({ jobId: run.jobId }));
    let prepareIdempotent = false;
    if (prepared) {
      const again = expectOk(
        'prepare (retry)',
        await routes.launchCoinPrepare({ jobId: run.jobId }),
      );
      prepareIdempotent = again.partiallySignedTx === prepared.partiallySignedTx;
      console.log(`  mint ${prepared.mint}, nonce account ${prepared.details?.nonceAccount}`);
      console.log(`  retry returns the same transaction: ${prepareIdempotent}`);
    }
    const nonceEntry = (await journals.nonces.get(run.launchpadId))!;

    // 2b. Finding (simulation only, no cost): the same launch with a referral on the first buy.
    let referralFinding: { withReferral: string; withoutReferral: string } | null = null;
    if (prepared && nonceEntry.creation?.address) {
      const simulate = async (referral: PublicKey | null): Promise<string> => {
        const core = createForgeRouteCore({ connection, firstBuyReferral: referral });
        const built = await core.buildLaunchCoinTx({
          config: new PublicKey(configs.launchpadCoinConfig),
          creator,
          owner: client.publicKey,
          mint: Keypair.generate().publicKey,
          name: 'Forge Routes Coin',
          symbol: 'FROUTE',
          metadataUri: 'https://example.com/forge/devnet/simulation.json',
          firstBuyLamports: 10_000_000n,
          nonceAccount: new PublicKey(nonceEntry.creation!.address!),
        });
        const result = await connection.simulateTransaction(
          new VersionedTransaction(built.transaction.compileMessage()),
          { sigVerify: false, commitment: 'confirmed' },
        );
        const slippage = (result.value.logs ?? []).some((l) => /ExceededSlippage/.test(l));
        return result.value.err
          ? `fails: ${JSON.stringify(result.value.err)}${slippage ? ' (ExceededSlippage)' : ''}`
          : 'succeeds';
      };
      referralFinding = {
        withReferral: await simulate(DEVNET_REFERRAL),
        withoutReferral: await simulate(null),
      };
      console.log(`  first buy with a referral: ${referralFinding.withReferral}`);
      console.log(`  first buy without a referral: ${referralFinding.withoutReferral}`);
      run.referralFinding = referralFinding;
      run.prepareIdempotent = prepareIdempotent;
      saveRun(run);
    }
    referralFinding ??= run.referralFinding ?? null;

    // 3. The client signs last and sends (what apps/web relays).
    let launchSignature = run.launchSignature;
    let launchSlot: number | null = null;
    if (prepared && !launchSignature) {
      console.log('\n=== 3. client signs and sends ===');
      const tx = Transaction.from(Buffer.from(prepared.partiallySignedTx, 'base64'));
      const message = tx.serializeMessage();
      tx.partialSign(client);
      if (!tx.serializeMessage().equals(message)) throw new Error('the message changed');
      const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
      launchSignature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      run.launchSignature = launchSignature;
      saveRun(run);
      console.log(`  launch ${launchSignature} (${raw.length} bytes)`);
    }
    if (launchSignature) launchSlot = await confirmByPolling(launchSignature);

    // 4. On-chain result, then a third prepare must be refused.
    const entry = (await journals.launches.get(run.jobId))!;
    const mint = new PublicKey(entry.mint);
    const pool = new PublicKey(entry.details.pool);
    const [mintInfo, poolInfo] = await connection.getMultipleAccountsInfo(
      [mint, pool],
      'confirmed',
    );
    const clientCoin = getAssociatedTokenAddressSync(
      mint,
      client.publicKey,
      true,
      TOKEN_PROGRAM_ID,
    );
    const coinBalance = BigInt(
      (await connection.getTokenAccountBalance(clientCoin, 'confirmed')).value.amount,
    );
    const poolState = await dbc.state.getPool(pool);
    console.log('\n=== 4. prepare after the launch ===');
    let third: { ok: true } | { ok: false; status: number; error: string } = { ok: true };
    for (let i = 0; i < 30; i++) {
      const r = await routes.launchCoinPrepare({ jobId: run.jobId });
      third = r.ok ? { ok: true } : r;
      if (r.ok || r.error !== 'launch_settling') break;
      await sleep(3_000); // the nonce advance must be finalized before the route decides
    }
    const refusedAgain =
      !third.ok && third.status === 409 && third.error === 'coin_already_launched';
    console.log(
      `  third prepare: ${third.ok ? 'returned a transaction (unexpected)' : third.error}`,
    );
    run.done = true;
    saveRun(run);

    // Spend, from the transactions themselves (fee payer = account 0): valid for resumed runs.
    const feePayerDebit = async (signature: string | null | undefined): Promise<bigint> => {
      if (!signature) return 0n;
      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) throw new Error(`transaction ${signature} not found`);
      return BigInt(tx.meta.preBalances[0]!) - BigInt(tx.meta.postBalances[0]!);
    };
    let payerSpent = 0n;
    for (const signature of [
      configsEntry.launchpad?.current?.signature,
      configsEntry.launchpadCoin?.current?.signature,
      nonceEntry.creation?.current?.signature,
    ]) {
      payerSpent += await feePayerDebit(signature);
    }
    const clientSpent = await feePayerDebit(launchSignature);
    const total = payerSpent + clientSpent;
    const launchedOk =
      !!mintInfo &&
      !!poolInfo &&
      coinBalance > 0n &&
      !!poolState &&
      poolState.poolState.creator.equals(creator) &&
      poolState.poolState.config.equals(new PublicKey(configs.launchpadCoinConfig));
    const ok =
      configsIdempotent &&
      configsOk &&
      (prepared === null ? run.prepareIdempotent !== false : prepareIdempotent) &&
      launchedOk &&
      refusedAgain &&
      total <= MAX_TOTAL_SPEND;

    report.p(
      'In-process run of `POST /v1/configs` and `POST /v1/launch-coin/prepare` (apps/signer/src/routes) ' +
        'on devnet: real keystore (throwaway, generated in `.state`), real @forge/core, in-memory ' +
        'database stand-in. The client wallet signs the prepared transaction last and sends it.',
    );
    report.h2('Accounts');
    report.table(
      ['Role', 'Address'],
      [
        ['Client (owner, fee claimer, fee payer of the launch)', accountLink(client.publicKey)],
        ['Signer payer wallet (keystore)', accountLink(payer)],
        ['Creator wallet (keystore, `creator:<launchpadId>`)', accountLink(creator)],
        ['Launchpad config', accountLink(configs.launchpadConfig)],
        ['Launchpad coin config', accountLink(configs.launchpadCoinConfig)],
        ['Durable nonce account (authority = creator)', accountLink(entry.details.nonceAccount)],
        ['Coin mint', accountLink(mint)],
        ['Pool', accountLink(pool)],
      ],
    );
    report.h2('Transactions');
    const rows: string[][] = [];
    const creationRows = [
      ['Launchpad config creation', configsEntry.launchpad?.current?.signature],
      ['Launchpad coin config creation', configsEntry.launchpadCoin?.current?.signature],
      ['Nonce account creation', nonceEntry.creation?.current?.signature],
      ['Launch (pool + first buy, signed by the client last)', launchSignature],
    ] as const;
    for (const [label, signature] of creationRows) {
      rows.push([label, signature ? txLink(signature) : 'n/a']);
    }
    report.table(['Step', 'Signature'], rows);
    report.h2('Finding: no referral on the first buy');
    report.p(
      'With a Meteora referral token account on the first buy, the DBC program does not apply ' +
        'the first-swap minimum fee: the swap pays the anti-sniper fee and fails with ' +
        '`ExceededSlippage`, even at 10% slippage. Without a referral it lands exactly at the ' +
        "quote. The route therefore passes no referral on the first buy (core's default would " +
        'add FORGE_METEORA_REFERRAL_ACCOUNT): change request filed for @forge/core.',
    );
    report.table(
      ['Same launch, simulated (sigVerify off, no cost)', 'Result'],
      [
        [
          `With the referral ${accountLink(DEVNET_REFERRAL)}`,
          referralFinding?.withReferral ?? 'not simulated (resumed run)',
        ],
        ['Without a referral', referralFinding?.withoutReferral ?? 'not simulated (resumed run)'],
      ],
    );
    if (existsSync(DISCARDED_FILE)) {
      const discarded = JSON.parse(readFileSync(DISCARDED_FILE, 'utf8')) as { mint?: string };
      report.p(
        `Note: a first prepare of this launchpad (mint ${discarded.mint ?? 'unknown'}) carried the ` +
          'referral; the client send was refused by the preflight simulation (ExceededSlippage), ' +
          'nothing landed and the nonce did not advance. That prepared transaction was removed ' +
          'from the devnet journal by hand before this run (two transactions on one nonce value ' +
          'are mutually exclusive anyway).',
      );
    }
    report.h2('Checks');
    report.table(
      ['Check', 'Result'],
      [
        [
          'Configs: fee claimer = client, creator share 25% (coin config) / spec (launchpad)',
          String(configsOk),
        ],
        ['Configs retry: same addresses, nothing sent', String(configsIdempotent)],
        [
          'Prepare retry: same partially signed transaction',
          prepared === null
            ? run.prepareIdempotent === undefined
              ? 'n/a (resumed run)'
              : `${run.prepareIdempotent} (fresh run)`
            : String(prepareIdempotent),
        ],
        [
          'Launch landed: mint, pool, creator = keystore creator, client holds the coin',
          String(launchedOk),
        ],
        ['Client coin balance (raw)', coinBalance.toString()],
        ['Launch slot', launchSlot === null ? 'n/a' : String(launchSlot)],
        ['Referral on the first buy', entry.details.referral],
        ['Prepare after the launch refused (409 coin_already_launched)', String(refusedAgain)],
        ['Alerts raised', alerts.length === 0 ? 'none' : alerts.join(', ')],
      ],
    );
    report.h2('Spend');
    report.table(
      ['Wallet', 'Spent'],
      [
        ['Payer (two config rents, the nonce rent, fees)', sol(payerSpent)],
        ['Client (pool accounts, Metaplex fee, first buy, fees)', sol(clientSpent)],
        ['Total (limit 0.1 SOL)', sol(total)],
      ],
    );
    report.verdict(
      ok,
      ok
        ? 'configs, durable-nonce launch and idempotency verified on devnet'
        : 'see the checks above',
    );
    report.write('signer-routes.md');
    if (!ok) process.exitCode = 1;
  } finally {
    await keystore.close();
  }
}

void runMain(main);
