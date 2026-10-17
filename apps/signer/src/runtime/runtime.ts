/**
 * The signer process (VPS 2): the private HMAC server with the signing routes, and the scheduled
 * jobs (claims, cashbox sweep, refunds, watch, fee conversion, plus optional modules such as the
 * buyback), all in ONE process over one shared context (modules.ts).
 *
 * Startup fails closed, before anything is scheduled or served, when:
 * - an environment variable is missing or malformed (env.ts, the jobs' own parsers, the server);
 * - a FORGE address is missing or invalid (`requireAddresses` of @forge/core);
 * - another signer (or the operator command) holds the instance lock of SIGNER_JOURNAL_DIR
 *   (instance.ts: the journals, the replay cache and the locks are per process);
 * - the keystore passphrase does not open the existing keys, or the `payer` / `cashbox` keys are
 *   missing, or the cashbox key is not FORGE_CASHBOX_WALLET;
 * - the RPC endpoint is not on SOLANA_CLUSTER (genesis hash check);
 * - on mainnet-beta only: the revenue wallet wiring is wrong (`revenueWiringProblems`: no
 *   `revenue` key or one that is not FORGE_REVENUE_WALLET, FORGE_PLATFORM_FEE_WALLET not that
 *   wallet, the Meteora referral account held by someone else). On devnet the same problems raise
 *   a high alert (`revenue_wiring`) and the revenue job stays off until they are fixed.
 * Fee recipients that are not rent-exempt are alerted (devnet finding), not fatal: core refuses
 * to build a transaction that would fail on them. An OPTIONAL job module (`extraJobs`, the
 * buyback) whose configuration is refused is disabled with a high alert: the built-in jobs and
 * the routes run without it. Except where the module is required (`required`): the buyback with
 * FORGE_BUYBACK_LIVE set on mainnet-beta is, so a refused live buyback there stops the startup.
 *
 * The keystore passphrase and the Supabase service role key are removed from the environment as
 * soon as they are parsed (env.ts `dropParsedSecrets`).
 *
 * Shutdown: stop accepting requests, stop scheduling, wait (bounded) for the requests and runs in
 * progress, flush the queued alerts, close the keystore (zeroes the passphrase), release the lock.
 */
