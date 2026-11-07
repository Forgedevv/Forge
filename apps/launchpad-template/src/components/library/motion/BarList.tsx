import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_EXPO, useCalm, useEntered } from './internal';

export interface BarListItem {
  /** Row name (coin symbol, wallet, category). */
  name: ReactNode;
  value: number;
  /** Text shown for the value. Default: the number in en-US format. */
  display?: string;
  /** Small element before the name (coin icon, rank). */
  icon?: ReactNode;
}

export interface BarListProps {
  items: readonly BarListItem[];
  /** Accessible name of the list, for example "Top coins by volume". */
  label: string;
  /** Value of a full bar. Default: the largest value. */
  max?: number;
  /** Milliseconds between two bars. Default 80. */
  stagger?: number;
  className?: string;
}

/**
 * A ranked list whose bars grow from the left one after the other when it scrolls into view, the
 * leader in the brand gradient and the others in a soft tint. For "Top coins by volume", the
 * biggest holders, fee shares or a leaderboard. Plain list markup: names and values are real text.
 */
export function BarList({ items, label, max, stagger = 80, className }: BarListProps) {
  const ref = useRef<HTMLOListElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.3 });
  const shown = calm || entered;
  const top = max ?? Math.max(1, ...items.map((item) => item.value));

  return (
    <ol
      ref={ref}
      aria-label={label}
      className={cn('fx-bar-list m-0 flex list-none flex-col gap-2 p-0', className)}
    >
      {items.map((item, i) => {
        const share = Math.max(0, Math.min(1, item.value / top));
        return (
          <li key={i} className="relative flex h-10 items-center justify-between gap-3 px-3">
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-full origin-left"
              style={{
                borderRadius: 'var(--radius)',
                transform: `scaleX(${shown ? share : 0})`,
                transition: calm ? 'none' : `transform 1.2s ${CSS_EASE_EXPO} ${i * stagger}ms`,
                background:
                  i === 0
                    ? 'linear-gradient(90deg, color-mix(in srgb, var(--color-primary) 55%, transparent), color-mix(in srgb, var(--color-accent) 45%, transparent))'
                    : 'color-mix(in srgb, var(--color-primary) 16%, transparent)',
              }}
            />
            <span className="relative flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--color-text)]">
              {item.icon}
              <span className="truncate">{item.name}</span>
            </span>
            <span className="relative shrink-0 text-sm tabular-nums text-[var(--color-text-muted)]">
              {item.display ?? item.value.toLocaleString('en-US')}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default BarList;
