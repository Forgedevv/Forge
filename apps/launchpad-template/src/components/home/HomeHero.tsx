import Link from 'next/link';
import { content } from '@/content';
import { MintSculpture } from '../MintSculpture';

/**
 * Home hero (FREE ZONE, presentational): launchpad name, tagline, the two main actions and the
 * illustration. Restyle or recompose it freely; keep a link to `/create-pool`.
 */
export function HomeHero() {
  return (
    <section className="launchpad-hero" aria-labelledby="launchpad-home-title">
      <div className="launchpad-hero-copy">
        <p className="launchpad-eyebrow">{content.strings.homeEyebrow}</p>
        <h1 id="launchpad-home-title">
          {content.name}
          <span className="launchpad-title-period">.</span>
        </h1>
        <p className="launchpad-hero-tagline">{content.tagline}</p>
        <div className="launchpad-hero-actions">
          <Link href="/create-pool" className="launchpad-hero-create">
            {content.strings.createCoin}
            <span aria-hidden="true">↗</span>
          </Link>
          <Link href="#markets" className="launchpad-hero-link">
            {content.strings.homeAction}
            <span aria-hidden="true">↓</span>
          </Link>
        </div>
      </div>
      <MintSculpture monogram={content.name.slice(0, 1)} />
    </section>
  );
}

export default HomeHero;
