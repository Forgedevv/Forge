import { content } from '@/content';
import { TiltCard } from '@/components/library/motion/TiltCard';
import { Reveal } from '@/components/library/motion/Reveal';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section, SectionTitle, useSectionId } from '../shared';
import type { ValuesSectionProps } from './ValuesSpotlight';

/**
 * Selling points as cards that tilt towards the pointer with a glare, each with a big outlined
 * number, rising one after the other. Playful and bold launchpads.
 */
export function ValuesTilt({ items, eyebrow, title, className }: ValuesSectionProps) {
  const values = items ?? content.values;
  const id = useSectionId('values');
  return (
    <Section
      labelledBy={title ? id : undefined}
      label={content.strings.valuesLabel}
      className={className}
    >
      {title ? <SectionTitle id={id} eyebrow={eyebrow} title={title} /> : null}
      <Reveal as="ul" stagger={0.12} className="grid gap-5 md:grid-cols-3" itemClassName="flex">
        {values.map((value, index) => (
          <TiltCard key={value.title} className="flex w-full flex-col gap-4 p-7">
            <span
              aria-hidden="true"
              className={cn(
                HEADING_FONT,
                'text-6xl leading-none text-transparent [-webkit-text-stroke:1px_var(--color-primary)]',
              )}
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            {value.icon ? (
              <span
                aria-hidden="true"
                className={cn('iconify text-2xl text-[var(--color-accent)]', value.icon)}
              />
            ) : null}
            <h3 className={cn(HEADING_FONT, 'text-2xl')}>{value.title}</h3>
            <p className={cn(MUTED, 'text-sm leading-relaxed')}>{value.body}</p>
          </TiltCard>
        ))}
      </Reveal>
    </Section>
  );
}

export default ValuesTilt;
