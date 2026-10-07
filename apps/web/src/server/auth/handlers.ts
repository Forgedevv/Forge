import { AuthNonceRequest, AuthVerifyRequest } from '@forge/shared';
import { z } from 'zod';
import { getSessionSecret, resolveSignInDomain } from './config';
import { NONCE_COOKIE, readCookie, serializeCookie } from './cookies';
import {
  checkOrigin,
  errorResponse,
  jsonResponse,
  readJsonBody,
  serverErrorResponse,
} from './http';
import { issueChallenge, NONCE_TTL_SECONDS, verifySignIn } from './sign-in';
import { clearSession, requireSession, setSession, getSession } from './session';
import { mintSupabaseAccessToken } from './supabase-token';

/*
 * Handlers of the /api/auth/* route files (kept here so they are testable without Next).
 */

/**
 * Backwards-compatible extension of AuthVerifyRequest: `nonce` is the token returned by
 * /api/auth/nonce. When omitted, the token is read from the HttpOnly nonce cookie set by
 * /api/auth/nonce.
 */
export const AuthVerifyRequestWithNonce = z.strictObject({
  ...AuthVerifyRequest.shape,
  nonce: z.string().min(1).max(2048).optional(),
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** POST /api/auth/nonce `{ wallet }` -> `{ nonce, message, expiresAt }`. */
export async function handleNonce(request: Request): Promise<Response> {
  try {
    const forbidden = checkOrigin(request);
    if (forbidden) return forbidden;
    const parsed = AuthNonceRequest.safeParse(await readJsonBody(request));
    if (!parsed.success) return errorResponse(400, 'BAD_REQUEST', 'Invalid wallet address.');

    const issued = issueChallenge(
      getSessionSecret(),
      parsed.data.wallet,
      resolveSignInDomain(request),
      nowSeconds(),
    );
    const response = jsonResponse({
      nonce: issued.token,
      message: issued.message,
      expiresAt: issued.expiresAt,
    });
    response.headers.append(
      'Set-Cookie',
      serializeCookie(request, NONCE_COOKIE, issued.token, NONCE_TTL_SECONDS),
    );
    return response;
  } catch (error) {
    return serverErrorResponse(error);
  }
}

const VERIFY_FAILURE_MESSAGE = 'Sign-in failed. Request a new message and sign it again.';

/** POST /api/auth/verify `{ wallet, signature, nonce? }` -> `{ wallet }` + session cookie. */
export async function handleVerify(request: Request): Promise<Response> {
  try {
    const forbidden = checkOrigin(request);
    if (forbidden) return forbidden;
    const parsed = AuthVerifyRequestWithNonce.safeParse(await readJsonBody(request));
    if (!parsed.success) return errorResponse(400, 'BAD_REQUEST', 'Invalid sign-in request.');

    const token = parsed.data.nonce ?? readCookie(request, NONCE_COOKIE);
    if (token === null) return errorResponse(401, 'UNAUTHORIZED', VERIFY_FAILURE_MESSAGE);

    const result = await verifySignIn({
      secret: getSessionSecret(),
      token,
      wallet: parsed.data.wallet,
      signature: parsed.data.signature,
      expectedDomain: resolveSignInDomain(request),
      nowSeconds: nowSeconds(),
    });
    if (!result.ok) {
      if (result.reason === 'bad_encoding') {
        return errorResponse(400, 'BAD_REQUEST', 'Invalid signature encoding.');
      }
      if (result.reason === 'wrong_wallet') {
        return errorResponse(401, 'WRONG_WALLET', 'The signed message is for another wallet.');
      }
      return errorResponse(401, 'UNAUTHORIZED', VERIFY_FAILURE_MESSAGE);
    }

    const response = jsonResponse({ wallet: result.wallet });
    setSession(response, request, result.wallet);
    response.headers.append('Set-Cookie', serializeCookie(request, NONCE_COOKIE, '', 0));
    return response;
  } catch (error) {
    return serverErrorResponse(error);
  }
}

/** POST /api/auth/logout -> `{ ok: true }`, session cookie cleared. */
export function handleLogout(request: Request): Response {
  const forbidden = checkOrigin(request);
  if (forbidden) return forbidden;
  return clearSession(jsonResponse({ ok: true }), request);
}

/** GET /api/auth/session -> `{ wallet }` or 401. */
export function handleSession(request: Request): Response {
  try {
    const session = getSession(request);
    if (session === null) return errorResponse(401, 'UNAUTHORIZED', 'Not signed in.');
    return jsonResponse(session);
  } catch (error) {
    return serverErrorResponse(error);
  }
}

/** GET /api/auth/supabase-token -> `{ accessToken, expiresAt }` (session required). */
export function handleSupabaseToken(request: Request): Response {
  const session = requireSession(request);
  if (session instanceof Response) return session;
  try {
    return jsonResponse(mintSupabaseAccessToken(session.wallet));
  } catch (error) {
    return serverErrorResponse(error);
  }
}
