'use client';
import Link from 'next/link';

import { useState, type ReactNode } from 'react';
import { useWebClient, useWorkspace } from './provider';
import { Address, Button, Empty, ErrorNotice, readableError } from './components';
import { sessionCopy as copy } from './content/session';
import { common } from './content/common';

export function LoginPanel({ initialMessage = '' }: { initialMessage?: string }) {
  const api = useWebClient();
  const { available, demo, closeLogin } = useWorkspace();
  const { session, status, connect } = api.useSession();
  const [message, setMessage] = useState(initialMessage);
  const [busy, setBusy] = useState(false);
  const login = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await connect();
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fw-login">
      <p className="fw-eyebrow">{copy.eyebrow}</p>
      <span className="fw-orbit" aria-hidden="true">
        ✳
      </span>
      <h1 id="wallet-title">
        {session ? copy.connected : status === 'signing' ? copy.signing : copy.title}
      </h1>
      <p>{status === 'signing' ? copy.signingBody : copy.body}</p>
      {session ? (
        <>
          <Address value={session.wallet} />
          <Link className="fw-button fw-button-primary" href="/dashboard" onClick={closeLogin}>
            {copy.continue} ↗
          </Link>
        </>
      ) : (
        <>
          {demo ? (
            <div className="fw-wallet-options">
              {copy.wallets.map((wallet, i) => (
                <Button
                  variant="secondary"
                  key={wallet}
                  disabled={busy || status === 'signing'}
                  onClick={login}
                >
                  <span className="fw-wallet-icon">{i === 0 ? '◕' : '▣'}</span>
                  {wallet}
                  <span>↗</span>
                </Button>
              ))}
            </div>
          ) : (
            <Button disabled={!available || busy || status === 'signing'} onClick={login}>
              {copy.choose}
            </Button>
          )}
          {!available && <p className="fw-notice">{common.unavailableBody}</p>}
          {message && (
            <p className="fw-notice" role="status">
              {message}
            </p>
          )}
          {status === 'error' && !message && <ErrorNotice message={copy.error} onRetry={login} />}
        </>
      )}
    </section>
  );
}
export function SessionGate({ children }: { children: ReactNode }) {
  const { session } = useWebClient().useSession();
  const { openLogin } = useWorkspace();
  return session ? (
    children
  ) : (
    <Empty title={copy.title}>
      <p>{copy.body}</p>
      <Button onClick={openLogin}>{common.connect}</Button>
    </Empty>
  );
}
