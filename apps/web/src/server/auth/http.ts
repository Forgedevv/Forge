import { AuthConfigError, isAllowedHost } from './config';

/*
 * HTTP helpers shared by the auth routes. Error bodies follow the ClientError shape
 * `{ code, message }`; `message` is safe to show to the end user.
 */

export type AuthErrorCode =
  'UNAUTHORIZED' | 'WRONG_WALLET' | 'BAD_REQUEST' | 'FORBIDDEN_ORIGIN' | 'SERVER_ERROR';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function errorResponse(status: number, code: AuthErrorCode, message: string): Response {
  return jsonResponse({ code, message }, status);
}

/** Maps unexpected errors to a generic 500. Only the error class and a fixed message are logged. */
export function serverErrorResponse(error: unknown): Response {
  if (error instanceof AuthConfigError) {
    // The message names the variable only (never its value).
    console.error(`[auth] configuration error: ${error.message}`);
  } else {
    console.error('[auth] unexpected error');
  }
  return errorResponse(500, 'SERVER_ERROR', 'Sign-in is temporarily unavailable.');
}

/**
 * Cross-site request guard for state-changing routes (login CSRF): rejects requests whose
 * Origin is not an allowed host, or that the browser flags as cross-site.
 */
export function checkOrigin(request: Request): Response | null {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return errorResponse(403, 'FORBIDDEN_ORIGIN', 'Cross-site request rejected.');
  }
  const origin = request.headers.get('origin');
  if (origin === null) return null;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return errorResponse(403, 'FORBIDDEN_ORIGIN', 'Cross-site request rejected.');
  }
  if (!isAllowedHost(host)) {
    return errorResponse(403, 'FORBIDDEN_ORIGIN', 'Cross-site request rejected.');
  }
  return null;
}

export const MAX_BODY_BYTES = 4096;

/** Reads a small JSON body. Returns undefined when the body is too large or not JSON. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
