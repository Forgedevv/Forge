import { SmoothAccordion } from '@/components/library/motion/SmoothAccordion';
import { cn } from '@/lib/utils';
import { Section, SectionTitle, useSectionId } from '../shared';
import { faqCopy, type FaqSectionProps } from './FaqAccordion';

export interface FaqSplitProps extends FaqSectionProps {
  /** Short line under the heading, for example where to ask other questions. */
  intro?: string;
}

/**
 * Questions beside a sticky heading: the title stays in view on the left while the answers open on
 * the right; the first answer starts open. Editorial, premium and tech launchpads.
 */
export function FaqSplit({ intro, ...props }: FaqSplitProps) {
  const copy = faqCopy(props);
  const id = useSectionId('faq');
  return (
    <Section
      labelledBy={id}
      className={cn('grid gap-8 md:grid-cols-[0.8fr_1.2fr]', props.className)}
    >
      <div className="md:sticky md:top-28 md:self-start">
        <SectionTitle id={id} eyebrow={copy.eyebrow} title={copy.title} intro={intro} />
      </div>
      <SmoothAccordion items={copy.items} defaultOpen={[0]} />
    </Section>
  );
}

export default FaqSplit;
