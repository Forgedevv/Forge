import '@fontsource/bebas-neue/index.css';
import '@fontsource/instrument-serif/index.css';
import '@fontsource-variable/fraunces/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import '@fontsource-variable/sora/index.css';
import '@fontsource-variable/space-grotesk/index.css';
import '@fontsource-variable/syne/index.css';
import '@fontsource-variable/unbounded/index.css';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { CoinRainBanner } from '@/components/sections/coin/CoinRainBanner';
import { CoinSpotlight } from '@/components/sections/coin/CoinSpotlight';
import { CoinTicker } from '@/components/sections/coin/CoinTicker';
import { CoinTorus } from '@/components/sections/coin/CoinTorus';
import { ClosingFilaments } from '@/components/sections/closing/ClosingFilaments';
import { ClosingGrid } from '@/components/sections/closing/ClosingGrid';
import { ClosingMagnetic } from '@/components/sections/closing/ClosingMagnetic';
import { ClosingMarquee } from '@/components/sections/closing/ClosingMarquee';
import { FaqAccordion } from '@/components/sections/faq/FaqAccordion';
import { FaqCards } from '@/components/sections/faq/FaqCards';
import { FaqSplit } from '@/components/sections/faq/FaqSplit';
import { FooterColumns } from '@/components/sections/footer/FooterColumns';
import { FooterMarquee } from '@/components/sections/footer/FooterMarquee';
import { FooterMinimal } from '@/components/sections/footer/FooterMinimal';
import { FooterWordmark } from '@/components/sections/footer/FooterWordmark';
import { HeroDotField } from '@/components/sections/hero/HeroDotField';
import { HeroHalo } from '@/components/sections/hero/HeroHalo';
import { HeroParticleField } from '@/components/sections/hero/HeroParticleField';
import { HeroPosterType } from '@/components/sections/hero/HeroPosterType';
import { HeroRetroGrid } from '@/components/sections/hero/HeroRetroGrid';
import { HeroSculpture } from '@/components/sections/hero/HeroSculpture';
import { HeroTerminal } from '@/components/sections/hero/HeroTerminal';
import { StepsRings } from '@/components/sections/steps/StepsRings';
import { StepsScrollStory } from '@/components/sections/steps/StepsScrollStory';
import { StepsStack } from '@/components/sections/steps/StepsStack';
import { StepsTimeline } from '@/components/sections/steps/StepsTimeline';
import { ValuesEditorial } from '@/components/sections/values/ValuesEditorial';
import { ValuesMarquee } from '@/components/sections/values/ValuesMarquee';
import { ValuesSpotlight } from '@/components/sections/values/ValuesSpotlight';
import { ValuesTilt } from '@/components/sections/values/ValuesTilt';

/**
 * Example sites, for FORGE only (excluded from the template repository): six imaginary launchpads,
 * each assembled from a different set of section variants, palette and font pairing, to show how
 * far apart two sites built from the same library can look. The market (FORGE component) sits
 * between the selling points and the steps on a real site; a placeholder marks its place here.
 */

interface ExampleSite {
  id: string;
  /** RGB triplets, as the theme stores them. */
  primary: string;
  accent: string;
  headingFont: string;
  bodyFont?: string;
  sections: (copy: { name: string }) => ReactNode;
  name: string;
  brief: string;
}

const MARKET = (
  <div className="mx-[var(--page-gutter)] grid h-40 place-items-center rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] text-xs uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
    Market (FORGE component)
  </div>
);

