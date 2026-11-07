import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useCalm, useEntered } from '../motion/internal';

export interface TypewriterTextProps {
  /** Phrases typed in turn, then erased. One phrase types once and stays. */
  phrases: readonly string[];
  /** Milliseconds per typed character. Default 55. */
  typeSpeed?: number;
  /** Milliseconds per erased character. Default 28. */
  eraseSpeed?: number;
  /** Milliseconds a complete phrase stays before it is erased. Default 1600. */
  hold?: number;
  /** Caret shape. Default `bar`. */
  caret?: 'bar' | 'block' | 'underscore';
  /** What screen readers hear. Default: all phrases, comma separated. */
  srText?: string;
  className?: string;
}

const CSS = `
@keyframes fx-caret-blink { 0%, 45% { opacity: 1; } 55%, 100% { opacity: 0; } }
.fx-caret { animation: fx-caret-blink 1s steps(1) infinite; }
.fx-caret[data-typing='true'] { animation: none; }
@media (prefers-reduced-motion: reduce) { .fx-caret { animation: none; } }
`;

/**
 * Terminal-style typing: phrases are typed character by character behind a blinking caret, held,
 * erased and replaced. Fits a tech or retro launchpad: "> deploying $NAPS...", "> pool created",
 * "> trading live". The slot is sized for the longest phrase. Pauses off screen; shows the first
 * phrase, complete, for reduced motion.
 */
export function TypewriterText({
  phrases,
  typeSpeed = 55,
  eraseSpeed = 28,
  hold = 1600,
  caret = 'bar',
  srText,
  className,
}: TypewriterTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  const visible = useEntered(ref, { once: false, margin: '0px' });
  const [state, setState] = useState({ phrase: 0, length: 0, erasing: false });
  const first = phrases[0] ?? '';

  useEffect(() => {
    if (calm || !visible || phrases.length === 0) return;
    const phrase = phrases[state.phrase % phrases.length] ?? '';
    const single = phrases.length === 1;
    let delay = state.erasing ? eraseSpeed : typeSpeed;
    let next = state;
    if (!state.erasing && state.length < phrase.length) {
      next = { ...state, length: state.length + 1 };
    } else if (!state.erasing) {
      if (single) return;
      delay = hold;
      next = { ...state, erasing: true };
    } else if (state.length > 0) {
      next = { ...state, length: state.length - 1 };
    } else {
      delay = typeSpeed * 4;
      next = { phrase: (state.phrase + 1) % phrases.length, length: 0, erasing: false };
    }
    const id = window.setTimeout(() => setState(next), delay);
    return () => window.clearTimeout(id);
  }, [calm, visible, phrases, state, typeSpeed, eraseSpeed, hold]);

  const phrase = calm ? first : (phrases[state.phrase % Math.max(1, phrases.length)] ?? '');
  const typed = calm ? first : phrase.slice(0, state.length);
  const typing = !calm && state.length > 0 && state.length < phrase.length;
  const longest = phrases.reduce((a, b) => (b.length > a.length ? b : a), '');

  return (
    <>
      <style>{CSS}</style>
      <span ref={ref} className={cn('fx-typewriter inline-grid', className)}>
        <span className="sr-only">{srText ?? phrases.join(', ')}</span>
        {/* The longest phrase, invisible, reserves the size of the slot. */}
        <span aria-hidden="true" className="invisible whitespace-pre [grid-area:1/1]">
          {longest}
          {' '}
        </span>
        <span aria-hidden="true" className="whitespace-pre [grid-area:1/1]">
          {typed}
          <span
            className="fx-caret inline-block align-baseline"
            data-typing={typing}
            style={{
              width: caret === 'bar' ? '0.08em' : '0.6em',
              height: caret === 'underscore' ? '0.1em' : '1em',
              marginLeft: '0.06em',
              transform: caret === 'bar' ? 'translateY(0.12em)' : undefined,
              background: 'var(--color-accent)',
              opacity: caret === 'block' ? 0.85 : 1,
            }}
          />
        </span>
      </span>
    </>
  );
}

export default TypewriterText;
