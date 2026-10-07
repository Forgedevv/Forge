'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { TxPhase } from '@forge/shared';
import { createMockController } from '../mocks/client';
import { WorkspaceProvider, useWorkspace } from './provider';
import { WorkspaceHeader } from './shell';
import { SessionGate, LoginPanel } from './session';
import { GatingScreen } from './gating';
import { ChatScreen } from './chat';
import { PaymentScreen } from './payment';
import { JobScreen } from './job';
import { LaunchScreen } from './launch';
import { DashboardScreen } from './dashboard';
import { DetailScreen } from './detail';
import { FaqScreen, TermsScreen } from './documents';
import { ForgeHome } from '../home/home';
import { Button, ErrorNotice, Heading, Loading, ScreenBoundary } from './components';
import { galleryCopy as copy, galleryScenarios } from './content/gallery';
import { common } from './content/common';
import { chatCopy } from './content/chat';
import { sessionCopy } from './content/session';

export function StateGallery({
  enabled,
  receipt = false,
}: {
  enabled: boolean;
  receipt?: boolean;
}) {
  const [selected, setSelected] = useState('session:choice'),
    [revision, setRevision] = useState(0);
  const { theme, toggleTheme } = useWorkspace();
  if (!enabled)
    return (
      <main className="fw fw-gallery">
        <Heading eyebrow={copy.eyebrow} title={copy.disabled}>
          {copy.command}
        </Heading>
      </main>
    );
  return (
    <main className="fw fw-gallery" data-theme={theme}>
      <div className="fw-title-row">
        <Heading eyebrow={copy.eyebrow} title={receipt ? copy.receipt : copy.title}>
          {receipt ? copy.receiptBody : copy.body}
        </Heading>
        <div className="fw-actions">
          <Link className="fw-button fw-button-secondary" href="/new">
            {copy.journey} ↗
          </Link>
          <Button variant="secondary" onClick={toggleTheme}>
            {theme === 'dark' ? common.light : common.dark}
          </Button>
          <Button onClick={() => setRevision((n) => n + 1)}>{copy.reset}</Button>
        </div>
      </div>
      <div className="fw-gallery-controls">
        <nav className="fw-gallery-index" aria-label={copy.navigation}>
          {copy.groups.map((group) => (
            <details key={group.id} open>
              <summary>{group.title}</summary>
              {group.states.map(([state, label]) => (
                <button
                  key={state}
                  aria-pressed={selected === `${group.id}:${state}`}
                  onClick={() => {
                    setSelected(`${group.id}:${state}`);
                    setRevision(0);
                  }}
                >
                  {label}
                </button>
              ))}
            </details>
          ))}
        </nav>
        <div className="fw-gallery-stage">
          <p className="fw-gallery-label">{selected}</p>
          <ScenarioPreview key={`${selected}-${revision}`} scenario={selected} theme={theme} />
        </div>
      </div>
    </main>
  );
}
function phaseFor(state: string): TxPhase {
  if (state.endsWith('signing')) return 'awaiting_signature';
  if (state.endsWith('sending')) return 'sending';
  if (state.endsWith('confirmed')) return 'confirmed';
  if (state.endsWith('rejected')) return 'rejected';
  if (state === 'check-failed' || state === 'send-error') return 'error';
  return 'idle';
}
function ScenarioPreview({ scenario, theme }: { scenario: string; theme: string }) {
  const controller = useMemo(() => createMockController(scenario), [scenario]);
  return (
    <WorkspaceProvider controller={controller}>
      <div className="fw" data-theme={theme}>
        <ScreenBoundary onRetry={controller.recover}>
          <ScenarioContent scenario={scenario} />
        </ScreenBoundary>
      </div>
    </WorkspaceProvider>
  );
}
function ScenarioContent({ scenario }: { scenario: string }) {
  const item = galleryScenarios.find((s) => s.id === scenario);
  if (!item) return null;
  const { group, state } = item;
  switch (group) {
    case 'home':
      return <ForgeHome flags={{ signupsPaused: state === 'paused' }} />;
    case 'session':
      return (
        <>
          {state === 'connected' && <WorkspaceHeader />}
          <LoginPanel initialMessage={state === 'rejected' ? sessionCopy.rejected : ''} />
        </>
      );
    case 'gating':
      return (
        <GatingScreen>
          <ChatScreen />
        </GatingScreen>
      );
    case 'chat':
      return (
        <ChatScreen
          launchpadId={state === 'modification' ? 'demo-pad' : undefined}
          initialBusy={state === 'confirming'}
          initialError={state === 'error' ? chatCopy.network : ''}
        />
      );
    case 'payment':
      return (
        <PaymentScreen
          jobId="demo-job"
          initialPhase={phaseFor(state)}
          holdLoading={state === 'loading'}
          autoRedirect={false}
        />
      );
    case 'job':
    case 'journey':
      return <JobScreen jobId="demo-job" autoRedirect={false} />;
    case 'launch':
      return (
        <LaunchScreen
          jobId="demo-job"
          initialPhase={phaseFor(state)}
          holdLoading={state === 'preparing'}
          autoRedirect={false}
        />
      );
    case 'dashboard':
      return <DashboardScreen claimPhase={phaseFor(state)} />;
    case 'detail':
      return <DetailScreen launchpadId="demo-pad" />;
    case 'information':
      return state === 'faq' ? <FaqScreen /> : <TermsScreen />;
    case 'global':
      return state === 'loading' ? (
        <Loading />
      ) : state === 'disconnected' ? (
        <SessionGate>
          <DashboardScreen />
        </SessionGate>
      ) : state === 'not-found' ? (
        <JobScreen jobId="missing" />
      ) : (
        <DashboardScreen />
      );
    default:
      return <ErrorNotice message={copy.missing} />;
  }
}
