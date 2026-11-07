import { FilamentStrands } from '@/components/library/backgrounds/FilamentStrands';
import { SplitReveal } from '@/components/library/text/SplitReveal';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section, useSectionId } from '../shared';
import { ClosingActions, closingCopy, type ClosingSectionProps } from './ClosingGrid';

/**
 * Closing call to action over a sheaf of glowing filaments rising from the bottom and parting
 * around the pointer; the title rises word by word. Premium, organic and dark launchpads.
 */
export function ClosingFilaments(props: ClosingSectionProps) {
  const copy = closingCopy(props);
  const id = useSectionId('closing');
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[34rem] flex-col items-center justify-center overflow-hidden text-center',
        props.className,
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        <FilamentStrands followPointer />
      </div>
      {/* A calm eye of the page colour behind the copy, so the strands never cross the text. */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -z-10 aspect-[3/2] w-[min(100vw,48rem)] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-bg)_80%,transparent)_50%,transparent)]"
      />
      <h2
        id={id}
        className={cn(HEADING_FONT, 'max-w-[16ch] text-[clamp(2.4rem,6vw,5rem)] leading-[0.95]')}
      >
        <SplitReveal as="span" split="words" text={copy.title} className="block" />
      </h2>
      <p className={cn(MUTED, 'mt-5 max-w-[44ch] leading-relaxed')}>{copy.body}</p>
      <ClosingActions
        primary={copy.primaryAction}
        secondary={copy.secondaryAction}
        className="justify-center"
      />
    </Section>
  );
}

export default ClosingFilaments;
