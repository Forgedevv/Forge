import {
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  PaymentsQuoteRequest,
  PaymentsQuoteResponse,
  type Session,
} from '@forge/shared';
import { checkOrigin as defaultCheckOrigin, readJsonBody } from '../auth/http';
import { requireSession as defaultRequireSession } from '../auth/session';
import {
  ClusterMismatchError,
  PaymentConfigError,
  PaymentError,
  PriceUnavailableError,
  RpcUnavailableError,
  StoreError,
  type PaymentErrorCode,
} from './errors';
import { errorName, type PaymentsLogger } from './log';
import { clientIp, PAYMENT_RATE_LIMITS, type RateLimiter, type RateLimitRule } from './rate-limit';
import type { PaymentsService } from './service';

/*
 * HTTP layer of POST /api/payments/quote and POST /api/payments/confirm: origin check (CSRF),
 * session, rate limits, strict zod bodies, then the service. Kept free of Next imports so it is
 * testable with plain Request objects.
 */

export interface PaymentsHandlers {
  quote(request: Request): Promise<Response>;
  confirm(request: Request): Promise<Response>;
}

export interface PaymentsHandlerDeps {
  service: PaymentsService;
  rateLimiter: RateLimiter;
  logger: PaymentsLogger;
  requireSession?: (request: Request) => Session | Response;
  checkOrigin?: (request: Request) => Response | null;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorJson(
  status: number,
  code: PaymentErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json({ code, message, ...extra }, status, headers);
}

/** Maps any error to a response. Only error names, codes and fixed texts are logged. */
export function errorToResponse(error: unknown, logger: PaymentsLogger, route: string): Response {
  if (error instanceof PaymentError) {
    const extra = error.paymentStatus ? { status: error.paymentStatus } : {};
    return errorJson(error.httpStatus, error.code, error.message, extra);
  }
  if (error instanceof PriceUnavailableError) {
    logger.log('warn', 'price.unavailable', { route });
    return errorJson(
      503,
      'PRICE_UNAVAILABLE',
      'Pricing is temporarily unavailable. Please try again in a moment.',
    );
  }
  if (error instanceof RpcUnavailableError) {
    logger.log('warn', 'rpc.unavailable', { route });
    return errorJson(
      503,
      'RPC_UNAVAILABLE',
      'The Solana network could not be reached. Please try again in a moment.',
    );
  }
  if (error instanceof ClusterMismatchError) {
    logger.log('error', 'rpc.wrong_cluster', { route });
    return errorJson(503, 'WRONG_CLUSTER', 'Payments are temporarily unavailable.');
  }
  if (error instanceof PaymentConfigError) {
    // Config messages name variables only.
    logger.log('error', 'config.invalid', { route, detail: error.message });
  } else if (error instanceof StoreError) {
    logger.log('error', 'store.failed', { route, dbCode: error.dbCode ?? null });
  } else {
    logger.log('error', 'unexpected', { route, error: errorName(error) });
  }
  return errorJson(500, 'SERVER_ERROR', 'Payments are temporarily unavailable.');
}

export function createPaymentsHandlers(deps: PaymentsHandlerDeps): PaymentsHandlers {
  const requireSession = deps.requireSession ?? defaultRequireSession;
  const checkOrigin = deps.checkOrigin ?? defaultCheckOrigin;
  const { service, rateLimiter, logger } = deps;

  function limited(key: string, rule: RateLimitRule): Response | null {
    const result = rateLimiter.hit(key, rule);
    if (result.ok) return null;
    return errorJson(
      429,
      'RATE_LIMITED',
      'Too many requests. Please wait a moment and try again.',
      {},
      { 'Retry-After': String(result.retryAfterSeconds) },
    );
  }

  /** Origin, IP limit, session, wallet limit. Returns the session wallet or a response. */
  function guard(request: Request, route: 'quote' | 'confirm'): { wallet: string } | Response {
    const forbidden = checkOrigin(request);
    if (forbidden) return forbidden;
    const ipRule = route === 'quote' ? PAYMENT_RATE_LIMITS.quoteIp : PAYMENT_RATE_LIMITS.confirmIp;
    const ipLimited = limited(`payments:${route}:ip:${clientIp(request)}`, ipRule);
    if (ipLimited) return ipLimited;
    const session = requireSession(request);
    if (session instanceof Response) return session;
    const walletRule =
      route === 'quote' ? PAYMENT_RATE_LIMITS.quoteWallet : PAYMENT_RATE_LIMITS.confirmWallet;
    const walletLimited = limited(`payments:${route}:wallet:${session.wallet}`, walletRule);
    if (walletLimited) return walletLimited;
    return { wallet: session.wallet };
  }

  return {
    async quote(request) {
      try {
        const guarded = guard(request, 'quote');
        if (guarded instanceof Response) return guarded;
        const parsed = PaymentsQuoteRequest.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          return errorJson(400, 'BAD_REQUEST', 'Invalid quote request.');
        }
        const quote = await service.createQuote({ wallet: guarded.wallet, ...parsed.data });
        return json(PaymentsQuoteResponse.parse(quote));
      } catch (error) {
        return errorToResponse(error, logger, 'quote');
      }
    },

    async confirm(request) {
      try {
        const guarded = guard(request, 'confirm');
        if (guarded instanceof Response) return guarded;
        const parsed = PaymentsConfirmRequest.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          return errorJson(400, 'BAD_REQUEST', 'Invalid payment confirmation request.');
        }
        const result = await service.confirmPayment({ wallet: guarded.wallet, ...parsed.data });
        const body = PaymentsConfirmResponse.parse({ status: result.status });
        return result.httpStatus === 202
          ? json(body, 202, { 'Retry-After': '2' })
          : json(body, 200);
      } catch (error) {
        return errorToResponse(error, logger, 'confirm');
      }
    },
  };
}
