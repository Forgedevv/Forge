import { content } from '@/content';
import { cn } from '@/lib/utils';

/** Short selling points of the launchpad (FREE ZONE, presentational). Copy: `content.values`. */
export function ValueStrip({ className }: { className?: string }) {
  return (
    <section className={cn('launchpad-values', className)} aria-label={content.strings.valuesLabel}>
      <ul className="launchpad-values-list">
        {content.values.map((value) => (
          <li key={value.title} className="launchpad-value">
            <span className={cn('launchpad-value-icon iconify', value.icon)} aria-hidden="true" />
            <p className="launchpad-value-title">{value.title}</p>
            <p>{value.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default ValueStrip;
