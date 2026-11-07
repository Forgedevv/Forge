import { Reveal } from '@/components/library/motion/Reveal';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section, SectionTitle, useSectionId } from '../shared';
import { stepsCopy, type StepsSectionProps } from './StepsStack';

/**
 * How it works as a vertical timeline: a thin line in the brand gradient, glowing nodes and the
 * steps rising one after the other. Calm, premium and tech launchpads.
 */
export function StepsTimeline(props: StepsSectionProps) {
  const copy = stepsCopy(props);
  const id = useSectionId('steps');
  return (
    <Section
      labelledBy={id}
      className={cn('grid gap-10 md:grid-cols-[0.9fr_1.1fr]', props.className)}
    >
      <div className="md:sticky md:top-28 md:self-start">
        <SectionTitle id={id} eyebrow={copy.eyebrow} title={copy.title} className="mb-0" />
      </div>
      <div className="relative pl-10">
        <div
          aria-hidden="true"
          className="absolute bottom-2 left-[0.6875rem] top-2 w-px bg-gradient-to-b from-[var(--color-primary)] via-[var(--color-accent)] to-transparent"
        />
        <Reveal as="ol" stagger={0.15} distance={20} className="flex flex-col gap-12">
          {copy.steps.map((step, index) => (
            <div key={step.title} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-10 top-1 grid h-6 w-6 place-items-center rounded-full border border-[var(--color-primary)] bg-[var(--color-bg)] shadow-[0_0_18px_rgb(var(--primary)/0.55)]"
              >
                <span className="h-2 w-2 rounded-full bg-[var(--color-primary)] text-primary-950" />
              </span>
              <p className="text-xs uppercase tracking-[0.18em] text-[var(--color-primary)]">
                {String(index + 1).padStart(2, '0')}
              </p>
              <h3 className={cn(HEADING_FONT, 'mt-2 text-[clamp(1.5rem,2.6vw,2.1rem)]')}>
                {step.title}
              </h3>
              <p className={cn(MUTED, 'mt-3 max-w-[46ch] leading-relaxed')}>{step.body}</p>
            </div>
          ))}
        </Reveal>
      </div>
    </Section>
  );
}

export default StepsTimeline;
