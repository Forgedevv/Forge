import { content } from '@/content';
import { PerspectiveGrid } from '@/components/library/backgrounds/PerspectiveGrid';
import { cn } from '@/lib/utils';
import { GhostAction, HEADING_FONT, MUTED, PrimaryAction, Section, useSectionId } from '../shared';

export interface ClosingSectionProps {
  title?: string;
  body?: string;
  primaryAction?: string;
  secondaryAction?: string;
  className?: string;
}

/** Copy of a closing call to action with the site defaults filled in. */
export function closingCopy(props: ClosingSectionProps) {
  const base = content.closing;
  return {
    title: props.title ?? base.title,
    body: props.body ?? base.body,
    primaryAction: props.primaryAction ?? base.primaryAction,
    secondaryAction: props.secondaryAction ?? base.secondaryAction,
  };
}

/** The two closing actions. */
export function ClosingActions({
  primary,
  secondary,
  className,
}: {
  primary: string;
  secondary: string;
  className?: string;
}) {
  return (
    <div className={cn('mt-8 flex flex-wrap items-center gap-3', className)}>
      <PrimaryAction href="/create-pool">
        {primary}
        <span aria-hidden="true">↗</span>
      </PrimaryAction>
      <GhostAction href="/#markets">{secondary}</GhostAction>
    </div>
  );
}

/**
 * Closing call to action over a neon floor that scrolls towards the viewer. Retro and tech
 * launchpads; echoes `HeroRetroGrid` without the sun. Light: pure CSS.
 */
export function ClosingGrid(props: ClosingSectionProps) {
  const copy = closingCopy(props);
  const id = useSectionId('closing');
  return (
    <Section labelledBy={id} className={props.className}>
      <div className="relative isolate overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] px-6 pb-40 pt-16 text-center">
        <div aria-hidden="true" className="absolute inset-0 -z-10">
          <PerspectiveGrid horizon={0.45} />
        </div>
        {/* A shade of the page colour behind the copy: the floor lines never cross the text. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 -z-10 h-3/4 bg-[radial-gradient(ellipse_60%_70%_at_50%_30%,var(--color-bg)_45%,transparent)]"
        />
        <h2
          id={id}
          className={cn(
            HEADING_FONT,
            'mx-auto max-w-[16ch] text-[clamp(2.4rem,6vw,5rem)] leading-[0.95]',
          )}
        >
          {copy.title}
        </h2>
        <p className={cn(MUTED, 'mx-auto mt-5 max-w-[44ch] leading-relaxed')}>{copy.body}</p>
        <ClosingActions
          primary={copy.primaryAction}
          secondary={copy.secondaryAction}
          className="justify-center"
        />
      </div>
    </Section>
  );
}

export default ClosingGrid;
