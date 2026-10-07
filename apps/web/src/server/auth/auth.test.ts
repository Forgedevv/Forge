// @vitest-environment node
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base58Decode, base58Encode } from './base58';
import { getSessionSecret, getSupabaseJwtSecret } from './config';
import {
  handleLogout,
  handleNonce,
  handleSession,
  handleSupabaseToken,
  handleVerify,
} from './handlers';
import { ConsumedNonceStore, consumedNonces } from './replay';
import { createSessionToken, getSession, requireSession, SESSION_TTL_SECONDS } from './session';
import { deriveKey, signToken } from './signed-token';
import { buildSignInMessage, issueChallenge, verifySignIn } from './sign-in';
import { mintSupabaseAccessToken } from './supabase-token';

const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
const SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-0123456789-abcdef';
const APP = 'https://forge.app';
const T0 = new Date('2026-10-07T12:00:00.000Z');

interface TestWallet {
  address: string;
  privateKey: KeyObject;
}

function newWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { address: base58Encode(Buffer.from(x, 'base64url')), privateKey };
}

function signMessage(wallet: TestWallet, message: string): string {
  return base58Encode(sign(null, Buffer.from(message, 'utf8'), wallet.privateKey));
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, base = APP) {
  return new Request(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(path: string, cookie?: string, base = APP) {
  return new Request(`${base}${path}`, { headers: cookie ? { cookie } : {} });
}

/** `name=value` pairs of the response's Set-Cookie headers, for a follow-up request. */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ');
}

async function requestNonce(wallet: string, base = APP) {
  const response = await handleNonce(post('/api/auth/nonce', { wallet }, {}, base));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { nonce: string; message: string; expiresAt: string };
  return { ...body, cookie: cookiesOf(response) };
}

async function signIn(wallet: TestWallet) {
  const { nonce, message } = await requestNonce(wallet.address);
  return handleVerify(
    post('/api/auth/verify', {
      wallet: wallet.address,
      signature: signMessage(wallet, message),
      nonce,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('SESSION_SECRET', SESSION_SECRET);
  vi.stubEnv('SUPABASE_JWT_SECRET', SUPABASE_JWT_SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP);
  consumedNonces.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('base58', () => {
  it('decodes the system program address to 32 zero bytes and round-trips', () => {
    expect(base58Decode('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
    const bytes = Uint8Array.from([0, 0, 1, 2, 255, 128, 7]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base58Decode('0OIl')).toBeNull();
  });
});

describe('sign-in', () => {
  it('signs in with a valid signature and opens a session', async () => {
    const wallet = newWallet();
    const { nonce, message, expiresAt, cookie } = await requestNonce(wallet.address);

    expect(message).toMatch(
      new RegExp(
        `^forge\\.app wants you to sign in with your Solana account: ${wallet.address}\\n\\n` +
          'Nonce: [0-9a-f]{32}\\nIssued At: 2026-10-07T12:00:00\\.000Z\\n' +
          'Expiration Time: 2026-10-07T12:05:00\\.000Z$',
      ),
    );
    expect(expiresAt).toBe('2026-10-07T12:05:00.000Z');
    expect(cookie).toContain('__Host-forge_auth_nonce=');
    expect(nonce.length).toBeGreaterThan(0);

    const response = await handleVerify(
      post('/api/auth/verify', {
        wallet: wallet.address,
        signature: signMessage(wallet, message),
        nonce,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wallet: wallet.address });
    expect(response.headers.get('cache-control')).toBe('no-store');

    const setCookies = response.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith('__Host-forge_session='))!;
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
    expect(session).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    // The nonce cookie is cleared.
    expect(setCookies.some((c) => c.startsWith('__Host-forge_auth_nonce=;'))).toBe(true);

    const sessionCookie = cookiesOf(response);
    expect(getSession(get('/api/x', sessionCookie))).toEqual({ wallet: wallet.address });
    const me = handleSession(get('/api/auth/session', sessionCookie));
    expect(await me.json()).toEqual({ wallet: wallet.address });
  });

  it('accepts the nonce from the HttpOnly cookie when the body omits it', async () => {
    const wallet = newWallet();
    const { message, cookie } = await requestNonce(wallet.address);
    const response = await handleVerify(
      post(
        '/api/auth/verify',
        { wallet: wallet.address, signature: signMessage(wallet, message) },
        { cookie },
      ),
    );
    expect(response.status).toBe(200);
  });

  it('uses non-secure, unprefixed cookies on localhost', async () => {
    const wallet = newWallet();
    const base = 'http://localhost:3000';
    const { nonce, message } = await requestNonce(wallet.address, base);
    expect(message.startsWith('localhost:3000 wants you')).toBe(true);
    const response = await handleVerify(
      post(
        '/api/auth/verify',
        { wallet: wallet.address, signature: signMessage(wallet, message), nonce },
        {},
        base,
      ),
    );
    expect(response.status).toBe(200);
    const session = response.headers.getSetCookie().find((c) => c.startsWith('forge_session='))!;
    expect(session).not.toContain('Secure');
    expect(session).toContain('HttpOnly');
  });

  it('rejects a signature from another wallet', async () => {
    const owner = newWallet();
    const attacker = newWallet();
    const { nonce, message } = await requestNonce(owner.address);

    // Attacker claims the owner's wallet but signs with their own key.
    const forged = await handleVerify(
      post('/api/auth/verify', {
        wallet: owner.address,
        signature: signMessage(attacker, message),
        nonce,
      }),
    );
    expect(forged.status).toBe(401);
    expect(forged.headers.getSetCookie().some((c) => c.includes('forge_session='))).toBe(false);

    // Attacker reuses the owner's challenge for their own wallet.
    const swapped = await handleVerify(
      post('/api/auth/verify', {
        wallet: attacker.address,
        signature: signMessage(attacker, message),
        nonce,
      }),
    );
    expect(swapped.status).toBe(401);
    expect(((await swapped.json()) as { code: string }).code).toBe('WRONG_WALLET');
  });

  it('rejects a tampered message or nonce token', async () => {
    const wallet = newWallet();
    const { nonce, message } = await requestNonce(wallet.address);

    // Signature over a modified message.
    const modified = message.replace(
      'Expiration Time: 2026-10-07T12:05',
      'Expiration Time: 2027-10-07T12:05',
    );
    const r1 = await handleVerify(
      post('/api/auth/verify', {
        wallet: wallet.address,
        signature: signMessage(wallet, modified),
        nonce,
      }),
    );
    expect(r1.status).toBe(401);

    // Token payload altered (later expiry) while keeping the original MAC.
    const [body, mac] = nonce.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      number
    >;
    payload.exp = payload.exp! + 3600;
    payload.iat = payload.iat! + 3600;
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
    const r2 = await handleVerify(
      post('/api/auth/verify', {
        wallet: wallet.address,
        signature: signMessage(wallet, message),
        nonce: tampered,
      }),
    );
    expect(r2.status).toBe(401);

    // Token signed with another secret.
    const foreign = issueChallenge(
      Buffer.from('another-secret-another-secret-another-secret'),
      wallet.address,
      'forge.app',
      Math.floor(T0.getTime() / 1000),
    );
    const r3 = await handleVerify(
      post('/api/auth/verify', {
        wallet: wallet.address,
        signature: signMessage(wallet, foreign.message),
        nonce: foreign.token,
      }),
    );
    expect(r3.status).toBe(401);
  });

  it('rejects an expired nonce', async () => {
    const wallet = newWallet();
    const { nonce, message } = await requestNonce(wallet.address);
    vi.setSystemTime(T0.getTime() + 5 * 60 * 1000);
    const response = await handleVerify(
      post('/api/auth/verify', {
        wallet: wallet.address,
        signature: signMessage(wallet, message),
        nonce,
      }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a reused nonce', async () => {
    const wallet = newWallet();
    const { nonce, message } = await requestNonce(wallet.address);
    const body = { wallet: wallet.address, signature: signMessage(wallet, message), nonce };
    expect((await handleVerify(post('/api/auth/verify', body))).status).toBe(200);
    expect((await handleVerify(post('/api/auth/verify', body))).status).toBe(401);
  });

  it('rejects a nonce issued for another domain', async () => {
    const wallet = newWallet();
    const { nonce, message } = await requestNonce(wallet.address);
    const response = await handleVerify(
      post(
        '/api/auth/verify',
        { wallet: wallet.address, signature: signMessage(wallet, message), nonce },
        {},
        'http://localhost:3000',
      ),
    );
    expect(response.status).toBe(401);
  });

  it('rejects bad signature encodings and malformed bodies', async () => {
    const wallet = newWallet();
    const { nonce } = await requestNonce(wallet.address);

    const notBase58 = await handleVerify(
      post('/api/auth/verify', { wallet: wallet.address, signature: '0'.repeat(88), nonce }),
    );
    expect(notBase58.status).toBe(400);

    // Valid base58 alphabet and length range, but not 64 bytes once decoded.
    const wrongLength = await handleVerify(
      post('/api/auth/verify', { wallet: wallet.address, signature: 'z'.repeat(88), nonce }),
    );
    expect(wrongLength.status).toBe(400);

    const unknownKey = await handleVerify(
      post('/api/auth/verify', { wallet: wallet.address, signature: 'z'.repeat(88), nonce, x: 1 }),
    );
    expect(unknownKey.status).toBe(400);

    expect((await handleVerify(post('/api/auth/verify', '{not json'))).status).toBe(400);
    expect((await handleNonce(post('/api/auth/nonce', { wallet: 'nope' }))).status).toBe(400);
    expect((await handleNonce(post('/api/auth/nonce', { wallet: 'x'.repeat(5000) }))).status).toBe(
      400,
    );
  });

  it('rejects a missing nonce', async () => {
    const wallet = newWallet();
    const response = await handleVerify(
      post('/api/auth/verify', { wallet: wallet.address, signature: '1'.repeat(64) }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects cross-site requests', async () => {
    const wallet = newWallet();
    const evil = await handleNonce(
      post('/api/auth/nonce', { wallet: wallet.address }, { origin: 'https://evil.example' }),
    );
    expect(evil.status).toBe(403);
    const crossSite = await handleVerify(
      post('/api/auth/verify', {}, { 'sec-fetch-site': 'cross-site' }),
    );
    expect(crossSite.status).toBe(403);
    expect((await handleLogout(post('/api/auth/logout', {}, { origin: 'null' }))).status).toBe(403);
  });
});

describe('nonce store', () => {
  it('forgets nonces after expiry and evicts the oldest when full', () => {
    const store = new ConsumedNonceStore(2);
    expect(store.consume('a', 100, 0)).toBe(true);
    expect(store.consume('a', 100, 0)).toBe(false);
    expect(store.has('a', 100)).toBe(false);
    store.consume('b', 200, 0);
    store.consume('c', 200, 0);
    store.consume('d', 200, 0);
    expect(store.size).toBe(2);
  });

  it('only consumes a nonce once the signature is valid', () => {
    const wallet = newWallet();
    const store = new ConsumedNonceStore();
    const now = 1_000_000;
    const issued = issueChallenge(Buffer.from(SESSION_SECRET), wallet.address, 'forge.app', now);
    const base = {
      secret: Buffer.from(SESSION_SECRET),
      token: issued.token,
      wallet: wallet.address,
      expectedDomain: 'forge.app',
      nowSeconds: now,
      store,
    };
    const bad = verifySignIn({ ...base, signature: signMessage(newWallet(), issued.message) });
    expect(bad).toEqual({ ok: false, reason: 'bad_signature' });
    expect(store.size).toBe(0);
    const good = verifySignIn({ ...base, signature: signMessage(wallet, issued.message) });
    expect(good).toEqual({ ok: true, wallet: wallet.address });
    expect(buildSignInMessage(issued.challenge)).toBe(issued.message);
  });
});

describe('session', () => {
  it('rejects forged session cookies', async () => {
    const wallet = newWallet();
    const now = Math.floor(T0.getTime() / 1000);
    const asCookie = (token: string) => `__Host-forge_session=${token}`;

    // Signed with another secret.
    const otherSecret = createSessionToken(Buffer.from('x'.repeat(40)), wallet.address, now);
    expect(getSession(get('/', asCookie(otherSecret)))).toBeNull();

    // Payload changed, MAC kept.
    const valid = createSessionToken(Buffer.from(SESSION_SECRET), wallet.address, now);
    const [, mac] = valid.split('.') as [string, string];
    const other = newWallet().address;
    const body = Buffer.from(
      JSON.stringify({ v: 1, wallet: other, iat: now, exp: now + SESSION_TTL_SECONDS }),
    ).toString('base64url');
    expect(getSession(get('/', asCookie(`${body}.${mac}`)))).toBeNull();

    // A sign-in nonce token is not a session (separate derived keys).
    const { nonce } = await requestNonce(wallet.address);
    expect(getSession(get('/', asCookie(nonce)))).toBeNull();

    // Unprefixed cookie on a secure request is ignored (could be planted by a subdomain).
    expect(getSession(get('/', `forge_session=${valid}`))).toBeNull();

    // Garbage and well-formed but too long lifetime.
    expect(getSession(get('/', asCookie('abc')))).toBeNull();
    const longLived = signToken(deriveKey(Buffer.from(SESSION_SECRET), 'session'), {
      v: 1,
      wallet: wallet.address,
      iat: now,
      exp: now + 10 * SESSION_TTL_SECONDS,
    });
    expect(getSession(get('/', asCookie(longLived)))).toBeNull();

    const denied = requireSession(get('/', asCookie(otherSecret)));
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(401);
    expect(getSession(get('/', asCookie(valid)))).toEqual({ wallet: wallet.address });
  });

  it('expires after 24 hours', async () => {
    const wallet = newWallet();
    const cookie = cookiesOf(await signIn(wallet));
    vi.setSystemTime(T0.getTime() + (SESSION_TTL_SECONDS - 1) * 1000);
    expect(getSession(get('/', cookie))).toEqual({ wallet: wallet.address });
    vi.setSystemTime(T0.getTime() + SESSION_TTL_SECONDS * 1000);
    expect(getSession(get('/', cookie))).toBeNull();
    expect(handleSession(get('/api/auth/session', cookie)).status).toBe(401);
  });

  it('logout clears the session cookie', async () => {
    const cookie = cookiesOf(await signIn(newWallet()));
    const response = handleLogout(post('/api/auth/logout', {}, { cookie }));
    expect(response.status).toBe(200);
    const cleared = response.headers.getSetCookie()[0]!;
    expect(cleared).toMatch(/^__Host-forge_session=; Path=\/; Max-Age=0;/);
  });
});

describe('supabase token', () => {
  it('mints an HS256 JWT with the expected claims', () => {
    const wallet = newWallet().address;
    const now = 1_800_000_000;
    const { accessToken, expiresAt } = mintSupabaseAccessToken(wallet, now);
    const [header, claims, signature] = accessToken.split('.') as [string, string, string];
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decode(claims)).toEqual({
      role: 'authenticated',
      aud: 'authenticated',
      sub: wallet,
      wallet,
      iat: now,
      exp: now + 3600,
    });
    const expected = createHmac('sha256', SUPABASE_JWT_SECRET)
      .update(`${header}.${claims}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    expect(expiresAt).toBe(new Date((now + 3600) * 1000).toISOString());
  });

  it('is only served to a signed-in wallet', async () => {
    expect(handleSupabaseToken(get('/api/auth/supabase-token')).status).toBe(401);
    const wallet = newWallet();
    const cookie = cookiesOf(await signIn(wallet));
    const response = handleSupabaseToken(get('/api/auth/supabase-token', cookie));
    expect(response.status).toBe(200);
    const { accessToken } = (await response.json()) as { accessToken: string };
    const claims = JSON.parse(
      Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8'),
    ) as {
      sub: string;
    };
    expect(claims.sub).toBe(wallet.address);
  });
});

describe('secrets', () => {
  it('refuses secrets shorter than 32 bytes', async () => {
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(31));
    vi.stubEnv('SUPABASE_JWT_SECRET', 'b'.repeat(31));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => getSessionSecret()).toThrow('SESSION_SECRET must be at least 32 bytes');
    expect(() => getSupabaseJwtSecret()).toThrow('SUPABASE_JWT_SECRET must be at least 32 bytes');
    const response = await handleNonce(post('/api/auth/nonce', { wallet: newWallet().address }));
    expect(response.status).toBe(500);
    vi.stubEnv('SESSION_SECRET', '');
    expect(() => getSessionSecret()).toThrow('SESSION_SECRET is not set');
  });

  it('never logs or returns secret values', async () => {
    const output: string[] = [];
    const capture = (...args: unknown[]) => {
      output.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
      );
    };
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    const bodies: string[] = [];
    const record = async (response: Response) => {
      bodies.push(await response.clone().text());
      return response;
    };

    const wallet = newWallet();
    const cookie = cookiesOf(await record(await signIn(wallet)));
    await record(handleSupabaseToken(get('/api/auth/supabase-token', cookie)));
    await record(await handleVerify(post('/api/auth/verify', '{bad')));

    // Misconfigured secrets: the error is logged, without the value.
    const shortSession = 'short-session-secret-value';
    const shortJwt = 'short-jwt-secret-value';
    vi.stubEnv('SESSION_SECRET', shortSession);
    await record(await handleNonce(post('/api/auth/nonce', { wallet: wallet.address })));
    vi.stubEnv('SESSION_SECRET', SESSION_SECRET);
    vi.stubEnv('SUPABASE_JWT_SECRET', shortJwt);
    await record(handleSupabaseToken(get('/api/auth/supabase-token', cookie)));

    expect(output.length).toBeGreaterThan(0);
    for (const text of [...output, ...bodies]) {
      for (const secret of [SESSION_SECRET, SUPABASE_JWT_SECRET, shortSession, shortJwt]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