const SITES: readonly ExampleSite[] = [
  {
    id: 'moonpaw',
    name: 'Moonpaw',
    brief: 'Meme launchpad, loud and funny, cats on the moon.',
    primary: '190 242 100',
    accent: '168 85 247',
    headingFont: "'Bebas Neue', Impact, sans-serif",
    sections: () => (
      <>
        <HeroPosterType
          name="Moon Paw Club"
          tagline="Every cat deserves a moon. Launch yours before the next one does."
          eyebrow="MEME LAUNCHPAD"
          tickerWords={['No presale', 'Fair curve', 'Cats only', 'Moon or nap']}
        />
        <ValuesMarquee
          items={[
            { title: 'Zero presale', body: 'Every paw starts on the same curve. No insiders.' },
            { title: 'One-minute launch', body: 'Name, ticker, picture of your cat. Done.' },
            { title: 'Creators eat', body: 'A share of every trade goes to the creator.' },
          ]}
        />
        {MARKET}
        <StepsStack title="Three naps to the moon." />
        <CoinRainBanner
          name="Moonpaw"
          symbol="PAW"
          description="The coin of the club. Holders get bragging rights and nothing else."
        />
        <FaqCards title="Dumb questions welcome" />
        <ClosingMarquee title="Your cat is waiting." primaryAction="Launch a paw" />
        <FooterMarquee name="Moonpaw" />
      </>
    ),
  },
  {
    id: 'aurum',
    name: 'Aurum',
    brief: 'Luxury launchpad for curated, premium coins. Calm, gold, serif.',
    primary: '212 175 55',
    accent: '232 220 196',
    headingFont: "'Instrument Serif', Georgia, serif",
    sections: () => (
      <>
        <HeroSculpture
          name="Aurum"
          tagline="A quiet place for coins made with care. Every launch is reviewed by its community."
          eyebrow="CURATED LAUNCHES"
          shape="gem"
        />
        <ValuesEditorial
          eyebrow="WHY AURUM"
          title="Fewer coins. Better ones."
          items={[
            { title: 'Curated', body: 'A short, public brief for every coin before it goes live.' },
            {
              title: 'Fair',
              body: 'The same transparent curve for everyone, from the first trade.',
            },
            { title: 'Rewarded', body: 'Creators earn from every trade and claim at any time.' },
          ]}
        />
        {MARKET}
        <StepsScrollStory title="How a coin earns its place." />
        <CoinSpotlight
          name="Aurum"
          symbol="AUR"
          description="The house coin, launched first and held to the same standard as every other."
        />
        <FaqSplit intro="Anything else? Write to the curators." />
        <ClosingFilaments title="Bring something worth keeping." />
        <FooterWordmark name="Aurum" />
      </>
    ),
  },
  {
    id: 'synthwave',
    name: 'Neon Arcade',
    brief: 'Retro arcade launchpad, 80s neon, playful.',
    primary: '236 72 153',
    accent: '34 211 238',
    headingFont: "'Unbounded Variable', 'Arial Black', sans-serif",
    sections: () => (
      <>
        <HeroRetroGrid
          name="Neon Arcade"
          tagline="Insert coin. Every launch is a new high score on the same fair curve."
          eyebrow="PLAYER ONE READY"
        />
        <ValuesTilt
          items={[
            {
              icon: 'ph--game-controller-bold',
              title: 'Press start',
              body: 'Your coin trades the second it exists.',
            },
            {
              icon: 'ph--trophy-bold',
              title: 'Fair play',
              body: 'No presale, no hidden allocation, no cheats.',
            },
            {
              icon: 'ph--coins-bold',
              title: 'Bonus points',
              body: 'Creators earn a share of every trade.',
            },
          ]}
        />
        {MARKET}
        <StepsRings title="Three levels to graduation." />
        <CoinTicker
          name="Arcade Token"
          symbol="ARC"
          description="The token of the arcade. It went live with the very first credit."
        />
        <FaqCards title="Cheat sheet" />
        <ClosingGrid
          title="Game on."
          body="One minute to launch. Every trade after that is in the open."
        />
        <FooterMarquee name="Neon Arcade" />
      </>
    ),
  },
  {
    id: 'nodeworks',
    name: 'Nodeworks',
    brief: 'Builder and AI-agent coins, technical and precise.',
    primary: '45 212 191',
    accent: '129 140 248',
    headingFont: "'Space Grotesk Variable', system-ui, sans-serif",
    bodyFont: "'Space Grotesk Variable', system-ui, sans-serif",
    sections: () => (
      <>
        <HeroTerminal
          name="Nodeworks"
          tagline="Launch infrastructure for agent coins."
          eyebrow="SYSTEM ONLINE"
          monogram="N"
          phrases={['launch --fair --curve', 'route fees --creator', 'graduate --to open-pool']}
        />
        <ValuesSpotlight
          title="Built like infrastructure."
          eyebrow="SPEC"
          items={[
            {
              icon: 'ph--cpu-bold',
              title: 'Deterministic launches',
              body: 'Same curve, same rules, every time. Readable on-chain.',
            },
            {
              icon: 'ph--shield-check-bold',
              title: 'No presale',
              body: 'Supply starts on the curve.',
            },
            {
              icon: 'ph--git-branch-bold',
              title: 'Fees routed',
              body: 'Creators claim their share whenever they want.',
            },
          ]}
        />
        {MARKET}
        <StepsTimeline title="Deploy in three steps." />
        <CoinTorus
          name="Nodeworks"
          symbol="NODE"
          description="Network coin of the launchpad. Same rules as every coin on it."
        />
        <FaqSplit />
        <ClosingMagnetic title="Ship your agent's coin." />
        <FooterColumns name="Nodeworks" tagline="Launch infrastructure for agent coins." />
      </>
    ),
  },
  {
    id: 'nebula',
    name: 'Nebula',
    brief: 'Space-themed, premium, dark, a bit mysterious.',
    primary: '129 140 248',
    accent: '244 114 182',
    headingFont: "'Syne Variable', 'Avenir Next', sans-serif",
    sections: () => (
      <>
        <HeroParticleField
          name="Nebula"
          tagline="Coins are born here. Some of them become stars."
          eyebrow="SIGNAL ACQUIRED"
        />
        <ValuesSpotlight />
        {MARKET}
        <StepsStack title="From dust to star." />
        <CoinSpotlight
          name="Nebula"
          symbol="NEB"
          description="The first star of the nebula, launched with the launchpad itself."
        />
        <FaqAccordion title="Transmissions" />
        <ClosingFilaments title="Light the next one." />
        <FooterWordmark name="Nebula" />
      </>
    ),
  },
  {
    id: 'driftwood',
    name: 'Driftwood',
    brief: 'Community coins for a slow, nature-loving crowd. Calm, organic.',
    primary: '134 179 120',
    accent: '232 196 140',
    headingFont: "'Fraunces Variable', Georgia, serif",
    sections: () => (
      <>
        <HeroDotField
          name="Driftwood"
          tagline="Small coins for slow communities. Nothing to rush."
          eyebrow="A CALMER LAUNCHPAD"
          words={['made slowly', 'shared fairly', 'kept honest']}
        />
        <ValuesEditorial />
        {MARKET}
        <StepsTimeline title="Three quiet steps." />
        <CoinTicker
          name="Driftwood"
          symbol="DRIFT"
          description="The coin that carries the place. It launched on the same curve as yours."
        />
        <FaqAccordion title="Good to know" />
        <ClosingMagnetic title="Plant something." />
        <FooterMinimal name="Driftwood" />
      </>
    ),
  },
  {
    id: 'halo',
    name: 'Halo',
    brief: 'Clean, bright, confident. A launchpad for brands.',
    primary: '250 204 21',
    accent: '96 165 250',
    headingFont: "'Sora Variable', system-ui, sans-serif",
    sections: () => (
      <>
        <HeroHalo
          name="Halo"
          tagline="Launch a coin your community will be proud to hold."
          eyebrow="FOR BRANDS"
        />
        <ValuesTilt />
        {MARKET}
        <StepsRings title="Live in three steps." />
        <CoinTorus name="Halo" symbol="HALO" description="The coin of the Halo community." />
        <FaqCards />
        <ClosingMagnetic title="Your brand, on-chain." />
        <FooterColumns name="Halo" tagline="Launch a coin your community will be proud to hold." />
      </>
    ),
  },
];

