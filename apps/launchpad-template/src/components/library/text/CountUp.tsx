import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useCalm, useEntered } from '../motion/internal';

export interface CountUpProps {
  /** Final value. */
  value: number;
  /** Starting value. Default 0. */
  from?: number;
  /** Seconds. Default 2. */
  duration?: number;
  /** Number format: `{ style: 'currency', currency: 'USD', notation: 'compact' }` gives "$4.2M". */
  format?: Intl.NumberFormatOptions;
  /** Locale of the format. Fixed by default so the server and the browser print the same string. */
  locale?: string;
  prefix?: string;
  suffix?: string;
  className?: string;
}

/**
 * A number that counts up quickly then settles softly (exponential ease out) when it scrolls into
 * view: "$12.4M volume", "48,920 holders", "1,284 coins launched". Any Intl format works (compact,
 * currency, percent). The final string reserves the width, so the line never jumps while counting.
 */
export function CountUp({
  value,
  from = 0,
  duration = 2,
  format,
  locale = 'en-US',
  prefix = '',
  suffix = '',
  className,
}: CountUpProps) {
  const host = useRef<HTMLSpanElement>(null);
  const live = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  const entered = useEntered(host, { amount: 0.6 });
  // Keyed on the content of `format`, so an inline object does not restart the count each render.
  const formatKey = JSON.stringify(format ?? {});
  const formatter = useMemo(() => new Intl.NumberFormat(locale, format), [locale, formatKey]);
  // Where the count currently stands: a new value counts on from here, not from `from` again.
  const current = useRef(from);
  const finalText = `${prefix}${formatter.format(value)}${suffix}`;
  const startText = `${prefix}${formatter.format(from)}${suffix}`;

  useEffect(() => {
    const el = live.current;
    if (!el) return;
    if (calm) {
      el.textContent = finalText;
      return;
    }
    if (!entered) return;
    let frame = 0;
    const start = performance.now();
    const origin = current.current;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / (duration * 1000));
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      // Written straight into the DOM: counting does not re-render React 60 times a second.
      current.current = origin + (value - origin) * eased;
      el.textContent = `${prefix}${formatter.format(current.current)}${suffix}`;
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [calm, entered, duration, formatter, value, prefix, suffix, finalText]);

  return (
    <span ref={host} className={cn('fx-count-up inline-grid tabular-nums', className)}>
      <span className="sr-only">{finalText}</span>
      {/* Both layers share one grid cell: the invisible final string holds the width. */}
      <span aria-hidden="true" className="invisible [grid-area:1/1]">
        {finalText}
      </span>
      <span ref={live} aria-hidden="true" className="text-right [grid-area:1/1]">
        {startText}
      </span>
    </span>
  );
}

export default CountUp;
