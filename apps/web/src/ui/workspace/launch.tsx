'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { OwnerTransactionSummary, TxPhase, TxResult } from '@forge/shared';
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
  readableError,
} from './components';
import { launchCopy as copy } from './content/launch';
import { common } from './content/common';

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
  const [summary, setSummary] = useState<OwnerTransactionSummary | null>(null),
    [error, setError] = useState(''),
    [phase, setPhase] = useState<TxPhase>(initialPhase),
    [result, setResult] = useState<TxResult | null>(null),
    [generation, setGeneration] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    if (holdLoading) return;
    let cancelled = false;
    setError('');
    void api
      .getOwnerTransactionSummary(jobId)
      .then((value) => {
        if (!cancelled) setSummary(value);
      })
      .catch((e) => {
        if (!cancelled) setError(readableError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, jobId, generation, holdLoading]);
  const sign = async () => {
    if (!summary || session?.wallet !== summary.ownerWallet || lock.current) return;
    lock.current = true;
    setError('');
    try {
      const next = await api.signOwnerTransaction(jobId, setPhase);
      setResult(next);
      setPhase(next.phase);
      if (next.phase === 'confirmed' && autoRedirect)
        router.replace(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (e) {
      setPhase('error');
      setError(readableError(e));
    } finally {
      lock.current = false;
    }
  };
  const busy = phase === 'awaiting_signature' || phase === 'sending';
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
            </div>
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
                      setError(readableError(e));
                    }
                  }}
                >
                  {copy.switch}
                </Button>
              </div>
            ) : phase === 'confirmed' ? (
              <>
                <h2>{copy.confirmed}</h2>
                <ActionLink href={`/jobs/${jobId}`}>{copy.track}</ActionLink>
              </>
            ) : (
              <>
                <Button disabled={busy} onClick={sign}>
                  {busy
                    ? phase === 'sending'
                      ? common.sending
                      : common.sign
                    : phase === 'error'
                      ? copy.retry
                      : copy.sign}{' '}
                  ↗
                </Button>
                {phase === 'error' && <p className="fw-caption">{copy.retryBody}</p>}
              </>
            )}
            <TransactionState phase={phase} result={result} />
          </Card>
        )
      )}
      {error && (
        <ErrorNotice message={error} onRetry={summary ? sign : () => setGeneration((n) => n + 1)} />
      )}
    </div>
  );
}
