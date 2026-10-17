import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { content } from '@/content';

type ThemeToggleProps = {
  className?: string;
};

export const ThemeToggle = ({ className }: ThemeToggleProps) => {
  const { resolvedTheme, setTheme } = useTheme();
  // The resolved theme is unknown during SSR: the icon and the mode-specific label only render
  // after mount, so the server and the first client render match (no hydration mismatch).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === 'dark';
  const label = !mounted
    ? content.strings.colorMode
    : isDark
      ? content.strings.lightMode
      : content.strings.darkMode;

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={cn(
        'flex h-9 w-9 shrink-0 cursor-pointer touch:h-10 touch:w-10 items-center justify-center rounded-full border border-neutral-800 text-neutral-300 transition-colors',
        'hover:bg-neutral-850 hover:text-neutral-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        className,
      )}
    >
      {mounted ? (
        <span
          className={cn('iconify h-[1.125rem] w-[1.125rem]', {
            'ph--moon-bold': isDark,
            'ph--sun-bold': !isDark,
          })}
        />
      ) : (
        <span className="h-[1.125rem] w-[1.125rem]" />
      )}
    </button>
  );
};

export default ThemeToggle;
