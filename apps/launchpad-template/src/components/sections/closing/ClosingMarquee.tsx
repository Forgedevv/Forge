import { DragMarquee } from '@/components/library/motion/DragMarquee';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section, useSectionId } from '../shared';
import { ClosingActions, closingCopy, type ClosingSectionProps } from './ClosingGrid';

/**
 * Closing call to action as a giant draggable ticker: the primary action repeats across the screen
 * in huge type, the title, body and buttons sit beneath. Meme, bold and retro launchpads.
 */
export function ClosingMarquee(props: ClosingSectionProps) {
  const copy = closingCopy(props);
  const id = useSectionId('closing');
  return (
    <Section labelledBy={id} className={cn('overflow-hidden', props.className)}>
      <div className="-mx-[var(--page-gutter)] border-y border-[var(--color-border)] py-6">
        <DragMarquee label={copy.title} speed={70} gap={56} fade={false}>
          {[0, 1, 2].map((key) => (
            <span
              key={key}
              aria-hidden="true"
              className={cn(
                HEADING_FONT,
                'flex items-center gap-14 text-[clamp(3rem,10vw,8rem)] uppercase leading-none',
              )}
            >
              {copy.primaryAction}
              <span className="text-[0.5em] text-[var(--color-primary)]">↗</span>
            </span>
          ))}
        </DragMarquee>
      </div>
      <div className="mt-10 grid gap-6 md:grid-cols-2 md:items-end">
        <h2 id={id} className={cn(HEADING_FONT, 'text-[clamp(2rem,4vw,3.2rem)] leading-tight')}>
          {copy.title}
        </h2>
        <div>
          <p className={cn(MUTED, 'max-w-[44ch] leading-relaxed')}>{copy.body}</p>
          <ClosingActions primary={copy.primaryAction} secondary={copy.secondaryAction} />
        </div>
      </div>
    </Section>
  );
}

export default ClosingMarquee;
