import { content } from '@/content';
import { WovenTorus } from '@/components/library/backgrounds/WovenTorus';
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

/**
 * Hero: a ring woven from glowing threads turns slowly in the middle of the page and tilts towards
 * the pointer; the name sits in its eye over a deep vignette, with small instrument labels in the
 * corners. Dark, organic and calm launchpads.
 */
export function HeroWovenRing(props: HeroCopy) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  const corners = content.values.slice(0, 2).map((value) => value.title);
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[min(94vh,58rem)] flex-col items-center justify-center overflow-hidden text-center',
        props.className,
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        <WovenTorus followPointer size={0.95} threads={64} />
      </div>
      {/* Vignette towards the page colour at the edges, and a calm eye for the title. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,transparent_35%,var(--color-bg)_78%)]"
      />
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -z-10 aspect-square w-[min(90vw,36rem)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-bg)_82%,transparent)_45%,transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[var(--page-gutter)] top-6 flex justify-between font-mono text-[0.65rem] uppercase tracking-[0.25em] text-[var(--color-text-muted)]"
      >
        <span>{content.strings.network}</span>
        <span>{copy.monogram}</span>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[var(--page-gutter)] bottom-6 hidden justify-between font-mono text-[0.65rem] uppercase tracking-[0.25em] text-[var(--color-text-muted)] sm:flex"
      >
        {corners.map((title) => (
          <span key={title}>{title}</span>
        ))}
      </div>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <h1
        id={id}
        className={cn(
          HEADING_FONT,
          'max-w-[13ch] text-[clamp(3rem,9vw,8rem)] leading-[0.9] [overflow-wrap:anywhere]',
        )}
      >
        <SplitReveal as="span" split="words" text={copy.name} className="block" />
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

export default HeroWovenRing;
