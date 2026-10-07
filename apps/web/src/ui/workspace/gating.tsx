'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useWebClient } from './provider';
import { Button, Card, ErrorNotice, Heading, Loading, readableError } from './components';
import { gatingCopy as copy } from './content/gating';

export function GatingScreen({ children }: { children?: ReactNode }) {
  const { gating, loading, recheck } = useWebClient().useGating();
  const [continued, setContinued] = useState(false);
  const [error, setError] = useState('');
  if (loading) return <Loading label={copy.checking} />;
  if (gating?.ok && continued && children) return children;
  return (
    <div className="fw-centered">
      <Heading eyebrow={copy.eyebrow} title={gating?.ok ? copy.ready : copy.title}>
        {copy.body}
      </Heading>
      <Card>
        {gating ? (
          <>
            <div className="fw-balance-grid">
              <div>
                <span>{copy.required}</span>
                <strong>{gating.required}</strong>
              </div>
              <div>
                <span>{copy.balance}</span>
                <strong>{gating.balance}</strong>
              </div>
            </div>
            <p className="fw-caption">{copy.units}</p>
            {!gating.enabled && <p className="fw-notice">{copy.disabled}</p>}
            {gating.ok ? (
              <Button onClick={() => setContinued(true)}>{copy.continue} ↗</Button>
            ) : (
              <div className="fw-actions">
                <Button
                  onClick={async () => {
                    setError('');
                    try {
                      await recheck();
                    } catch (e) {
                      setError(readableError(e));
                    }
                  }}
                >
                  {copy.recheck}
                </Button>
                <Link href="/faq#forge-access">{copy.acquire} ↗</Link>
              </div>
            )}
          </>
        ) : (
          <ErrorNotice
            message={copy.checking}
            onRetry={() => void recheck().catch((e) => setError(readableError(e)))}
          />
        )}
        {error && <ErrorNotice message={error} />}
      </Card>
    </div>
  );
}
