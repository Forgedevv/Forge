'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { JobStatus, Quote, TxPhase } from '@forge/shared';
import type { PaymentResult, PendingPayment } from '@/client/types';
import { useWebClient } from './provider';
import {
  ActionLink,
  Address,
  Amount,
  Button,
  Card,
  ErrorNotice,
  Heading,
  Loading,
  QuoteCountdown,
  TransactionState,
  readableError,
} from './components';
import { paymentCopy as copy } from './content/payment';
import { common } from './content/common';

/** Statuses reached once the payment is confirmed (the job left `spec_ready`). */
const AWAITING_PAYMENT: ReadonlySet<JobStatus> = new Set(['spec_ready']);

/** A sent payment that is not settled: confirmation is retried, a new quote is never offered. */
function SentPaymentNotice({
  result,
  busy,
  onCheck,
}: {
  result: PaymentResult;
  busy: boolean;
  onCheck(): void;
}) {
  const api = useWebClient();
  const confirming = result.outcome === 'confirming';
  return (
    <div className={`fw-notice ${confirming ? '' : 'fw-notice-error'}`} role="status">
      <h2>{confirming ? copy.stillConfirming : copy.needsSupport}</h2>
      <p>{result.error ?? (confirming ? copy.stillConfirmingBody : copy.needsSupportBody)}</p>
      {result.signature && (
        <>
          <Address value={result.signature} label={copy.signature} />
          <Link href={api.explorerTxUrl(result.signature)} target="_blank" rel="noreferrer">
            {copy.explorer} ↗
          </Link>
        </>
      )}
      <div className="fw-actions">
        {confirming && (
          <Button disabled={busy} onClick={onCheck}>
            {busy ? copy.checking : copy.checkAgain}
          </Button>
        )}
        <Link href="/faq">{copy.support} ↗</Link>
      </div>
    </div>
  );
}

function pendingResult(pending: PendingPayment): PaymentResult {
  return {
    phase: 'error',
    signature: pending.signature,
    outcome: pending.outcome,
    error: pending.message ?? undefined,
  };
}

