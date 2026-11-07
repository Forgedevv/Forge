import { content } from '@/content';
import { Reveal } from '@/components/library/motion/Reveal';
import { MarkerHighlight } from '@/components/library/text/MarkerHighlight';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section, SectionTitle, useSectionId } from '../shared';
import type { ValuesSectionProps } from './ValuesSpotlight';

/**
 * Selling points as an editorial list: thin rules, big numbers, the title with a highlighter
 * stroke drawn behind it as it enters the screen. Calm, premium and organic launchpads.
 */
export function ValuesEditorial({ items, eyebrow, title, className }: ValuesSectionProps) {
  const values = items ?? content.values;
  const id = useSectionId('values');
  return (
    <Section
      labelledBy={title ? id : undefined}
      label={content.strings.valuesLabel}
      className={className}
    >
      {title ? <SectionTitle id={id} eyebrow={eyebrow} title={title} /> : null}
      <Reveal as="ol" stagger={0.12} className="border-b border-[var(--color-border)]">
        {values.map((value, index) => (
          <div
            key={value.title}
            className="grid gap-3 border-t border-[var(--color-border)] py-8 md:grid-cols-[6rem_1fr_1.2fr] md:items-baseline md:gap-8"
          >
            <span
              aria-hidden="true"
              className={cn(HEADING_FONT, 'text-sm text-[var(--color-text-muted)]')}
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className={cn(HEADING_FONT, 'text-[clamp(1.6rem,3vw,2.4rem)] leading-tight')}>
              <MarkerHighlight delay={0.2 + index * 0.1}>{value.title}</MarkerHighlight>
            </h3>
            <p className={cn(MUTED, 'max-w-[44ch] leading-relaxed')}>{value.body}</p>
          </div>
        ))}
      </Reveal>
    </Section>
  );
}

export default ValuesEditorial;
