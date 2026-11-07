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
 * Hero: a synthwave horizon. A neon floor scrolls towards the viewer under a striped sun, the name
 * flips up letter by letter with a springy landing. Retro, playful and bold launchpads. Light: CSS.
 */
export function HeroRetroGrid({ sun = true, ...props }: HeroRetroGridProps) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[min(92vh,56rem)] flex-col items-center overflow-hidden pt-[clamp(5rem,12vw,9rem)] text-center',
        props.className,
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        <PerspectiveGrid sun={sun} horizon={0.58} />
      </div>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <h1
        id={id}
        className={cn(
          HEADING_FONT,
          'text-[clamp(3rem,10vw,9rem)] uppercase leading-[0.88] [overflow-wrap:anywhere] [text-shadow:0_0_40px_rgb(var(--primary)/0.45)]',
        )}
      >
        <SplitReveal as="span" text={copy.name} effect="flip" className="block" />
      </h1>
      <p
        className={cn(MUTED, 'mt-6 max-w-[38ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed')}
      >
        {copy.tagline}
      </p>
      <HeroActions
        primary={copy.primaryAction}
        secondary={copy.secondaryAction}
        className="justify-center"
      />
    </Section>
  );
}

export default HeroRetroGrid;
