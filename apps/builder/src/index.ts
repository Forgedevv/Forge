/// <reference types="node" />
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { requireAddresses } from '@forge/core';
import { OPS, SolanaCluster } from '@forge/shared';
import { z } from 'zod';
import { createAlerter } from './alerts.js';
import { createSupabaseJobsDb } from './db.js';
import { createGateway, DEFAULT_PRICING, type Gateway } from './gateway/index.js';
import { createGithubClient, githubOptionsFromEnv } from './github.js';
import {
  AGENT_DEFAULTS,
  createGithubRepoSource,
  createPipelineHandler,
  createSupabaseStore,
  PersistentCostGatewayStore,
  PIPELINE_DEFAULTS,
  removeStaleWorkdirs,
  visualReviewFromEnv,
  type AgentGateway,
  type PipelineDeps,
  type VisualReviewConfig,
} from './pipeline/index.js';
import {
  assertStepTimeoutsFitJob,
  buildSite,
  createSandboxRunner,
  loadSandboxConfig,
} from './sandbox/index.js';
import type { SpawnFn } from './sandbox/docker.js';
import { scanDiff } from './scan/index.js';
import {
  assertSignerCluster,
  createSignerClient,
  SIGNER_STARTUP_CHECK,
  type SignerClusterCheckOptions,
} from './signer-client.js';
import { enforceDisabledLaunchpads } from './disable.js';
import { isRelayTokenSecret } from './relay-token.js';
import { startSleepScheduler, type SleepScheduler } from './sleep.js';
import { createVercelClient, pickProjectEnv, vercelOptionsFromEnv } from './vercel.js';
import { defaultMaxJobMs, type Worker, type WorkerLogger } from './worker.js';
import { sanitizeError } from './worker/messages.js';
import { createWorkerLogger, runWorker } from './worker/run.js';

/**
 * Builder process (VPS 1): the model gateway, the job worker with the creation and modification
 * pipelines, and the daily sleep cycle. Configuration: apps/builder/.env.example.
 *
 * Start-up checks, in order, before any job is picked up: environment (zod, names only in
 * errors; the Telegram alert variables on mainnet-beta), FORGE addresses (`requireAddresses` of
 * @forge/core), public variables of client
 * projects, sandbox step timeouts against the cap on one job, sandbox configuration, visual
 * review setting, the signer's cluster (its health route must report SOLANA_CLUSTER; an
 * unreachable signer is retried a few times with backoff, then the start-up fails), removal of
 * sandbox containers and job folders left by a crash, then the gateway listens and the worker
 * starts polling.
 */

const intFromEnv = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);
const boolFromEnv = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const BuilderEnvSchema = z.object({
  SOLANA_CLUSTER: SolanaCluster.default('devnet'),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /** Real API key: used by the gateway only, never enters a sandbox. */
  ANTHROPIC_API_KEY: z.string().min(20),
  FORGE_GATEWAY_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.:-]{1,253}$/)
    .default('127.0.0.1'),
  FORGE_GATEWAY_PORT: intFromEnv(8787, 1, 65_535),
  FORGE_GATEWAY_UPSTREAM_URL: z.url().default('https://api.anthropic.com'),
  FORGE_GATEWAY_DAILY_BUDGET_USD: z.coerce.number().positive().max(100_000).default(200),
  BUILDER_AGENT_MODEL: z
    .string()
    .default('claude-sonnet-5-5')
    .refine((m) => Object.hasOwn(DEFAULT_PRICING, m), 'model is not priced by the gateway'),
  BUILDER_AGENT_BIN: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,200}$/)
    .default(AGENT_DEFAULTS.bin),
  BUILDER_AGENT_MAX_TURNS: intFromEnv(AGENT_DEFAULTS.maxTurns, 5, 500),
  BUILDER_AGENT_MEMORY_MB: intFromEnv(AGENT_DEFAULTS.memoryMb, 512, 16_384),
  BUILDER_AGENT_CPUS: z.coerce.number().min(0.5).max(8).default(AGENT_DEFAULTS.cpus),
  /** Signs the per-launchpad relay token of each client project (at least 32 bytes). */
  RPC_RELAY_TOKEN_SECRET: z.string().refine(isRelayTokenSecret, 'at least 32 bytes'),
  SIGNER_URL: z.url(),
  SIGNER_HMAC_SECRET: z.string().min(32),
  /** The configs route waits for on-chain confirmations. */
  SIGNER_TIMEOUT_MS: intFromEnv(120_000, 5_000, 600_000),
  /** `<slug>.<CLIENTS_DOMAIN>` for every client site. */
  CLIENTS_DOMAIN: z.string().min(4),
  BUILDER_SLEEP_ENABLED: boolFromEnv(true),
  BUILDER_SLEEP_INTERVAL_HOURS: intFromEnv(24, 1, 24 * 7),
  /** Disabled launchpads: their sites are cut at startup, every sleep cycle and this often. */
  BUILDER_DISABLED_SWEEP_MINUTES: intFromEnv(15, 1, 24 * 60),
  BUILDER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
});

