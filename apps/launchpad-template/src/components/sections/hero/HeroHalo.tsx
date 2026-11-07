import Link from 'next/link';
import { ConicGlow } from '@/components/library/backgrounds/ConicGlow';
import { MagneticButton } from '@/components/library/motion/MagneticButton';
import { ShimmerText } from '@/components/library/text/ShimmerText';
import { cn } from '@/lib/utils';
import {
  Eyebrow,
  HEADING_FONT,
  MUTED,
  Section,
  heroCopy,
  useSectionId,
  type HeroCopy,
} from '../shared';

/**
 * Hero: a slow rotating halo of the brand colours behind a centred name filled with the flowing
 * brand gradient, and a magnetic call to action. Premium, bold and dark launchpads. Light: pure CSS.
 */
export function HeroHalo(props: HeroCopy) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[min(88vh,52rem)] flex-col items-center justify-center overflow-hidden text-center',
        props.className,
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        <ConicGlow size="min(78vw, 46rem)" y={0.48} />
      </div>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <h1
        id={id}
        className={cn(
          HEADING_FONT,
          'max-w-[13ch] text-[clamp(3.2rem,9vw,8.5rem)] leading-[0.9] [overflow-wrap:anywhere]',
        )}
      >
        <ShimmerText variant="gradient">{copy.name}</ShimmerText>
      </h1>
      <p
        className={cn(MUTED, 'mt-6 max-w-[38ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed')}
      >
        {copy.tagline}
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
        <MagneticButton href="/create-pool">
          {copy.primaryAction}
          <span aria-hidden="true">↗</span>
        </MagneticButton>
        <Link
          href="/#markets"
          className="text-sm text-[var(--color-text)] underline decoration-[var(--color-border)] underline-offset-8 transition hover:decoration-[var(--color-primary)]"
        >
          {copy.secondaryAction}
        </Link>
      </div>
    </Section>
  );
}

export default HeroHalo;
