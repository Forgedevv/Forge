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
 * Hero: a small, slow rotating halo of the brand colours set right behind a centred name filled
 * with the flowing brand gradient, and a magnetic call to action. The halo stays a quiet ring
 * around the title, never a wash over the page. Premium, bold and dark launchpads. Light: pure CSS.
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
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <div className="relative">
        {/* A small ring behind the title only, faded at its edge so it never floods the hero. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 aspect-square w-[min(72vw,24rem)] -translate-x-1/2 -translate-y-1/2 opacity-[0.45] [mask-image:radial-gradient(closest-side,#000_62%,transparent)]"
        >
          <ConicGlow size="min(60vw, 19rem)" />
        </div>
        <h1
          id={id}
          className={cn(
            HEADING_FONT,
            'max-w-[13ch] text-[clamp(3.2rem,9vw,8.5rem)] leading-[0.9] [overflow-wrap:anywhere]',
          )}
        >
          <ShimmerText variant="gradient">{copy.name}</ShimmerText>
        </h1>
      </div>
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
