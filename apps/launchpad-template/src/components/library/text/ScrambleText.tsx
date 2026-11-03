import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useCalm, useEntered } from '../motion/internal';

type TextTag = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'span' | 'div';

const DEFAULT_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$#%&@*+=<>/';

export interface ScrambleTextProps {
  /** The final string. Screen readers read it once, as plain text. */
  text: string;
  /** Element to render. Default `span`. */
  as?: TextTag;
  /** Total decode time, in milliseconds. Default 1100. */
  duration?: number;
  /** Glyphs shown while a letter is still scrambled. */
  glyphs?: string;
  /** When to play: on entering the screen, on hover/focus of the text, or both (default). */
  trigger?: 'view' | 'hover' | 'both';
  className?: string;
}

/**
 * Decoding text: every letter cycles through random glyphs and locks into place from left to right,
 * like a terminal resolving a hash. Fits tech-flavoured labels, a contract address teaser, a stat
 * caption or a whole headline ("$NAPS IS LIVE"). Best with a monospace or tabular font.
 */
export function ScrambleText({
  text,
  as: Tag = 'span',
  duration = 1100,
  glyphs = DEFAULT_GLYPHS,
  trigger = 'both',
  className,
}: ScrambleTextProps) {
  const host = useRef<HTMLElement>(null);
  const live = useRef<HTMLSpanElement>(null);
  const frame = useRef(0);
  const calm = useCalm();
  const entered = useEntered(host, { amount: 0.5 });

  const play = useCallback(() => {
    const el = live.current;
    if (!el || calm) return;
    cancelAnimationFrame(frame.current);
    const chars = Array.from(text);
    const pool = Array.from(glyphs);
    const start = performance.now();
    let lastSwap = 0;
    let scrambled = chars.map(() => '');
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // Letters lock in from left to right; the first 20% of the time is pure noise.
      const locked = Math.floor(Math.max(0, (t - 0.2) / 0.8) * chars.length);
      if (now - lastSwap > 45) {
        lastSwap = now;
        scrambled = chars.map((c) =>
          c.trim() ? (pool[Math.floor(Math.random() * pool.length)] ?? c) : c,
        );
      }
      el.textContent = chars.map((c, i) => (i < locked ? c : scrambled[i])).join('');
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else el.textContent = text;
    };
    frame.current = requestAnimationFrame(tick);
  }, [calm, duration, glyphs, text]);

  useEffect(() => {
    if (entered && trigger !== 'hover') play();
  }, [entered, trigger, play]);

  useEffect(() => {
    const el = live.current;
    if (calm && el) el.textContent = text;
    return () => cancelAnimationFrame(frame.current);
  }, [calm, text]);

  const onHover = trigger === 'view' ? undefined : play;

  return (
    <Tag
      ref={host as never}
      className={cn('fx-scramble relative inline-block', className)}
      onPointerEnter={onHover}
      onFocus={onHover}
    >
      <span className="sr-only">{text}</span>
      {/* The final text, invisible, reserves the size: scrambled glyphs never move the layout. */}
      <span aria-hidden="true" className="invisible">
        {text}
      </span>
      <span ref={live} aria-hidden="true" className="absolute inset-0 overflow-hidden">
        {text}
      </span>
    </Tag>
  );
}

export default ScrambleText;
