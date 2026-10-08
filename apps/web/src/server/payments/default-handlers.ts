import { Connection } from '@solana/web3.js';
import { readPaymentsConfig } from './config';
import { createCorePaymentGateway } from './gateway';
import { createPaymentsHandlers, errorToResponse, type PaymentsHandlers } from './handlers';
import { consoleLogger } from './log';
import { JupiterPriceSource } from './price-source';
import { MemoryRateLimiter } from './rate-limit';
import { createPaymentsService } from './service';
import { createServiceSupabaseClient, SupabasePaymentsStore } from './supabase-store';

/*
 * Production wiring of the payment routes, built from the environment at the first request (a
 * configuration error is answered with a 500 and retried on the next request).
 */

let handlers: PaymentsHandlers | null = null;

export function getPaymentsHandlers(): PaymentsHandlers {
  if (handlers) return handlers;
  const config = readPaymentsConfig();
  const store = new SupabasePaymentsStore(
    createServiceSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey),
  );
  const connection = new Connection(config.rpcUrl, {
    commitment: 'confirmed',
    // Retries are done by the adapter (bounded, with backoff).
    disableRetryOnRateLimit: true,
  });
  // TODO(merge): the gateway calls core-adapter.ts, to be replaced with @forge/core at merge.
  const gateway = createCorePaymentGateway({ connection, cluster: config.cluster });
  const prices = new JupiterPriceSource({ apiKey: config.jupiterApiKey });
  const service = createPaymentsService({ store, gateway, prices, logger: consoleLogger });
  handlers = createPaymentsHandlers({
    service,
    rateLimiter: new MemoryRateLimiter(),
    logger: consoleLogger,
  });
  return handlers;
}

function withHandlers(
  run: (h: PaymentsHandlers) => Promise<Response>,
  route: string,
): Promise<Response> {
  let h: PaymentsHandlers;
  try {
    h = getPaymentsHandlers();
  } catch (error) {
    return Promise.resolve(errorToResponse(error, consoleLogger, route));
  }
  return run(h);
}

/** POST /api/payments/quote */
export function handleQuote(request: Request): Promise<Response> {
  return withHandlers((h) => h.quote(request), 'quote');
}

/** POST /api/payments/confirm */
export function handleConfirm(request: Request): Promise<Response> {
  return withHandlers((h) => h.confirm(request), 'confirm');
}
