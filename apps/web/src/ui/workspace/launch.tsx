'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { JobStatus, TxPhase, TxResult } from '@forge/shared';
import { serverCodeOf } from '@/client/errors';
import type { LaunchReview } from '@/client/types';
import { useWebClient, useWorkspace } from './provider';
import {
  ActionLink,
  Address,
  Amount,
  Button,
  Card,
  ErrorNotice,
  Heading,
  Loading,
  TransactionState,
  describeError,
  type FriendlyError,
} from './components';
import { launchCopy as copy } from './content/launch';
import { common } from './content/common';
import { Muse } from '../muse';

/** The launch transaction is confirmed once the job reached one of these statuses. */
const SIGNED_STATUSES: ReadonlySet<JobStatus> = new Set(['owner_signed', 'deploying', 'live']);

/** One unit of the 4 decimals `formatSol` shows by default (0.0001 SOL). */
const DISPLAY_STEP_LAMPORTS = 100_000n;

/**
 * The balance the wallet must hold, rounded up to the displayed precision: rounding it to the
 * nearest value could show less than the launch needs.
 */
function balanceNeededForDisplay(lamports: string): string {
  if (!/^\d+$/.test(lamports)) return lamports;
  const steps = (BigInt(lamports) + DISPLAY_STEP_LAMPORTS - 1n) / DISPLAY_STEP_LAMPORTS;
  return (steps * DISPLAY_STEP_LAMPORTS).toString();
}

export function LaunchScreen({
  jobId,
  initialPhase = 'idle',
  holdLoading = false,
  autoRedirect = true,
}: {
  jobId: string;
  initialPhase?: TxPhase;
  holdLoading?: boolean;
  autoRedirect?: boolean;
}) {
  const api = useWebClient(),
    router = useRouter(),
    { openLogin } = useWorkspace();
  const { session, disconnect } = api.useSession();
  const { job } = api.useJob(jobId);
  const [summary, setSummary] = useState<LaunchReview | null>(null),
    [alreadySigned, setAlreadySigned] = useState(false),
    [acknowledged, setAcknowledged] = useState(false),
    [error, setError] = useState<FriendlyError | null>(null),
    [phase, setPhase] = useState<TxPhase>(initialPhase),
    [result, setResult] = useState<TxResult | null>(null),
    [generation, setGeneration] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    if (holdLoading) return;
    let cancelled = false;
    setError(null);
    void api
      .getOwnerTransactionSummary(jobId)
      .then((value) => {
        if (cancelled) return;
        setSummary(value);
        setAcknowledged(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Signed and confirmed already (e.g. from another tab): that is a success.
        if (serverCodeOf(e) === 'ALREADY_SIGNED') setAlreadySigned(true);
        else setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, jobId, generation, holdLoading]);
  const signed =
    phase === 'confirmed' || alreadySigned || Boolean(job && SIGNED_STATUSES.has(job.status));
  // Without a successful simulation of this exact transaction the amounts are a minimum and the
  // launch may fail: the owner must say they want to sign anyway.
  const simulated = summary?.simulation === 'ok';
  const sign = async () => {
    if (!summary || session?.wallet !== summary.ownerWallet || lock.current) return;
    if (!simulated && !acknowledged) return;
    lock.current = true;
    setError(null);
    try {
      const next = await api.signOwnerTransaction(jobId, setPhase);
      setResult(next);
      setPhase(next.phase);
      if (next.phase === 'confirmed' && autoRedirect)
        router.replace(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (e) {
      setPhase('error');
      setError(describeError(e));
    } finally {
      lock.current = false;
    }
  };
  const busy = phase === 'awaiting_signature' || phase === 'sending';
  const confirmedView = (
    <>
      <Muse className="fw-launch-muse" size={96} mood="success" />
      <h2>{copy.confirmed}</h2>
      <ActionLink href={`/jobs/${jobId}`}>{copy.track}</ActionLink>
    </>
  );
  if (signed && !summary) {
    return (
      <div className="fw-centered">
        <Heading eyebrow={copy.eyebrow} title={copy.title}>
          {copy.explanation}
        </Heading>
        <Card className="fw-launch-card">{confirmedView}</Card>
      </div>
    );
  }
  return (
    <div className="fw-centered">
      <Heading eyebrow={copy.eyebrow} title={copy.title}>
        {copy.explanation}
      </Heading>
      {!summary && !error ? (
        <Loading label={copy.preparing} />
      ) : (
        summary && (
          <Card className="fw-launch-card">
            <span className="fw-coin-emblem" aria-hidden="true">
              ◒
            </span>
            <h2>
              {summary.coinName} <span className="fw-muted">{summary.coinSymbol}</span>
            </h2>
            <div className="fw-launch-amounts">
              <div>
                <p>{copy.firstBuy}</p>
                <Amount lamports={summary.firstBuyLamports} large />
              </div>
              <div>
                <p>{copy.network}</p>
                <Amount lamports={summary.estimatedNetworkFeeLamports} />
              </div>
              <div>
                <p>{copy.total}</p>
                <Amount
                  lamports={(
                    BigInt(summary.firstBuyLamports) + BigInt(summary.estimatedNetworkFeeLamports)
                  ).toString()}
                />
              </div>
              {summary.ownerRequiredBalanceLamports !== undefined && (
                <div>
                  <p>{copy.balanceNeeded}</p>
                  <Amount
                    lamports={balanceNeededForDisplay(summary.ownerRequiredBalanceLamports)}
                  />
                </div>
              )}
            </div>
            <p className="fw-caption">{copy.networkHint}</p>
            {!simulated && (
              <div className="fw-notice fw-notice-error" role="alert">
                <h2>
                  {summary.simulation === 'failed'
                    ? copy.simulationFailed
                    : copy.simulationUnavailable}
                </h2>
                <p>
                  {summary.simulation === 'failed'
                    ? copy.simulationFailedBody
                    : copy.simulationUnavailableBody}
                </p>
                <label className="fw-confirm-check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <span>{copy.acknowledge}</span>
                </label>
              </div>
            )}
            <Address value={summary.ownerWallet} label={copy.owner} />
            {session?.wallet !== summary.ownerWallet ? (
              <div className="fw-notice">
                <p>{copy.wrong}</p>
                {session && <Address value={session.wallet} label={copy.connected} />}
                <Button
                  onClick={async () => {
                    try {
                      await disconnect();
                      openLogin();
                    } catch (e) {
                      setError(describeError(e));
                    }
                  }}
                >
                  {copy.switch}
                </Button>
              </div>
            ) : signed ? (
              confirmedView
            ) : (
              <>
                <Button disabled={busy || (!simulated && !acknowledged)} onClick={sign}>
                  {busy
                    ? phase === 'sending'
                      ? common.sending
                      : common.sign
                    : phase === 'error'
                      ? copy.retry
                      : copy.sign}{' '}
                  ↗
                </Button>
                {phase === 'error' && (
                  <p className="fw-caption">
                    {result?.signature ? copy.retrySigned : copy.retryBody}
                  </p>
                )}
              </>
            )}
            <TransactionState phase={phase} result={result} />
          </Card>
        )
      )}
      {error && (
        <ErrorNotice
          message={error.message}
          detail={error.detail}
          reference={jobId}
          onRetry={summary ? sign : () => setGeneration((n) => n + 1)}
        />
      )}
    </div>
  );
}
