import { content } from '@/content';
import { SpotlightGrid } from '@/components/library/motion/SpotlightGrid';
import { cn } from '@/lib/utils';
import { Section, SectionTitle, useSectionId, type ValueItem } from '../shared';

export interface ValuesSectionProps {
  /** Selling points. Default `content.values`. */
  items?: readonly ValueItem[];
  /** Optional heading; without it the section is named by `content.strings.valuesLabel`. */
  eyebrow?: string;
  title?: string;
  className?: string;
}

/**
 * Selling points as a bento of dark cards; a soft light follows the pointer across the grid and
 * lights the borders it passes. The first card is wide. Tech and premium launchpads.
 */
export function ValuesSpotlight({ items, eyebrow, title, className }: ValuesSectionProps) {
  const values = items ?? content.values;
  const id = useSectionId('values');
  return (
    <Section
      labelledBy={title ? id : undefined}
      label={content.strings.valuesLabel}
      className={className}
    >
      {title ? <SectionTitle id={id} eyebrow={eyebrow} title={title} /> : null}
      <SpotlightGrid
        columns={3}
        items={values.map((value, index) => ({
          kicker: String(index + 1).padStart(2, '0'),
          title: value.title,
          description: value.body,
          size: index === 0 && values.length > 2 ? ('wide' as const) : ('normal' as const),
          visual: value.icon ? (
            <span
              aria-hidden="true"
              className={cn('iconify text-3xl text-[var(--color-primary)]', value.icon)}
            />
          ) : undefined,
        }))}
      />
    </Section>
  );
}

export default ValuesSpotlight;
