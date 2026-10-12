import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SectionHeadingProps = {
  id: string;
  eyebrow?: string;
  title: ReactNode;
  intro?: ReactNode;
  className?: string;
};

/** Eyebrow, title and optional intro shared by the home sections (FREE ZONE, presentational). */
export function SectionHeading({ id, eyebrow, title, intro, className }: SectionHeadingProps) {
  return (
    <header className={cn('launchpad-section-heading', className)}>
      {eyebrow ? <p className="launchpad-eyebrow">{eyebrow}</p> : null}
      <h2 id={id}>{title}</h2>
      {intro ? <p className="launchpad-section-intro">{intro}</p> : null}
    </header>
  );
}

export default SectionHeading;
