'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { LaunchpadSummary, TxPhase } from '@forge/shared';
import { useWebClient, useWorkspace } from './provider';
import {
  ActionLink,
  Amount,
  Button,
  Card,
  ClaimButton,
  Empty,
  ErrorNotice,
  Heading,
  Loading,
  readableError,
} from './components';
import { dashboardCopy as copy } from './content/dashboard';
import { common } from './content/common';
import { safeUrl } from './safe-url';

export function DashboardScreen({ claimPhase }: { claimPhase?: TxPhase }) {
  const api = useWebClient();
  const { launchpads, loading, refresh } = api.useLaunchpads();
  const { signupsPaused } = api.useFlags();
  return (
    <>
      <div className="fw-title-row">
        <Heading eyebrow={copy.eyebrow} title={copy.title}>
          {copy.subtitle}
        </Heading>
        {!signupsPaused && <ActionLink href="/new">{common.create}</ActionLink>}
      </div>
      {loading ? (
        <Loading />
      ) : launchpads.length === 0 ? (
        <Empty title={copy.empty}>
          <p>{copy.emptyBody}</p>
          {!signupsPaused && <ActionLink href="/new">{common.create}</ActionLink>}
        </Empty>
      ) : (
        <div className="fw-pad-grid">
          {launchpads.map((pad) => (
            <LaunchpadCard key={pad.id} pad={pad} refresh={refresh} claimPhase={claimPhase} />
          ))}
        </div>
      )}
    </>
  );
}
function LaunchpadCard({
  pad,
  refresh,
  claimPhase,
}: {
  pad: LaunchpadSummary;
  refresh(): void;
  claimPhase?: TxPhase;
}) {
  const api = useWebClient(),
    { toast } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const url = safeUrl(pad.siteUrl);
  return (
    <Card className="fw-pad-card">
      <div className="fw-pad-top">
        <span className="fw-pad-icon" aria-hidden="true">
          {pad.name.slice(0, 1)}
        </span>
        <span className={`fw-badge fw-badge-${pad.status}`}>{copy.status[pad.status]}</span>
      </div>
      <h2>{pad.name}</h2>
      <p className="fw-pad-subtitle">
        {pad.coin.name} <span>{pad.coin.symbol}</span>
      </p>
      {url && (
        <Link className="fw-site-url" href={url} target="_blank" rel="noreferrer">
          {pad.slug}.forgepads.xyz ↗
        </Link>
      )}
      <div className="fw-pad-metrics">
        <div>
          <span>{copy.coins}</span>
          <strong>{pad.coinsCount}</strong>
        </div>
        <div>
          <span>{copy.changes}</span>
          <strong>{pad.includedModificationsLeft}</strong>
        </div>
      </div>
      <div className="fw-fees">
        <p>{copy.fees}</p>
        <Amount lamports={pad.claimablePartnerFeesLamports} />
        <ClaimButton
          launchpadId={pad.id}
          lamports={pad.claimablePartnerFeesLamports}
          initialPhase={claimPhase}
          onSuccess={() => {
            refresh();
            toast(copy.claimSuccess);
          }}
        />
      </div>
      {pad.status === 'sleeping' && (
        <div className="fw-notice">
          <p>{copy.sleep}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await api.reactivateLaunchpad(pad.id);
                refresh();
              } catch (e) {
                setError(readableError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? copy.waking : copy.wake}
          </Button>
        </div>
      )}
      {pad.status === 'disabled' && <p className="fw-notice">{copy.disabled}</p>}
      {pad.activeJobId && (
        <Link className="fw-current-job" href={`/jobs/${pad.activeJobId}`}>
          {copy.job} ↗
        </Link>
      )}
      <div className="fw-card-links">
        <Link href={`/launchpads/${pad.id}`}>{copy.view} ↗</Link>
        {pad.status !== 'disabled' && (
          <Link href={`/launchpads/${pad.id}/modify`}>{copy.modify} ↗</Link>
        )}
      </div>
      {error && <ErrorNotice message={error} />}
    </Card>
  );
}
