'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { JOB_STATUS_LABELS, type Job, type LaunchpadStatus, type TxPhase } from '@forge/shared';
import type { LaunchpadSummaryView } from '@/client/types';
import { useWebClient, useWorkspace } from './provider';
import {
  ActionLink,
  Amount,
  Button,
  Card,
  ClaimButton,
  ErrorNotice,
  Loading,
  readableError,
} from './components';
import { dashboardCopy as copy } from './content/dashboard';
import { common } from './content/common';
import { safeUrl, siteHost } from './safe-url';
import { Muse, museColorsFor, museMoodForJob, type MuseMood } from '../muse';
import { MuseHero, type HeroAction } from './muse-hero';
import { LaunchpadArt } from './launchpad-art';
import { StartAgainButton, draftNext, useStartAgain } from './start-again';

type PadColors = { primary: string | null; accent: string | null };

export function DashboardScreen({
  claimPhase,
  heroFallback = false,
}: {
  claimPhase?: TxPhase;
  heroFallback?: boolean;
}) {
  const api = useWebClient();
  const { launchpads, loading, refresh, error: loadError } = api.useLaunchpads();
  const { signupsPaused } = api.useFlags();
  const [colors, setColors] = useState<Record<string, PadColors>>({});
  const [filter, setFilter] = useState<
    'all' | 'live' | 'building' | 'draft' | 'sleeping' | 'disabled'
  >('all');
  const [query, setQuery] = useState('');
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
  const visibleLaunchpads = useMemo(
    () =>
      launchpads.filter((pad) => {
        const matchesFilter =
          filter === 'all' ||
          (filter === 'building' ? Boolean(pad.activeJobId) : pad.status === filter);
        const search = query.trim().toLocaleLowerCase();
        return (
          matchesFilter &&
          (!search ||
            `${pad.name} ${pad.slug} ${pad.coin.name} ${pad.coin.symbol}`
              .toLocaleLowerCase()
              .includes(search))
        );
      }),
    [filter, launchpads, query],
  );
  const hero = (action: HeroAction) => (
    <MuseHero
      action={action}
      muses={muses}
      forceFallback={heroFallback}
      layout="open"
      heading={<h1 className="fw-dashboard-title">{copy.title}</h1>}
      body={action === 'welcome' ? copy.hero.welcome.body : null}
      footer={
        launchpads.length > 0 && (
          <section className="fw-workshop-pulse" aria-label={copy.overview}>
            <dl className="fw-pulse-grid">
              <PulseMetric label={copy.totalLaunchpads} value={launchpads.length} />
              <PulseMetric
                label={copy.liveLaunchpads}
                value={launchpads.filter((pad) => pad.status === 'live').length}
              />
              <PulseMetric
                label={copy.coins}
                value={
                  launchpads.some((pad) => pad.onchainAvailable === false)
                    ? null
                    : launchpads.reduce((sum, pad) => sum + pad.coinsCount, 0)
                }
              />
              <PulseMetric
                label={copy.activeBuilds}
                value={launchpads.filter((pad) => pad.activeJobId).length}
              />
            </dl>
          </section>
        )
      }
    >
      {(create || (action === 'building' && activeJobId)) && (
        <div className="fw-dashboard-actions">
          {create}
          {action === 'building' && activeJobId && (
            <ActionLink href={`/jobs/${activeJobId}`} secondary>
              {copy.job}
            </ActionLink>
          )}
        </div>
      )}
    </MuseHero>
  );
  return (
    <div className="fw-dashboard">
      {loading ? (
        <>
          <h1 className="fw-dashboard-title">{copy.title}</h1>
          <Loading />
        </>
      ) : loadError && launchpads.length === 0 ? (
        <>
          <h1 className="fw-dashboard-title">{copy.title}</h1>
          <ErrorNotice message={loadError} onRetry={refresh} />
        </>
      ) : (
        <>
          {activeJobId ? (
            <JobAwareHero jobId={activeJobId} fallback={baseAction} render={hero} />
          ) : (
            hero(baseAction)
          )}
          {launchpads.length > 0 && (
            <>
              <section className="fw-pad-section" aria-label={copy.padSection}>
                <div className="fw-pad-toolbar">
                  <div>
                    <p className="fw-eyebrow">{copy.collectionEyebrow}</p>
                    <h2>{copy.padSection}</h2>
                  </div>
                  <label className="fw-pad-search">
                    <span aria-hidden="true">⌕</span>
                    <span className="fw-sr-only">{copy.searchLabel}</span>
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={copy.searchPlaceholder}
                      type="search"
                    />
                  </label>
                </div>
                <div className="fw-pad-filters" role="group" aria-label={copy.filterLabel}>
                  {(['all', 'live', 'building', 'draft', 'sleeping', 'disabled'] as const).map(
                    (key) => (
                      <button
                        key={key}
                        type="button"
                        className={filter === key ? 'is-active' : ''}
                        aria-pressed={filter === key}
                        onClick={() => setFilter(key)}
                      >
                        {copy.filters[key]}
                        <span aria-hidden="true">
                          {key === 'all'
                            ? launchpads.length
                            : key === 'building'
                              ? launchpads.filter((pad) => pad.activeJobId).length
                              : launchpads.filter((pad) => pad.status === key).length}
                        </span>
                      </button>
                    ),
                  )}
                </div>
                {visibleLaunchpads.length ? (
                  <div className="fw-pad-grid">
                    {visibleLaunchpads.map((pad) => (
                      <LaunchpadCard
                        key={pad.id}
                        pad={pad}
                        refresh={refresh}
                        claimPhase={claimPhase}
                        onColors={onColors}
                        signupsPaused={signupsPaused}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="fw-filter-empty">
                    <p>{copy.noMatches}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setFilter('all');
                        setQuery('');
                      }}
                    >
                      {copy.clearFilters}
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

function PulseMetric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="fw-pulse-metric">
      <dt>{label}</dt>
      <dd>{value === null ? copy.unknown : value.toLocaleString()}</dd>
    </div>
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
  signupsPaused,
}: {
  pad: LaunchpadSummaryView;
  refresh(): void;
  claimPhase?: TxPhase;
  onColors(id: string, colors: PadColors): void;
  signupsPaused: boolean;
}) {
  const api = useWebClient(),
    { toast } = useWorkspace();
  const { launchpad } = api.useLaunchpad(pad.id);
  const { primary, accent } = museColorsFor(launchpad?.spec);
  useEffect(() => {
    onColors(pad.id, { primary, accent });
  }, [onColors, pad.id, primary, accent]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const restart = useStartAgain(pad.id);
  // A draft never offers a change: it is started again (refunded) or continued (open job).
  const next = draftNext(pad);
  const url = safeUrl(pad.siteUrl);
  const onchainKnown = pad.onchainAvailable !== false;
  const latestJob = launchpad?.jobs.reduce<Job | undefined>(
    (latest, job) =>
      !latest || Date.parse(job.updatedAt) > Date.parse(latest.updatedAt) ? job : latest,
    undefined,
  );
  return (
    <Card className="fw-pad-card">
      <Link
        className="fw-pad-cover-link"
        href={`/launchpads/${pad.id}`}
        aria-label={copy.openPad(pad.name)}
      >
        <LaunchpadArt name={pad.name} slug={pad.slug} primary={primary} accent={accent} />
        <span className={`fw-badge fw-badge-${pad.status}`}>{copy.status[pad.status]}</span>
        <span className="fw-pad-cover-arrow" aria-hidden="true">
          ↗
        </span>
      </Link>
      <div className="fw-pad-main">
        <div className="fw-pad-titleline">
          <span className="fw-pad-icon">
            <Muse
              size={36}
              primary={primary}
              accent={accent}
              mood={pad.activeJobId ? 'building' : PAD_MOOD[pad.status]}
              label={copy.padMuse(pad.name)}
            />
          </span>
          <div className="fw-pad-name">
            <h2>{pad.name}</h2>
            <p className="fw-pad-subtitle">
              {pad.coin.name} <span>{pad.coin.symbol}</span>
            </p>
            {url && (
              <Link className="fw-site-url" href={url} target="_blank" rel="noreferrer">
                {siteHost(url)} <span aria-hidden="true">↗</span>
              </Link>
            )}
          </div>
        </div>
      </div>
      <div className="fw-pad-side">
        <div className="fw-pad-metrics" aria-label={copy.padStats}>
          <div>
            <span>{copy.coins}</span>
            <strong>
              {onchainKnown ? pad.coinsCount.toString().padStart(2, '0') : copy.unknown}
            </strong>
          </div>
          <div>
            <span>{copy.changes}</span>
            <strong>{pad.includedModificationsLeft.toString().padStart(2, '0')}</strong>
          </div>
        </div>
      </div>
      <div className="fw-pad-revenue">
        <div>
          <p>{copy.fees}</p>
          {onchainKnown ? (
            <Amount lamports={pad.claimablePartnerFeesLamports} />
          ) : (
            <p className="fw-muted">{copy.feesUnavailable}</p>
          )}
        </div>
        <ClaimButton
          launchpadId={pad.id}
          lamports={pad.claimablePartnerFeesLamports}
          amountKnown={onchainKnown}
          initialPhase={claimPhase}
          onSuccess={() => {
            refresh();
            toast(copy.claimSuccess);
          }}
        />
      </div>
      {latestJob && (
        <div className="fw-pad-activity">
          <span className="fw-activity-dot" aria-hidden="true" />
          <div>
            <span>{copy.latestActivity}</span>
            <strong>{JOB_STATUS_LABELS[latestJob.status]}</strong>
          </div>
          <time dateTime={latestJob.updatedAt}>
            {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
              new Date(latestJob.updatedAt),
            )}
          </time>
        </div>
      )}
      {pad.status === 'sleeping' && (
        <div className="fw-notice fw-pad-notice">
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
      {pad.status === 'disabled' && <p className="fw-notice fw-pad-notice">{copy.disabled}</p>}
      {next.kind === 'start_again' && (
        <div className="fw-notice fw-pad-notice">
          <p>{copy.refunded}</p>
          {signupsPaused ? (
            <p>{common.paused}</p>
          ) : (
            <StartAgainButton state={restart} variant="secondary" />
          )}
        </div>
      )}
      {next.kind === 'continue' ? (
        <Link className="fw-current-job" href={next.href}>
          {common.continue} ↗
        </Link>
      ) : (
        pad.activeJobId && (
          <Link className="fw-current-job" href={`/jobs/${pad.activeJobId}`}>
            {copy.job} ↗
          </Link>
        )
      )}
      <div className="fw-card-links fw-pad-actions">
        <Link href={`/launchpads/${pad.id}`}>{copy.view} ↗</Link>
        {pad.status === 'live' && <Link href={`/launchpads/${pad.id}/modify`}>{copy.modify}</Link>}
      </div>
      {/* Both are already readable messages. */}
      {(error || restart.error) && <ErrorNotice message={error || restart.error} />}
    </Card>
  );
}
