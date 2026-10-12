import Link from 'next/link';
import { content } from '@/content';
import { cn } from '@/lib/utils';

/** Closing call to action at the bottom of a page (FREE ZONE, presentational). Copy: `content.closing`. */
export function ClosingCta({ className }: { className?: string }) {
  const copy = content.closing;
  return (
    <section
      className={cn('launchpad-section launchpad-closing', className)}
      aria-labelledby="launchpad-closing-title"
    >
      <div className="launchpad-closing-card">
        <h2 id="launchpad-closing-title">{copy.title}</h2>
        <p>{copy.body}</p>
        <div className="launchpad-closing-actions">
          <Link href="/create-pool" className="launchpad-button launchpad-button-primary">
            {copy.primaryAction}
            <span aria-hidden="true">↗</span>
          </Link>
          <Link href="/#markets" className="launchpad-button launchpad-button-ghost">
            {copy.secondaryAction}
          </Link>
        </div>
      </div>
    </section>
  );
}

export default ClosingCta;
