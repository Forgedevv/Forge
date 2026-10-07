import { isSecureRequest } from './config';

/*
 * Cookie names and serialization. On secure requests the `__Host-` prefix is used: the browser
 * then only accepts the cookie when it is Secure, has Path=/ and no Domain, so a sibling
 * subdomain cannot plant or overwrite it.
 */

export const SESSION_COOKIE = 'forge_session';
export const NONCE_COOKIE = 'forge_auth_nonce';

export function cookieName(base: string, request: Request): string {
  return isSecureRequest(request) ? `__Host-${base}` : base;
}

export function serializeCookie(
  request: Request,
  base: string,
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${cookieName(base, request)}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (maxAgeSeconds === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (isSecureRequest(request)) parts.push('Secure');
  return parts.join('; ');
}

/** Reads a cookie from the request (first occurrence). Values are not URI-decoded. */
export function readCookie(request: Request, base: string): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  const name = cookieName(base, request);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
