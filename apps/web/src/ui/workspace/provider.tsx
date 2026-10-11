'use client';

import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { ClientError } from '@forge/shared';
import { withClientExtensions } from '@/client/extensions';
import type { ForgeClientInput, ForgeWebClient } from '@/client/types';
import { createMockController, type MockController } from '../mocks/client';
import { formatSol, formatUsd, shortAddress, explorerTxUrl } from './format';
import { common } from './content/common';
import { LoginPanel } from './session';
import { Muse } from '../muse';
import './workspace.css';

const LiveWorkspaceProvider = lazy(() =>
  import('./live-provider').then(({ LiveWorkspaceProvider }) => ({
    default: LiveWorkspaceProvider,
  })),
);

const unavailable = async () => {
  throw new ClientError('NETWORK', common.unavailableBody);
};
// A safe default for isolated components rendered outside the application provider.
const unavailableClient: ForgeClientInput = {
  useSession: () => ({
    session: null,
    status: 'idle',
    connect: unavailable,
    disconnect: unavailable,
  }),
  useFlags: () => ({ signupsPaused: false }),
  useGating: () => ({ gating: null, loading: false, recheck: unavailable }),
  useChat: () => ({
    messages: [],
    streaming: false,
    spec: {},
    validation: { complete: false, errors: {} },
    rateLimited: false,
    conversationId: null,
    send() {},
  }),
  useJob: () => ({ job: null, events: [], loading: false }),
  useLaunchpads: () => ({ launchpads: [], loading: false, refresh() {} }),
  useLaunchpad: () => ({ launchpad: null, loading: false }),
  confirmSpec: unavailable,
  requestModification: unavailable,
  getQuote: unavailable,
  payQuote: unavailable,
  approvePreview: unavailable,
  getOwnerTransactionSummary: unavailable,
  signOwnerTransaction: unavailable,
  claimPartnerFees: unavailable,
  reactivateLaunchpad: unavailable,
  formatSol,
  formatUsd,
  shortAddress,
  explorerTxUrl,
};
type Context = {
  client: ForgeWebClient;
  available: boolean;
  demo: boolean;
  theme: 'dark' | 'light';
  toggleTheme(): void;
  openLogin(): void;
  closeLogin(): void;
  toast(message: string): void;
  recover(): void;
  navigate(path: string): void;
};
const WorkspaceContext = createContext<Context>({
  client: withClientExtensions(unavailableClient),
  available: false,
  demo: false,
  theme: 'dark',
  toggleTheme() {},
  openLogin() {},
  closeLogin() {},
  toast() {},
  recover() {},
  navigate() {},
});
export const useWorkspace = () => useContext(WorkspaceContext);
export const useWebClient = () => useWorkspace().client;

export function WorkspaceProvider({
  children,
  controller: supplied,
}: {
  children: ReactNode;
  controller?: MockController;
}) {
  const [controller] = useState(() =>
    process.env.NODE_ENV !== 'production'
      ? (supplied ?? (process.env.NEXT_PUBLIC_USE_MOCKS === '1' ? createMockController() : null))
      : null,
  );
  return controller ? (
    <WorkspaceStateProvider client={controller.client} controller={controller}>
      {children}
    </WorkspaceStateProvider>
  ) : (
    <Suspense
      fallback={
        <div className="fw fw-client-loading" role="status">
          {common.loading}
        </div>
      }
    >
      <LiveWorkspaceProvider>{children}</LiveWorkspaceProvider>
    </Suspense>
  );
}

/** Shared interface state; the live wallet provider is mounted separately from preview mocks. */
export function WorkspaceStateProvider({
  children,
  client: input,
  controller,
}: {
  children: ReactNode;
  client: ForgeClientInput;
  controller?: MockController;
}) {
  const client = useMemo(() => withClientExtensions(input), [input]);
  const router = useRouter();
  const [login, setLogin] = useState(false);
  const [message, setMessage] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    controller?.start();
    return () => controller?.dispose();
  }, [controller]);
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(''), 4500);
    return () => clearTimeout(id);
  }, [message]);
  return (
    <WorkspaceContext.Provider
      value={{
        client,
        available: true,
        demo: Boolean(controller),
        theme,
        toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
        openLogin: () => setLogin(true),
        closeLogin: () => setLogin(false),
        toast: setMessage,
        recover: () => controller?.recover(),
        navigate: router.push,
      }}
    >
      {children}
      {login && <LoginDialog onClose={() => setLogin(false)} theme={theme} />}
      {message && (
        <div className="fw-toast" role="status" data-theme={theme}>
          <Muse size={28} mood="success" gaze="none" interactive={false} />
          <span>{message}</span>
        </div>
      )}
    </WorkspaceContext.Provider>
  );
}

function LoginDialog({ onClose, theme }: { onClose(): void; theme: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusLogin = () =>
      (element.querySelector<HTMLElement>('.fw-login button:not(:disabled)') ?? element).focus();
    focusLogin();
    let pickerOpen = false;
    let resumeFocus: HTMLElement | null = null;
    // The wallet adapter portals its picker to the body, outside this dialog.
    const observer = new MutationObserver(() => {
      const picker = document.querySelector<HTMLElement>('.wallet-adapter-modal[role="dialog"]');
      if (picker && !pickerOpen) {
        pickerOpen = true;
        resumeFocus = element.contains(document.activeElement)
          ? (document.activeElement as HTMLElement)
          : null;
        picker.querySelector<HTMLElement>('button')?.focus();
        element.inert = true;
        element.setAttribute('aria-hidden', 'true');
      } else if (!picker && pickerOpen) {
        pickerOpen = false;
        element.inert = false;
        element.removeAttribute('aria-hidden');
        if (resumeFocus?.isConnected && !resumeFocus.matches(':disabled')) resumeFocus.focus();
        else focusLogin();
      } else if (!picker && document.activeElement === document.body) {
        // Authentication can replace the focused login button with the connected view.
        focusLogin();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (!document.querySelector('.wallet-adapter-modal')) previous?.focus();
    };
  }, []);
  return (
    <div
      className="fw fw-login-layer"
      data-theme={theme}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="fw-login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
          if (e.key !== 'Tab') return;
          e.stopPropagation();
          const controls = e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first) {
            e.preventDefault();
            e.currentTarget.focus();
          } else if (
            e.shiftKey &&
            (document.activeElement === first || document.activeElement === e.currentTarget)
          ) {
            e.preventDefault();
            last?.focus();
          } else if (
            !e.shiftKey &&
            (document.activeElement === last || document.activeElement === e.currentTarget)
          ) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <button
          className="fw-icon-button fw-dialog-close"
          onClick={onClose}
          aria-label={common.close}
        >
          ×
        </button>
        <LoginPanel />
      </div>
    </div>
  );
}
