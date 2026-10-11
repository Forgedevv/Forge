/**
 * The signer process (VPS 2): the private HMAC server with the signing routes, and the scheduled
 * jobs (claims, cashbox sweep, refunds, watch, fee conversion, plus optional modules such as the
 * buyback), all in ONE process over one shared context (modules.ts).
 *
 * Startup fails closed, before anything is scheduled or served, when:
 * - an environment variable is missing or malformed (env.ts, the jobs' own parsers, the server);
 * - a FORGE address is missing or invalid (`requireAddresses` of @forge/core);
 * - the keystore passphrase does not open the existing keys, or the `payer` / `cashbox` keys are
 *   missing, or the cashbox key is not FORGE_CASHBOX_WALLET;
 * - the RPC endpoint is not on SOLANA_CLUSTER (genesis hash check).
 * Fee recipients that are not rent-exempt are alerted (devnet finding), not fatal: core refuses
 * to build a transaction that would fail on them.
 *
 * Shutdown: stop accepting requests, stop scheduling, wait (bounded) for the requests and runs in
 * progress, flush the queued alerts, close the keystore (zeroes the passphrase).
 */
import type { Server } from 'node:http';
import { Connection } from '@solana/web3.js';
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
import { createExpectedSignatures } from '../jobs/watch.js';
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
import { parseRuntimeEnv, type EnvSource, type RuntimeEnv } from './env.js';
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
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'FORGE_MINT',
] as const;

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
  const serverEnv = loadSignerServerEnv(env as NodeJS.ProcessEnv);
  const a = requireAddresses(SIGNER_ADDRESS_NAMES, env);
  const addresses: SignerAddresses = {
    vault: a.FORGE_MULTISIG_VAULT,
    cashbox: a.FORGE_CASHBOX_WALLET,
    platformFee: a.FORGE_PLATFORM_FEE_WALLET,
    meteoraReferral: a.FORGE_METEORA_REFERRAL_ACCOUNT,
    jupiterReferral: a.FORGE_JUPITER_REFERRAL_ACCOUNT,
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

  const keystore: Keystore = await openKeystore({
    dir: config.keystoreDir,
    passphrase: config.keystorePassphrase,
    logger,
  });
  try {
    const payer = await requireRoleRef(keystore, 'payer');
    const cashbox = await requireRoleRef(keystore, 'cashbox', addresses.cashbox);

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

    const rpc = rpcFromConnection(connection);
    const db = createPostgrestClient({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      fetch: doFetch,
    });
    const flags = createPostgrestFlagsReader(db);
    const expected = createExpectedSignatures(24 * 60 * 60_000, now);
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
      db,
      supabase: { url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey },
      flags,
      alerter,
      logger,
      jobLogger: (name) => createJobLogger(logger, name),
      walletLock: new Mutex(),
      payerLock: new Mutex(),
      expected,
      onBeforeSend: (signature) => expected.expect(signature),
      journalDir: config.journalDir,
      convertRoles: config.convertRoles,
      convertIntervalMs: config.convertIntervalMs,
      fetch: doFetch,
    };

    const scheduler = new JobScheduler({ logger: createJobLogger(logger, 'scheduler'), now });
    for (const module of [...BUILTIN_JOB_MODULES, ...(options.extraJobs ?? [])]) {
      scheduler.register(module.name, await module.create(context));
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
        flags,
        journals: createFileRouteJournals(config.journalDir),
        alerter,
        logger: createJobLogger(logger, 'routes'),
        config: {
          metadataUriTemplate: config.coinMetadataUrl,
          computeUnitPriceMicroLamports: config.priorityFeeMicroLamports,
          paused: config.routesPaused,
        },
        onBeforeSend: context.onBeforeSend,
        payerLock: context.payerLock,
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
    throw err;
  }
}
