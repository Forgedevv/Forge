import { content } from '@/content';
import { Reveal } from '@/components/library/motion/Reveal';
import { ScrambleText } from '@/components/library/text/ScrambleText';
import { cn } from '@/lib/utils';
import { MUTED, Section, SectionTitle, useSectionId } from '../shared';
import type { ValuesSectionProps } from './ValuesSpotlight';

/**
 * Selling points printed in a terminal window: a title bar with a file name, then one prompt line
 * per point whose title decodes like a signal as it scrolls into view. Tech, dark and retro
 * launchpads.
 */
export function ValuesTerminal({ items, eyebrow, title, className }: ValuesSectionProps) {
  const values = items ?? content.values;
  const id = useSectionId('values');
  return (
    <Section
      labelledBy={title ? id : undefined}
      label={content.strings.valuesLabel}
      className={className}
    >
      {title ? <SectionTitle id={id} eyebrow={eyebrow} title={title} /> : null}
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] font-mono">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--color-accent)]" />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--color-border)]" />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--color-border)]" />
          <span className={cn(MUTED, 'ml-3 text-xs')} aria-hidden="true">
            {content.name.toLowerCase().replace(/\s+/g, '-')}/values.log
          </span>
        </div>
        <Reveal
          as="ul"
          stagger={0.12}
          blur={0}
          className="flex flex-col divide-y divide-[var(--color-border)]"
        >
          {values.map((value, index) => (
            <div
              key={value.title}
              className="grid gap-2 px-5 py-6 md:grid-cols-[3rem_minmax(0,1fr)_minmax(0,1.3fr)] md:items-baseline md:gap-6"
            >
              <span aria-hidden="true" className="text-xs text-[var(--color-primary)]">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="text-base font-semibold uppercase tracking-[0.08em]">
                <span aria-hidden="true" className="text-[var(--color-primary)]">
                  &gt;{' '}
                </span>
                <ScrambleText text={value.title} trigger="view" />
              </h3>
              <p className={cn(MUTED, 'text-sm leading-relaxed')}>{value.body}</p>
            </div>
          ))}
        </Reveal>
      </div>
    </Section>
  );
}

export default ValuesTerminal;
