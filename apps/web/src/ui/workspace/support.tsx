'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useWorkspace } from './provider';
import { supportCopy as copy } from './content/support';

/*
 * How a client reaches the FORGE team. Every channel is an optional public build-time variable:
 * NEXT_PUBLIC_SUPPORT_X_URL (an https://x.com/<handle> link, the primary channel),
 * NEXT_PUBLIC_SUPPORT_TELEGRAM_URL (an https://t.me/... link) and NEXT_PUBLIC_SUPPORT_EMAIL. The
 * screens show whichever is set, X first; an invalid value counts as unset. With none, they point
 * to the help page and to the channel of the beta invite.
 */

export interface SupportContact {
  x: string | null;
  telegram: string | null;
  email: string | null;
}

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * An X profile link (https on x.com or twitter.com, a single handle segment), normalised to
 * https://x.com/<handle>, or null.
 */
export function xUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !X_HOSTS.has(url.hostname)) return null;
    if (url.username || url.password || url.port) return null;
    const handle = url.pathname.replace(/^\/|\/$/g, '');
    if (!X_HANDLE_RE.test(handle)) return null;
    return `https://x.com/${handle}`;
  } catch {
    return null;
  }
}

const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me']);

/** A Telegram link (https on t.me or telegram.me, with a path), or null. */
export function telegramUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !TELEGRAM_HOSTS.has(url.hostname)) return null;
    if (url.username || url.password || url.port || url.pathname.length < 2) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Deliberately narrow: a value that could break the mailto: link is refused.
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

/** A plain email address, or null. */
export function supportEmail(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && value.length <= 254 && EMAIL_RE.test(value) ? value : null;
}

/** The configured contact. Next.js inlines the variables at build time. */
export function readSupportContact(
  env: { x?: string; telegram?: string; email?: string } = {
    x: process.env.NEXT_PUBLIC_SUPPORT_X_URL,
    telegram: process.env.NEXT_PUBLIC_SUPPORT_TELEGRAM_URL,
    email: process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
  },
): SupportContact {
  return {
    x: xUrl(env.x),
    telegram: telegramUrl(env.telegram),
    email: supportEmail(env.email),
  };
}

function hasChannel(contact: SupportContact): boolean {
  return Boolean(contact.x || contact.telegram || contact.email);
}

/** A mailto: link with the reference in the subject and the body. */
export function supportMailto(
  email: string,
  { reference, context = [], subject = copy.emailSubject }: SupportTopic = {},
): string {
  const lines = [...(reference ? [`${copy.emailReference}: ${reference}`] : []), ...context];
  const query = [
    `subject=${encodeURIComponent(reference ? `${subject} (${reference})` : subject)}`,
    ...(lines.length ? [`body=${encodeURIComponent(`${lines.join('\n')}\n\n`)}`] : []),
  ];
  return `mailto:${email}?${query.join('&')}`;
}

export interface SupportTopic {
  /** The id the team needs (a job id, a launchpad id). Shown with a copy button. */
  reference?: string | null;
  /** More lines for the email body (a transaction signature, a wallet). */
  context?: string[];
  subject?: string;
}

/** The contact links alone, for notices: whichever channel is set, else the help page. */
export function SupportLinks({
  reference,
  context,
  subject,
  fallback = true,
}: SupportTopic & {
  /** Link to the help page when no channel is set (false: render nothing). */
  fallback?: boolean;
}) {
  const contact = readSupportContact();
  if (!hasChannel(contact)) {
    return fallback ? <Link href="/faq#support">{copy.help}</Link> : null;
  }
  return (
    <>
      {contact.x && (
        <a href={contact.x} target="_blank" rel="noopener noreferrer">
          {copy.xShort} <span aria-hidden="true">↗</span>
        </a>
      )}
      {contact.telegram && (
        <a href={contact.telegram} target="_blank" rel="noopener noreferrer">
          {copy.telegramShort} <span aria-hidden="true">↗</span>
        </a>
      )}
      {contact.email && (
        <a href={supportMailto(contact.email, { reference, context, subject })}>
          {copy.emailShort} <span aria-hidden="true">↗</span>
        </a>
      )}
    </>
  );
}

/** A copyable reference: shortened on screen, complete in the copy and on failure. */
export function SupportReference({
  value,
  label = copy.reference,
}: {
  value: string;
  label?: string;
}) {
  const { toast } = useWorkspace();
  const [failed, setFailed] = useState(false);
  return (
    <div className="fw-support-reference">
      <span className="fw-muted">{label}</span>
      <div>
        <code title={value}>{value}</code>
        <button
          type="button"
          className="fw-button fw-button-quiet"
          aria-label={`${copy.copy} ${label.toLowerCase()}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              toast(copy.copied);
            } catch {
              setFailed(true);
            }
          }}
        >
          {copy.copy}
        </button>
      </div>
      {failed && <p role="status">{copy.copyFailed}</p>}
    </div>
  );
}

/** "Contact us": the configured channels and the reference to quote. */
export function SupportBlock({
  reference,
  context,
  subject,
  title = copy.title,
}: SupportTopic & { title?: string }) {
  const contact = readSupportContact();
  const configured = hasChannel(contact);
  const body = configured
    ? reference
      ? copy.body
      : copy.bodyNoReference
    : reference
      ? copy.fallback
      : copy.fallbackNoReference;
  return (
    <section className="fw-support" aria-label={title}>
      <h3>{title}</h3>
      <p>{body}</p>
      {reference && <SupportReference value={reference} />}
      <div className="fw-actions">
        {contact.x && (
          <a
            className="fw-button fw-button-secondary"
            href={contact.x}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.x}
            <span aria-hidden="true">↗</span>
          </a>
        )}
        {contact.telegram && (
          <a
            className="fw-button fw-button-secondary"
            href={contact.telegram}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.telegram}
            <span aria-hidden="true">↗</span>
          </a>
        )}
        {contact.email && (
          <a
            className="fw-button fw-button-secondary"
            href={supportMailto(contact.email, { reference, context, subject })}
          >
            {copy.email(contact.email)}
            <span aria-hidden="true">↗</span>
          </a>
        )}
        {!configured && <Link href="/faq#support">{copy.help}</Link>}
      </div>
    </section>
  );
}
