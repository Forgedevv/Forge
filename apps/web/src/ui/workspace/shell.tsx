'use client';
import Link from 'next/link';

import { useState, type ReactNode } from 'react';
import { useWebClient, useWorkspace } from './provider';
import { common } from './content/common';
import { ActionLink, Button, Empty, ScreenBoundary } from './components';
import { SessionGate } from './session';

export function WorkspaceFrame({
  children,
  requireSession = true,
}: {
  children: ReactNode;
  requireSession?: boolean;
}) {
  const workspace = useWorkspace();
  const [retry, setRetry] = useState(0);
  return (
    <div className="fw" data-theme={workspace.theme}>
      <ScreenBoundary
        onRetry={() => {
          workspace.recover();
          setRetry((n) => n + 1);
        }}
      >
        <WorkspaceHeader />
        <main className="fw-main" key={retry}>
          {workspace.demo && <p className="fw-demo-banner">{common.demo}</p>}
          {!workspace.available && requireSession ? (
            <Empty title={common.unavailable}>
              <p>{common.unavailableBody}</p>
              <ActionLink href="/">{common.home}</ActionLink>
            </Empty>
          ) : requireSession ? (
            <SessionGate>{children}</SessionGate>
          ) : (
            children
          )}
        </main>
      </ScreenBoundary>
      <footer className="fw-footer">
        <Link href="/" aria-label={common.footerBrand} className="fw-footer-brand">
          <BrandLogo className="fw-logo-footer" width={84} height={19} />
          <span aria-hidden="true">/ {common.workshop}</span>
        </Link>
        <nav aria-label={common.information}>
          <Link href="/faq">{common.faq}</Link>
          <Link href="/terms">{common.terms}</Link>
        </nav>
      </footer>
    </div>
  );
}
/** Both wordmarks are rendered; CSS shows the one that matches the active theme. */
function BrandLogo({
  className,
  width,
  height,
}: {
  className: string;
  width: number;
  height: number;
}) {
  return (
    <>
      <img
        className={`${className} fw-logo-for-dark`}
        src="/brand/forge-logo-wordmark-light-text.svg"
        alt={common.brand}
        width={width}
        height={height}
      />
      <img
        className={`${className} fw-logo-for-light`}
        src="/brand/forge-logo-wordmark-dark-text.svg"
        alt={common.brand}
        width={width}
        height={height}
      />
    </>
  );
}

export function WorkspaceHeader() {
  const api = useWebClient();
  const { session, disconnect } = api.useSession();
  const { signupsPaused } = api.useFlags();
  const { openLogin, toggleTheme, theme } = useWorkspace();
  return (
    <header className="fw-header">
      <Link href="/" className="fw-brand" aria-label={common.home}>
        <BrandLogo className="fw-logo" width={140} height={32} />
        <span className="fw-brand-note">/ {common.workshop}</span>
      </Link>
      <nav aria-label={common.navigation}>
        <Link href="/dashboard">{common.dashboard}</Link>
        {!signupsPaused && (
          <Link href="/new" className="fw-create-link">
            {common.create}
            <span aria-hidden="true">↗</span>
          </Link>
        )}
      </nav>
      <div className="fw-header-tools">
        <button
          className="fw-icon-button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? common.light : common.dark}
        >
          {theme === 'dark' ? '☼' : '◐'}
        </button>
        {session ? (
          <details className="fw-account">
            <summary>
              <span className="fw-avatar" aria-hidden="true">
                ◒
              </span>
              <span>{api.shortAddress(session.wallet)}</span>
            </summary>
            <div>
              <Link href="/dashboard">{common.dashboard}</Link>
              <Button variant="quiet" onClick={() => void disconnect()}>
                {common.disconnect}
              </Button>
            </div>
          </details>
        ) : (
          <Button variant="secondary" onClick={openLogin}>
            {common.connect}
          </Button>
        )}
      </div>
    </header>
  );
}
