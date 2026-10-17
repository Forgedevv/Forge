'use client';
import Link from 'next/link';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWebClient, useWorkspace } from './provider';
import { common } from './content/common';
import { ActionLink, Button, ScreenBoundary } from './components';
import { SessionGate } from './session';
import { MuseHero } from './muse-hero';

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
            <MuseHero
              action="welcome"
              muses={[]}
              title={common.unavailable}
              body={common.unavailableBody}
            >
              <ActionLink href="/">{common.home}</ActionLink>
            </MuseHero>
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

/**
 * The wallet menu. Closes on a choice, a click or tap outside, Escape (focus back on the toggle)
 * and history navigation, so it never stays open over the next page.
 */
export function AccountMenu({
  label,
  onDisconnect,
}: {
  label: string;
  onDisconnect(): Promise<void> | void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      menu.current?.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', close);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', close);
    };
  }, [open]);
  return (
    <details className="fw-account" ref={menu} open={open}>
      <summary
        aria-expanded={open}
        onClick={(event) => {
          // Driven by state, so that closing from outside keeps React and the element in step.
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <span className="fw-avatar" aria-hidden="true">
          ◒
        </span>
        <span>{label}</span>
      </summary>
      <div>
        <Link href="/dashboard" onClick={() => setOpen(false)}>
          {common.dashboard}
        </Link>
        <Button
          variant="quiet"
          onClick={() => {
            setOpen(false);
            void Promise.resolve(onDisconnect()).catch(() => undefined);
          }}
        >
          {common.disconnect}
        </Button>
      </div>
    </details>
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
            <span aria-hidden="true">→</span>
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
          <AccountMenu label={api.shortAddress(session.wallet)} onDisconnect={disconnect} />
        ) : (
          <Button variant="secondary" onClick={openLogin}>
            {common.connect}
          </Button>
        )}
      </div>
    </header>
  );
}