export default function ExampleSites() {
  const router = useRouter();
  const requested = typeof router.query.site === 'string' ? router.query.site : undefined;
  const site = SITES.find((entry) => entry.id === requested) ?? SITES[0]!;

  // Canvas and 3D effects read the colours on the document root: mirror the site palette there.
  useEffect(() => {
    const root = document.documentElement.style;
    const entries: [string, string][] = [
      ['--primary', site.primary],
      ['--accent', site.accent],
      ['--color-primary', `rgb(${site.primary})`],
      ['--color-accent', `rgb(${site.accent})`],
      ['--font-heading', site.headingFont],
    ];
    for (const [name, value] of entries) root.setProperty(name, value);
    return () => {
      for (const [name] of entries) root.removeProperty(name);
    };
  }, [site]);

  const style = {
    '--primary': site.primary,
    '--accent': site.accent,
    '--color-primary': `rgb(${site.primary})`,
    '--color-accent': `rgb(${site.accent})`,
    '--font-heading': site.headingFont,
    ...(site.bodyFont ? { '--font-body': site.bodyFont, fontFamily: site.bodyFont } : {}),
  } as CSSProperties;

  return (
    <div className="dark min-h-screen bg-background text-foreground" style={style}>
      <Head>
        <title>{`${site.name} — FORGE example`}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <nav
        aria-label="Example sites"
        className="sticky top-0 z-40 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-background/85 px-4 py-2 text-xs backdrop-blur"
      >
        <span className="mr-2 font-semibold">FORGE examples</span>
        {SITES.map((entry) => (
          <Link
            key={entry.id}
            href={`/examples?site=${entry.id}`}
            aria-current={entry.id === site.id ? 'page' : undefined}
            className="rounded-full border border-[var(--color-border)] px-3 py-1 aria-[current=page]:border-[var(--color-primary)] aria-[current=page]:text-[var(--color-primary)]"
          >
            {entry.name}
          </Link>
        ))}
        <span className="ml-auto hidden text-[var(--color-text-muted)] md:inline">
          Brief: {site.brief}
        </span>
      </nav>
      <main key={site.id} className="mx-auto max-w-[var(--content-width)]">
        {site.sections({ name: site.name })}
      </main>
    </div>
  );
}