export type BuilderEnv = z.infer<typeof BuilderEnvSchema>;

/** Variables read by this module (documented in .env.example). */
export const BUILDER_ENV_NAMES: readonly string[] = Object.keys(BuilderEnvSchema.shape);

/** FORGE addresses the builder needs: the ones it copies into client Vercel projects. */
export const BUILDER_ADDRESSES = [
  'FORGE_REVENUE_WALLET',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
] as const;

/** The environment without empty values: an `.env` line with no value counts as unset. */
export function withoutEmpty(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/**
 * The Telegram variables of the operator alerts (alerts.ts). Required on mainnet-beta, like on
 * the signer (apps/signer/src/runtime/env.ts): an alert that only reaches the log is lost.
 */
export const ALERTING_VARIABLES = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;

/**
 * Validates the builder environment. Errors name the variables, never their values. On
 * mainnet-beta the Telegram alert variables are required (blank counts as unset).
 */
export function loadBuilderEnv(env: Record<string, string | undefined>): BuilderEnv {
  const cleaned = withoutEmpty(env);
  const parsed = BuilderEnvSchema.safeParse(cleaned);
  const invalid = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '?')))];
  const cluster = parsed.success ? parsed.data.SOLANA_CLUSTER : cleaned.SOLANA_CLUSTER;
  const missingAlerting =
    cluster === 'mainnet-beta'
      ? ALERTING_VARIABLES.filter((name) => (cleaned[name] ?? '').trim() === '')
      : [];
  if (!parsed.success || missingAlerting.length > 0) {
    const parts = [
      invalid.filter((name) => !(missingAlerting as readonly string[]).includes(name)).join(', '),
      missingAlerting.length > 0
        ? `${missingAlerting.join(', ')} required on mainnet-beta (alerts would only be logged without them)`
        : '',
    ].filter(Boolean);
    throw new Error(`invalid builder environment: ${parts.join('; ')}`);
  }
  return parsed.data;
}

/**
 * Everything checked before the process does anything: environment, FORGE addresses, public
 * variables of client projects. Pure (no network), so it is unit tested.
 */
export function checkStartupConfig(env: Record<string, string | undefined>): {
  config: BuilderEnv;
  projectEnv: Record<string, string>;
} {
  const config = loadBuilderEnv(env);
  const cleaned = withoutEmpty(env);
  requireAddresses(BUILDER_ADDRESSES, cleaned);
  const picked = pickProjectEnv({ ...cleaned, SOLANA_CLUSTER: config.SOLANA_CLUSTER });
  if (picked.missing.length > 0 || picked.invalid.length > 0) {
    const parts = [
      picked.missing.length > 0 ? `missing: ${picked.missing.join(', ')}` : '',
      picked.invalid.length > 0 ? `invalid: ${picked.invalid.join(', ')}` : '',
    ].filter(Boolean);
    throw new Error(`client project variables are not configured (${parts.join('; ')})`);
  }
  if (picked.vars.SOLANA_CLUSTER !== config.SOLANA_CLUSTER) {
    throw new Error('SOLANA_CLUSTER of client projects does not match the builder cluster');
  }
  return { config, projectEnv: picked.vars };
}

