import { SolanaAddress, type Session } from '@forge/shared';
import { getSessionSecret } from './config';
import { readCookie, serializeCookie, SESSION_COOKIE } from './cookies';
import { errorResponse, serverErrorResponse } from './http';
import { deriveKey, signToken, verifyToken } from './signed-token';

/*
 * Session = HMAC-SHA256 signed cookie (key derived from SESSION_SECRET) holding the wallet and
 * an expiry. Stateless: logout clears the cookie, but a copied cookie stays valid until `exp`.
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

/** The session of the request, or null if absent, forged or expired. */
export function getSession(request: Request): Session | null {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return null;
  const session = parseSessionToken(getSessionSecret(), token);
  return session === null ? null : { wallet: session.wallet };
}

/**
 * The session of the request, or a 401 response to return as is:
 *
 *   const session = requireSession(request);
 *   if (session instanceof Response) return session;
 */
export function requireSession(request: Request): Session | Response {
  let session: Session | null;
  try {
    session = getSession(request);
  } catch (error) {
    return serverErrorResponse(error);
  }
  return session ?? errorResponse(401, 'UNAUTHORIZED', 'Sign in with your wallet first.');
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
