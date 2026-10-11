import { SupabaseTokenResponse, WEB_API_ROUTES } from '@forge/shared';
import { Keypair } from '@solana/web3.js';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const walletState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => walletState.value }));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: () => ({ setVisible: vi.fn() }),
}));
vi.mock('../supabase', () => ({
  subscribeSupabase: () => () => undefined,
  getSupabaseSnapshot: () => null,
  getServerSupabaseSnapshot: () => null,
}));

import { useBetaAccess, useSession } from '../hooks';
import { request } from '../http';
import {
  clearBetaNotInvited,
  getBetaSnapshot,
  getSessionSnapshot,
  setSession,
} from '../session-store';

const keypair = Keypair.generate();
const address = keypair.publicKey.toBase58();
const BETA = {
  code: 'BETA_NOT_INVITED',
  message: 'FORGE is in private beta and this wallet is not on the invite list yet.',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  clearBetaNotInvited();
  setSession(null);
  walletState.value = {
    connected: true,
    connecting: false,
    publicKey: keypair.publicKey,
    wallet: { adapter: {} },
    connect: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signMessage: vi.fn().mockResolvedValue(new Uint8Array(64).fill(3)),
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('BETA_NOT_INVITED', () => {
  it('from the Supabase token route clears the local session and raises the beta notice', async () => {
    setSession({ wallet: address });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(BETA, 403)));
    await expect(
      request(WEB_API_ROUTES.authSupabaseToken.path, SupabaseTokenResponse),
    ).rejects.toMatchObject({ code: 'BETA_NOT_INVITED' });
    expect(getSessionSnapshot()).toBeNull();
    expect(getBetaSnapshot()).toBe(true);
  });

  it('from the session restore shows the beta notice instead of a session', async () => {
    setSession({ wallet: address });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(BETA, 403)));
    const { result } = renderHook(() => ({ session: useSession(), beta: useBetaAccess() }));
    await waitFor(() => expect(result.current.beta.notInvited).toBe(true));
    expect(result.current.session.session).toBeNull();
    act(() => result.current.beta.dismiss());
    expect(result.current.beta.notInvited).toBe(false);
  });

  it('on sign-in rejects with BETA_NOT_INVITED and raises the notice; a new attempt clears it', async () => {
    const fetchFn = vi.fn((url: string) => {
      if (url === WEB_API_ROUTES.authNonce.path) {
        return Promise.resolve(
          json({ nonce: 'n', message: 'sign me', expiresAt: '2030-01-01T00:00:00.000Z' }),
        );
      }
      if (url === WEB_API_ROUTES.authVerify.path) return Promise.resolve(json(BETA, 403));
      return Promise.resolve(json({ code: 'UNAUTHORIZED', message: 'Not signed in.' }, 401));
    });
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => ({ session: useSession(), beta: useBetaAccess() }));
    let caught: unknown;
    await act(async () => {
      await result.current.session.connect().catch((e: unknown) => {
        caught = e;
      });
    });
    expect(caught).toMatchObject({ code: 'BETA_NOT_INVITED' });
    expect(result.current.beta.notInvited).toBe(true);
    expect(result.current.session.session).toBeNull();
    expect(getSessionSnapshot()).toBeNull();

    // Another wallet signs in: the notice is cleared as the attempt starts.
    fetchFn.mockImplementation((url: string) =>
      Promise.resolve(
        url === WEB_API_ROUTES.authNonce.path
          ? json({ nonce: 'n', message: 'sign me', expiresAt: '2030-01-01T00:00:00.000Z' })
          : json({ wallet: address }),
      ),
    );
    await act(async () => {
      await result.current.session.connect();
    });
    expect(result.current.beta.notInvited).toBe(false);
    await waitFor(() => expect(result.current.session.session).toEqual({ wallet: address }));
  });
});
