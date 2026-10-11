import { Connection } from '@solana/web3.js';
import { MemoryRateLimiter, type RateLimiter } from '../payments/rate-limit';
import { readRoutesConfig, type RoutesConfig } from './config';
import { consoleLogger, type RoutesLogger } from './log';
import type { RoutesStore } from './store';
import { SupabaseRoutesStore, createServiceSupabaseClient } from './supabase-store';

/*
 * Production dependencies shared by the job and launchpad routes, built from the environment at
 * the first request (a configuration error is answered with a 503 and retried on the next one).
 * The rate limiter is per server instance (see payments/rate-limit.ts).
 */

export interface RoutesRuntime {
  config: RoutesConfig;
  store: RoutesStore;
  connection: Connection;
  rateLimiter: RateLimiter;
}

const GLOBAL_KEY = Symbol.for('forge.web.routes.runtime');

export function getRoutesRuntime(): RoutesRuntime {
  const g = globalThis as unknown as Record<symbol, RoutesRuntime | undefined>;
  const cached = g[GLOBAL_KEY];
  if (cached) return cached;
  const config = readRoutesConfig();
  const runtime: RoutesRuntime = {
    config,
    store: new SupabaseRoutesStore(
      createServiceSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey),
    ),
    connection: new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      // Retries are done by the callers (bounded, with backoff).
      disableRetryOnRateLimit: true,
    }),
    rateLimiter: new MemoryRateLimiter(),
  };
  g[GLOBAL_KEY] = runtime;
  return runtime;
}

export const jobsLogger: RoutesLogger = consoleLogger('jobs');
export const launchpadsLogger: RoutesLogger = consoleLogger('launchpads');
