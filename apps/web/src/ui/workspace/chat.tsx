'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LaunchpadSpec } from '@forge/shared';
import { useWebClient } from './provider';
import { Button, Card, ErrorNotice, Heading, Loading, readableError } from './components';
import { GatingScreen } from './gating';
import { SpecSummary } from './spec-summary';
import { chatCopy as copy } from './content/chat';
import { common } from './content/common';

export function NewScreen({ launchpadId }: { launchpadId?: string }) {
  const api = useWebClient();
  const { signupsPaused } = api.useFlags();
  const { launchpad, loading } = api.useLaunchpad(launchpadId ?? '');
  if (launchpadId && loading) return <Loading />;
  if (launchpadId && !launchpad) return <ErrorNotice message={common.missing} />;
  return signupsPaused && !launchpadId ? (
    <ErrorNotice message={common.paused} />
  ) : (
    <GatingScreen>
      <ChatScreen launchpadId={launchpadId} />
    </GatingScreen>
  );
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
  const request = chat.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
  const confirm = async () => {
    if (lock.current || !chat.validation.complete || !chat.conversationId || chat.streaming) return;
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
            <Button
              disabled={!chat.validation.complete || chat.streaming || busy}
              onClick={confirm}
            >
              {busy ? copy.confirming : launchpadId ? copy.confirmChange : copy.confirm} ↗
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
