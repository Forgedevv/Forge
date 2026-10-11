import { createHmac } from 'node:crypto';
import { getSupabaseJwtSecret } from './config';

/*
 * Supabase access token for RLS and Realtime, signed HS256 with the project's legacy JWT secret
 * (SUPABASE_JWT_SECRET). Newer Supabase projects may use asymmetric signing keys instead
 * (ES256/RS256 with a private JWK): only this module would change.
 */

/**
 * Short on purpose: the token is not revocable, so its lifetime bounds how long a wallet removed
 * from the private beta (or a stolen token) keeps database and Realtime access. The browser
 * refreshes it through GET /api/auth/supabase-token about a minute before expiry, and that route
 * re-checks the session and the beta every time.
 */
export const SUPABASE_TOKEN_TTL_SECONDS = 10 * 60;

export interface SupabaseAccessTokenClaims {
  role: 'authenticated';
  aud: 'authenticated';
  sub: string;
  wallet: string;
  iat: number;
  exp: number;
}

export interface SupabaseAccessToken {
  accessToken: string;
  expiresAt: string;
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function mintSupabaseAccessToken(
  wallet: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SupabaseAccessToken {
  const secret = getSupabaseJwtSecret();
  const claims: SupabaseAccessTokenClaims = {
    role: 'authenticated',
    aud: 'authenticated',
    sub: wallet,
    wallet,
    iat: nowSeconds,
    exp: nowSeconds + SUPABASE_TOKEN_TTL_SECONDS,
  };
  const signingInput = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return {
    accessToken: `${signingInput}.${signature}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
