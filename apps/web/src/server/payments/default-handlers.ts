import { Connection } from '@solana/web3.js';
import { readPaymentsConfig } from './config';
import { createCorePaymentGateway } from './gateway';
import { createPaymentsHandlers, errorToResponse, type PaymentsHandlers } from './handlers';
import { consoleLogger } from './log';
import { StoreError } from './errors';
import { SupabasePriceReferenceStore } from './price-reference-store';
import { GuardedPriceSource, JupiterPriceSource } from './price-source';
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
  const db = createServiceSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const store = new SupabasePaymentsStore(db);
  const connection = new Connection(config.rpcUrl, {
    commitment: 'confirmed',
    // Retries are done by the adapter (bounded, with backoff).
    disableRetryOnRateLimit: true,
  });
  const gateway = createCorePaymentGateway({
    connection,
    cluster: config.cluster,
    cashbox: config.cashbox,
  });
  // Every quote's rate within the configured bounds and close to the last accepted one (kept in
  // the database too, so that a fresh instance starts from it).
  const prices = new GuardedPriceSource(
    new JupiterPriceSource({ apiKey: config.jupiterApiKey }),
    config.priceGuard,
    {
      onRefused: ({ reason, price, reference }) =>
        consoleLogger.log('warn', 'price.refused', { reason, price, reference }),
      referenceStore: new SupabasePriceReferenceStore(db),
      onStoreError: (operation, error) =>
        consoleLogger.log('warn', 'price.reference_store_unavailable', {
          operation,
          detail: error instanceof StoreError ? error.message : 'unexpected error',
        }),
    },
  );
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
