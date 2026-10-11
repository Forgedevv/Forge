// @vitest-environment node
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base58Encode } from './base58';
import { handleNonce, handleSession, handleSupabaseToken, handleVerify } from './handlers';
import { consumedNonces } from './replay';
import { createSessionToken, getSession, requireSession } from './session';

const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
const SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-0123456789-abcdef';
const APP = 'https://forge.app';

interface TestWallet {
  address: string;
  privateKey: KeyObject;
}

function newWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { address: base58Encode(Buffer.from(x, 'base64url')), privateKey };
}

function post(path: string, body: unknown) {
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string) {
  return new Request(`${APP}${path}`, { headers: cookie ? { cookie } : {} });
}

function sessionCookie(wallet: string): string {
  return `__Host-forge_session=${createSessionToken(Buffer.from(SESSION_SECRET), wallet)}`;
}

async function signIn(wallet: TestWallet): Promise<Response> {
  const nonceRes = await handleNonce(post('/api/auth/nonce', { wallet: wallet.address }));
  expect(nonceRes.status).toBe(200);
  const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };
  const signature = base58Encode(sign(null, Buffer.from(message, 'utf8'), wallet.privateKey));
  return handleVerify(post('/api/auth/verify', { wallet: wallet.address, signature, nonce }));
}

const invited = newWallet();
const stranger = newWallet();

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SESSION_SECRET);
  vi.stubEnv('SUPABASE_JWT_SECRET', SUPABASE_JWT_SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP);
  vi.stubEnv('FORGE_BETA_MODE', 'on');
  vi.stubEnv('FORGE_BETA_ALLOWLIST', invited.address);
  consumedNonces.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('private beta gate', () => {
  it('lets an invited wallet sign in and use authenticated routes', async () => {
    const res = await signIn(invited);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-forge_session='))).toBe(
      true,
    );
    const cookie = sessionCookie(invited.address);
    expect(handleSession(get('/api/auth/session', cookie)).status).toBe(200);
    expect(handleSupabaseToken(get('/api/auth/supabase-token', cookie)).status).toBe(200);
    expect(requireSession(get('/api/x', cookie))).toEqual({ wallet: invited.address });
  });

  it('refuses sign-in to a wallet that is not invited, with no session cookie', async () => {
    const res = await signIn(stranger);
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('BETA_NOT_INVITED');
    expect(body.message).toMatch(/private beta/);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__Host-forge_session='))).toBe(false);
    // The consumed sign-in nonce cookie is cleared.
    expect(cookies.some((c) => c.startsWith('__Host-forge_auth_nonce=;'))).toBe(true);
  });

  it('still rejects a bad signature as 401 before looking at the allowlist', async () => {
    const nonceRes = await handleNonce(post('/api/auth/nonce', { wallet: stranger.address }));
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const signature = base58Encode(new Uint8Array(64));
    const res = await handleVerify(
      post('/api/auth/verify', { wallet: stranger.address, signature, nonce }),
    );
    expect(res.status).toBe(401);
  });

  it('closes existing sessions of a wallet removed from the list on the next request', async () => {
    const cookie = sessionCookie(invited.address);
    expect(requireSession(get('/api/x', cookie))).toEqual({ wallet: invited.address });

    vi.stubEnv('FORGE_BETA_ALLOWLIST', stranger.address);
    const denied = requireSession(get('/api/x', cookie));
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
    expect(await (denied as Response).json()).toMatchObject({ code: 'BETA_NOT_INVITED' });
    expect(getSession(get('/api/x', cookie))).toBeNull();
    expect(handleSession(get('/api/auth/session', cookie)).status).toBe(403);
    expect(handleSupabaseToken(get('/api/auth/supabase-token', cookie)).status).toBe(403);

    // Invited again: the same cookie works again.
    vi.stubEnv('FORGE_BETA_ALLOWLIST', `${stranger.address},${invited.address}`);
    expect(requireSession(get('/api/x', cookie))).toEqual({ wallet: invited.address });
  });

  it('keeps 401 for requests without a session', () => {
    const res = requireSession(get('/api/x'));
    expect((res as Response).status).toBe(401);
    expect(handleSession(get('/api/auth/session')).status).toBe(401);
  });

  it('fails closed when the list is empty or invalid, without logging it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('FORGE_BETA_ALLOWLIST', '');
    const res = await signIn(invited);
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-forge_session='))).toBe(
      false,
    );
    const cookie = sessionCookie(invited.address);
    expect((requireSession(get('/api/x', cookie)) as Response).status).toBe(503);

    vi.stubEnv('FORGE_BETA_ALLOWLIST', `${invited.address},not-a-wallet`);
    expect((requireSession(get('/api/x', cookie)) as Response).status).toBe(503);
    expect(errors.mock.calls.flat().join(' ')).not.toContain(invited.address);
  });

  it('fails closed in production when no list is configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('FORGE_BETA_MODE', '');
    vi.stubEnv('FORGE_BETA_ALLOWLIST', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect((requireSession(get('/api/x', sessionCookie(invited.address))) as Response).status).toBe(
      503,
    );
  });

  it('lets every wallet in when the beta is off', async () => {
    vi.stubEnv('FORGE_BETA_MODE', 'off');
    const res = await signIn(stranger);
    expect(res.status).toBe(200);
    expect(requireSession(get('/api/x', sessionCookie(stranger.address)))).toEqual({
      wallet: stranger.address,
    });
  });
});
