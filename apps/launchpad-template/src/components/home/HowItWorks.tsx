import { content } from '@/content';
import { cn } from '@/lib/utils';
import { SectionHeading } from './SectionHeading';

/** Numbered steps from creation to graduation (FREE ZONE, presentational). Copy: `content.howItWorks`. */
export function HowItWorks({ className }: { className?: string }) {
  const copy = content.howItWorks;
  return (
    <section
      className={cn('launchpad-section launchpad-steps', className)}
      aria-labelledby="launchpad-steps-title"
    >
      <SectionHeading id="launchpad-steps-title" eyebrow={copy.eyebrow} title={copy.title} />
      <ol className="launchpad-steps-list">
        {copy.steps.map((step, index) => (
          <li key={step.title} className="launchpad-step">
            <span className="launchpad-step-index" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default HowItWorks;
