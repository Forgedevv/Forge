'use client';
import { useEffect, useState, type ReactNode } from 'react';
import type { GatingResponse } from '@forge/shared';
import { useWebClient } from './provider';
import { Button, Card, ErrorNotice, Heading, Loading, readableError } from './components';
import { gatingCopy as copy } from './content/gating';
import { FORGE_TOKEN_DECIMALS, formatTokenAmount } from './format';

/** A raw $FORGE amount of the gating answer, in whole tokens (display only). */
function forgeAmount(raw: string, decimals = FORGE_TOKEN_DECIMALS): string {
  return `${formatTokenAmount(raw, decimals)} ${copy.unit}`;
}

/** The wallet that passed the check in this tab (sessionStorage: gone when the tab closes). */
export const GATING_PASS_KEY = 'forge.gating.passed';

function readPass(wallet: string): boolean {
  if (!wallet) return false;
  try {
    return window.sessionStorage.getItem(GATING_PASS_KEY) === wallet;
  } catch {
    return false;
  }
}

function writePass(wallet: string | null) {
  try {
    if (wallet) window.sessionStorage.setItem(GATING_PASS_KEY, wallet);
    else window.sessionStorage.removeItem(GATING_PASS_KEY);
  } catch {
    // Storage unavailable (private mode): the check is simply shown again next time.
  }
}

/** No requirement to meet: the check is off (before $FORGE launches) or the amount is zero. */
export function gatingWaived(gating: GatingResponse | null): boolean {
  return Boolean(gating?.ok && (!gating.enabled || /^0+$/.test(gating.required)));
}

export function GatingScreen({ children }: { children?: ReactNode }) {
  const api = useWebClient();
  const { gating, loading, recheck } = api.useGating();
  const wallet = api.useSession().session?.wallet ?? '';
  // Passed earlier in this tab with this wallet: straight to the chat, no "Continue" every visit.
  const [remembered] = useState(() => readPass(wallet));
  const [continued, setContinued] = useState(false);
  const [error, setError] = useState('');
  const failed = gating !== null && !gating.ok;
  useEffect(() => {
    if (failed) writePass(null);
  }, [failed]);
  if (children) {
    if (gatingWaived(gating)) return children;
    // The server checks again on every message: a remembered pass only skips this screen.
    if (remembered && !failed && (loading || gating)) return children;
    if (gating?.ok && continued) return children;
  }
  if (loading) return <Loading label={copy.checking} />;
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
                <strong>{forgeAmount(gating.required, gating.decimals)}</strong>
              </div>
              <div>
                <span>{copy.balance}</span>
                <strong>{forgeAmount(gating.balance, gating.decimals)}</strong>
              </div>
            </div>
            {!gating.enabled && <p className="fw-notice">{copy.disabled}</p>}
            {gating.ok ? (
              <Button
                onClick={() => {
                  writePass(wallet);
                  setContinued(true);
                }}
              >
                {copy.continue}
              </Button>
            ) : (
              <>
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
                </div>
                {/* No official way to get $FORGE is published yet: say so, never a dead link. */}
                <p className="fw-caption fw-gating-soon">{copy.acquireSoon}</p>
              </>
            )}
          </>
        ) : (
          <ErrorNotice
            message={copy.unavailable}
            onRetry={() => void recheck().catch((e) => setError(readableError(e)))}
          />
        )}
        {error && <ErrorNotice message={error} />}
      </Card>
    </div>
  );
}
