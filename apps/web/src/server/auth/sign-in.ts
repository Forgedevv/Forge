import { randomBytes } from 'node:crypto';
import { SolanaAddress } from '@forge/shared';
import { base58DecodeExact } from './base58';
import { verifyEd25519 } from './ed25519';
import { ConsumedNonceStore, consumedNonces } from './replay';
import { deriveKey, signToken, verifyToken } from './signed-token';

/*
 * Stateless sign-in challenge. `POST /api/auth/nonce` returns a nonce token: the challenge
 * fields (domain, wallet, random nonce, issued-at, expiry) HMAC-signed with a key derived from
 * SESSION_SECRET. The message the wallet signs is rebuilt from the verified token, so the server
 * never parses client-supplied message text.
 */

export const NONCE_TTL_SECONDS = 5 * 60;
/** Tolerated clock skew between server instances for `iat`. */
const CLOCK_SKEW_SECONDS = 60;

export interface SignInChallenge {
  v: 1;
  domain: string;
  wallet: string;
  nonce: string;
  iat: number;
  exp: number;
}

export function buildSignInMessage(challenge: SignInChallenge): string {
  return (
    `${challenge.domain} wants you to sign in with your Solana account: ${challenge.wallet}\n` +
    `\n` +
    `Nonce: ${challenge.nonce}\n` +
    `Issued At: ${new Date(challenge.iat * 1000).toISOString()}\n` +
    `Expiration Time: ${new Date(challenge.exp * 1000).toISOString()}`
  );
}

export interface IssuedChallenge {
  /** Opaque signed token, sent back to `/api/auth/verify`. */
  token: string;
  /** Exact text the wallet must sign (UTF-8 bytes). */
  message: string;
  expiresAt: string;
  challenge: SignInChallenge;
}

export function issueChallenge(
  secret: Buffer,
  wallet: string,
  domain: string,
  nowSeconds: number,
): IssuedChallenge {
  const challenge: SignInChallenge = {
    v: 1,
    domain,
    wallet,
    nonce: randomBytes(16).toString('hex'),
    iat: nowSeconds,
    exp: nowSeconds + NONCE_TTL_SECONDS,
  };
  return {
    token: signToken(deriveKey(secret, 'auth-nonce'), challenge),
    message: buildSignInMessage(challenge),
    expiresAt: new Date(challenge.exp * 1000).toISOString(),
    challenge,
  };
}

function isChallenge(value: unknown): value is SignInChallenge {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.domain === 'string' &&
    typeof c.wallet === 'string' &&
    typeof c.nonce === 'string' &&
    /^[0-9a-f]{32}$/.test(c.nonce) &&
    Number.isSafeInteger(c.iat) &&
    Number.isSafeInteger(c.exp)
  );
}

export type SignInFailure =
  | 'invalid_token'
  | 'expired'
  | 'wrong_domain'
  | 'wrong_wallet'
  | 'reused_nonce'
  | 'bad_encoding'
  | 'bad_signature';

export type SignInResult = { ok: true; wallet: string } | { ok: false; reason: SignInFailure };

export interface VerifySignInInput {
  secret: Buffer;
  token: string;
  wallet: string;
  /** base58-encoded 64-byte ed25519 signature of the message. */
  signature: string;
  /** Domain expected for this request (see resolveSignInDomain). */
  expectedDomain: string;
  nowSeconds: number;
  store?: ConsumedNonceStore;
}

/**
 * Checks, in order: token MAC, expiry, domain, wallet binding, nonce reuse, encodings, ed25519
 * signature. The nonce is consumed only after the signature is valid.
 */
export function verifySignIn(input: VerifySignInInput): SignInResult {
  const store = input.store ?? consumedNonces;
  const challenge = verifyToken(deriveKey(input.secret, 'auth-nonce'), input.token);
  if (!isChallenge(challenge)) return { ok: false, reason: 'invalid_token' };
  if (challenge.exp - challenge.iat !== NONCE_TTL_SECONDS)
    return { ok: false, reason: 'invalid_token' };
  if (input.nowSeconds >= challenge.exp) return { ok: false, reason: 'expired' };
  if (challenge.iat > input.nowSeconds + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'invalid_token' };
  }
  if (challenge.domain !== input.expectedDomain) return { ok: false, reason: 'wrong_domain' };
  if (challenge.wallet !== input.wallet) return { ok: false, reason: 'wrong_wallet' };
  if (store.has(challenge.nonce, input.nowSeconds)) return { ok: false, reason: 'reused_nonce' };

  if (!SolanaAddress.safeParse(input.wallet).success) return { ok: false, reason: 'bad_encoding' };
  const publicKey = base58DecodeExact(input.wallet, 32);
  const signature = base58DecodeExact(input.signature, 64);
  if (publicKey === null || signature === null) return { ok: false, reason: 'bad_encoding' };

  const message = Buffer.from(buildSignInMessage(challenge), 'utf8');
  if (!verifyEd25519(message, signature, publicKey)) return { ok: false, reason: 'bad_signature' };

  if (!store.consume(challenge.nonce, challenge.exp, input.nowSeconds)) {
    return { ok: false, reason: 'reused_nonce' };
  }
  return { ok: true, wallet: challenge.wallet };
}
