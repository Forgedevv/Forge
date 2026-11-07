import { Reveal } from '@/components/library/motion/Reveal';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section, SectionTitle, useSectionId } from '../shared';
import { faqCopy, type FaqSectionProps } from './FaqAccordion';

/**
 * Questions and answers all visible, as a grid of cards that rise one after the other, each
 * question marked with a big brand-coloured "?". Playful and bold launchpads with short answers.
 */
export function FaqCards(props: FaqSectionProps) {
  const copy = faqCopy(props);
  const id = useSectionId('faq');
  return (
    <Section labelledBy={id} className={props.className}>
      <SectionTitle id={id} eyebrow={copy.eyebrow} title={copy.title} />
      <Reveal as="ul" stagger={0.08} className="grid gap-4 md:grid-cols-2" itemClassName="flex">
        {copy.items.map((item) => (
          <div
            key={item.question}
            className="flex w-full gap-5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          >
            <span
              aria-hidden="true"
              className={cn(HEADING_FONT, 'text-4xl leading-none text-[var(--color-primary)]')}
            >
              ?
            </span>
            <div>
              <h3 className="font-medium leading-snug">{item.question}</h3>
              <p className={cn(MUTED, 'mt-2 text-sm leading-relaxed')}>{item.answer}</p>
            </div>
          </div>
        ))}
      </Reveal>
    </Section>
  );
}

export default FaqCards;
