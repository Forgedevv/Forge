import { useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_EXPO, cssSafeId, useCalm, useEntered } from './internal';

export interface ProgressRingProps {
  /** Progress from 0 to 100. */
  value: number;
  /** Accessible name, for example "Bonding curve progress". */
  label: string;
  /** Diameter, in pixels. Default 180. */
  size?: number;
  /** Ring thickness, in pixels. Default 12. */
  thickness?: number;
  /** Tick marks around the ring. Default true. */
  ticks?: boolean;
  /** Centre content. Default: the percentage, big, with the label below. */
  children?: ReactNode;
  className?: string;
}

/**
 * A circular gauge drawn in SVG: a primary-to-accent arc sweeps around a faint track up to the
 * value when it scrolls into view, with a glowing head and fine ticks. Made for the bonding curve
 * ("72% to graduation"), a presale-free "pool filled" meter or a holder goal. Announced as a
 * progress bar to screen readers.
 */
export function ProgressRing({
  value,
  label,
  size = 180,
  thickness = 12,
  ticks = true,
  children,
  className,
}: ProgressRingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = cssSafeId(useId());
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.5 });
  const pct = Math.max(0, Math.min(100, value));
  const shown = calm || entered ? pct : 0;
  // Geometry in viewBox units (0-100): stroke width, then a radius that leaves room for the ticks.
  const sw = (thickness / size) * 100;
  const r = 50 - sw / 2 - (ticks ? 6 : 1);
  const transition = calm
    ? 'none'
    : `stroke-dashoffset 1.6s ${CSS_EASE_EXPO}, transform 1.6s ${CSS_EASE_EXPO}`;

  return (
    <div
      ref={ref}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('fx-progress-ring relative inline-grid place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full -rotate-90"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${id}-grad`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--color-primary)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--color-accent)' }} />
          </linearGradient>
          <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth={sw}
          style={{ stroke: 'var(--color-border)' }}
        />
        {ticks &&
          Array.from({ length: 40 }, (_, i) => (
            <line
              key={i}
              x1="50"
              y1={1}
              x2="50"
              y2={i % 5 === 0 ? 4 : 2.5}
              style={{ stroke: 'var(--color-text-muted)' }}
              strokeOpacity={i % 5 === 0 ? 0.6 : 0.3}
              strokeWidth={0.5}
              transform={`rotate(${i * 9} 50 50)`}
            />
          ))}
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={`url(#${id}-grad)`}
          strokeWidth={sw}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="100 100"
          style={{ strokeDashoffset: 100 - shown, transition }}
        />
        {/* Glowing head, riding the end of the arc. */}
        <g
          style={{
            transform: `rotate(${shown * 3.6}deg)`,
            transformOrigin: '50px 50px',
            transition,
          }}
        >
          <circle
            cx={50 + r}
            cy="50"
            r={sw * 0.6}
            style={{ fill: 'var(--color-accent)' }}
            filter={`url(#${id}-glow)`}
            opacity={shown > 0 ? 0.9 : 0}
          />
        </g>
      </svg>
      <div className="relative flex flex-col items-center text-center">
        {children ?? (
          <>
            <span
              className="text-4xl font-semibold tabular-nums text-[var(--color-text)]"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              {Math.round(pct)}%
            </span>
            <span className="mt-1 max-w-[70%] text-xs text-[var(--color-text-muted)]">{label}</span>
          </>
        )}
      </div>
    </div>
  );
}

export default ProgressRing;
