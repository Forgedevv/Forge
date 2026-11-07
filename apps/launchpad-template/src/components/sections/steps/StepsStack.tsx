import { content } from '@/content';
import { StackCards } from '@/components/library/motion/StackCards';
import { cn } from '@/lib/utils';
import { HEADING_FONT, Section, SectionTitle, useSectionId, type StepItem } from '../shared';

export interface StepsSectionProps {
  eyebrow?: string;
  title?: string;
  /** Steps. Default `content.howItWorks.steps`. */
  steps?: readonly StepItem[];
  className?: string;
}

/** Copy of a steps section with the site defaults filled in. */
export function stepsCopy(props: StepsSectionProps) {
  return {
    eyebrow: props.eyebrow ?? content.howItWorks.eyebrow,
    title: props.title ?? content.howItWorks.title,
    steps: props.steps ?? content.howItWorks.steps,
  };
}

/**
 * How it works as cards that pin and stack on top of each other while the page scrolls, each
 * with a giant step number. A strong, cinematic middle of the page for any mood.
 */
export function StepsStack(props: StepsSectionProps) {
  const copy = stepsCopy(props);
  const id = useSectionId('steps');
  return (
    <Section labelledBy={id} className={props.className}>
      <SectionTitle id={id} eyebrow={copy.eyebrow} title={copy.title} />
      <StackCards
        top={96}
        items={copy.steps.map((step, index) => ({
          kicker: `${String(index + 1).padStart(2, '0')} / ${String(copy.steps.length).padStart(2, '0')}`,
          title: step.title,
          description: step.body,
          visual: (
            <span
              aria-hidden="true"
              className={cn(
                HEADING_FONT,
                'text-[clamp(5rem,12vw,9rem)] leading-none text-[var(--color-primary)]',
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

export default StepsStack;
