'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LaunchpadSpec, LaunchpadSummary } from '@forge/shared';
import { useWebClient } from './provider';
import {
  ActionLink,
  Button,
  Card,
  ErrorNotice,
  Heading,
  Loading,
  readableError,
} from './components';
import { GatingScreen } from './gating';
import { SpecSummary } from './spec-summary';
import { StartAgainButton, StartAgainHold, draftNext, useStartAgain } from './start-again';
import { chatCopy as copy } from './content/chat';
import { common } from './content/common';
import { Muse } from '../muse';

export function NewScreen({ launchpadId }: { launchpadId?: string }) {
  const api = useWebClient();
  const { signupsPaused } = api.useFlags();
  const { launchpad, loading, refresh } = api.useLaunchpad(launchpadId ?? '');
  if (launchpadId && loading) return <Loading />;
  if (launchpadId && !launchpad) return <ErrorNotice message={common.missing} />;
  // A change can only be requested for a live launchpad: say why instead of opening the chat.
  if (launchpad && launchpad.status !== 'live') {
    return (
      <ChangeUnavailable launchpad={launchpad} signupsPaused={signupsPaused} refresh={refresh} />
    );
  }
  return signupsPaused && !launchpadId ? (
    <ErrorNotice message={common.paused} />
  ) : (
    <GatingScreen>
      <ChatScreen launchpadId={launchpadId} />
    </GatingScreen>
  );
}

/** The change chat of a launchpad that is not live: what it is waiting for, and the next step. */
export function ChangeUnavailable({
  launchpad,
  signupsPaused,
  refresh,
}: {
  launchpad: LaunchpadSummary;
  signupsPaused: boolean;
  /** Reloads the launchpad (after a refused "start again"). */
  refresh?: () => void;
}) {
  const restart = useStartAgain(launchpad.id, refresh);
  const next = draftNext(launchpad);
  const text = copy.unavailable;
  const [title, body] =
    launchpad.status === 'sleeping'
      ? [text.sleepingTitle, text.sleeping]
      : launchpad.status === 'disabled'
        ? [text.disabledTitle, text.disabled]
        : [text.draftTitle, next.kind === 'start_again' ? text.refunded : text.draft];
  const detailHref = `/launchpads/${encodeURIComponent(launchpad.id)}`;
  return (
    <>
      <Link className="fw-back" href={detailHref}>
        ← {text.details}
      </Link>
      <Heading eyebrow={copy.eyebrow} title={title}>
        {body}
      </Heading>
      <Card>
        <h2>{launchpad.name}</h2>
        {next.kind === 'on_hold' && <StartAgainHold reason={next.reason} />}
        {next.kind === 'start_again' && signupsPaused && (
          <p className="fw-notice" role="status">
            {common.paused}
          </p>
        )}
        <div className="fw-actions">
          {next.kind === 'start_again' && !signupsPaused && <StartAgainButton state={restart} />}
          {next.kind === 'continue' && <ActionLink href={next.href}>{common.continue}</ActionLink>}
          {launchpad.status === 'sleeping' && (
            <ActionLink href="/dashboard">{common.dashboard}</ActionLink>
          )}
          <ActionLink href={detailHref} secondary>
            {text.details}
          </ActionLink>
        </div>
        {restart.error && <ErrorNotice message={restart.error} />}
      </Card>
    </>
  );
}

/**
 * Why a change cannot be confirmed for this launchpad right now, or null when it can. Not loaded
 * yet counts as "not now" (empty message): the confirmation is only offered once it is known.
 */
