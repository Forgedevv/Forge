import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_BACK, useCalm, useEntered } from '../motion/internal';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export interface OdometerProps {
  value: number;
  /** Number format, for example `{ maximumFractionDigits: 1 }` or `{ notation: 'compact' }`. */
  format?: Intl.NumberFormatOptions;
  /** Locale of the format. Fixed by default so the server and the browser print the same string. */
  locale?: string;
  /** Text before and after the number, for example `$` and `+`. */
  prefix?: string;
  suffix?: string;
  /** Milliseconds per column, rolled right to left. Default 70. */
  stagger?: number;
  className?: string;
}

/**
 * A mechanical counter: each digit is a column of 0-9 that rolls to its value, right to left with a
 * slight overshoot, when it scrolls into view and every time the value changes. Columns are fixed
 * width (tabular figures), so nothing moves around it. For headline stats ("1,284 coins launched")
 * and live figures (market cap, holders).
 */
export function Odometer({
  value,
  format,
  locale = 'en-US',
  prefix = '',
  suffix = '',
  stagger = 70,
  className,
}: OdometerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.6 });
  const shown = calm || entered;
  const text = new Intl.NumberFormat(locale, format).format(value);
  const chars = Array.from(text);
  const digitCount = chars.filter((c) => c >= '0' && c <= '9').length;
  let seenDigits = 0;

  return (
    <span
      ref={ref}
      className={cn('fx-odometer inline-flex items-start tabular-nums', className)}
      // Every cell is exactly 1em tall with a line height of 1, so digits and signs line up.
      style={{ lineHeight: 1 }}
      data-state={shown ? 'shown' : 'hidden'}
    >
      <span className="sr-only">{`${prefix}${text}${suffix}`}</span>
      {prefix && <span aria-hidden="true">{prefix}</span>}
      {chars.map((c, i) => {
        // Keyed from the right, so units stay units when the number grows a digit.
        const key = chars.length - i;
        if (c < '0' || c > '9') {
          return (
            <span key={key} aria-hidden="true">
              {c}
            </span>
          );
        }
        const fromRight = digitCount - 1 - seenDigits++;
        const digit = shown ? Number(c) : 0;
        return (
          <span
            key={key}
            aria-hidden="true"
            className="relative inline-block overflow-hidden"
            style={{ height: '1em', lineHeight: 1 }}
          >
            {/* The real digit, invisible, sizes the column. */}
            <span className="invisible block">{c}</span>
            <span
              className="absolute inset-x-0 top-0 block"
              style={{
                transform: `translateY(${-digit}em)`,
                transition: calm ? 'none' : `transform 1.1s ${CSS_EASE_BACK}`,
                transitionDelay: calm ? undefined : `${fromRight * stagger}ms`,
              }}
            >
              {DIGITS.map((d) => (
                <span key={d} className="block text-center" style={{ height: '1em' }}>
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
      {suffix && <span aria-hidden="true">{suffix}</span>}
    </span>
  );
}

export default Odometer;
