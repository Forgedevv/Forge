'use client';
import Link from 'next/link';
import type { LaunchpadSpecDraft, SpecValidation } from '@forge/shared';
import { Address } from './components';
import { chatCopy as copy } from './content/chat';
import { common } from './content/common';
import { safeUrl } from './safe-url';

export function SpecSummary({
  spec,
  validation,
}: {
  spec: LaunchpadSpecDraft;
  validation: SpecValidation;
}) {
  const field = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
        spec,
      );
  return (
    <section aria-label={copy.summary}>
      <div className="fw-summary-heading">
        <h2>{copy.summary}</h2>
        <span className="fw-badge">{validation.complete ? copy.ready : copy.incomplete}</span>
      </div>
      <p className="fw-caption">{copy.summaryHint}</p>
      <dl className="fw-spec-fields">
        {Object.entries(copy.labels).map(([path, label]) => {
          const value = field(path),
            error = validation.errors[path];
          const color =
            path.endsWith('Color') && typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
              ? value
              : null;
          let display =
            value === undefined || value === ''
              ? copy.fieldPending
              : typeof value === 'boolean'
                ? value
                  ? common.yes
                  : common.no
                : String(value);
          if (typeof value === 'number') {
            if (path === 'tradingFeeBps') display = `${value / 100}%`;
            else if (path === 'coinCreatorSharePct') display = `${value}%`;
            else if (path.endsWith('Sol'))
              display = `${value.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`;
          }
          if (path === 'slug' && value) display = `${String(value)}.forgepads.xyz`;
          return (
            <div key={path} className={error ? 'fw-field-invalid' : ''}>
              <dt>{label}</dt>
              <dd aria-invalid={Boolean(error)}>
                {color ? (
                  <span className="fw-color-value">
                    <i style={{ backgroundColor: color }} />
                    {display}
                  </span>
                ) : path === 'ownerWallet' && typeof value === 'string' ? (
                  <Address value={value} />
                ) : path === 'launchpadCoin.imageUrl' &&
                  typeof value === 'string' &&
                  safeUrl(value) ? (
                  <Link href={safeUrl(value)!} target="_blank" rel="noreferrer">
                    {common.preview} ↗
                  </Link>
                ) : (
                  display
                )}
                {error && <small className="fw-field-error">{error}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
