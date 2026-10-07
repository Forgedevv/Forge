/*
 * Auth configuration read from the environment. Error messages name the variable but never
 * include its value.
 */

export const MIN_SECRET_BYTES = 32;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

function readSecret(name: 'SESSION_SECRET' | 'SUPABASE_JWT_SECRET'): Buffer {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new AuthConfigError(`${name} is not set`);
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new AuthConfigError(`${name} must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return bytes;
}

/** Secret used for nonce tokens and session cookies (via derived subkeys). */
export function getSessionSecret(): Buffer {
  return readSecret('SESSION_SECRET');
}

/** Secret used to sign Supabase access tokens (HS256). */
export function getSupabaseJwtSecret(): Buffer {
  return readSecret('SUPABASE_JWT_SECRET');
}

/** Parsed NEXT_PUBLIC_APP_URL (required, http or https). */
export function getAppUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (raw === undefined || raw === '') throw new AuthConfigError('NEXT_PUBLIC_APP_URL is not set');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthConfigError('NEXT_PUBLIC_APP_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AuthConfigError('NEXT_PUBLIC_APP_URL must be an http(s) URL');
  }
  return url;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Whether `host` (hostname[:port]) may appear as the sign-in domain and as a request Origin:
 * the host of NEXT_PUBLIC_APP_URL, plus local hosts outside production.
 */
export function isAllowedHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === getAppUrl().host.toLowerCase()) return true;
  if (process.env.NODE_ENV !== 'production') {
    try {
      return isLocalHostname(new URL(`http://${normalized}`).hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Domain shown in the sign-in message: the request host when it is allowed, otherwise the
 * host of NEXT_PUBLIC_APP_URL. Never an arbitrary client-supplied value.
 */
export function resolveSignInDomain(request: Request): string {
  const host = new URL(request.url).host.toLowerCase();
  return isAllowedHost(host) ? host : getAppUrl().host.toLowerCase();
}

/** Cookies are Secure everywhere except on local http hosts. */
export function isSecureRequest(request: Request): boolean {
  const url = new URL(request.url);
  return !(url.protocol === 'http:' && isLocalHostname(url.hostname));
}
