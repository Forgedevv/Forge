import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_BACK, useCalm, useEntered } from './internal';

export interface ArcGaugeProps {
  /** Value from 0 to 100. */
  value: number;
  /** Accessible name and caption, for example "Buy pressure". */
  label: string;
  /** Text shown (and announced) for the value. Default: the rounded percentage. */
  valueText?: string;
  /** Captions at both ends of the arc. Default "0%" and "100%". */
  minLabel?: string;
  maxLabel?: string;
  /** Number of segments in the arc. Default 28. */
  segments?: number;
  /** Width, in pixels (the height follows). Default 260. */
  width?: number;
  className?: string;
}

const CX = 100;
const CY = 100;

function polar(radius: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
}

/**
 * A speedometer-style half gauge: segments light up one after the other from the primary to the
 * accent colour while a needle swings to the value with a small overshoot. For a "hype meter",
 * buy/sell pressure, the bonding curve or a holder-distribution score. SVG and CSS transitions;
 * announced as a meter to screen readers.
 */
export function ArcGauge({
  value,
  label,
  valueText,
  minLabel = '0%',
  maxLabel = '100%',
  segments = 28,
  width = 260,
  className,
}: ArcGaugeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.5 });
  const pct = Math.max(0, Math.min(100, value));
  const shown = calm || entered ? pct : 0;
  const text = valueText ?? `${Math.round(pct)}%`;
  const gap = 1.4;
  const sweep = 180 / segments;

  return (
    <div
      ref={ref}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={text}
      className={cn('fx-arc-gauge inline-flex flex-col items-center', className)}
      style={{ width }}
    >
      <svg viewBox="0 0 200 112" className="w-full overflow-visible" aria-hidden="true">
        {Array.from({ length: segments }, (_, k) => {
          const start = 180 + k * sweep + gap / 2;
          const end = start + sweep - gap;
          const [x1, y1] = polar(84, start);
          const [x2, y2] = polar(84, end);
          const [x3, y3] = polar(66, end);
          const [x4, y4] = polar(66, start);
          const lit = ((k + 0.5) / segments) * 100 <= shown;
          const mix = segments > 1 ? Math.round((k / (segments - 1)) * 100) : 0;
          return (
            <path
              key={k}
              d={`M${x1} ${y1}A84 84 0 0 1 ${x2} ${y2}L${x3} ${y3}A66 66 0 0 0 ${x4} ${y4}Z`}
              style={{
                // Colours go through style: `var()` is not reliable in SVG presentation attributes.
                fill: lit
                  ? `color-mix(in srgb, var(--color-accent) ${mix}%, var(--color-primary))`
                  : 'var(--color-border)',
                transition: calm ? 'none' : `fill 0.35s ease-out ${lit ? k * 35 : 0}ms`,
              }}
            />
          );
        })}
        <g
          style={{
            transform: `rotate(${-90 + shown * 1.8}deg)`,
            transformOrigin: `${CX}px ${CY}px`,
            transition: calm ? 'none' : `transform 1.5s ${CSS_EASE_BACK}`,
          }}
        >
          <path
            d={`M${CX - 3} ${CY}L${CX} ${CY - 58}L${CX + 3} ${CY}Z`}
            style={{ fill: 'var(--color-text)' }}
          />
        </g>
        <circle
          cx={CX}
          cy={CY}
          r="7"
          strokeWidth="2"
          style={{ fill: 'var(--color-surface-raised)', stroke: 'var(--color-text)' }}
        />
        <text
          x="16"
          y="112"
          fontSize="9"
          textAnchor="middle"
          style={{ fill: 'var(--color-text-muted)' }}
        >
          {minLabel}
        </text>
        <text
          x="184"
          y="112"
          fontSize="9"
          textAnchor="middle"
          style={{ fill: 'var(--color-text-muted)' }}
        >
          {maxLabel}
        </text>
      </svg>
      <span
        className="mt-1 text-3xl font-semibold tabular-nums text-[var(--color-text)]"
        style={{ fontFamily: 'var(--font-heading)' }}
      >
        {text}
      </span>
      <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
        {label}
      </span>
    </div>
  );
}

export default ArcGauge;
