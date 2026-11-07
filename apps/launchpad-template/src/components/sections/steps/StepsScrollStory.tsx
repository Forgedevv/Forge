import { ScrollWords } from '@/components/library/text/ScrollWords';
import { cn } from '@/lib/utils';
import { Eyebrow, HEADING_FONT, MUTED, Section, useSectionId } from '../shared';
import { stepsCopy, type StepsSectionProps } from './StepsStack';

/**
 * How it works told as a story: each step is a large sentence whose words light up one by one as
 * the reader scrolls, with the step title in the margin. Editorial, calm and premium launchpads.
 */
export function StepsScrollStory(props: StepsSectionProps) {
  const copy = stepsCopy(props);
  const id = useSectionId('steps');
  return (
    <Section labelledBy={id} className={props.className}>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <h2
        id={id}
        className={cn(HEADING_FONT, 'max-w-3xl text-[clamp(2rem,4.6vw,3.75rem)] leading-[0.98]')}
      >
        {copy.title}
      </h2>
      <ol className="mt-[clamp(2.5rem,6vw,4.5rem)] flex flex-col gap-[clamp(2.5rem,6vw,4.5rem)]">
        {copy.steps.map((step, index) => (
          <li
            key={step.title}
            className="grid gap-4 border-t border-[var(--color-border)] pt-6 md:grid-cols-[14rem_1fr]"
          >
            <h3 className={cn(MUTED, 'text-sm uppercase tracking-[0.16em]')}>
              <span className="text-[var(--color-primary)]">
                {String(index + 1).padStart(2, '0')}
              </span>{' '}
              {step.title}
            </h3>
            <ScrollWords
              text={step.body}
              className={cn(HEADING_FONT, 'text-[clamp(1.6rem,3.4vw,2.8rem)] leading-[1.12]')}
            />
          </li>
        ))}
      </ol>
    </Section>
  );
}

export default StepsScrollStory;
