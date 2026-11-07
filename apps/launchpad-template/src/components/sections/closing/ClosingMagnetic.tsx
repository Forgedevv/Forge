import Link from 'next/link';
import { ConicGlow } from '@/components/library/backgrounds/ConicGlow';
import { MagneticButton } from '@/components/library/motion/MagneticButton';
import { MaskLines } from '@/components/library/text/MaskLines';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section } from '../shared';
import { closingCopy, type ClosingSectionProps } from './ClosingGrid';

/**
 * Closing call to action as a big statement: the title rises line by line on the left, a magnetic
 * button that follows the pointer sits in a soft halo on the right. Bold and premium launchpads.
 */
export function ClosingMagnetic(props: ClosingSectionProps) {
  const copy = closingCopy(props);
  return (
    <Section
      label={copy.title}
      className={cn(
        'grid items-center gap-10 overflow-hidden border-t border-[var(--color-border)] md:grid-cols-[1.4fr_1fr]',
        props.className,
      )}
    >
      <div>
        <MaskLines
          as="h2"
          lines={[copy.title]}
          className={cn(HEADING_FONT, 'text-[clamp(2.6rem,7vw,6rem)] leading-[0.92]')}
        />
        <p className={cn(MUTED, 'mt-5 max-w-[44ch] leading-relaxed')}>{copy.body}</p>
      </div>
      <div className="relative flex min-h-64 flex-col items-center justify-center gap-6">
        <div aria-hidden="true" className="absolute inset-0 -z-10">
          <ConicGlow size="18rem" duration={14} />
        </div>
        <MagneticButton href="/create-pool" strength={0.45}>
          {copy.primaryAction}
          <span aria-hidden="true">↗</span>
        </MagneticButton>
        <Link
          href="/#markets"
          className="text-sm underline decoration-[var(--color-border)] underline-offset-8 transition hover:decoration-[var(--color-primary)]"
        >
          {copy.secondaryAction}
        </Link>
      </div>
    </Section>
  );
}

export default ClosingMagnetic;
