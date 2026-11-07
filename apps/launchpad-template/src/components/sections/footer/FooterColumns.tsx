import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED } from '../shared';
import { FooterNav, footerCopy, type FooterProps } from './FooterWordmark';

/**
 * Classic footer in three columns: logo, name and tagline; the site links stacked; the legal note.
 * Calm and tech launchpads, or any site that wants a quiet ending.
 */
export function FooterColumns(props: FooterProps) {
  const copy = footerCopy(props);
  return (
    <footer
      className={cn(
        'grid gap-10 border-t border-[var(--color-border)] px-[var(--page-gutter)] py-14 md:grid-cols-[1.4fr_1fr_1fr]',
        props.className,
      )}
    >
      <div>
        <Link href="/" className="inline-flex items-center gap-3">
          <Logo className="h-8 w-8" />
          <span className={cn(HEADING_FONT, 'text-2xl')}>{copy.name}</span>
        </Link>
        <p className={cn(MUTED, 'mt-4 max-w-[34ch] text-sm leading-relaxed')}>{copy.tagline}</p>
      </div>
      <FooterNav links={copy.links} className="[&_ul]:flex-col [&_ul]:gap-3" />
      <div className="flex flex-col gap-2 text-xs text-[var(--color-text-muted)] md:text-right">
        <span>{copy.note}</span>
        <span>{copy.disclaimer}</span>
      </div>
    </footer>
  );
}

export default FooterColumns;
