'use client';
import Link from 'next/link';

import { useState, type ReactNode } from 'react';
import { useWebClient, useWorkspace } from './provider';
import { Address, Button, ErrorNotice, readableError } from './components';
import { sessionCopy as copy } from './content/session';
import { common } from './content/common';
import { supportCopy } from './content/support';
import { SupportLinks } from './support';
import { Muse } from '../muse';
import { MuseHero } from './muse-hero';

/** Shown when the server refuses the wallet: FORGE is in private beta and it is not invited. */
export function BetaNotice({ onSwitch }: { onSwitch(): void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="fw-login fw-beta" role="alert" aria-labelledby="beta-title">
      <p className="fw-eyebrow">{copy.betaEyebrow}</p>
      <Muse className="fw-login-muse" size={72} mood="sleeping" />
      <h1 id="beta-title">{copy.betaTitle}</h1>
      <p>{copy.betaBody}</p>
      <div className="fw-actions">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSwitch();
            } finally {
              setBusy(false);
            }
          }}
        >
          {copy.betaSwitch}
        </Button>
        <Link href="/faq#invite">{copy.betaHelp}</Link>
        <SupportLinks subject={supportCopy.inviteSubject} fallback={false} />
      </div>
    </section>
  );
}

export function LoginPanel({ initialMessage = '' }: { initialMessage?: string }) {
  const api = useWebClient();
  const { available, demo, closeLogin } = useWorkspace();
  const { session, status, connect, disconnect } = api.useSession();
  const beta = api.useBetaAccess();
  const [message, setMessage] = useState(initialMessage);
  const [busy, setBusy] = useState(false);
  const [connectionStarted, setConnectionStarted] = useState(false);
  const login = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await connect();
      if (!demo) setConnectionStarted(true);
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setBusy(false);
    }
  };
  if (beta.notInvited && !session) {
    return (
      <BetaNotice
        onSwitch={async () => {
          await disconnect().catch(() => undefined);
          beta.dismiss();
          setMessage('');
          setConnectionStarted(false);
        }}
      />
    );
  }
  return (
    <section className="fw-login">
      <p className="fw-eyebrow">{copy.eyebrow}</p>
      <Muse
        className="fw-login-muse"
        size={72}
        mood={session ? 'success' : status === 'signing' ? 'waiting_approval' : 'idle'}
      />
      <h1 id="wallet-title">
        {session ? copy.connected : status === 'signing' ? copy.signing : copy.title}
      </h1>
      <p>{status === 'signing' ? copy.signingBody : copy.body}</p>
      {session ? (
        <>
          <Address value={session.wallet} />
          <Link className="fw-button fw-button-primary" href="/dashboard" onClick={closeLogin}>
            {copy.continue} <span aria-hidden="true">→</span>
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
                </Button>
              ))}
            </div>
          ) : (
            <Button disabled={!available || busy || status === 'signing'} onClick={login}>
              {connectionStarted ? copy.resume : copy.choose}
            </Button>
          )}
          {!demo && connectionStarted && status === 'idle' && !message && (
            <p className="fw-caption" role="status">
              {copy.delegated}
            </p>
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
  const api = useWebClient();
  const { session, disconnect } = api.useSession();
  const beta = api.useBetaAccess();
  const { openLogin } = useWorkspace();
  if (!session && beta.notInvited) {
    return (
      <div className="fw-centered">
        <BetaNotice
          onSwitch={async () => {
            await disconnect().catch(() => undefined);
            beta.dismiss();
            openLogin();
          }}
        />
      </div>
    );
  }
  return session ? (
    children
  ) : (
    <MuseHero action="welcome" muses={[]} title={copy.title} body={copy.body}>
      <Button onClick={openLogin}>{common.connect}</Button>
    </MuseHero>
  );
}