import type { Server } from 'node:http';
import { TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { Connection, type PublicKey } from '@solana/web3.js';
import { pino } from 'pino';
import {
  CLUSTER_GENESIS_HASH,
  RentExemptionError,
  assertRentExempt,
  requireAddresses,
} from '@forge/core';
import { createAlerterFromEnv } from '../alerts.js';
import { createForgeSignerCore } from '../core-adapter.js';
import { openKeystore, type Keystore } from '../keystore.js';
import {
  Mutex,
  createJobLogger,
  createPostgrestClient,
  createPostgrestFlagsReader,
  describeError,
  requireRoleRef,
  rpcFromConnection,
  sendAlert,
} from '../jobs/shared.js';
import { PayerReservations } from '../jobs/reservations.js';
import { revenueWiringProblems } from '../jobs/revenue.js';
import { createExpectedSignatureLog, createExpectedSignatures } from '../jobs/watch.js';
import {
  createFileRouteJournals,
  createForgeRouteCore,
  createPostgrestRouteStore,
  createSignerRoutes,
  type RouteCore,
} from '../routes/index.js';
import type { SignerHealthReport } from '../routes/schemas.js';
import {
  createSignerLogger,
  createSignerServer,
  loadSignerServerEnv,
  type SignerRouteHandlers,
} from '../server.js';
import {
  dropConsumedSecrets,
  dropParsedSecrets,
  parseRuntimeEnv,
  type EnvSource,
  type RuntimeEnv,
} from './env.js';
import { acquireInstanceLock, type InstanceLock } from './instance.js';
import {
  BUILTIN_JOB_MODULES,
  type SignerAddresses,
  type SignerJobContext,
  type SignerJobModule,
} from './modules.js';
import { JobScheduler } from './scheduler.js';

export interface SignerRuntimeOptions {
  env: EnvSource;
  /** Optional job modules run next to the built-in ones (e.g. the buyback). */
  extraJobs?: readonly SignerJobModule[];
  /** Injection for tests (no network): connection, fetch, loggers, clock, listen port. */
  connection?: Connection;
  fetch?: typeof fetch;
  logger?: pino.Logger;
  serverLogger?: pino.Logger;
  now?: () => number;
  port?: number;
  /** Replaces the route core (tests). */
  routeCore?: RouteCore;
}

export interface SignerRuntime {
  readonly config: RuntimeEnv;
  readonly context: SignerJobContext;
  readonly scheduler: JobScheduler;
  readonly routes: SignerRouteHandlers;
  readonly server: Server;
  /** Optional job modules whose configuration was refused at startup (alerted, not scheduled). */
  readonly disabledJobs: readonly string[];
  health(): SignerHealthReport;
  /** Listens and starts the job loops. */
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

/** Names of the FORGE addresses the signer uses (INTERFACES §8 plus the launch referral). */
export const SIGNER_ADDRESS_NAMES = [
  'FORGE_MULTISIG_VAULT',
  'FORGE_CASHBOX_WALLET',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_REVENUE_WALLET',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'FORGE_MINT',
] as const;

/**
 * Owner of a classic SPL token account read on-chain; null when the account is missing, not
 * owned by the token program or not decodable (the rent check reports those separately).
 */
async function readTokenAccountOwner(
  connection: Connection,
  address: PublicKey,
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) return null;
  try {
    return unpackAccount(address, info, TOKEN_PROGRAM_ID).owner;
  } catch {
    return null;
  }
}

const ROOT_REDACT = [
  'secret',
  'passphrase',
  'serviceRoleKey',
  'hmacSecret',
  'headers',
  'authorization',
  'apikey',
];

export async function createSignerRuntime(options: SignerRuntimeOptions): Promise<SignerRuntime> {
  // An empty value is an unset one (a copied .env.example leaves optional values blank).
  const env: EnvSource = Object.fromEntries(
    Object.entries(options.env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const config = parseRuntimeEnv(env);
  // Parsed: the secrets leave the environment (ours, the caller's and the process one).
  dropParsedSecrets(env, options.env, process.env);
  const serverEnv = loadSignerServerEnv(env as NodeJS.ProcessEnv);
  const a = requireAddresses(SIGNER_ADDRESS_NAMES, env);
  const addresses: SignerAddresses = {
    vault: a.FORGE_MULTISIG_VAULT,
    cashbox: a.FORGE_CASHBOX_WALLET,
    platformFee: a.FORGE_PLATFORM_FEE_WALLET,
    meteoraReferral: a.FORGE_METEORA_REFERRAL_ACCOUNT,
    jupiterReferral: a.FORGE_JUPITER_REFERRAL_ACCOUNT,
    revenue: a.FORGE_REVENUE_WALLET,
    forgeMint: a.FORGE_MINT,
  };
  const now = options.now ?? Date.now;
  const logger =
    options.logger ??
    pino({
      name: 'signer',
      level: config.logLevel,
      redact: { paths: ROOT_REDACT, censor: '[redacted]' },
    });
  const doFetch = options.fetch ?? globalThis.fetch;
  const alerter = createAlerterFromEnv(logger.child({ module: 'alerts' }), env, {
    fetch: doFetch,
    now,
  });
  const startupLog = createJobLogger(logger, 'startup');

  // One signer per journal directory, taken before any key is opened.
  const lock: InstanceLock = await acquireInstanceLock(config.journalDir, { command: 'signer' });
  let keystore: Keystore;
  try {
    keystore = await openKeystore({
      dir: config.keystoreDir,
      passphrase: config.keystorePassphrase,
      logger,
    });
  } catch (err) {
    await lock.release().catch(() => undefined);
    throw err;
  }
  try {
    const payer = await requireRoleRef(keystore, 'payer');
    const cashbox = await requireRoleRef(keystore, 'cashbox', addresses.cashbox);
    const revenueRef = await keystore.findRef('revenue');
    const revenueKey = revenueRef ? await keystore.getPublicKey(revenueRef) : null;

    const connection =
      options.connection ?? new Connection(config.rpcUrl, { commitment: 'confirmed' });
    const genesis = await connection.getGenesisHash();
    if (genesis !== CLUSTER_GENESIS_HASH[config.cluster]) {
      throw new Error(`RPC_URL does not serve SOLANA_CLUSTER (${config.cluster})`);
    }
    try {
      await assertRentExempt(connection, [
        { address: addresses.platformFee, label: 'FORGE_PLATFORM_FEE_WALLET' },
        { address: addresses.meteoraReferral, label: 'FORGE_METEORA_REFERRAL_ACCOUNT' },
      ]);
    } catch (err) {
      if (!(err instanceof RentExemptionError)) throw err;
      startupLog.warn(
        { accounts: err.accounts.map((x) => x.label) },
        'fee recipient not rent-exempt',
      );
      await sendAlert(
        alerter,
        startupLog,
        'high',
        'fee_recipient_not_rent_exempt',
        'A FORGE fee recipient is missing or below the rent-exempt minimum: swaps and launches through it fail until it is funded',
        { accounts: err.accounts.map((x) => x.label).join(', ') },
        'fee_recipient_not_rent_exempt',
      );
    }
    // The revenue wallet must be the keystore key, the platform fee wallet and the holder of the
    // Meteora referral account (D34): fatal on mainnet-beta, a high alert on devnet.
    const wiringProblems = revenueWiringProblems({
      revenue: addresses.revenue,
      platformFee: addresses.platformFee,
      vault: addresses.vault,
      cashbox: addresses.cashbox,
      revenueKey,
      referralOwner: await readTokenAccountOwner(connection, addresses.meteoraReferral),
    });
    if (wiringProblems.length > 0) {
      if (config.cluster === 'mainnet-beta') {
        throw new Error(`revenue wallet wiring refused: ${wiringProblems.join('; ')}`);
      }
      startupLog.warn({ problems: wiringProblems }, 'revenue wallet wiring refused');
      await sendAlert(
        alerter,
        startupLog,
        'high',
        'revenue_wiring',
        'The revenue wallet is not wired: the trading revenue cannot be forwarded to the vault (on mainnet-beta the signer would refuse to start)',
        { problems: wiringProblems.join('; ') },
        'revenue_wiring',
      );
    }
    const revenue =
      revenueRef && revenueKey && revenueKey.equals(addresses.revenue)
        ? { ref: revenueRef, publicKey: revenueKey }
        : null;

    const rpc = rpcFromConnection(connection);
    const db = createPostgrestClient({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      fetch: doFetch,
    });
    const flags = createPostgrestFlagsReader(db);
    // Every announced signature is on disk (fsynced) before its broadcast, so a restart between
    // a broadcast and the next watcher state save does not flag the signer's own transaction.
    const expectedTtlMs = 24 * 60 * 60_000;
    const expectedLog = createExpectedSignatureLog(config.journalDir, { ttlMs: expectedTtlMs, now });
    const expected = createExpectedSignatures(expectedTtlMs, now, expectedLog);
    const context: SignerJobContext = {
      env,
      cluster: config.cluster,
      addresses,
      connection,
      rpc,
      core: createForgeSignerCore({
        connection,
        cashbox: addresses.cashbox,
        cluster: config.cluster,
      }),
      keystore,
      payer,
      cashbox,
      revenue,
      priorityFeeMicroLamports: config.priorityFeeMicroLamports,
      db,
      supabase: { url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey },
      flags,
      alerter,
      logger,
      jobLogger: (name) => createJobLogger(logger, name),
      walletLock: new Mutex(),
      payerLock: new Mutex(),
      payerReservations: new PayerReservations(),
      expected,
      expectedLog,
      onBeforeSend: (signature) => expected.expect(signature),
      journalDir: config.journalDir,
      convertRoles: config.convertRoles,
      convertIntervalMs: config.convertIntervalMs,
      fetch: doFetch,
    };

    const scheduler = new JobScheduler({ logger: createJobLogger(logger, 'scheduler'), now });
    for (const module of BUILTIN_JOB_MODULES) {
      scheduler.register(module.name, await module.create(context));
    }
    // Optional modules: a refused configuration disables that module only, loudly, unless the
    // module is required in this environment (the live buyback on mainnet-beta): then the
    // startup fails, like for a built-in job.
    const disabledJobs: string[] = [];
    for (const module of options.extraJobs ?? []) {
      try {
        scheduler.register(module.name, await module.create(context));
      } catch (err) {
        if (module.required?.(context)) throw err;
        const summary = describeError(err);
        disabledJobs.push(module.name);
        startupLog.error({ job: module.name, err: summary }, 'optional job disabled');
        await sendAlert(
          alerter,
          startupLog,
          'high',
          'job_module_disabled',
          `The optional ${module.name} job is disabled: its configuration was refused at startup; the other jobs and the signing routes run without it`,
          { job: module.name, error: summary.message },
          `job_module_disabled:${module.name}`,
        );
      }
    }

    let running = false;
    let stopping: Promise<void> | null = null;
    const startedAt = now();
    const health = (): SignerHealthReport => ({
      ok: running && stopping === null,
      cluster: config.cluster,
      uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      jobs: scheduler.states(),
    });

    const routes = createSignerRoutes(
      {
        store: createPostgrestRouteStore(db),
        core:
          // No referral on the first buy (devnet finding, see createForgeRouteCore).
          options.routeCore ?? createForgeRouteCore({ connection }),
        rpc,
        keystore,
        // The creation payment is proven on-chain (finalized) before any payer spend.
        payments: {
          cashbox: addresses.cashbox,
          verifyPayment: (signature, expected) => context.core.verifyPayment(signature, expected),
        },
        flags,
        journals: createFileRouteJournals(config.journalDir),
        alerter,
        logger: createJobLogger(logger, 'routes'),
        config: {
          metadataUriTemplate: config.coinMetadataUrl,
          computeUnitPriceMicroLamports: config.priorityFeeMicroLamports,
          paused: config.routesPaused,
          maxLaunchpadsPerDay: config.maxLaunchpadsPerDay,
          minPaymentLamports: config.minPaymentLamports,
        },
        onBeforeSend: context.onBeforeSend,
        payerLock: context.payerLock,
        payerReservations: context.payerReservations,
        now,
      },
      { health },
    );
    const server = createSignerServer({
      hmacSecret: serverEnv.hmacSecret,
      routes,
      allowedIps: serverEnv.allowedIps,
      production: serverEnv.production,
      logger: options.serverLogger ?? createSignerLogger(),
      now,
    });
    // Consumed: the server holds the HMAC secret, the alerter the bot token, the buyback and
    // conversion jobs their Jupiter client. Nothing reads them from the environment any more.
    dropConsumedSecrets(env, options.env, process.env);

    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        const drained = Promise.allSettled([closed, scheduler.stop()]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), config.shutdownTimeoutMs);
        });
        const outcome = await Promise.race([drained.then(() => 'drained' as const), timeout]);
        if (timer) clearTimeout(timer);
        if (outcome === 'timeout') {
          startupLog.warn({}, 'shutdown timeout: closing the remaining connections');
          server.closeAllConnections();
        }
        running = false;
        await alerter.flushPending();
        await keystore.close();
        await lock.release().catch((err: unknown) => {
          startupLog.warn({ err: describeError(err) }, 'instance lock not released');
        });
        startupLog.info({}, 'signer stopped');
      })();
      return stopping;
    };

    return {
      config,
      context,
      scheduler,
      routes,
      server,
      disabledJobs,
      health,
      async start() {
        if (running) throw new Error('already started');
        const port = options.port ?? serverEnv.port;
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, config.host, () => {
            server.off('error', reject);
            resolve();
          });
        });
        running = true;
        scheduler.start();
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        startupLog.info(
          { cluster: config.cluster, host: config.host, port: bound, jobs: scheduler.names() },
          'signer started',
        );
        return { host: config.host, port: bound };
      },
      stop,
    };
  } catch (err) {
    startupLog.error({ err: describeError(err) }, 'signer startup failed');
    await keystore.close();
    await lock.release().catch(() => undefined);
    throw err;
  }
}
