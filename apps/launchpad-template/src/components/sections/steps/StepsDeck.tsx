import { CardDeck } from '@/components/library/motion/CardDeck';
import { cn } from '@/lib/utils';
import { HEADING_FONT, Section, SectionTitle, useSectionId } from '../shared';
import { stepsCopy, type StepsSectionProps } from './StepsStack';

/**
 * How it works as a fanned deck of cards: the visitor brings a step to the front by clicking or
 * with the arrow keys, each card showing a giant step number. Playful, bold and premium launchpads.
 */
export function StepsDeck(props: StepsSectionProps) {
  const copy = stepsCopy(props);
  const id = useSectionId('steps');
  return (
    <Section labelledBy={id} className={props.className}>
      <SectionTitle id={id} eyebrow={copy.eyebrow} title={copy.title} align="center" />
      <CardDeck
        label={copy.title}
        initialIndex={0}
        cardWidth={240}
        className="mx-auto"
        items={copy.steps.map((step, index) => ({
          id: `step-${index + 1}`,
          title: step.title,
          caption: step.body,
          art: (
            <span
              aria-hidden="true"
              className={cn(
                HEADING_FONT,
                'grid h-full w-full place-items-center bg-[radial-gradient(circle_at_30%_20%,rgb(var(--primary)/0.35),transparent_65%)] text-[6rem] leading-none text-[var(--color-primary)]',
              )}
            >
              {index + 1}
            </span>
          ),
        }))}
      />
    </Section>
  );
}

export default StepsDeck;
