import Link from 'next/link';
import { content } from '@/content';
import { MaskLines } from '@/components/library/text/MaskLines';
import { cn } from '@/lib/utils';
import { HEADING_FONT, MUTED, footerLinks } from '../shared';

export interface FooterProps {
  name?: string;
  tagline?: string;
  note?: string;
  disclaimer?: string;
  /** Site links. Default: market, create, about and creator fees. */
  links?: readonly { href: string; label: string }[];
  className?: string;
}

/** Copy of a footer with the site defaults filled in. */
export function footerCopy(props: FooterProps) {
  return {
    name: props.name ?? content.name,
    tagline: props.tagline ?? content.tagline,
    note: props.note ?? content.footer.note,
    disclaimer: props.disclaimer ?? content.footer.disclaimer,
    links: props.links ?? footerLinks(),
  };
}

/** The site links as a row (or wrapped lines on phones). */
export function FooterNav({
  links,
  className,
}: {
  links: readonly { href: string; label: string }[];
  className?: string;
}) {
  return (
    <nav aria-label={content.strings.footerNavLabel} className={className}>
      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Footer that signs the site with its name in giant type across the full width, uncovered like a
 * curtain when it scrolls into view; links and the legal note sit above. Bold, editorial and
 * premium launchpads.
 */
export function FooterWordmark(props: FooterProps) {
  const copy = footerCopy(props);
  return (
    <footer
      className={cn(
        'overflow-hidden border-t border-[var(--color-border)] px-[var(--page-gutter)] pt-12',
        props.className,
      )}
    >
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <p className={cn(MUTED, 'max-w-[36ch] text-sm leading-relaxed')}>{copy.tagline}</p>
        <FooterNav links={copy.links} />
      </div>
      <div className="mt-10 flex flex-wrap justify-between gap-2 text-xs text-[var(--color-text-muted)]">
        <span>{copy.note}</span>
        <span>{copy.disclaimer}</span>
      </div>
      <MaskLines
        as="p"
        effect="curtain"
        lines={[copy.name]}
        className={cn(
          HEADING_FONT,
          'mt-6 text-[clamp(3.5rem,15vw,15rem)] leading-[0.82] text-[var(--color-text)] [overflow-wrap:anywhere]',
        )}
      />
    </footer>
  );
}

export default FooterWordmark;
