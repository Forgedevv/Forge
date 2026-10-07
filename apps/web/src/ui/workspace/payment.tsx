'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Quote, TxPhase, TxResult } from '@forge/shared';
import { useWebClient } from './provider';
import {
  ActionLink,
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
  const [quote, setQuote] = useState<Quote | null>(null),
    [error, setError] = useState(''),
    [phase, setPhase] = useState<TxPhase>(initialPhase),
    [result, setResult] = useState<TxResult | null>(null),
    [expired, setExpired] = useState(false),
    [generation, setGeneration] = useState(0);
  const lock = useRef(false);
  const hasJob = Boolean(job);
  const kind = job?.type === 'modify_launchpad' ? 'modification' : 'creation';
  useEffect(() => {
    if (!hasJob || holdLoading) return;
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
        if (!cancelled) setError(readableError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, jobId, kind, generation, hasJob, holdLoading]);
  const busy = phase === 'awaiting_signature' || phase === 'sending';
  const pay = async () => {
    if (!quote || lock.current) return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setExpired(true);
      return;
    }
    lock.current = true;
    setError('');
    try {
      const next = await api.payQuote(quote, setPhase);
      setResult(next);
      setPhase(next.phase);
      if (next.phase === 'confirmed' && autoRedirect)
        router.replace(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (e) {
      setError(readableError(e));
      setPhase('error');
      if (Date.parse(quote.expiresAt) <= Date.now()) setExpired(true);
    } finally {
      lock.current = false;
    }
  };
  if (loading || (!quote && !error && job) || holdLoading) return <Loading label={copy.loading} />;
  if (!job) return <ErrorNotice message={common.missing} />;
  return (
    <div className="fw-centered">
      <Heading eyebrow={copy.eyebrow} title={kind === 'creation' ? copy.title : copy.changeTitle}>
        {copy.body}
      </Heading>
      <Card className="fw-payment-card">
        {quote && (
          <>
            <p className="fw-eyebrow">
              {quote.kind === 'creation' ? common.creation : common.modification}
            </p>
            <Amount lamports={quote.lamports} usd={quote.usdAmount} large />
            <p>{kind === 'creation' ? copy.includes : copy.changeIncludes}</p>
            {phase === 'confirmed' ? (
              <>
                <h2>{copy.paid}</h2>
                <ActionLink href={`/jobs/${jobId}`}>{copy.track}</ActionLink>
              </>
            ) : expired && !busy && quote.lamports === '0' ? (
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
        )}
        {error && <ErrorNotice message={error} onRetry={() => setGeneration((n) => n + 1)} />}
      </Card>
    </div>
  );
}
