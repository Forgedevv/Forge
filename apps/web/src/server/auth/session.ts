import { SolanaAddress, type Session } from '@forge/shared';
import { BETA_NOT_INVITED_MESSAGE, BETA_UNAVAILABLE_MESSAGE, checkBetaAccess } from '../beta';
import { getSessionSecret } from './config';
import { readCookie, serializeCookie, SESSION_COOKIE } from './cookies';
import { errorResponse, serverErrorResponse } from './http';
import { deriveKey, signToken, verifyToken } from './signed-token';

/*
 * Session = HMAC-SHA256 signed cookie (key derived from SESSION_SECRET) holding the wallet and
 * an expiry. Stateless: logout clears the cookie, but a copied cookie stays valid until `exp`.
 * While the private beta is on, every read of the session re-checks the wallet against the
 * allowlist (src/server/beta), so a removed wallet loses access on its next request.
 */

export const SESSION_TTL_SECONDS = 24 * 60 * 60;

interface SessionPayload {
  v: 1;
  wallet: string;
  iat: number;
  exp: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createSessionToken(secret: Buffer, wallet: string, now = nowSeconds()): string {
  const payload: SessionPayload = { v: 1, wallet, iat: now, exp: now + SESSION_TTL_SECONDS };
  return signToken(deriveKey(secret, 'session'), payload);
}

export function parseSessionToken(
  secret: Buffer,
  token: string,
  now = nowSeconds(),
): (Session & { exp: number }) | null {
  const payload = verifyToken(deriveKey(secret, 'session'), token);
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.v !== 1 || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return null;
  const iat = p.iat as number;
  const exp = p.exp as number;
  if (exp - iat !== SESSION_TTL_SECONDS || now >= exp) return null;
  const wallet = SolanaAddress.safeParse(p.wallet);
  if (!wallet.success) return null;
  return { wallet: wallet.data, exp };
}

/** The wallet in the session cookie, or null if absent, forged or expired (no beta check). */
function readSessionCookie(request: Request): Session | null {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return null;
  const session = parseSessionToken(getSessionSecret(), token);
  return session === null ? null : { wallet: session.wallet };
}

/**
 * The response refusing `wallet` under the private beta (403 BETA_NOT_INVITED, or 503 when the
 * beta configuration is unusable), or null when the wallet is allowed. Checked on every request,
 * so removing a wallet from FORGE_BETA_ALLOWLIST also ends its open sessions.
 */
export function betaRefusal(wallet: string): Response | null {
  const access = checkBetaAccess(wallet);
  if (access === 'allowed') return null;
  if (access === 'not_invited') {
    return errorResponse(403, 'BETA_NOT_INVITED', BETA_NOT_INVITED_MESSAGE);
  }
  return errorResponse(503, 'SERVER_ERROR', BETA_UNAVAILABLE_MESSAGE);
}

/**
 * The session of the request, or null if absent, forged, expired or for a wallet the private
 * beta does not let in.
 */
export function getSession(request: Request): Session | null {
  const session = readSessionCookie(request);
  if (session === null) return null;
  return checkBetaAccess(session.wallet) === 'allowed' ? session : null;
}

/**
 * The session of the request, or the response to return as is (401 when signed out, 403
 * BETA_NOT_INVITED / 503 when the private beta refuses the wallet):
 *
 *   const session = requireSession(request);
 *   if (session instanceof Response) return session;
 */
export function requireSession(
  request: Request,
  signedOutMessage = 'Sign in with your wallet first.',
): Session | Response {
  let session: Session | null;
  try {
    session = readSessionCookie(request);
  } catch (error) {
    return serverErrorResponse(error);
  }
  if (session === null) return errorResponse(401, 'UNAUTHORIZED', signedOutMessage);
  return betaRefusal(session.wallet) ?? session;
}

/** Adds the Set-Cookie header opening a session for `wallet` on `response`. */
export function setSession(response: Response, request: Request, wallet: string): Response {
  const token = createSessionToken(getSessionSecret(), wallet);
  response.headers.append(
    'Set-Cookie',
    serializeCookie(request, SESSION_COOKIE, token, SESSION_TTL_SECONDS),
  );
  return response;
}

/** Adds the Set-Cookie header deleting the session cookie on `response`. */
export function clearSession(response: Response, request: Request): Response {
  response.headers.append('Set-Cookie', serializeCookie(request, SESSION_COOKIE, '', 0));
  return response;
}
