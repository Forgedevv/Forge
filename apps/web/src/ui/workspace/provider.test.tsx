import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WEB_API_ROUTES } from '@forge/shared';
import { base58Encode } from '@/client/base58';
import { setSession } from '@/client/session-store';
import { createMockController } from '../mocks/client';
import { WorkspaceProvider, useWebClient, useWorkspace } from './provider';
import { LoginPanel, SessionGate } from './session';
import { GatingScreen } from './gating';
import { sessionCopy as copy } from './content/session';
import { gatingCopy } from './content/gating';
import { common } from './content/common';

const wallet = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const adapters = vi.hoisted(() => ({
  mount: vi.fn(),
  showSelector: vi.fn(),
  signMessage: vi.fn(),
}));
const supabase = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@solana/wallet-adapter-react', () => ({
  ConnectionProvider: ({ children, endpoint }: { children: ReactNode; endpoint: string }) => {
    adapters.mount(endpoint);
    return children;
  },
  WalletProvider: ({ children }: { children: ReactNode }) => children,
  useConnection: () => ({ connection: null }),
  useWallet: () => wallet.value,
}));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => children,
  useWalletModal: () => ({ setVisible: adapters.showSelector }),
}));
vi.mock('@/client/supabase', () => ({
  startSupabaseAuth: supabase.start,
  stopSupabaseAuth: supabase.stop,
  subscribeSupabase: () => () => undefined,
  getSupabaseSnapshot: () => null,
  getServerSupabaseSnapshot: () => null,
  getSupabase: () => null,
}));

let address: string;
let fetchApi: ReturnType<typeof vi.fn<(path: string) => Promise<Response>>>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The live provider is loaded lazily; compile it once up front (slow on a busy machine) so the
// tests below measure behaviour, not module loading.
beforeAll(async () => {
  await import('./live-provider');
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NEXT_PUBLIC_USE_MOCKS', '0');
  setSession(null);
  // Synthetic public identity for HTTP schema validation; no private key or transaction exists.
  address = base58Encode(crypto.getRandomValues(new Uint8Array(32)));
  adapters.signMessage.mockResolvedValue(new Uint8Array(64).fill(7));
  supabase.start.mockResolvedValue(undefined);
  wallet.value = {
    connected: true,
    connecting: false,
    publicKey: { toBase58: () => address },
    wallet: { adapter: {} },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signMessage: adapters.signMessage,
  };
  let signedIn = false;
  fetchApi = vi.fn((path: string) => {
    if (path === WEB_API_ROUTES.authSession.path)
      return Promise.resolve(signedIn ? json({ wallet: address }) : json({}, 401));
    if (path === WEB_API_ROUTES.authNonce.path)
      return Promise.resolve(
        json({
          nonce: 'test-login-nonce',
          message: 'Sign in to the frontend test.',
          expiresAt: '2030-01-01T00:00:00Z',
        }),
      );
    if (path === WEB_API_ROUTES.authVerify.path) {
      signedIn = true;
      return Promise.resolve(json({ wallet: address }));
    }
    if (path === WEB_API_ROUTES.authLogout.path) {
      signedIn = false;
      return Promise.resolve(json({ ok: true }));
    }
    if (path === WEB_API_ROUTES.flags.path) return Promise.resolve(json({ signupsPaused: false }));
    return Promise.resolve(json({ message: 'Unexpected test endpoint.' }, 404));
  });
  vi.stubGlobal('fetch', fetchApi);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  setSession(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function Status() {
  const { demo } = useWorkspace();
  const api = useWebClient();
  const { session, disconnect } = api.useSession();
  const { signupsPaused } = api.useFlags();
  return (
    <>
      <p>{demo ? 'Preview client' : 'Live client'}</p>
      <p>{signupsPaused ? 'Creation paused' : 'Creation open'}</p>
      {session && <button onClick={() => void disconnect()}>End session</button>}
    </>
  );
}

function mount(controller?: ReturnType<typeof createMockController>) {
  return render(
    <WorkspaceProvider controller={controller}>
      <Status />
      <LoginPanel />
      <SessionGate>
        <p>Protected workshop</p>
      </SessionGate>
    </WorkspaceProvider>,
  );
}

it('uses the real login client and protects the workshop until authentication succeeds', async () => {
  mount();
  const choose = await screen.findByRole('button', { name: copy.choose }, { timeout: 10000 });
  expect(choose).toBeEnabled();
  expect(screen.queryByText('Protected workshop')).not.toBeInTheDocument();
  fireEvent.click(choose);
  expect(await screen.findByText('Protected workshop')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: copy.connected })).toBeInTheDocument();
  expect(adapters.mount).toHaveBeenCalledWith(`${window.location.origin}/api/rpc`);
  expect(adapters.signMessage).toHaveBeenCalledOnce();
  expect(new TextDecoder().decode(adapters.signMessage.mock.calls[0]?.[0])).toBe(
    'Sign in to the frontend test.',
  );
  expect(fetchApi.mock.calls.some(([path]) => path === WEB_API_ROUTES.authVerify.path)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'End session' }));
  await waitFor(() => expect(screen.queryByText('Protected workshop')).not.toBeInTheDocument());
  expect(fetchApi.mock.calls.some(([path]) => path === WEB_API_ROUTES.authLogout.path)).toBe(true);
}, 10000);

