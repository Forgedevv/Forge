import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { content } from '@/content';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './ThemeToggle';
import { useDismiss } from './ui/useDismiss';

/**
 * Site navigation on phones and small tablets (the header shows the links inline from `md`). A
 * menu button opens a panel under the header with the site links and the theme toggle. It closes
 * on Escape (focus back on the button), on a press outside, when focus leaves it, and when a link
 * is followed. Styled with the theme variables (`launchpad-mobile-menu*` in theme.css).
 */
export const MobileNav = ({ className }: { className?: string }) => {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, button, panel);

  // Opening moves focus to the first link.
  useEffect(() => {
    if (open) panel.current?.querySelector('a')?.focus();
  }, [open]);

  // Back and forward navigation closes the menu too.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('popstate', close);
    window.addEventListener('hashchange', close);
    return () => {
      window.removeEventListener('popstate', close);
      window.removeEventListener('hashchange', close);
    };
  }, [open, close]);

  return (
    <div className={cn('md:hidden', className)}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? content.strings.closeMenu : content.strings.openMenu}
        onClick={() => setOpen((value) => !value)}
        className="launchpad-menu-button flex h-10 w-10 shrink-0 items-center justify-center"
      >
        <span
          aria-hidden="true"
          className={cn('iconify h-5 w-5', open ? 'ph--x-bold' : 'ph--list-bold')}
        />
      </button>
      <div
        ref={panel}
        id={panelId}
        hidden={!open}
        className="launchpad-mobile-menu absolute inset-x-0 top-full border-b"
      >
        <nav aria-label={content.strings.menuLabel} className="launchpad-mobile-menu-inner">
          {/* Links written one by one: the site scan reads every link target. */}
          <ul className="flex flex-col">
            <li>
              <Link href="/" onClick={close} className="launchpad-mobile-menu-link">
                {content.strings.explore}
              </Link>
            </li>
            <li>
              <Link href="/about" onClick={close} className="launchpad-mobile-menu-link">
                {content.strings.aboutTitle}
              </Link>
            </li>
            <li>
              <Link href="/creator-fees" onClick={close} className="launchpad-mobile-menu-link">
                {content.strings.creatorFees}
              </Link>
            </li>
          </ul>
          <div className="launchpad-mobile-menu-row">
            <span>{content.strings.themeLabel}</span>
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </div>
  );
};

export default MobileNav;
