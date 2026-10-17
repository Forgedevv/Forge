'use client';
import Link from 'next/link';

import {
  Component,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  JOB_STATUS_LABELS,
  type ClaimTransactionSummary,
  type Job,
  type Lamports,
  type TxPhase,
  type TxResult,
} from '@forge/shared';
import { useWebClient, useWorkspace } from './provider';
import { common } from './content/common';
import { jobCopy } from './content/job';
import { Muse, type MuseMood } from '../muse';
import { SupportLinks } from './support';
import { errorDetail, readableError } from './errors';
import { errorCopy } from './content/errors';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' }) {
  return (
    <button type="button" className={`fw-button fw-button-${variant} ${className}`} {...props} />
  );
}
/** A link to another site (opened in a new tab, marked ↗); anything else stays in the app. */
export function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//i.test(href);
}
export function ActionLink({
  href,
  children,
  secondary = false,
}: {
  href: string;
  children: ReactNode;
  secondary?: boolean;
}) {
  const className = `fw-button fw-button-${secondary ? 'secondary' : 'primary'}`;
  // ↗ only for another site; an action inside the workshop gets a plain arrow.
  return isExternalHref(href) ? (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  ) : (
    <Link className={className} href={href}>
      {children}
      <span aria-hidden="true">→</span>
    </Link>
  );
}
export function Heading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="fw-heading">
      <p className="fw-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`fw-card ${className}`}>{children}</section>;
}
export function Loading({ label = common.loading }: { label?: string }) {
  return (
    <div className="fw-loading" role="status" aria-label={label}>
      <span className="fw-spinner" />
      <p>{label}</p>
      <div className="fw-skeleton" />
      <div className="fw-skeleton fw-skeleton-short" />
    </div>
  );
}
/** The technical side of a failure, collapsed: for support, never in the message itself. */
export function ErrorDetails({
  detail,
  reference,
}: {
  detail?: string | null;
  reference?: string | null;
}) {
  if (!detail && !reference) return null;
  return (
    <details className="fw-error-details">
      <summary>{errorCopy.details}</summary>
      {reference && (
        <p>
          {errorCopy.reference}: <code>{reference}</code>
        </p>
      )}
      {detail && <code className="fw-wrap">{detail}</code>}
    </details>
  );
}
export function ErrorNotice({
  message,
  onRetry,
  reference,
  detail,
}: {
  message: string;
  onRetry?: () => void;
  /** The id the team needs to help (a job or launchpad id), quoted in the support message. */
  reference?: string | null;
  /** Technical detail of the failure, shown collapsed for support. */
  detail?: string | null;
}) {
  return (
    <div className="fw-notice fw-notice-error" role="alert">
      <p>{message}</p>
      <ErrorDetails detail={detail} reference={reference} />
      <div className="fw-actions">
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            {common.retry}
          </Button>
        )}
        <SupportLinks reference={reference} />
      </div>
    </div>
  );
}
export function Empty({
  title = common.empty,
  mood = 'idle',
  children,
}: {
  title?: string;
  mood?: MuseMood;
  children?: ReactNode;
}) {
  return (
    <Card className="fw-empty">
      <Muse className="fw-empty-muse" size={96} mood={mood} />
      <h2>{title}</h2>
      {children}
    </Card>
  );
}
export function StatusBadge({ job }: { job: Job }) {
  return <span className={`fw-badge fw-badge-${job.status}`}>{JOB_STATUS_LABELS[job.status]}</span>;
}
export function Amount({
  lamports,
  usd,
  large = false,
}: {
  lamports: Lamports;
  usd?: number;
  large?: boolean;
}) {
  const api = useWebClient();
  return (
    <div className={`fw-amount ${large ? 'fw-amount-large' : ''}`}>
      <strong>{api.formatSol(lamports)}</strong>
      {usd !== undefined && <span>{api.formatUsd(usd)}</span>}
    </div>
  );
}
export function Address({ value, label }: { value: string; label?: string }) {
  const api = useWebClient();
  const { toast } = useWorkspace();
  const [failed, setFailed] = useState(false);
  return (
    <div className="fw-address">
      {label && <span className="fw-muted">{label}</span>}
      <div>
        <code title={value}>{api.shortAddress(value)}</code>
        <Button
          variant="quiet"
          aria-label={`${common.copy} ${label ?? common.address}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              toast(common.copied);
            } catch {
              setFailed(true);
            }
          }}
        >
          {common.copy}
        </Button>
      </div>
      {failed && (
        <p role="status">
          {common.copyFailed}
          <code className="fw-wrap">{value}</code>
        </p>
      )}
    </div>
  );
}
export function TransactionState({ phase, result }: { phase: TxPhase; result?: TxResult | null }) {
  const api = useWebClient();
  const current =
    phase === 'awaiting_signature' ? 0 : phase === 'sending' ? 1 : phase === 'confirmed' ? 2 : -1;
  return (
    <div className="fw-transaction" aria-live="polite" aria-atomic="true">
      {current >= 0 && (
        <ol>
          {common.phases.map((label, i) => (
            <li
              key={label}
              aria-current={i === current ? 'step' : undefined}
              data-complete={i < current}
            >
              <span>{i < current ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}
      {phase === 'rejected' && <p className="fw-notice">{common.rejected}</p>}
      {phase === 'error' && <ErrorNotice message={result?.error ?? common.txError} />}
      {phase === 'confirmed' && result?.signature && (
        <Link href={api.explorerTxUrl(result.signature)} target="_blank" rel="noreferrer">
          {common.receipt} <span aria-hidden="true">↗</span>
        </Link>
      )}
    </div>
  );
}
export function QuoteCountdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?(): void }) {
  const [now, setNow] = useState(() => Date.now());
  const expiredOnce = useRef(false);
  const latest = useRef(onExpire);
  latest.current = onExpire;
  useEffect(() => {
    expiredOnce.current = false;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  useEffect(() => {
    if (seconds === 0 && !expiredOnce.current) {
      expiredOnce.current = true;
      latest.current?.();
    }
  }, [seconds]);
  return (
    <time
      className="fw-countdown"
      dateTime={expiresAt}
      aria-label={common.countdown(seconds)}
      data-urgent={seconds <= 15}
    >
      {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
    </time>
  );
}
export function JobStepTracker({ job }: { job: Job }) {
  const statuses =
    job.type === 'modify_launchpad'
      ? ['paid', 'building', 'preview_ready', 'approved', 'deploying', 'live']
      : [
          'paid',
          'building',
          'preview_ready',
          'approved',
          'onchain_setup',
          'awaiting_owner_signature',
          'deploying',
          'live',
        ];
  const labels =
    job.type === 'modify_launchpad'
      ? jobCopy.steps.filter((_, i) => i !== 4 && i !== 5)
      : jobCopy.steps;
  const effective =
    job.status === 'owner_signed'
      ? 'deploying'
      : job.status === 'failed' || job.status === 'refunded'
        ? job.failedStage === 'onchain'
          ? 'onchain_setup'
          : job.failedStage === 'deploy'
            ? 'deploying'
            : 'building'
        : job.status;
  const current = statuses.indexOf(effective);
  const failed = job.status === 'failed' || job.status === 'refunded';
  return (
    <ol className="fw-step-tracker" aria-label={jobCopy.progress}>
      {statuses.map((status, i) => (
        <li
          key={status}
          aria-current={i === current ? 'step' : undefined}
          data-complete={i < current || job.status === 'live'}
          data-failed={failed && i === current}
        >
          <span>
            {i < current || job.status === 'live'
              ? '✓'
              : failed && i === current
                ? '!'
                : String(i + 1).padStart(2, '0')}
          </span>
          <p>{labels[i]}</p>
        </li>
      ))}
    </ol>
  );
}
/** Claims are made pool by pool; this bounds one click (the server reports what is left). */
export const MAX_CLAIM_ROUNDS = 10;

interface ClaimReviewState {
  summary: ClaimTransactionSummary | null;
  decide(sign: boolean): void;
}

function claimedLamports(summary: ClaimTransactionSummary): Lamports {
  return (BigInt(summary.tradingFeesLamports) + BigInt(summary.poolCreationFeeLamports)).toString();
}

/** What one claim transaction collects and costs, shown before the wallet is asked to sign. */
function ClaimReview({ review }: { review: ClaimReviewState }) {
  const { summary } = review;
  return (
    <div className="fw-notice fw-claim-review" role="group" aria-label={common.claimReview}>
      {summary ? (
        <dl className="fw-review-list">
          <div>
            <dt>{common.claimAmount}</dt>
            <dd>
              <Amount lamports={claimedLamports(summary)} />
            </dd>
          </div>
          <div>
            <dt>{common.claimCost}</dt>
            <dd>
              <Amount lamports={summary.ownerCostLamports} />
            </dd>
          </div>
          {summary.remainingPools > 0 && (
            <div>
              <dt>{common.claimRemaining}</dt>
              <dd>{summary.remainingPools}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p>{common.claimNoSummary}</p>
      )}
      <p className="fw-caption">
        {summary && summary.remainingPools > 0 ? common.claimEachPool : common.claimToWallet}
      </p>
      <div className="fw-actions">
        <Button onClick={() => review.decide(true)}>{common.claimSign}</Button>
        <Button variant="quiet" onClick={() => review.decide(false)}>
          {common.cancel}
        </Button>
      </div>
    </div>
  );
}

export function ClaimButton({
  launchpadId,
  lamports,
  onSuccess,
  initialPhase = 'idle',
  amountKnown = true,
}: {
  launchpadId: string;
  lamports: Lamports;
  onSuccess?(): void;
  initialPhase?: TxPhase;
  /** False when the claimable amount could not be read: claiming is still offered. */
  amountKnown?: boolean;
}) {
  const api = useWebClient();
  const [phase, setPhase] = useState<TxPhase>(initialPhase);
  const [result, setResult] = useState<TxResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<ClaimReviewState | null>(null);
  const [claimed, setClaimed] = useState<{ lamports: Lamports | null; signature?: string }[]>([]);
  const [stalled, setStalled] = useState(false);
  const busy =
    preparing || review !== null || phase === 'awaiting_signature' || phase === 'sending';
  const nothing = amountKnown && lamports === '0';
  const lock = useRef(false);
  const claim = async () => {
    if (lock.current || nothing) return;
    lock.current = true;
    setStalled(false);
    setClaimed([]);
    const seenPools = new Set<string>();
    let confirmed = false;
    try {
      // One transaction per pool; each one is reviewed and signed on its own.
      for (let round = 1; round <= MAX_CLAIM_ROUNDS; round++) {
        setPreparing(true);
        let repeated = false;
        const next = await api.claimPartnerFees(launchpadId, setPhase, {
          review: (summary) =>
            new Promise<boolean>((resolve) => {
              setPreparing(false);
              // The same pool again: its fees are not refreshed yet, never claim it twice.
              if (summary && seenPools.has(summary.pool)) {
                repeated = true;
                resolve(false);
                return;
              }
              setReview({
                summary,
                decide: (sign) => {
                  setReview(null);
                  resolve(sign);
                },
              });
            }),
        });
        setPreparing(false);
        if (repeated) {
          setStalled(true);
          setPhase(confirmed ? 'confirmed' : 'idle');
          break;
        }
        if (next.phase === 'idle') {
          setPhase(confirmed ? 'confirmed' : 'idle');
          break;
        }
        setResult(next);
        setPhase(next.phase);
        if (next.phase !== 'confirmed') break;
        confirmed = true;
        const summary = next.summary ?? null;
        if (summary) seenPools.add(summary.pool);
        setClaimed((list) => [
          ...list,
          {
            lamports: summary ? claimedLamports(summary) : null,
            ...(next.signature ? { signature: next.signature } : {}),
          },
        ]);
        if (!summary || summary.remainingPools === 0) break;
      }
    } catch (error) {
      setPhase('error');
      setResult({ phase: 'error', error: readableError(error) });
    } finally {
      setPreparing(false);
      setReview(null);
      lock.current = false;
      if (confirmed) onSuccess?.();
    }
  };
  return (
    <div className="fw-claim">
      <p className="fw-caption">{common.claimExplanation}</p>
      {review ? (
        <ClaimReview review={review} />
      ) : (
        <Button disabled={nothing || busy || phase === 'confirmed'} onClick={claim}>
          {phase === 'confirmed'
            ? common.confirmed
            : preparing
              ? common.claimPreparing
              : busy
                ? phase === 'sending'
                  ? common.sending
                  : common.sign
                : nothing
                  ? common.noFees
                  : common.claim}
        </Button>
      )}
      {claimed.length > 0 && (
        <ol className="fw-claim-log" aria-label={common.claimLog}>
          {claimed.map((entry, i) => (
            <li key={entry.signature ?? i}>
              <span>
                {common.claimDone} {entry.lamports ? api.formatSol(entry.lamports) : ''}
              </span>
              {entry.signature && (
                <Link href={api.explorerTxUrl(entry.signature)} target="_blank" rel="noreferrer">
                  {common.receipt} <span aria-hidden="true">↗</span>
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
      {stalled && <p className="fw-caption">{common.claimStalled}</p>}
      <TransactionState phase={phase} result={result} />
    </div>
  );
}
export { describeError, readableError, type FriendlyError } from './errors';
export class ScreenBoundary extends Component<
  { children: ReactNode; onRetry(): void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    // A crash is a bug: a stable message, the error itself only in the details.
    return this.state.error ? (
      <ErrorNotice
        message={errorCopy.crash}
        detail={errorDetail(this.state.error)}
        onRetry={() => {
          this.props.onRetry();
          this.setState({ error: null });
        }}
      />
    ) : (
      this.props.children
    );
  }
}
