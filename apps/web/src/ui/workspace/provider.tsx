'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ClientError, type WebClient } from '@forge/shared';
import { createMockController, type MockController } from '../mocks/client';
import { formatSol, formatUsd, shortAddress, explorerTxUrl } from './format';
import { common } from './content/common';
import { LoginPanel } from './session';
import './workspace.css';

const unavailable = async () => {
  throw new ClientError('NETWORK', common.unavailableBody);
};
// Agent 3 owns src/client. Replace this adapter with its WebClient export when delivered.
const unavailableClient: WebClient = {
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
  client: WebClient;
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
  client: unavailableClient,
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
  const router = useRouter();
  const [controller] = useState(
    () =>
      supplied ??
      (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_USE_MOCKS === '1'
        ? createMockController()
        : null),
  );
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
        client: controller?.client ?? unavailableClient,
        available: Boolean(controller),
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
          {message}
        </div>
      )}
    </WorkspaceContext.Provider>
  );
}

function LoginDialog({ onClose, theme }: { onClose(): void; theme: string }) {
  const [element, setElement] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, [element]);
  return (
    <dialog
      ref={setElement}
      className="fw fw-login-dialog"
      data-theme={theme}
      aria-labelledby="wallet-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
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
    </dialog>
  );
}
