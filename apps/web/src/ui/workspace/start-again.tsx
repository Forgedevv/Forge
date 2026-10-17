'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { JobStatus, LaunchpadSummary, StartAgainBlockedReason } from '@forge/shared';
import { useWebClient } from './provider';
import { Button, readableError } from './components';
import { common } from './content/common';
import { SupportLinks } from './support';

/*
 * What a launchpad that never went live offers instead of "request a change": "start again" when
 * its creation was refunded (same blueprint, a new creation job to pay), "continue" when a job is
 * open (pay it, or follow it), and why it waits when it was refunded but cannot be started again
 * yet (refund or payment still settling, a check by the team, a blueprint to design again).
 * Changes are only offered for a live launchpad.
 */

/** Where "continue" leads for an open job: its payment while it awaits one, else its tracker. */
export function continueHref(jobId: string, status: JobStatus | null | undefined): string {
  const path = `/jobs/${encodeURIComponent(jobId)}`;
  return status === 'spec_ready' ? `${path}/pay` : path;
}

export type DraftNext =
  | { kind: 'start_again' }
  | { kind: 'continue'; href: string }
  | { kind: 'on_hold'; reason: StartAgainBlockedReason }
  | { kind: 'none' };

/** The next step of a draft launchpad; `none` for any other status. */
export function draftNext(
  launchpad: Pick<
    LaunchpadSummary,
    'status' | 'activeJobId' | 'activeJobStatus' | 'canStartAgain' | 'startAgainBlocked'
  >,
): DraftNext {
  if (launchpad.status !== 'draft') return { kind: 'none' };
  if (launchpad.canStartAgain === true) return { kind: 'start_again' };
  if (launchpad.activeJobId) {
    return {
      kind: 'continue',
      href: continueHref(launchpad.activeJobId, launchpad.activeJobStatus),
    };
  }
  if (launchpad.startAgainBlocked) return { kind: 'on_hold', reason: launchpad.startAgainBlocked };
  return { kind: 'none' };
}

/**
 * Starts a refunded draft again, then opens the payment of its new creation job. When the server
 * refuses (a refund that just became pending, a check by the team...), `onRefused` reloads the
 * launchpad so the screen shows why instead of the button.
 */
export function useStartAgain(launchpadId: string, onRefused?: () => void) {
  const api = useWebClient(),
    router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false);
  const start = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const { jobId } = await api.retryLaunchpad(launchpadId);
      router.push(`/jobs/${encodeURIComponent(jobId)}/pay`);
    } catch (e) {
      setError(readableError(e));
      setBusy(false);
      onRefused?.();
    } finally {
      lock.current = false;
    }
  };
  return { start, busy, error };
}

export function StartAgainButton({
  state,
  variant = 'primary',
}: {
  state: ReturnType<typeof useStartAgain>;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Button variant={variant} disabled={state.busy} onClick={state.start}>
      {state.busy ? common.startingAgain : common.startAgain}
    </Button>
  );
}

/** Why a refunded draft waits instead of "start again", with the help link when the team decides. */
export function StartAgainHold({
  reason,
  className = 'fw-notice',
  reference,
}: {
  reason: StartAgainBlockedReason;
  className?: string;
  /** The launchpad id, quoted to the team when it has to check the launchpad. */
  reference?: string;
}) {
  return (
    <div className={className} role="status">
      <p>{common.startAgainBlocked[reason]}</p>
      {reason === 'needs_support' && (
        <p className="fw-support-links">
          <SupportLinks reference={reference} />
        </p>
      )}
    </div>
  );
}
