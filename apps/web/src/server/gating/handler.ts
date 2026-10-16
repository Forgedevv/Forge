import type { GatingResponse } from '@forge/shared';
import { requireSession } from '@/server/auth';
import { GatingError, getDefaultGatingCheck, type GatingStatusCheck } from '../chat/gating';
import { apiError } from '../chat/http';
import { clientIp, getDefaultRateLimiter, type RateLimiter } from '../chat/rate-limit';

/*
 * GET /api/gating -> GatingResponse `{ ok, required, balance, enabled }` (docs/INTERFACES.md §6):
 * the $FORGE gate of the signed-in wallet (FORGE_GATING_AMOUNT of FORGE_MINT, raw units as
 * decimal strings). Without FORGE_MINT the gate is disabled: `{ ok: true, enabled: false,
 * required: '0', balance: '0' }`. The balance read is cached briefly by the gating check, and
 * the route is rate limited per IP (before anything else) and per wallet. Fails closed: an RPC
 * or configuration failure is a 503, never `ok: true`.
 */

export const GATING_ROUTE_LIMITS = {
  ip: { limit: 60, windowMs: 60_000 },
  wallet: { limit: 30, windowMs: 60_000 },
} as const;

export interface GatingRouteDeps {
  gating: () => GatingStatusCheck;
  limiter: () => RateLimiter;
  log?: (message: string) => void;
}

export function defaultGatingRouteDeps(): GatingRouteDeps {
  return { gating: getDefaultGatingCheck, limiter: getDefaultRateLimiter };
}

function limited(retryAfterSeconds: number): Response {
  return apiError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', {
    'Retry-After': String(retryAfterSeconds),
  });
}

export async function handleGating(
  request: Request,
  deps: GatingRouteDeps = defaultGatingRouteDeps(),
): Promise<Response> {
  const log = deps.log ?? ((message: string) => console.error(message));
  const limiter = deps.limiter();
  const { ip, wallet: perWallet } = GATING_ROUTE_LIMITS;

  const byIp = await limiter.consume(`gating:ip:${clientIp(request)}`, ip.limit, ip.windowMs);
  if (!byIp.allowed) return limited(byIp.retryAfterSeconds);

  const session = requireSession(request);
  if (session instanceof Response) return session;

  const byWallet = await limiter.consume(
    `gating:wallet:${session.wallet}`,
    perWallet.limit,
    perWallet.windowMs,
  );
  if (!byWallet.allowed) return limited(byWallet.retryAfterSeconds);

  try {
    const status = await deps.gating()(session.wallet);
    const body: GatingResponse = {
      ok: status.ok,
      required: status.required.toString(),
      balance: status.balance.toString(),
      enabled: status.enabled,
      ...(status.decimals !== undefined ? { decimals: status.decimals } : {}),
    };
    return Response.json(body, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // GatingError messages name variables or error codes, never values or RPC texts.
    log(
      error instanceof GatingError
        ? `[gating] ${error.name}: ${error.message}`
        : '[gating] unexpected error',
    );
    return apiError(503, 'SERVER_ERROR', 'The $FORGE balance check is temporarily unavailable.');
  }
}
