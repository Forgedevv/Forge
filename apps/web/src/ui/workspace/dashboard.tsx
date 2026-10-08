'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { LaunchpadStatus, LaunchpadSummary, TxPhase } from '@forge/shared';
import { useWebClient, useWorkspace } from './provider';
import {
  ActionLink,
  Amount,
  Button,
  Card,
  ClaimButton,
  ErrorNotice,
  Heading,
  Loading,
  readableError,
} from './components';
import { dashboardCopy as copy } from './content/dashboard';
import { common } from './content/common';
import { safeUrl } from './safe-url';
import { Muse, museColorsFor, museMoodForJob, type MuseMood } from '../muse';
import { MuseHero, type HeroAction } from './muse-hero';

type PadColors = { primary: string | null; accent: string | null };

export function DashboardScreen({
  claimPhase,
  heroFallback = false,
}: {
  claimPhase?: TxPhase;
  heroFallback?: boolean;
}) {
  const api = useWebClient();
  const { launchpads, loading, refresh } = api.useLaunchpads();
  const { signupsPaused } = api.useFlags();
  const [colors, setColors] = useState<Record<string, PadColors>>({});
  const onColors = useCallback((id: string, value: PadColors) => {
    setColors((previous) =>
      previous[id]?.primary === value.primary && previous[id]?.accent === value.accent
        ? previous
        : { ...previous, [id]: value },
    );
  }, []);
  const muses = launchpads.map((pad) => ({
    id: pad.id,
    primary: colors[pad.id]?.primary ?? null,
    accent: colors[pad.id]?.accent ?? null,
  }));
  const activeJobId = launchpads.find((pad) => pad.activeJobId)?.activeJobId ?? null;
  const baseAction: HeroAction =
    launchpads.length === 0
      ? 'welcome'
      : launchpads.some((pad) => pad.status === 'live')
        ? 'live'
        : 'idle';
  const create = !signupsPaused && <ActionLink href="/new">{common.create}</ActionLink>;
  const hero = (action: HeroAction) => (
    <MuseHero action={action} muses={muses} forceFallback={heroFallback}>
      {action === 'welcome' && create}
      {action === 'building' && activeJobId && (
        <ActionLink href={`/jobs/${activeJobId}`}>{copy.job}</ActionLink>
      )}
    </MuseHero>
  );
  return (
    <>
      <div className="fw-title-row">
        <Heading eyebrow={copy.eyebrow} title={copy.title}>
          {copy.subtitle}
        </Heading>
        {!signupsPaused && launchpads.length > 0 && (
          <ActionLink href="/new">{common.create}</ActionLink>
        )}
      </div>
      {loading ? (
        <Loading />
      ) : (
        <>
          {activeJobId ? (
            <JobAwareHero jobId={activeJobId} fallback={baseAction} render={hero} />
          ) : (
            hero(baseAction)
          )}
          {launchpads.length > 0 && (
            <div className="fw-pad-grid">
              {launchpads.map((pad) => (
                <LaunchpadCard
                  key={pad.id}
                  pad={pad}
                  refresh={refresh}
                  claimPhase={claimPhase}
                  onColors={onColors}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Watches the active job so the hero Muse can craft while it builds. */
function JobAwareHero({
  jobId,
  fallback,
  render,
}: {
  jobId: string;
  fallback: HeroAction;
  render(action: HeroAction): ReactNode;
}) {
  const { job } = useWebClient().useJob(jobId);
  const mood = job ? museMoodForJob(job.status) : null;
  return <>{render(mood === 'building' ? 'building' : fallback)}</>;
}

const PAD_MOOD: Record<LaunchpadStatus, MuseMood> = {
  draft: 'idle',
  live: 'idle',
  sleeping: 'sleeping',
  disabled: 'sleeping',
};

function LaunchpadCard({
  pad,
  refresh,
  claimPhase,
  onColors,
}: {
  pad: LaunchpadSummary;
  refresh(): void;
  claimPhase?: TxPhase;
  onColors(id: string, colors: PadColors): void;
}) {
  const api = useWebClient(),
    { toast } = useWorkspace();
  // The launchpad's own Muse takes its theme colors.
  const { launchpad } = api.useLaunchpad(pad.id);
  const { primary, accent } = museColorsFor(launchpad?.spec);
  useEffect(() => {
    onColors(pad.id, { primary, accent });
  }, [onColors, pad.id, primary, accent]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const url = safeUrl(pad.siteUrl);
  return (
    <Card className="fw-pad-card">
      <div className="fw-pad-top">
        <span className="fw-pad-icon">
          <Muse
            size={44}
            primary={primary}
            accent={accent}
            mood={pad.activeJobId ? 'building' : PAD_MOOD[pad.status]}
            label={copy.padMuse(pad.name)}
          />
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