/**
 * Visual review of new sites (second agent pass on screenshots of the built site), read from
 * `BUILDER_VISUAL_REVIEW` (`off` default, `on`) and the review image of the sandbox
 * (`FORGE_SANDBOX_REVIEW_IMAGE`). On without an image: disabled, and said at startup. Read apart
 * from `BuilderEnvSchema`, like the sandbox variables.
 */
export function visualReviewSetup(
  env: Record<string, string | undefined>,
  reviewImage: string | null,
  logger: Pick<WorkerLogger, 'info' | 'warn'>,
): VisualReviewConfig | undefined {
  const setting = visualReviewFromEnv(env, reviewImage);
  if (setting.enabled) {
    const c = setting.config;
    logger.info(
      {
        captureTimeoutMs: c.captureTimeoutMs,
        agentTimeoutMs: c.agentTimeoutMs,
        maxBudgetUsd: c.maxBudgetUsd,
      },
      'visual review enabled for new sites',
    );
    return c;
  }
  if (setting.reason === 'no_image') {
    logger.warn(
      {},
      'BUILDER_VISUAL_REVIEW is on but FORGE_SANDBOX_REVIEW_IMAGE is not set: visual review disabled',
    );
  } else {
    logger.info({}, 'visual review off');
  }
  return undefined;
}

/**
 * The gateway as the pipeline sees it, with the job cost from the gateway's own accounting (what
 * the visual review budgets from).
 */
export function pipelineGateway(
  gateway: Pick<Gateway, 'issueToken' | 'revokeToken'>,
  costs: { getJobCost(jobId: string): Promise<number> },
): AgentGateway {
  return {
    issueToken: (jobId, options) => gateway.issueToken(jobId, options),
    revokeToken: (token) => gateway.revokeToken(token),
    jobCostUsd: (jobId) => costs.getJobCost(jobId),
  };
}

export interface BuilderProcess {
  worker: Worker;
  gateway: Gateway;
  scheduler: SleepScheduler | undefined;
  /**
   * Graceful shutdown: site upkeep (disabled sweep, sleep cycle), worker (running jobs get their
   * grace period), gateway.
   */
  stop(): Promise<void>;
}

export interface StartBuilderOptions {
  env?: Record<string, string | undefined>;
  logger?: WorkerLogger;
  /** Registers SIGTERM / SIGINT handlers. Default true. */
  handleSignals?: boolean;
  /** Test seam: docker CLI spawner of the sandbox. */
  spawn?: SpawnFn;
  /** Test seam: listen on this port instead of FORGE_GATEWAY_PORT (0 = any free port). */
  gatewayPort?: number;
  /** Test seam: retries of the signer cluster check (default SIGNER_STARTUP_CHECK). */
  signerCheck?: Pick<SignerClusterCheckOptions, 'attempts' | 'baseDelayMs' | 'sleep'>;
}

