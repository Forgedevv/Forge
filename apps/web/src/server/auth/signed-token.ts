import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Compact HMAC-SHA256 signed tokens: `base64url(JSON payload).base64url(mac)`.
 * Each token kind uses its own key derived from SESSION_SECRET, so a token of one kind can
 * never be accepted as another kind (nonce token vs session cookie).
 */

export type TokenPurpose = 'auth-nonce' | 'session';

export function deriveKey(secret: Buffer, purpose: TokenPurpose): Buffer {
  return createHmac('sha256', secret).update(`forge/auth/v1/${purpose}`).digest();
}

function mac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signToken(key: Buffer, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(key, body).toString('base64url')}`;
}

const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** Returns the parsed payload if the MAC is valid, otherwise null. Never throws. */
export function verifyToken(key: Buffer, token: string): unknown {
  if (token.length > 4096 || !TOKEN_RE.test(token)) return null;
  const [body, sig] = token.split('.') as [string, string];
  const expected = mac(key, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
