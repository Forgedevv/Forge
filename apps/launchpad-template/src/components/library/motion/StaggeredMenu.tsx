import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { isExternalHref, safeHref } from '../shared/safeHref';
import { EASE_CURTAIN, EASE_EXPO, useCalm } from './internal';

export interface StaggeredMenuLink {
  label: string;
  /** A path of this site or an allowed social or explorer page (`safeHref`); others are left out. */
  href: string;
}

export interface StaggeredMenuProps {
  /** Main links, shown big and numbered. */
  items: readonly StaggeredMenuLink[];
  /** Small links at the bottom of the panel (X, Telegram, docs). */
  socials?: readonly StaggeredMenuLink[];
  /** Accessible name of the panel. Default "Menu". */
  label?: string;
  /**
   * Keep the panel inside the nearest positioned parent instead of covering the window. Used by
   * the showcase demo; a site header normally leaves it off.
   */
  contained?: boolean;
  /** Side the panel comes from. Default `right`. */
  side?: 'left' | 'right';
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
 * A full-height menu that opens in layers: two bands of the brand colours sweep across, then the
 * panel lands and its big numbered links rise one after the other. The button morphs into a cross.
 * For the site header on every screen size, or as the mobile menu of a bolder launchpad. Escape
 * closes it, focus stays inside while open and returns to the button after; it simply appears for
 * reduced motion.
 */
export function StaggeredMenu({
  items: rawItems,
  socials: rawSocials = [],
  label = 'Menu',
  contained = false,
  side = 'right',
  className,
}: StaggeredMenuProps) {
  // Only paths of this site and allowed social or explorer pages.
  const items = safeLinks(rawItems);
  const socials = safeLinks(rawSocials);
  const calm = useCalm();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);
  const dir = side === 'right' ? 1 : -1;

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => firstLink.current?.focus(), calm ? 0 : 350);
    let restore: string | undefined;
    if (!contained) {
      restore = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
    }
    return () => {
      window.clearTimeout(t);
      if (restore !== undefined) document.documentElement.style.overflow = restore;
    };
  }, [open, calm, contained]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab' || !root.current) return;
    // Keep Tab inside the button and the panel while the menu is open.
    const focusable = Array.from(
      root.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const slide = (delay: number) => ({
    initial: { x: `${dir * 100}%` },
    animate: { x: '0%', transition: { duration: calm ? 0 : 0.7, ease: EASE_CURTAIN, delay } },
    exit: {
      x: `${dir * 100}%`,
      transition: {
        duration: calm ? 0 : 0.5,
        ease: EASE_CURTAIN,
        delay: calm ? 0 : 0.1 - delay / 3,
      },
    },
  });
  const position = contained ? 'absolute' : 'fixed';
  const edge = side === 'right' ? 'right-0' : 'left-0';

  return (
    <div ref={root} onKeyDown={onKeyDown} className={cn('fx-staggered-menu', className)}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
        className="relative z-[61] inline-flex h-10 items-center gap-3 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-text)]"
      >
        <span>{open ? 'Close' : label}</span>
        <span aria-hidden="true" className="relative block h-3 w-4">
          {[0, 1].map((line) => (
            <span
              key={line}
              className="absolute left-0 block h-[2px] w-full rounded-full bg-current"
              style={{
                top: open ? 5 : line * 10,
                transform: open ? `rotate(${line ? -45 : 45}deg)` : 'none',
                transition: calm ? 'none' : 'top 0.3s, transform 0.4s 0.1s',
              }}
            />
          ))}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="menu"
            className={cn(position, 'inset-0 z-[60] overflow-hidden')}
            initial={{ opacity: 1 }}
            exit={{ opacity: 1, transition: { duration: calm ? 0 : 0.7 } }}
          >
            <motion.button
              type="button"
              tabIndex={-1}
              aria-label="Close menu"
              onClick={close}
              className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-bg)_55%,transparent)] backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: calm ? 0 : 0.4 } }}
              exit={{ opacity: 0, transition: { duration: calm ? 0 : 0.4, delay: calm ? 0 : 0.2 } }}
            />
            {/* Two coloured bands sweep in ahead of the panel. */}
            {['var(--color-primary)', 'var(--color-accent)'].map((color, i) => (
              <motion.div
                key={color}
                aria-hidden="true"
                className={cn('absolute inset-y-0 w-full max-w-md', edge)}
                style={{ background: color }}
                {...slide(i * 0.07)}
              />
            ))}
            <motion.div
              id={panelId}
              role="dialog"
              aria-modal="true"
              aria-label={label}
              className={cn(
                'absolute inset-y-0 flex w-full max-w-md flex-col justify-between bg-[var(--color-surface)] px-8 pb-8 pt-20',
                edge,
              )}
              {...slide(0.14)}
            >
              <ol className="m-0 flex list-none flex-col gap-1 p-0">
                {items.map((item, i) => (
                  <li key={item.href} className="overflow-hidden">
                    <motion.a
                      ref={i === 0 ? firstLink : undefined}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className="group flex items-baseline gap-3 py-1 text-4xl font-semibold leading-tight text-[var(--color-text)] outline-none transition-colors hover:text-[var(--color-primary)] focus-visible:text-[var(--color-primary)]"
                      style={{ fontFamily: 'var(--font-heading)' }}
                      initial={{ y: '110%', rotate: 4 }}
                      animate={{
                        y: '0%',
                        rotate: 0,
                        transition: {
                          duration: calm ? 0 : 0.9,
                          ease: EASE_EXPO,
                          delay: calm ? 0 : 0.32 + i * 0.07,
                        },
                      }}
                    >
                      <span className="font-mono text-xs text-[var(--color-accent)]">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {item.label}
                    </motion.a>
                  </li>
                ))}
              </ol>
              {socials.length > 0 && (
                <motion.ul
                  className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 border-t border-[var(--color-border)] p-0 pt-5 text-sm"
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: 1,
                    transition: { duration: calm ? 0 : 0.5, delay: calm ? 0 : 0.6 },
                  }}
                >
                  {socials.map((s) => (
                    <li key={s.href}>
                      <a
                        href={s.href}
                        rel={isExternalHref(s.href) ? 'noopener noreferrer' : undefined}
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                      >
                        {s.label}
                      </a>
                    </li>
                  ))}
                </motion.ul>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default StaggeredMenu;
