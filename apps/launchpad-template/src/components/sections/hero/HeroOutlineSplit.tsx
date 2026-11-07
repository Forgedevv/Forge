import { motion, useAnimationFrame, useMotionValue } from 'motion/react';
import { useRef, useState } from 'react';
import { content } from '@/content';
import { useCalm, useEntered } from '@/components/library/motion/internal';
import { MaskLines } from '@/components/library/text/MaskLines';
import { cn } from '@/lib/utils';
import {
  Eyebrow,
  HEADING_FONT,
  HeroActions,
  MUTED,
  Section,
  heroCopy,
  type HeroCopy,
  type ValueItem,
} from '../shared';

export interface HeroOutlineSplitProps extends HeroCopy {
  /** Selling points scrolling up the right column. Default: `content.values`. */
  points?: readonly ValueItem[];
  /** Drift speed of the column, in pixels per second. Default 28. */
  speed?: number;
}

const LAPS = 3;

/**
 * A column of selling points drifting upwards in a seamless loop. Stops on hover and focus, has a
 * pause button, and becomes a plain scrollable list without motion.
 */
function VerticalTicker({
  points,
  label,
  speed,
}: {
  points: readonly ValueItem[];
  label: string;
  speed: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const calm = useCalm();
  const visible = useEntered(box, { once: false, margin: '100px' });
  const [paused, setPaused] = useState(false);
  const hold = useRef(false);
  const y = useMotionValue(0);

  useAnimationFrame((_, delta) => {
    const el = track.current;
    if (calm || paused || hold.current || !visible || !el) return;
    // Three laps: the visible one and two copies, so the box never shows an empty tail.
    const lap = el.offsetHeight / LAPS;
    if (lap <= 0) return;
    let next = y.get() - (speed * Math.min(delta, 50)) / 1000;
    if (next <= -lap) next += lap;
    y.set(next);
  });

  const list = (copy: boolean) => (
    <ul aria-hidden={copy || undefined} inert={copy || undefined} className="flex flex-col">
      {points.map((point, index) => (
        <li
          key={`${point.title}-${index}`}
          className="border-b border-[var(--color-border)] py-[clamp(1.25rem,3vw,2rem)]"
        >
          <span className="font-mono text-xs text-[var(--color-primary)]">
            {String(index + 1).padStart(2, '0')}
          </span>
          <p className={cn(HEADING_FONT, 'mt-2 text-[clamp(1.5rem,2.6vw,2.2rem)] leading-tight')}>
            {point.title}
          </p>
          <p className={cn(MUTED, 'mt-2 max-w-[36ch] text-sm leading-relaxed')}>{point.body}</p>
        </li>
      ))}
    </ul>
  );

  return (
    <div
      ref={box}
      role="region"
      aria-label={label}
      className="relative h-[clamp(20rem,62vh,36rem)] border-t border-[var(--color-border)] md:border-l md:border-t-0 md:pl-[clamp(1.5rem,3vw,2.5rem)]"
    >
      {calm ? (
        <div className="h-full overflow-y-auto">{list(false)}</div>
      ) : (
        <div
          className="h-full overflow-hidden [mask-image:linear-gradient(transparent,#000_14%,#000_86%,transparent)]"
          onPointerEnter={() => {
            hold.current = true;
          }}
          onPointerLeave={() => {
            hold.current = false;
          }}
          onFocus={() => {
            hold.current = true;
          }}
          onBlur={() => {
            hold.current = false;
          }}
        >
          <motion.div ref={track} style={{ y }}>
            {list(false)}
            {list(true)}
            {list(true)}
          </motion.div>
        </div>
      )}
      {calm ? null : (
        <button
          type="button"
          aria-pressed={paused}
          aria-label={paused ? `Play ${label}` : `Pause ${label}`}
          onClick={() => setPaused((value) => !value)}
          className="absolute bottom-2 right-0 grid h-8 w-8 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] transition hover:border-[var(--color-primary)]"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
            {paused ? <path d="M4 2.5v11l9-5.5z" /> : <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />}
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Hero: a split screen. The name stands on the left in huge outlined letters, one word per line
 * rising out of its mask, the last word filled; the selling points drift up a column on the right
 * like a slow departure board. Bold, retro and dark launchpads.
 */
export function HeroOutlineSplit({ points, speed = 28, ...props }: HeroOutlineSplitProps) {
  const copy = heroCopy(props);
  const words = copy.name.split(/\s+/).filter(Boolean).slice(0, 4);
  const lines = words.map((word, index) =>
    index === words.length - 1 && words.length > 1 ? (
      <span key={`${word}-${index}`} className="text-[var(--color-text)]">
        {word}
      </span>
    ) : (
      <span
        key={`${word}-${index}`}
        className="text-transparent [-webkit-text-stroke:1.5px_var(--color-text)]"
      >
        {word}
      </span>
    ),
  );
  return (
    <Section
      label={copy.name}
      className={cn(
        'grid min-h-[min(92vh,56rem)] items-center gap-10 overflow-hidden md:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] md:gap-[clamp(2rem,5vw,5rem)]',
        props.className,
      )}
    >
      <div className="min-w-0">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <MaskLines
          as="h1"
          lines={lines}
          className={cn(
            HEADING_FONT,
            'text-[clamp(3.4rem,11vw,10.5rem)] uppercase leading-[0.86] [overflow-wrap:anywhere]',
          )}
        />
        <p
          className={cn(
            MUTED,
            'mt-8 max-w-[38ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed',
          )}
        >
          {copy.tagline}
        </p>
        <HeroActions primary={copy.primaryAction} secondary={copy.secondaryAction} />
      </div>
      <VerticalTicker
        points={points ?? content.values}
        label={content.strings.valuesLabel}
        speed={speed}
      />
    </Section>
  );
}

export default HeroOutlineSplit;