export function PaymentScreen({
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
    router = useRouter();
  const { job, loading } = api.useJob(jobId);
  // A payment already sent for this job (this tab): it is confirmed again, never paid twice.
  const [sent, setSent] = useState<PaymentResult | null>(() => {
    const pending = api.getPendingPayment(jobId);
    return pending ? pendingResult(pending) : null;
  });
  const [quote, setQuote] = useState<Quote | null>(null),
    [error, setError] = useState(''),
    [phase, setPhase] = useState<TxPhase>(initialPhase),
    [result, setResult] = useState<PaymentResult | null>(null),
    [expired, setExpired] = useState(false),
    [generation, setGeneration] = useState(0);
  const lock = useRef(false);
  const hasJob = Boolean(job);
  const paid = Boolean(job && !AWAITING_PAYMENT.has(job.status));
  const kind = job?.type === 'modify_launchpad' ? 'modification' : 'creation';

  const finish = useCallback(
    (next: PaymentResult) => {
      setResult(next);
      setPhase(next.phase);
      if (next.outcome && next.outcome !== 'confirmed' && next.outcome !== 'failed') setSent(next);
      else setSent(null);
      if (next.outcome === 'failed') setGeneration((n) => n + 1);
      if (next.phase === 'confirmed' && autoRedirect)
        router.replace(`/jobs/${encodeURIComponent(jobId)}`);
    },
    [autoRedirect, jobId, router],
  );

  const recheck = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setError('');
    try {
      finish(await api.resumePayment(jobId, setPhase));
    } catch (e) {
      setError(readableError(e));
    } finally {
      lock.current = false;
    }
  }, [api, finish, jobId]);

  // Resume the confirmation of a payment sent before this page was opened (e.g. a reload).
  const resumeOnMount = useRef(sent?.outcome === 'confirming');
  useEffect(() => {
    if (!resumeOnMount.current || holdLoading) return;
    resumeOnMount.current = false;
    void recheck();
  }, [holdLoading, recheck]);

  useEffect(() => {
    if (!hasJob || holdLoading || paid || sent) return;
    let cancelled = false;
    setQuote(null);
    setError('');
    setExpired(false);
    void api
      .getQuote(jobId, kind)
      .then((value) => {
        if (!cancelled) {
          setQuote(value);
          setExpired(Date.parse(value.expiresAt) <= Date.now());
        }
      })
      .catch((e) => {
        if (!cancelled) {
          const pending = api.getPendingPayment(jobId);
          if (pending) setSent(pendingResult(pending));
          else setError(readableError(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // `sent` only gates the request: settling a payment never asks for a quote by itself.
  }, [api, jobId, kind, generation, hasJob, holdLoading, paid]);

  const busy = phase === 'awaiting_signature' || phase === 'sending';
  const pay = async () => {
    if (!quote || lock.current || sent) return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setExpired(true);
      return;
    }
    lock.current = true;
    setError('');
    try {
      finish(await api.payQuote(quote, setPhase));
    } catch (e) {
      setError(readableError(e));
      setPhase('error');
      if (Date.parse(quote.expiresAt) <= Date.now()) setExpired(true);
    } finally {
      lock.current = false;
    }
  };
  const confirmedView = (
    <>
      <h2>{copy.paid}</h2>
      <ActionLink href={`/jobs/${jobId}`}>{copy.track}</ActionLink>
    </>
  );
  if (loading || holdLoading) return <Loading label={copy.loading} />;
  if (!job) return <ErrorNotice message={common.missing} />;
  if (!quote && !error && !sent && !paid) return <Loading label={copy.loading} />;
  return (
    <div className="fw-centered">
      <Heading eyebrow={copy.eyebrow} title={kind === 'creation' ? copy.title : copy.changeTitle}>
        {copy.body}
      </Heading>
      <Card className="fw-payment-card">
        {phase === 'confirmed' || (paid && !sent) ? (
          <>
            {quote && <Amount lamports={quote.lamports} usd={quote.usdAmount} large />}
            {confirmedView}
            <TransactionState phase={phase} result={result} />
          </>
        ) : sent ? (
          <>
            {busy ? (
              <p className="fw-caption" role="status">
                {copy.confirming}
              </p>
            ) : (
              <SentPaymentNotice result={sent} busy={busy} onCheck={() => void recheck()} />
            )}
            {busy && <TransactionState phase={phase} result={result} />}
          </>
        ) : (
          quote && (
            <>
              <p className="fw-eyebrow">
                {quote.kind === 'creation' ? common.creation : common.modification}
              </p>
              <Amount lamports={quote.lamports} usd={quote.usdAmount} large />
              <p>{kind === 'creation' ? copy.includes : copy.changeIncludes}</p>
              {expired && !busy && quote.lamports === '0' ? (
                <div className="fw-notice" role="status">
                  <h2>{copy.expired}</h2>
                  <Button
                    onClick={() => {
                      setPhase('idle');
                      setGeneration((n) => n + 1);
                    }}
                  >
                    {copy.fresh}
                  </Button>
                </div>
              ) : quote.lamports === '0' ? (
                <>
                  <p className="fw-notice">
                    {copy.included} {copy.includedBody}
                  </p>
                  <Button disabled={busy} onClick={pay}>
                    {copy.continue} ↗
                  </Button>
                </>
              ) : (
                <>
                  <div className="fw-quote-time">
                    <span>{copy.expires}</span>
                    <QuoteCountdown expiresAt={quote.expiresAt} onExpire={() => setExpired(true)} />
                  </div>
                  {expired && !busy ? (
                    <div className="fw-notice" role="status">
                      <h2>{copy.expired}</h2>
                      <p>{copy.expiredBody}</p>
                      <Button
                        onClick={() => {
                          setPhase('idle');
                          setGeneration((n) => n + 1);
                        }}
                      >
                        {copy.fresh}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="fw-caption">{copy.signing}</p>
                      <Button disabled={busy || expired} onClick={pay}>
                        {busy ? (phase === 'sending' ? common.sending : common.sign) : copy.pay} ↗
                      </Button>
                    </>
                  )}
                </>
              )}
              <TransactionState phase={phase} result={result} />
            </>
          )
        )}
        {error && <ErrorNotice message={error} onRetry={() => setGeneration((n) => n + 1)} />}
      </Card>
    </div>
  );
}
