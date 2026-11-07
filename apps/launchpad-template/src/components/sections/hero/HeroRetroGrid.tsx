import { PerspectiveGrid } from '@/components/library/backgrounds/PerspectiveGrid';
import { SplitReveal } from '@/components/library/text/SplitReveal';
import { cn } from '@/lib/utils';
import {
  Eyebrow,
  HEADING_FONT,
  HeroActions,
  MUTED,
  Section,
  heroCopy,
  useSectionId,
  type HeroCopy,
} from '../shared';

export interface HeroRetroGridProps extends HeroCopy {
  /** The striped sun on the horizon. Default true. */
  sun?: boolean;
}

/**
 * Hero: a synthwave horizon. The name flips up letter by letter above a striped sun, a neon floor
 * scrolls towards the viewer under it, and the tagline and actions sit on a solid panel below the
 * horizon, so no line ever crosses the sun. Retro, playful and bold launchpads. Light: CSS.
 */
export function HeroRetroGrid({ sun = true, ...props }: HeroRetroGridProps) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[min(92vh,56rem)] flex-col items-center justify-center overflow-hidden pt-[clamp(4rem,10vw,7rem)] text-center',
        props.className,
      )}
    >
      <div className="relative z-10 w-full">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h1
          id={id}
          className={cn(
            HEADING_FONT,
            'mx-auto max-w-[14ch] text-[clamp(2.8rem,10vw,9rem)] uppercase leading-[0.88] [overflow-wrap:anywhere] [text-shadow:0_0_40px_rgb(var(--primary)/0.45)]',
          )}
        >
          <SplitReveal as="span" text={copy.name} effect="flip" className="block" />
        </h1>
      </div>
      {/* The horizon band: the sun sets in its upper half, the floor fills the lower half. */}
      <div
        aria-hidden="true"
        className="relative -mx-[var(--page-gutter)] mt-[clamp(1rem,3vw,2rem)] h-[clamp(13rem,32vw,22rem)] self-stretch"
      >
        <PerspectiveGrid sun={sun} horizon={0.56} />
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-b from-transparent to-[var(--color-bg)]" />
      </div>
      <div className="relative z-10 -mt-[clamp(2.5rem,6vw,4.5rem)] w-full max-w-xl rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg)] px-[clamp(1.25rem,4vw,2.5rem)] py-[clamp(1.25rem,3vw,2rem)] shadow-[0_-12px_40px_-24px_rgb(var(--primary)/0.6)]">
        <p
          className={cn(
            MUTED,
            'mx-auto max-w-[38ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed',
          )}
        >
          {copy.tagline}
        </p>
        <HeroActions
          primary={copy.primaryAction}
          secondary={copy.secondaryAction}
          className="mt-6 justify-center"
        />
      </div>
    </Section>
  );
}

export default HeroRetroGrid;
