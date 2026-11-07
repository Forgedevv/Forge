import { LayoutGroup, motion } from 'motion/react';
import { useId, useState, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { safeHref } from '../shared/safeHref';
import { useCalm } from './internal';

export interface PillNavLink {
  label: string;
  /** A path of this site or an allowed social or explorer page (`safeHref`); others are left out. */
  href: string;
}

export interface PillNavProps {
  items: readonly PillNavLink[];
  /** The current page. When omitted, the component remembers the last clicked link itself. */
  activeHref?: string;
  /** Accessible name of the navigation. Default "Main". */
  label?: string;
  /** Called when a link is clicked (for client-side routing, call `preventDefault` there). */
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}

/** The links with a target this site may use (`safeHref`); the others are left out. */
function safeLinks<T extends { href: string }>(links: readonly T[]): T[] {
  return links.flatMap((link) => {
    const href = safeHref(link.href);
    return href ? [{ ...link, href }] : [];
  });
}

/**
 * A floating pill-shaped navigation bar: a solid pill marks the current page and glides to the
 * clicked link, while a softer pill follows the pointer from link to link. The compact header for a
 * launchpad ("Explore", "Create", "Leaderboard", "Docs"). Real links with `aria-current`; the pills
 * jump instead of gliding for reduced motion.
 */
export function PillNav({
  items: rawItems,
  activeHref,
  label = 'Main',
  onNavigate,
  className,
}: PillNavProps) {
  // Only paths of this site and allowed social or explorer pages.
  const items = safeLinks(rawItems);
  const calm = useCalm();
  const group = useId();
  const [clicked, setClicked] = useState(items[0]?.href);
  const [hovered, setHovered] = useState<string | null>(null);
  const active = activeHref ?? clicked;
  const spring = calm
    ? { duration: 0 }
    : ({ type: 'spring', bounce: 0.22, duration: 0.5 } as const);

  return (
    <nav aria-label={label} className={cn('fx-pill-nav inline-flex', className)}>
      <LayoutGroup id={group}>
        <ul
          className="m-0 flex list-none items-center gap-1 rounded-full border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_80%,transparent)] p-1 backdrop-blur"
          onPointerLeave={() => setHovered(null)}
        >
          {items.map((item) => {
            const isActive = item.href === active;
            return (
              <li key={item.href} className="relative">
                {hovered === item.href && !isActive && (
                  <motion.span
                    layoutId="hover"
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)]"
                    transition={spring}
                  />
                )}
                {isActive && (
                  <motion.span
                    layoutId="active"
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full bg-[var(--color-primary)] text-primary-950 shadow-[0_6px_20px_-8px_var(--color-primary)]"
                    transition={spring}
                  />
                )}
                <a
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  onPointerEnter={() => setHovered(item.href)}
                  onFocus={() => setHovered(item.href)}
                  onBlur={() => setHovered(null)}
                  onClick={(e) => {
                    setClicked(item.href);
                    onNavigate?.(item.href, e);
                  }}
                  className={cn(
                    'relative z-10 block rounded-full px-4 py-2 text-sm font-medium outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
                    isActive
                      ? 'text-primary-950'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
                  )}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </LayoutGroup>
    </nav>
  );
}

export default PillNav;
