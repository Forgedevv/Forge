/// <reference types="node" />
import { pino } from 'pino';
import { createAlerter } from '../alerts.js';
import { createSupabaseJobsDb } from '../db.js';
import { Worker, type JobHandler, type WorkerLogger } from '../worker.js';
import { loadWorkerEnv } from './config.js';

/** Keys that must never reach a log line, wherever they appear in a logged object. */
const REDACT_PATHS = [
  '*.authorization',
  '*.apiKey',
  '*.serviceRoleKey',
  '*.token',
  '*.secret',
  '*.owner_tx',
  'serviceRoleKey',
  'token',
  'secret',
];

export function createWorkerLogger(level: string = 'info'): WorkerLogger {
  return pino({
    level,
    base: { app: 'forge-builder' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}

export interface RunWorkerOptions {
  handler: JobHandler;
  env?: Record<string, string | undefined>;
  logger?: WorkerLogger;
  /** Registers SIGTERM / SIGINT handlers. Default true. */
  handleSignals?: boolean;
}

/**
 * Builds the worker from the process environment, starts it and wires graceful shutdown.
 * Resolves with the worker once it is polling; call `stop()` to shut it down.
 */
export function runWorker(opts: RunWorkerOptions): Worker {
  const env = loadWorkerEnv(opts.env ?? process.env);
  const logger = opts.logger ?? createWorkerLogger(env.BUILDER_LOG_LEVEL);
  const db = createSupabaseJobsDb({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const alerter = createAlerter({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    logger,
    minIntervalMs: 60_000,
  });
  const worker = new Worker({
    db,
    handler: opts.handler,
    logger,
    alerter,
    concurrency: env.BUILDER_CONCURRENCY,
    pollIntervalMs: env.BUILDER_POLL_INTERVAL_MS,
    ...(env.BUILDER_WORKER_ID ? { workerId: env.BUILDER_WORKER_ID } : {}),
  });

  if (opts.handleSignals !== false) {
    let shuttingDown = false;
    const onSignal = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'shutdown requested');
      worker.stop().then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ error: err instanceof Error ? err.name : 'unknown' }, 'shutdown failed');
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
  }

  worker.start();
  return worker;
}
