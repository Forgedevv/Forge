import { content } from '@/content';
import { SmoothAccordion } from '@/components/library/motion/SmoothAccordion';
import { Section, SectionTitle, useSectionId, type FaqItem } from '../shared';

export interface FaqSectionProps {
  eyebrow?: string;
  title?: string;
  /** Questions. Default `content.faq.items`. */
  items?: readonly FaqItem[];
  className?: string;
}

/** Copy of a FAQ section with the site defaults filled in. */
export function faqCopy(props: FaqSectionProps) {
  return {
    eyebrow: props.eyebrow ?? content.faq.eyebrow,
    title: props.title ?? content.faq.title,
    items: props.items ?? content.faq.items,
  };
}

/** Questions in a centred column; answers glide open with a smooth height animation. Any mood. */
export function FaqAccordion(props: FaqSectionProps) {
  const copy = faqCopy(props);
  const id = useSectionId('faq');
  return (
    <Section labelledBy={id} className={props.className}>
      <SectionTitle id={id} eyebrow={copy.eyebrow} title={copy.title} align="center" />
      <SmoothAccordion items={copy.items} className="mx-auto max-w-3xl" />
    </Section>
  );
}

export default FaqAccordion;
