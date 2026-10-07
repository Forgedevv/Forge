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
  type Job,
  type Lamports,
  type TxPhase,
  type TxResult,
} from '@forge/shared';
import { useWebClient, useWorkspace } from './provider';
import { common } from './content/common';
import { jobCopy } from './content/job';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' }) {
  return (
    <button type="button" className={`fw-button fw-button-${variant} ${className}`} {...props} />
  );
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
  return (
    <Link className={`fw-button fw-button-${secondary ? 'secondary' : 'primary'}`} href={href}>
      {children}
      <span aria-hidden="true">↗</span>
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
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="fw-notice fw-notice-error" role="alert">
      <p>{message}</p>
      <div className="fw-actions">
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            {common.retry}
          </Button>
        )}
        <Link href="/faq">{common.support} ↗</Link>
      </div>
    </div>
  );
}
export function Empty({
  title = common.empty,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <Card className="fw-empty">
      <span className="fw-orbit" aria-hidden="true">
        ✳
      </span>
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
          {common.receipt} ↗
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
export function ClaimButton({
  launchpadId,
  lamports,
  onSuccess,
  initialPhase = 'idle',
}: {
  launchpadId: string;
  lamports: Lamports;
  onSuccess?(): void;
  initialPhase?: TxPhase;
}) {
  const api = useWebClient();
  const [phase, setPhase] = useState<TxPhase>(initialPhase);
  const [result, setResult] = useState<TxResult | null>(null);
  const busy = phase === 'awaiting_signature' || phase === 'sending';
  const lock = useRef(false);
  return (
    <div>
      <p className="fw-caption">{common.claimExplanation}</p>
      <Button
        disabled={lamports === '0' || busy || phase === 'confirmed'}
        onClick={async () => {
          if (lock.current || lamports === '0') return;
          lock.current = true;
          try {
            const next = await api.claimPartnerFees(launchpadId, setPhase);
            setResult(next);
            setPhase(next.phase);
            if (next.phase === 'confirmed') onSuccess?.();
          } catch (error) {
            setPhase('error');
            setResult({ phase: 'error', error: readableError(error) });
          } finally {
            lock.current = false;
          }
        }}
      >
        {phase === 'confirmed'
          ? common.confirmed
          : busy
            ? phase === 'sending'
              ? common.sending
              : common.sign
            : lamports === '0'
              ? common.noFees
              : common.claim}
      </Button>
      <TransactionState phase={phase} result={result} />
    </div>
  );
}
export function readableError(error: unknown) {
  return error instanceof Error ? error.message : common.error;
}
export class ScreenBoundary extends Component<
  { children: ReactNode; onRetry(): void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <ErrorNotice
        message={this.state.error.message}
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