function changeBlocked(
  launchpad: Pick<LaunchpadSummary, 'status' | 'activeJobId' | 'activeJobStatus'> | null,
): string | null {
  if (!launchpad) return '';
  if (launchpad.status !== 'live') {
    return launchpad.status === 'sleeping' ? copy.unavailable.sleeping : copy.unavailable.draft;
  }
  // A change awaiting payment is rewritten; one paid or further along blocks a new request.
  const status = launchpad.activeJobStatus;
  if (launchpad.activeJobId && status && status !== 'spec_ready') return copy.changeInProgress;
  return null;
}
export function ChatScreen({
  launchpadId,
  initialBusy = false,
  initialError = '',
}: {
  launchpadId?: string;
  initialBusy?: boolean;
  initialError?: string;
}) {
  const api = useWebClient(),
    router = useRouter();
  const chat = api.useChat({ launchpadId });
  const { launchpad } = api.useLaunchpad(launchpadId ?? '');
  const [text, setText] = useState(''),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(initialBusy);
  const lock = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  }, [chat.messages]);
  const lastAssistant = chat.messages.map((m) => m.role).lastIndexOf('assistant');
  const blocked = launchpadId ? changeBlocked(launchpad) : null;
  // Offered only when the server can accept it: a complete blueprint, a conversation, and for a
  // change a live launchpad with no other change in progress.
  const canConfirm =
    chat.validation.complete && !chat.streaming && Boolean(chat.conversationId) && blocked === null;
  const museMood = chat.streaming ? 'thinking' : text.trim() ? 'listening' : 'idle';
  const request = chat.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
  const confirm = async () => {
    if (lock.current || !canConfirm || !chat.conversationId) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = launchpadId
        ? await api.requestModification(launchpadId, chat.conversationId, request)
        : await api.confirmSpec(chat.conversationId, {
            ...chat.spec,
            version: 1,
            quote: 'SOL',
          } as LaunchpadSpec);
      router.push(`/jobs/${encodeURIComponent(result.jobId)}/pay`);
    } catch (e) {
      setError(readableError(e));
      setBusy(false);
    } finally {
      lock.current = false;
    }
  };
  return (
    <>
      <Heading eyebrow={copy.eyebrow} title={launchpadId ? copy.modifyTitle : copy.title}>
        {launchpadId ? copy.locked : copy.subtitle}
      </Heading>
      <div className="fw-studio-grid">
        <section className="fw-chat" aria-label={copy.title}>
          <div className="fw-messages" role="log" aria-live="polite" aria-relevant="additions text">
            {chat.messages.map((message, i) => (
              <article key={i} className={`fw-message fw-message-${message.role}`}>
                <span className="fw-message-author">
                  {message.role === 'assistant' && (
                    <Muse
                      size={28}
                      mood={i === lastAssistant ? museMood : 'idle'}
                      gaze={i === lastAssistant ? 'cursor' : 'none'}
                    />
                  )}
                  {message.role === 'assistant' ? copy.assistant : copy.user}
                </span>
                <p>{message.content || (chat.streaming ? copy.typing : '')}</p>
              </article>
            ))}
            <div ref={end} />
          </div>
          {chat.streaming && (
            <p className="fw-typing" role="status">
              <span />
              {copy.typing}
            </p>
          )}
          {chat.rateLimited && (
            <p className="fw-notice" role="status">
              {copy.limited}
            </p>
          )}
          {canConfirm && (
            // Next to the conversation, so the owner does not scroll the blueprint to confirm.
            <div className="fw-chat-ready" role="status">
              <p>
                <strong>{copy.ready}</strong>
                {copy.readyHint}
              </p>
              <Button disabled={busy} onClick={confirm}>
                {busy ? copy.confirming : launchpadId ? copy.confirmChange : copy.confirm} ↗
              </Button>
            </div>
          )}
          {blocked && chat.validation.complete && !chat.streaming && (
            <p className="fw-notice" role="status">
              {blocked}
            </p>
          )}
          <form
            className="fw-composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim() || chat.streaming || chat.rateLimited) return;
              setError('');
              try {
                chat.send(text.trim());
                setText('');
              } catch (failure) {
                setError(readableError(failure));
              }
            }}
          >
            <label className="fw-sr-only" htmlFor="chat-message">
              {copy.message}
            </label>
            <textarea
              id="chat-message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={launchpadId ? copy.modifyPlaceholder : copy.placeholder}
              rows={3}
              disabled={busy || chat.rateLimited}
            />
            <Button
              type="submit"
              disabled={!text.trim() || chat.streaming || chat.rateLimited || busy}
            >
              {copy.send}
              <span aria-hidden="true">↑</span>
            </Button>
          </form>
          {error && <ErrorNotice message={error} />}
        </section>
        <Card className="fw-summary">
          <details open>
            <summary>{copy.summary}</summary>
            {launchpadId ? (
              <section>
                <h2>{copy.request}</h2>
                <p className="fw-request-text">{request || copy.modifyPlaceholder}</p>
                <p className="fw-notice">{copy.locked}</p>
                <p>
                  {copy.included}: <strong>{launchpad?.includedModificationsLeft ?? '—'}</strong>
                </p>
              </section>
            ) : (
              <SpecSummary spec={chat.spec} validation={chat.validation} />
            )}
          </details>
          <div className="fw-summary-confirm">
            <p className="fw-caption">{copy.edit}</p>
            <Button disabled={!canConfirm || busy} onClick={confirm}>
              {busy ? copy.confirming : launchpadId ? copy.confirmChange : copy.confirm} ↗
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
