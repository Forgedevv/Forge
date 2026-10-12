import Link from 'next/link';
import { content } from '@/content';
import { Logo } from './Logo';

/**
 * Site footer (FREE ZONE, presentational): logo, tagline, site links and a short note. Rendered by
 * `ui/Page` on every free-zone page and by the app shell around the creator fee page.
 */
export function SiteFooter() {
  return (
    <footer className="launchpad-footer">
      <div className="launchpad-footer-brand">
        <Link href="/" className="launchpad-footer-home">
          <Logo className="launchpad-footer-logo" />
          <span>{content.name}</span>
        </Link>
        <p>{content.tagline}</p>
      </div>
      <nav className="launchpad-footer-nav" aria-label={content.strings.footerNavLabel}>
        <Link href="/#markets" className="launchpad-nav-link">
          {content.strings.explore}
        </Link>
        <Link href="/create-pool" className="launchpad-nav-link">
          {content.strings.createCoin}
        </Link>
        <Link href="/about" className="launchpad-nav-link">
          {content.strings.aboutTitle}
        </Link>
        <Link href="/creator-fees" className="launchpad-nav-link">
          {content.strings.creatorFees}
        </Link>
      </nav>
      <div className="launchpad-footer-meta">
        <span>{content.footer.note}</span>
        <span>{content.footer.disclaimer}</span>
      </div>
    </footer>
  );
}

export default SiteFooter;
