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
  ErrorNotice,
  Heading,
  JobStepTracker,
  Loading,
  StatusBadge,
  readableError,
} from './components';
import { safeUrl } from './safe-url';
import { jobCopy as copy } from './content/job';
import { common } from './content/common';

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
  const { launchpad } = api.useLaunchpad(job?.launchpadId ?? '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false);
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (autoRedirect && job?.status === 'awaiting_owner_signature')
      router.replace(`/jobs/${encodeURIComponent(jobId)}/launch`);
  }, [autoRedirect, job?.status, router, jobId]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [events.length]);
  if (loading) return <Loading />;
  if (!job) return <ErrorNotice message={common.missing} />;
  const preview = safeUrl(job.previewUrl),
    site = safeUrl(launchpad?.siteUrl);
  const approve = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.approvePreview(jobId);
    } catch (e) {
      setError(readableError(e));
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
          {job.status === 'spec_ready' && (
            <>
              <h2>{copy.waiting}</h2>
              <ActionLink href={`/jobs/${jobId}/pay`}>{copy.payment}</ActionLink>
            </>
          )}
          {['paid', 'building'].includes(job.status) && (
            <>
              <span className="fw-orbit fw-orbit-moving" aria-hidden="true">
                ✳
              </span>
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
                <>
                  <iframe
                    className="fw-preview-frame"
                    src={preview}
                    title={copy.frame}
                    sandbox="allow-scripts allow-forms"
                    referrerPolicy="no-referrer"
                    loading="lazy"
                  />
                  <Link href={preview} target="_blank" rel="noreferrer">
                    {common.newTab} ↗
                  </Link>
                </>
              ) : (
                <p>{common.pending}</p>
              )}
              <div className="fw-actions">
                <Button disabled={!preview || busy} onClick={approve}>
                  {busy ? copy.approving : copy.approve} ↗
                </Button>
                <ActionLink href={`/launchpads/${job.launchpadId}/modify`} secondary>
                  {copy.change}
                </ActionLink>
              </div>
              <p className="fw-caption">{copy.changeNote}</p>
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
              <span className="fw-success-symbol" aria-hidden="true">
                ↗
              </span>
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
                        setError(common.copyFailed);
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
              {job.error && <p>{job.error}</p>}
              <Link href="/faq">{common.support} ↗</Link>
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
              <ActionLink href="/dashboard" secondary>
                {common.dashboard}
              </ActionLink>
            </>
          )}
          {error && <ErrorNotice message={error} />}
        </Card>
        <Card className="fw-event-card">
          <h2>{copy.log}</h2>
          <ol
            className="fw-event-log"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label={copy.log}
          >
            {events.length ? (
              events.map((event, i) => (
                <li key={event.id} ref={i === events.length - 1 ? end : undefined}>
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
