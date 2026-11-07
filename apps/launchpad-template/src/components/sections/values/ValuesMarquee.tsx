import { content } from '@/content';
import { DragMarquee } from '@/components/library/motion/DragMarquee';
import { Reveal } from '@/components/library/motion/Reveal';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section } from '../shared';
import type { ValuesSectionProps } from './ValuesSpotlight';

/**
 * Selling points as two giant draggable ticker bands drifting in opposite directions, then the
 * details in three short columns. Bold, meme and retro launchpads.
 */
export function ValuesMarquee({ items, className }: ValuesSectionProps) {
  const values = items ?? content.values;
  const word = (title: string, accent: boolean) => (
    <span
      key={title}
      className={cn(
        HEADING_FONT,
        'flex items-center gap-10 text-[clamp(2.4rem,6vw,5rem)] uppercase leading-none',
        accent && 'text-transparent [-webkit-text-stroke:1px_var(--color-text)]',
      )}
    >
      {title}
      <span aria-hidden="true" className="text-[0.5em] text-[var(--color-primary)]">
        ●
      </span>
    </span>
  );
  return (
    <Section label={content.strings.valuesLabel} className={cn('overflow-hidden', className)}>
      <div className="-mx-[var(--page-gutter)] flex flex-col gap-4">
        <DragMarquee label={content.strings.valuesLabel} speed={44} gap={40}>
          {values.map((value) => word(value.title, false))}
        </DragMarquee>
        <DragMarquee
          label={content.strings.valuesLabel}
          speed={32}
          gap={40}
          direction="right"
          pauseButton={false}
        >
          {values.map((value) => word(value.title, true))}
        </DragMarquee>
      </div>
      <Reveal as="ul" stagger={0.1} className="mt-12 grid gap-8 md:grid-cols-3">
        {values.map((value) => (
          <div key={value.title} className="border-t border-[var(--color-border)] pt-4">
            <h3 className="text-sm font-medium uppercase tracking-[0.14em]">{value.title}</h3>
            <p className={cn(MUTED, 'mt-2 text-sm leading-relaxed')}>{value.body}</p>
          </div>
        ))}
      </Reveal>
    </Section>
  );
}

export default ValuesMarquee;
