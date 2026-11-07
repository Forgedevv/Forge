import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/utils';
import { FooterNav, footerCopy, type FooterProps } from './FooterWordmark';

/**
 * Footer on a single centred line: logo, links, then the legal note in small print. Minimal and
 * calm launchpads, or under a strong closing section.
 */
export function FooterMinimal(props: FooterProps) {
  const copy = footerCopy(props);
  return (
    <footer
      className={cn(
        'flex flex-col items-center gap-5 border-t border-[var(--color-border)] px-[var(--page-gutter)] py-10 text-center',
        props.className,
      )}
    >
      <Link href="/" aria-label={copy.name} className="inline-flex">
        <Logo className="h-7 w-7" />
      </Link>
      <FooterNav links={copy.links} className="[&_ul]:justify-center" />
      <p className="text-xs text-[var(--color-text-muted)]">
        {copy.note} · {copy.disclaimer}
      </p>
    </footer>
  );
}

export default FooterMinimal;
