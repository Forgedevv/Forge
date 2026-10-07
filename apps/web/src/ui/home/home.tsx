'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Flags } from '@forge/shared';
import type { ExperienceHandle } from './engine';
import { homeContent as copy } from './content';
import Link from 'next/link';
import { useWorkspace } from '../workspace/provider';
import './home.css';

export function ForgeMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="m18 2-3 10H6l8 7-3 11 15-17H16l2-11Z" fill="currentColor" />
    </svg>
  );
}

function Arrow({ direction = 'diagonal' }: { direction?: 'down' | 'diagonal' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="forge-arrow">
      <path
        d={direction === 'down' ? 'M12 3v17m-7-7 7 7 7-7' : 'M5 19 19 5M5 5h14v14'}
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function PilotIllustration() {
  return (
    <svg viewBox="0 0 300 340" className="forge-pilot" aria-hidden="true">
      <ellipse cx="152" cy="315" rx="72" ry="9" fill="currentColor" opacity=".12" />
      <g transform="rotate(-9 150 170)">
        <path
          d="m112 243-9 47h37l10-49m24-2 8 48h35l-19-53"
          fill="var(--forge-ember)"
          stroke="var(--forge-ink)"
          strokeWidth="4"
        />
        <path
          d="M102 150c-35 7-47 54-35 64 16 7 21-29 38-23m90-38c36 4 51 38 40 55-12 12-26-16-37-18"
          fill="var(--forge-pilot-shell)"
          stroke="var(--forge-ink)"
          strokeWidth="4"
        />
        <path
          d="M150 129c-45 0-62 36-59 75s24 55 60 55 61-16 64-55-20-75-65-75Z"
          fill="var(--forge-pilot-shell)"
          stroke="var(--forge-ink)"
          strokeWidth="4"
        />
        <rect
          x="82"
          y="67"
          width="138"
          height="103"
          rx="35"
          fill="var(--forge-pilot-shell)"
          stroke="var(--forge-ink)"
          strokeWidth="4"
        />
        <rect x="94" y="102" width="114" height="43" rx="16" fill="var(--forge-ink)" />
        <rect x="119" y="115" width="12" height="18" rx="6" fill="var(--forge-acid)" />
        <rect x="171" y="115" width="12" height="18" rx="6" fill="var(--forge-acid)" />
        <path d="m183 67 10-30" stroke="var(--forge-ember)" strokeWidth="9" />
        <circle
          cx="195"
          cy="31"
          r="12"
          fill="var(--forge-acid)"
          stroke="var(--forge-ink)"
          strokeWidth="3"
        />
        <rect x="132" y="187" width="38" height="40" rx="9" fill="var(--forge-ember)" />
        <path d="m154 193-13 16h10l-6 13 17-18h-11Z" fill="var(--forge-ivory)" />
        <path d="M55 198v-66" stroke="var(--forge-ink)" strokeWidth="10" />
        <rect
          x="27"
          y="115"
          width="59"
          height="28"
          rx="7"
          fill="var(--forge-ember)"
          stroke="var(--forge-ink)"
          strokeWidth="3"
        />
      </g>
    </svg>
  );
}

export function ProductDetails({ onConnect }: { onConnect?: () => void }) {
  return (
    <div className="forge-details-content">
      <p className="forge-eyebrow">{copy.details.eyebrow}</p>
      <h2>{copy.details.title}</h2>
      <p className="forge-detail-intro">{copy.details.intro}</p>
      <ol className="forge-steps">
        {copy.details.steps.map((step, i) => (
          <li key={step.title}>
            <span>{String(i + 1).padStart(2, '0')}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="forge-price">
        <p className="forge-eyebrow">{copy.details.priceLabel}</p>
        <p className="forge-price-value">
          {copy.details.price}
          <small>{copy.details.priceUnit}</small>
        </p>
        <p>{copy.details.priceDescription}</p>
      </div>
      <div className="forge-example">
        <div className="forge-example-art" aria-hidden="true">
          <ForgeMark />
          <span>{copy.details.exampleTitle}</span>
          <i />
          <i />
          <i />
        </div>
        <p className="forge-eyebrow">{copy.details.exampleBadge}</p>
        <h3>{copy.details.exampleTitle}</h3>
        <p>{copy.details.exampleDescription}</p>
      </div>
      <section className="forge-faq">
        <h3>{copy.details.faqTitle}</h3>
        {copy.details.questions.map((item) => (
          <details key={item.question}>
            <summary>
              {item.question}
              <span aria-hidden="true">+</span>
            </summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </section>
      {onConnect && (
        <button className="forge-solid-button" onClick={onConnect}>
          {copy.connect}
          <Arrow />
        </button>
      )}
      <a className="forge-text-link" href="/terms">
        {copy.terms}
        <Arrow />
      </a>
    </div>
  );
}

function Manifesto({ paused }: { paused: boolean }) {
  const [group, setGroup] = useState(0);
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(
      () => setGroup((previous) => (previous + 1) % copy.manifesto.length),
      6200,
    );
    return () => window.clearInterval(timer);
  }, [paused]);
  return (
    <div className="forge-manifesto" key={group} aria-hidden="true">
      {copy.manifesto[group]!.map((line, lineIndex) => (
        <p key={line} style={{ '--line': lineIndex } as CSSProperties}>
          {Array.from(line).map((letter, i) => (
            <span key={i} style={{ '--letter': i } as CSSProperties}>
              {letter === ' ' ? '\u00a0' : letter}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

export function ForgeHome({ flags: suppliedFlags }: { flags?: Flags }) {
  const workspace = useWorkspace();
  const clientFlags = workspace.client.useFlags();
  const { session, disconnect } = workspace.client.useSession();
  const flags = suppliedFlags ?? clientFlags;
  const root = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const engine = useRef<ExperienceHandle | null>(null);
  const pausedRef = useRef(false),
    skipRequested = useRef(false);
  const panelOpen = useRef(false);
  const [chapter, setChapter] = useState(0),
    [intro, setIntro] = useState(true);
  const [paused, setPaused] = useState(false),
    [simple, setSimple] = useState(false);
  const [panel, setPanel] = useState<'details' | 'connect' | null>(null);
  const [rendererFailed, setRendererFailed] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) {
      setPreferencesReady(true);
      return;
    }
    const apply = () => {
      pausedRef.current = media.matches;
      setPaused(media.matches);
    };
    apply();
    setPreferencesReady(true);
    media.addEventListener?.('change', apply);
    return () => media.removeEventListener?.('change', apply);
  }, []);
  useEffect(() => {
    if (simple || !preferencesReady || !stage.current) return;
    const element = stage.current;
    let cancelled = false,
      handle: ExperienceHandle | null = null;
    const fallback = () => {
      if (!cancelled) {
        setRendererFailed(true);
        setSimple(true);
        setIntro(false);
      }
    };
    const timeout = window.setTimeout(fallback, 12000);
    void import('./engine')
      .then(({ createExperience }) => {
        if (cancelled) return;
        handle = createExperience(element, {
          paused: pausedRef.current || panelOpen.current,
          onChapter: (value) => {
            if (!cancelled) setChapter(value);
          },
          onProgress: (value, progress) => {
            root.current?.style.setProperty('--journey-progress', String(value / 5));
            root.current?.style.setProperty('--intro-progress', String(progress));
          },
          onIntroDone: () => {
            if (!cancelled) setIntro(false);
          },
          onFailure: fallback,
        });
        engine.current = handle;
        handle.setInteractive(!panelOpen.current);
        if (skipRequested.current) handle.skipIntro();
        window.clearTimeout(timeout);
      })
      .catch(fallback);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      handle?.dispose();
      if (engine.current === handle) engine.current = null;
    };
  }, [simple, preferencesReady]);
  useEffect(() => {
    pausedRef.current = paused;
    engine.current?.setPaused(paused || panel !== null);
  }, [paused, panel]);
  useEffect(() => {
    panelOpen.current = panel !== null;
    engine.current?.setInteractive(panel === null);
  }, [panel]);
  useEffect(() => {
    const modal = dialog.current;
    if (!panel || !modal) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.showModal();
    return () => {
      modal.close();
      previousFocus?.focus();
    };
  }, [panel]);

  const navigate = (next: number, duration = 2) => {
    const value = Math.max(0, Math.min(5, next));
    if (engine.current) engine.current.goTo(next, duration);
    else setChapter(value);
    stage.current?.focus({ preventScroll: true });
  };
  const skipIntro = () => {
    skipRequested.current = true;
    setIntro(false);
    engine.current?.skipIntro();
  };
  const openDetails = () => {
    skipIntro();
    setPanel('details');
  };
  const openConnection = () => {
    skipIntro();
    if (workspace.available) {
      if (session) workspace.navigate('/new');
      else workspace.openLogin();
      return;
    }
    setPanel('connect');
  };
  const showSimple = () => {
    skipIntro();
    setSimple(true);
  };
  const content = copy.chapters[chapter]!;

  return (
    <div
      ref={root}
      className="forge-home"
      data-chapter={chapter}
      data-paused={paused}
      data-simple={simple}
      data-intro={intro && !simple}
    >
      <header className="forge-header">
        <a className="forge-brand" href="/" aria-label={copy.brand}>
          <ForgeMark />
          <span>{copy.brand}</span>
        </a>
        <div className="forge-header-actions">
          {session && (
            <details className="forge-account">
              <summary>
                <span aria-hidden="true">◒</span> {workspace.client.shortAddress(session.wallet)}
              </summary>
              <div>
                <Link href="/dashboard">{copy.dashboard}</Link>
                <button onClick={() => void disconnect()}>{copy.disconnect}</button>
              </div>
            </details>
          )}
          <button className="forge-details-link" onClick={openDetails}>
            {copy.menu}
            <span aria-hidden="true">+</span>
          </button>
          <button
            className="forge-launch-button"
            onClick={openConnection}
            disabled={flags.signupsPaused}
          >
            {copy.create}
            <Arrow />
          </button>
        </div>
      </header>
      {flags.signupsPaused && (
        <p className="forge-paused-banner" role="status">
          {copy.paused}
        </p>
      )}
      {!simple ? (
        <main ref={stage} className="forge-stage" tabIndex={0} aria-label={copy.navigation}>
          <div className="forge-scene-copy" key={chapter}>
            <p className="forge-scene-eyebrow">{content.eyebrow}</p>
            <div className={`forge-chapter-title forge-title-${chapter}`}>
              {chapter === 0 ? <h1>{content.title}</h1> : <h2>{content.title}</h2>}
              {(chapter === 0 || chapter === 5) && <p>{content.description}</p>}
              {chapter === 5 && (
                <button
                  className="forge-final-action"
                  onClick={openConnection}
                  disabled={flags.signupsPaused}
                >
                  {copy.connect}
                  <Arrow />
                </button>
              )}
            </div>
            {chapter === 4 && <Manifesto paused={paused} />}
          </div>
          <div className="forge-side-note" aria-hidden="true">
            <span>{copy.platform}</span>
            <span>{String(chapter + 1).padStart(2, '0')} — 06</span>
          </div>
          <p className="forge-subtitle" key={`subtitle-${chapter}`}>
            {content.subtitle}
          </p>
          {chapter === 0 && (
            <button className="forge-scroll" onClick={() => navigate(1, 1)}>
              <span>{copy.scroll}</span>
              <Arrow direction="down" />
            </button>
          )}
          {chapter > 0 && (
            <div className="forge-chapter-arrows">
              <button onClick={() => navigate(chapter - 1)} aria-label={copy.previous}>
                ←
              </button>
              <button
                onClick={() => navigate(chapter === 5 ? 0 : chapter + 1)}
                aria-label={chapter === 5 ? copy.restart : copy.next}
              >
                →
              </button>
            </div>
          )}
          <p className="forge-sr-only" aria-live="polite" aria-atomic="true">
            {copy.chapterNames[chapter]}
          </p>
        </main>
      ) : (
        <main className="forge-simple">
          {rendererFailed && (
            <p className="forge-fallback-status" role="status">
              {copy.fallback}
            </p>
          )}
          <section className="forge-simple-hero">
            <div>
              <p className="forge-eyebrow">{copy.chapters[0].eyebrow}</p>
              <h1>{copy.chapters[0].title}</h1>
              <p>{copy.chapters[0].description}</p>
              <button
                className="forge-solid-button"
                onClick={openConnection}
                disabled={flags.signupsPaused}
              >
                {copy.connect}
                <Arrow />
              </button>
            </div>
            <PilotIllustration />
          </section>
          {copy.chapters.slice(1, 5).map((item, index) => (
            <section className="forge-simple-chapter" key={item.title}>
              <span className="forge-simple-number" aria-hidden="true">
                {String(index + 2).padStart(2, '0')}
              </span>
              <div>
                <p className="forge-eyebrow">{item.eyebrow}</p>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
              </div>
            </section>
          ))}
          <section className="forge-simple-final">
            <p className="forge-eyebrow">{copy.chapters[5].eyebrow}</p>
            <h2>{copy.chapters[5].title}</h2>
            <p>{copy.chapters[5].description}</p>
            <button
              className="forge-solid-button"
              onClick={openConnection}
              disabled={flags.signupsPaused}
            >
              {copy.connect}
              <Arrow />
            </button>
          </section>
          <ProductDetails onConnect={flags.signupsPaused ? undefined : openConnection} />
        </main>
      )}
      <footer className="forge-footer">
        {!simple && (
          <nav className="forge-timeline" aria-label={copy.navigation}>
            {copy.chapterNames.map((name, i) => (
              <button
                key={name}
                aria-label={`${String(i + 1).padStart(2, '0')} — ${name}`}
                aria-current={chapter === i ? 'step' : undefined}
                onClick={() => navigate(i)}
              >
                <span />
                <span className="forge-timeline-tooltip">{name}</span>
              </button>
            ))}
          </nav>
        )}
        <span className="forge-footer-chapter">{copy.chapterNames[chapter]}</span>
        <div className="forge-footer-tools">
          {!simple && (
            <button
              className="forge-motion-button"
              onClick={() => setPaused(!paused)}
              aria-label={paused ? copy.motionOff : copy.motionOn}
              aria-pressed={paused}
            >
              <span aria-hidden="true">{paused ? '▷' : 'Ⅱ'}</span>
            </button>
          )}
          <button
            onClick={
              simple
                ? () => {
                    setRendererFailed(false);
                    setSimple(false);
                  }
                : showSimple
            }
          >
            {simple ? copy.immersive : copy.simpler}
          </button>
          <a href="/faq">{copy.faq}</a>
          <a href="/terms">{copy.terms}</a>
          <span className="forge-copyright">{copy.copyright}</span>
        </div>
      </footer>
      {intro && !simple && (
        <div className="forge-intro">
          <div className="forge-intro-top">
            <span>{copy.loading}</span>
            <ForgeMark />
          </div>
          <div className="forge-intro-logo">
            {Array.from(copy.brand).map((letter, index) => (
              <span key={index}>{letter}</span>
            ))}
          </div>
          <p>{copy.ignition}</p>
          <div className="forge-intro-progress">
            <span />
          </div>
          <button onClick={skipIntro}>
            {copy.skip}
            <Arrow />
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        className="forge-dialog"
        aria-labelledby={panel === 'details' ? 'forge-details-label' : 'forge-connect-label'}
        onCancel={(event) => {
          event.preventDefault();
          setPanel(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPanel(null);
        }}
      >
        <div className="forge-dialog-sheet">
          <div className="forge-dialog-heading">
            <span id="forge-details-label">
              {copy.brand} / {copy.menu}
            </span>
            <button onClick={() => setPanel(null)} aria-label={copy.close}>
              ×
            </button>
          </div>
          {panel === 'details' ? (
            <ProductDetails
              onConnect={flags.signupsPaused ? undefined : () => setPanel('connect')}
            />
          ) : (
            <div className="forge-connect-content">
              <ForgeMark />
              <p className="forge-eyebrow">{copy.connection.eyebrow}</p>
              <h2 id="forge-connect-label">{copy.connection.title}</h2>
              <p>{copy.connection.description}</p>
              <button className="forge-solid-button" onClick={() => setPanel('details')}>
                {copy.connection.action}
                <Arrow />
              </button>
            </div>
          )}
        </div>
      </dialog>
    </div>
  );
}