/** Starts the builder. Resolves once the gateway listens and the worker polls. */
export async function startBuilder(opts: StartBuilderOptions = {}): Promise<BuilderProcess> {
  // Every loader below gets the same environment, empty values removed.
  const env = withoutEmpty(opts.env ?? process.env);
  const { config, projectEnv } = checkStartupConfig(env);
  const logger = opts.logger ?? createWorkerLogger(config.BUILDER_LOG_LEVEL);
  // The worker below runs with its default cap on one job: the sandbox step timeouts in use
  // (BUILD_DEFAULTS) and the agent's must fit in it, or a slow build would be cut mid-job.
  assertStepTimeoutsFitJob({
    maxJobMs: defaultMaxJobMs(),
    agentTimeoutMs: AGENT_DEFAULTS.timeoutMs,
  });

  const sandboxConfig = loadSandboxConfig(env);
  if (!sandboxConfig.gateway) {
    throw new Error(
      'FORGE_SANDBOX_GATEWAY_UPSTREAM is required: the agent reaches the gateway through it',
    );
  }
  const review = visualReviewSetup(env, sandboxConfig.reviewImage, logger);

  // The signer must run on the builder's cluster: checked before anything runs, through a client
  // with a short timeout (assertSignerCluster: a mismatch fails at once, an unreachable signer is
  // retried with backoff, then fails).
  const signerHealth = await assertSignerCluster(
    createSignerClient({
      baseUrl: config.SIGNER_URL,
      hmacSecret: config.SIGNER_HMAC_SECRET,
      timeoutMs: SIGNER_STARTUP_CHECK.timeoutMs,
      maxAttempts: 1,
    }),
    config.SOLANA_CLUSTER,
    { logger, ...opts.signerCheck },
  );
  logger.info(
    { cluster: signerHealth.cluster, signerOk: signerHealth.ok },
    'signer cluster checked',
  );

  const runner = createSandboxRunner(sandboxConfig, {
    logger,
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
  });
  const leftovers = await runner.cleanupStale();
  const staleFolders = await removeStaleWorkdirs(
    sandboxConfig.jobsRoot,
    OPS.jobLockStaleMinutes * 2 * 60_000,
  );
  logger.info({ ...leftovers, staleFolders }, 'sandbox leftovers cleaned');

  const githubOptions = githubOptionsFromEnv(env);
  const github = createGithubClient(githubOptions);
  // Deployments upload the files of a commit, read through the GitHub App (vercel.ts).
  const vercel = createVercelClient({ ...vercelOptionsFromEnv(env), source: github });
  const store = createSupabaseStore({
    url: config.SUPABASE_URL,
    serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
  });
  const alerter = createAlerter({
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
    logger,
    minIntervalMs: 60_000,
  });

  // The daily budget survives a restart: the startup day starts from what today's jobs already
  // spent (an approximation from above, see cost-store.ts), then accumulates in memory.
  const startupDay = new Date().toISOString().slice(0, 10);
  const costStore = new PersistentCostGatewayStore(store, logger, {
    day: startupDay,
    load: () => store.sumJobCostsSince(`${startupDay}T00:00:00.000Z`),
  });
  try {
    await costStore.seedDailyCost();
  } catch (err) {
    // Fail closed: the gateway refuses requests until the seed loads (retried on each request).
    logger.warn(
      { error: sanitizeError(err) },
      'could not read the API cost already spent today; the gateway refuses requests until it can',
    );
  }
  const gateway = createGateway({
    upstreamUrl: config.FORGE_GATEWAY_UPSTREAM_URL,
    apiKey: config.ANTHROPIC_API_KEY,
    store: costStore,
    pricing: DEFAULT_PRICING,
    dailyBudgetUsd: config.FORGE_GATEWAY_DAILY_BUDGET_USD,
    onAlert: (alert) =>
      alerter.alert(
        'high',
        `gateway_daily_budget:${alert.day}`,
        'Daily API budget above the alert threshold',
        {
          day: alert.day,
          totalUsd: alert.totalUsd.toFixed(2),
          dailyBudgetUsd: alert.dailyBudgetUsd,
        },
      ),
  });
  const address = await gateway.listen(
    opts.gatewayPort ?? config.FORGE_GATEWAY_PORT,
    config.FORGE_GATEWAY_HOST,
  );
  logger.info({ host: address.address, port: address.port }, 'gateway listening');

  const deps: PipelineDeps = {
    github,
    vercel,
    repoSource: createGithubRepoSource({ org: githubOptions.org, github }),
    runner,
    buildSite,
    gateway: pipelineGateway(gateway, costStore),
    scan: scanDiff,
    signer: createSignerClient({
      baseUrl: config.SIGNER_URL,
      hmacSecret: config.SIGNER_HMAC_SECRET,
      timeoutMs: config.SIGNER_TIMEOUT_MS,
    }),
    store,
    alerter,
    config: {
      cluster: config.SOLANA_CLUSTER,
      clientsDomain: config.CLIENTS_DOMAIN,
      projectEnv,
      rpcRelayTokenSecret: config.RPC_RELAY_TOKEN_SECRET,
      scanOptions: {
        ...(projectEnv.NEXT_PUBLIC_FORGE_RPC_RELAY_URL
          ? { rpcRelayHost: new URL(projectEnv.NEXT_PUBLIC_FORGE_RPC_RELAY_URL).hostname }
          : {}),
        ...(projectEnv.R2_PUBLIC_URL
          ? { r2PublicHost: new URL(projectEnv.R2_PUBLIC_URL).hostname }
          : {}),
      },
      agent: {
        bin: config.BUILDER_AGENT_BIN,
        model: config.BUILDER_AGENT_MODEL,
        maxTurns: config.BUILDER_AGENT_MAX_TURNS,
        timeoutMs: AGENT_DEFAULTS.timeoutMs,
        memoryMb: config.BUILDER_AGENT_MEMORY_MB,
        cpus: config.BUILDER_AGENT_CPUS,
        budgetUsd: AGENT_DEFAULTS.budgetUsd,
      },
      // No registry token: @forge/core installs from the public npm registry (decision D26).
      sandboxUid: sandboxConfig.uid,
      sandboxGid: sandboxConfig.gid,
      deploymentTimeoutMs: PIPELINE_DEFAULTS.deploymentTimeoutMs,
      promotionTimeoutMs: PIPELINE_DEFAULTS.promotionTimeoutMs,
      ...(review ? { review } : {}),
    },
  };

  const worker = runWorker({
    handler: createPipelineHandler(deps),
    env,
    logger,
    handleSignals: false,
  });

  // Site upkeep: disabled launchpads are cut (always, from startup on), and the sleep cycle runs
  // when enabled.
  const flags = createSupabaseJobsDb({
    url: config.SUPABASE_URL,
    serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
  });
  const isPaused = () => flags.getFlag('deploys_paused');
  const verified = new Map<string, string>();
  const rpcRelayTokenSecret = config.RPC_RELAY_TOKEN_SECRET;
  const scheduler: SleepScheduler | undefined = startSleepScheduler(
    { store, github, vercel, projectEnv, rpcRelayTokenSecret, logger, alerter, isPaused },
    {
      intervalMs: config.BUILDER_SLEEP_INTERVAL_HOURS * 3_600_000,
      sleepEnabled: config.BUILDER_SLEEP_ENABLED,
      disableIntervalMs: config.BUILDER_DISABLED_SWEEP_MINUTES * 60_000,
      enforceDisabled: (signal) =>
        enforceDisabledLaunchpads(
          {
            store,
            github,
            vercel,
            projectEnv,
            rpcRelayTokenSecret,
            logger,
            alerter,
            isPaused,
            verified,
          },
          signal,
        ),
    },
  );

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info({}, 'builder stopping');
      await scheduler?.stop();
      await worker.stop();
      await gateway.close();
      logger.info({}, 'builder stopped');
    })();
    return stopping;
  };

  if (opts.handleSignals !== false) {
    const onSignal = (signal: string) => {
      logger.info({ signal }, 'shutdown requested');
      stop().then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ error: sanitizeError(err) }, 'shutdown failed');
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
  }

  return { worker, gateway, scheduler, stop };
}

/** True when this module is the process entry point (`tsx src/index.ts`, `node dist/index.js`). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  startBuilder().catch((err: unknown) => {
    // Start-up errors name variables, never values; redacted again to be sure.
    process.stderr.write(`forge-builder failed to start: ${sanitizeError(err)}\n`);
    process.exit(1);
  });
}