it('delegates wallet selection and offers the next sign-in step without sending a transaction', async () => {
  wallet.value = { ...wallet.value, connected: false, publicKey: null, wallet: null };
  mount();
  fireEvent.click(await screen.findByRole('button', { name: copy.choose }));
  expect(await screen.findByRole('button', { name: copy.resume })).toBeEnabled();
  expect(screen.getByText(copy.delegated)).toBeInTheDocument();
  expect(adapters.showSelector).toHaveBeenCalledWith(true);
  expect(adapters.signMessage).not.toHaveBeenCalled();
  expect(fetchApi.mock.calls.some(([path]) => path === WEB_API_ROUTES.authNonce.path)).toBe(false);
});

it('keeps a failed live login outside the protected workshop and allows retry', async () => {
  const normal = fetchApi.getMockImplementation();
  fetchApi.mockImplementation((path: string) =>
    path === WEB_API_ROUTES.authNonce.path
      ? Promise.resolve(json({ message: 'Authentication service unavailable.' }, 503))
      : normal!(path),
  );
  mount();
  fireEvent.click(await screen.findByRole('button', { name: copy.choose }));
  expect(await screen.findByText('Authentication service unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('Protected workshop')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: copy.choose })).toBeEnabled();
  expect(adapters.signMessage).not.toHaveBeenCalled();
});

it('reads the real signup flag instead of a preview default', async () => {
  const normal = fetchApi.getMockImplementation();
  fetchApi.mockImplementation((path: string) =>
    path === WEB_API_ROUTES.flags.path
      ? Promise.resolve(json({ signupsPaused: true }))
      : normal!(path),
  );
  mount();
  expect(await screen.findByText('Creation paused')).toBeInTheDocument();
});

it('ignores the preview flag and an injected preview controller in production', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_USE_MOCKS', '1');
  const preview = createMockController('dashboard:three');
  const start = vi.spyOn(preview, 'start');
  mount(preview);
  expect(await screen.findByText('Live client')).toBeInTheDocument();
  expect(screen.queryByText('Preview client')).not.toBeInTheDocument();
  expect(screen.queryByText('Protected workshop')).not.toBeInTheDocument();
  expect(start).not.toHaveBeenCalled();
  expect(adapters.mount).toHaveBeenCalled();
});

it('keeps an explicitly supplied development preview isolated from wallet and API access', async () => {
  mount(createMockController('dashboard:three'));
  await act(async () => {});
  expect(screen.getByText('Preview client')).toBeInTheDocument();
  expect(screen.getByText('Protected workshop')).toBeInTheDocument();
  expect(adapters.mount).not.toHaveBeenCalled();
  expect(fetchApi).not.toHaveBeenCalled();
});

it('enables the default preview only with the development mock flag', async () => {
  vi.stubEnv('NEXT_PUBLIC_USE_MOCKS', '1');
  mount();
  await act(async () => {});
  expect(screen.getByText('Preview client')).toBeInTheDocument();
  expect(adapters.mount).not.toHaveBeenCalled();
  expect(fetchApi).not.toHaveBeenCalled();
});

function OpenLogin() {
  const { openLogin } = useWorkspace();
  return <button onClick={openLogin}>Open login</button>;
}

it('keeps keyboard focus inside login and returns it to the opener on Escape', () => {
  render(
    <WorkspaceProvider controller={createMockController('session:idle')}>
      <OpenLogin />
    </WorkspaceProvider>,
  );
  const opener = screen.getByRole('button', { name: 'Open login' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog');
  const buttons = within(dialog).getAllByRole('button');
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(last, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it('yields focus to the external wallet picker and restores the login continuation', async () => {
  wallet.value = { ...wallet.value, connected: false, publicKey: null, wallet: null };
  render(
    <WorkspaceProvider>
      <OpenLogin />
    </WorkspaceProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open login' }));
  const dialog = screen.getByRole('dialog');
  const choose = within(dialog).getByRole('button', { name: copy.choose });
  fireEvent.click(choose);
  await screen.findByRole('button', { name: copy.resume });
  expect(adapters.showSelector).toHaveBeenCalledWith(true);
  // Simulate the adapter's documented body portal, including its mount and unmount.
  const picker = document.createElement('div');
  picker.className = 'wallet-adapter-modal';
  picker.setAttribute('role', 'dialog');
  const pickWallet = document.createElement('button');
  pickWallet.textContent = 'Select test wallet';
  picker.append(pickWallet);
  try {
    document.body.append(picker);
    await waitFor(() => expect(pickWallet).toHaveFocus());
    expect(dialog).toHaveAttribute('aria-hidden', 'true');
    expect(dialog.inert).toBe(true);
    picker.remove();
    await waitFor(() => expect(choose).toHaveFocus());
    expect(dialog).not.toHaveAttribute('aria-hidden');
    expect(dialog.inert).toBe(false);
  } finally {
    picker.remove();
  }
});

it('shows a failed real access check and unlocks only after a successful retry', async () => {
  const normal = fetchApi.getMockImplementation();
  let accessReady = false;
  fetchApi.mockImplementation((path: string) =>
    path === WEB_API_ROUTES.gating.path
      ? Promise.resolve(
          accessReady
            ? json({ ok: true, enabled: false, required: '0', balance: '0' })
            : json({ message: 'Access service unavailable.' }, 503),
        )
      : normal!(path),
  );
  render(
    <WorkspaceProvider>
      <GatingScreen>
        <p>Access-controlled chat</p>
      </GatingScreen>
    </WorkspaceProvider>,
  );
  expect(await screen.findByText(gatingCopy.unavailable)).toBeInTheDocument();
  expect(screen.queryByText('Access-controlled chat')).not.toBeInTheDocument();
  accessReady = true;
  fireEvent.click(screen.getByRole('button', { name: common.retry }));
  // The check is disabled before $FORGE launches: straight to the chat, no "Continue".
  expect(await screen.findByText('Access-controlled chat')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: new RegExp(gatingCopy.continue) }),
  ).not.toBeInTheDocument();
});

it('retains dialog focus when successful authentication replaces the login controls', async () => {
  render(
    <WorkspaceProvider>
      <OpenLogin />
    </WorkspaceProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open login' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: copy.choose }));
  expect(
    await within(dialog).findByRole('link', { name: new RegExp(copy.continue) }),
  ).toBeInTheDocument();
  await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('shows the private beta notice when the real sign-in is refused for this wallet', async () => {
  fetchApi.mockImplementation((path: string) => {
    if (path === WEB_API_ROUTES.authNonce.path)
      return Promise.resolve(
        json({
          nonce: 'n',
          message: 'Sign in to the frontend test.',
          expiresAt: '2030-01-01T00:00:00Z',
        }),
      );
    if (path === WEB_API_ROUTES.authVerify.path)
      return Promise.resolve(
        json({ code: 'BETA_NOT_INVITED', message: 'FORGE is in private beta.' }, 403),
      );
    if (path === WEB_API_ROUTES.flags.path) return Promise.resolve(json({ signupsPaused: false }));
    return Promise.resolve(json({}, 401));
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: copy.choose }, { timeout: 10000 }));
  const notices = await screen.findAllByRole('alert');
  expect(notices.some((n) => n.textContent?.includes(copy.betaTitle))).toBe(true);
  expect(screen.queryByText('Protected workshop')).not.toBeInTheDocument();
});
