'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWebClient, useWorkspace } from './provider';
import {
  ActionLink,
  Amount,
  Button,
  Card,
  ErrorDetails,
  ErrorNotice,
  Heading,
  JobStepTracker,
  Loading,
  StatusBadge,
  describeError,
  type FriendlyError,
} from './components';
import { jobErrorDetail } from './errors';
import { safeUrl } from './safe-url';
import { jobCopy as copy } from './content/job';
import { common } from './content/common';
import { SupportBlock } from './support';
import { PreviewCard } from './preview-card';
import { useStickToBottom } from './scroll';
import { Muse, museMoodForJob } from '../muse';
import { StartAgainButton, StartAgainHold, draftNext, useStartAgain } from './start-again';

export function JobScreen({
  jobId,
  autoRedirect = true,
}: {
  jobId: string;
  autoRedirect?: boolean;
}) {
  const api = useWebClient(),
    router = useRouter(),
    { toast } = useWorkspace();
  const { job, events, loading } = api.useJob(jobId);
  const { launchpad, refresh: refreshLaunchpad } = api.useLaunchpad(job?.launchpadId ?? '');
  const { signupsPaused } = api.useFlags();
  const restart = useStartAgain(job?.launchpadId ?? '', refreshLaunchpad);
  const next = launchpad ? draftNext(launchpad) : null;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<FriendlyError | null>(null);
  const lock = useRef(false);
  // The activity log follows new events inside its own box, never scrolling the page.
  const log = useStickToBottom<HTMLOListElement>(`${loading}:${events.length}`);
  useEffect(() => {
    if (autoRedirect && job?.status === 'awaiting_owner_signature')
      router.replace(`/jobs/${encodeURIComponent(jobId)}/launch`);
  }, [autoRedirect, job?.status, router, jobId]);
  if (loading) return <Loading />;
  if (!job) return <ErrorNotice message={common.missing} />;
  const preview = safeUrl(job.previewUrl),
    site = safeUrl(launchpad?.siteUrl);
  const approve = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.approvePreview(jobId);
    } catch (e) {
      setError(describeError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Heading eyebrow={copy.eyebrow} title={job.status === 'live' ? copy.live : copy.title}>
        {job.status === 'live' ? copy.liveBody : undefined}
      </Heading>
      <div className="fw-job-heading">
        <StatusBadge job={job} />
        <span className="fw-caption">
          {job.type === 'create_launchpad' ? common.creation : common.modification}
        </span>
      </div>
      <JobStepTracker job={job} />
      <div className="fw-job-grid">
        <Card className="fw-job-stage">
          <Muse
            className="fw-job-muse"
            size={job.status === 'preview_ready' ? 64 : 120}
            mood={museMoodForJob(job.status)}
          />
          {job.status === 'spec_ready' && (
            <>
              <h2>{copy.waiting}</h2>
              <ActionLink href={`/jobs/${jobId}/pay`}>{copy.payment}</ActionLink>
            </>
          )}
          {['paid', 'building'].includes(job.status) && (
            <>
              <h2>{copy.building}</h2>
              {job.attempts >= 2 && (
                <p>
                  {copy.attempt} {job.attempts}/2
                </p>
              )}
            </>
          )}
          {job.status === 'preview_ready' && (
            <>
              <h2>{copy.preview}</h2>
              <p>{copy.previewBody}</p>
              {preview ? (
                <PreviewCard url={preview} />
              ) : (
                <p>{common.pending}</p>
              )}
              <div className="fw-actions">
                <Button disabled={!preview || busy} onClick={approve}>
                  {busy ? copy.approving : copy.approve} ↗
                </Button>
                {/* A creation preview belongs to a draft: changes come once it is live. */}
                {job.type === 'modify_launchpad' && (
                  <ActionLink href={`/launchpads/${job.launchpadId}/modify`} secondary>
                    {copy.change}
                  </ActionLink>
                )}
              </div>
              {job.type === 'modify_launchpad' && <p className="fw-caption">{copy.changeNote}</p>}
            </>
          )}
          {['approved', 'onchain_setup'].includes(job.status) && (
            <Loading label={job.type === 'modify_launchpad' ? copy.deploying : copy.setup} />
          )}
          {job.status === 'awaiting_owner_signature' && (
            <>
              <h2>{copy.waiting}</h2>
              <ActionLink href={`/jobs/${jobId}/launch`}>{copy.sign}</ActionLink>
            </>
          )}
          {['owner_signed', 'deploying'].includes(job.status) && <Loading label={copy.deploying} />}
          {job.status === 'live' && (
            <>
              <h2>{launchpad?.name}</h2>
              {site ? (
                <div className="fw-actions">
                  <ActionLink href={site}>{copy.site}</ActionLink>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          new URL(site, window.location.origin).href,
                        );
                        toast(common.copied);
                      } catch {
                        setError({ message: common.copyFailed, detail: null });
                      }
                    }}
                  >
                    {copy.share}
                  </Button>
                </div>
              ) : (
                <p>{copy.unavailable}</p>
              )}
              <ActionLink href="/dashboard" secondary>
                {copy.dashboard}
              </ActionLink>
            </>
          )}
          {job.status === 'failed' && (
            <div role="status">
              <h2>
                {job.failedStage === 'build'
                  ? job.attempts < 2
                    ? copy.retrying
                    : copy.refundPending
                  : copy.team}
              </h2>
              {job.failedStage === 'build' && (
                <p>
                  {copy.attempt} {job.attempts}/2
                </p>
              )}
              <p>
                {job.failedStage === 'build'
                  ? job.attempts < 2
                    ? copy.retryingBody
                    : copy.refundBody
                  : copy.teamBody}
              </p>
              <ErrorDetails detail={jobErrorDetail(job.error)} reference={jobId} />
              <SupportBlock reference={jobId} />
            </div>
          )}
          {job.status === 'refunded' && (
            <>
              <h2>{copy.refunded}</h2>
              {job.refund && (
                <>
                  <Amount lamports={job.refund.lamports} large />
                  <Link
                    href={api.explorerTxUrl(job.refund.signature)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {common.receipt} ↗
                  </Link>
                </>
              )}
              {job.type === 'create_launchpad' && launchpad?.canStartAgain === true && (
                <>
                  <p>{signupsPaused ? common.paused : copy.startAgain}</p>
                  {!signupsPaused && <StartAgainButton state={restart} />}
                </>
              )}
              {job.type === 'create_launchpad' && next?.kind === 'on_hold' && (
                <StartAgainHold reason={next.reason} reference={job.launchpadId} />
              )}
              <ActionLink href="/dashboard" secondary>
                {common.dashboard}
              </ActionLink>
            </>
          )}
          {error && <ErrorNotice message={error.message} detail={error.detail} reference={jobId} />}
          {restart.error && <ErrorNotice message={restart.error} />}
        </Card>
        <Card className="fw-event-card">
          <h2>{copy.log}</h2>
          <ol
            className="fw-event-log"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label={copy.log}
            ref={log.ref}
            onScroll={log.onScroll}
          >
            {events.length ? (
              events.map((event) => (
                <li key={event.id}>
                  <time dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'UTC',
                    })}{' '}
                    UTC
                  </time>
                  <p>{event.message}</p>
                </li>
              ))
            ) : (
              <li>{copy.noEvents}</li>
            )}
          </ol>
        </Card>
      </div>
    </>
  );
}
