import { content } from '@/content';
import { cn } from '@/lib/utils';
import { SectionHeading } from './SectionHeading';

/** Questions and answers as native disclosure widgets (FREE ZONE, presentational). Copy: `content.faq`. */
export function Faq({ className }: { className?: string }) {
  const copy = content.faq;
  return (
    <section
      className={cn('launchpad-section launchpad-faq', className)}
      aria-labelledby="launchpad-faq-title"
    >
      <SectionHeading id="launchpad-faq-title" eyebrow={copy.eyebrow} title={copy.title} />
      <div className="launchpad-faq-list">
        {copy.items.map((item) => (
          <details key={item.question} className="launchpad-faq-item">
            <summary>
              <span>{item.question}</span>
              <span className="launchpad-faq-toggle" aria-hidden="true" />
            </summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export default Faq;
