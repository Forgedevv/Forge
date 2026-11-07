import { ProgressRing } from '@/components/library/motion/ProgressRing';
import { Reveal } from '@/components/library/motion/Reveal';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, Section, SectionTitle, useSectionId } from '../shared';
import { stepsCopy, type StepsSectionProps } from './StepsStack';

/**
 * How it works as progress rings that fill as they enter the screen, one more third each step, like
 * a bonding curve filling up to graduation. Tech and playful launchpads.
 */
export function StepsRings(props: StepsSectionProps) {
  const copy = stepsCopy(props);
  const id = useSectionId('steps');
  const count = copy.steps.length;
  return (
    <Section labelledBy={id} className={props.className}>
      <SectionTitle id={id} eyebrow={copy.eyebrow} title={copy.title} align="center" />
      <Reveal
        as="ol"
        stagger={0.15}
        className={cn('grid gap-12 text-center', count > 2 && 'md:grid-cols-3')}
      >
        {copy.steps.map((step, index) => (
          <div key={step.title} className="flex flex-col items-center">
            <ProgressRing
              value={Math.round(((index + 1) / count) * 100)}
              label={step.title}
              size={150}
              thickness={8}
            >
              <span className={cn(HEADING_FONT, 'text-5xl')}>{index + 1}</span>
            </ProgressRing>
            <h3 className={cn(HEADING_FONT, 'mt-6 text-2xl')}>{step.title}</h3>
            <p className={cn(MUTED, 'mt-3 max-w-[32ch] text-sm leading-relaxed')}>{step.body}</p>
          </div>
        ))}
      </Reveal>
    </Section>
  );
}

export default StepsRings;
