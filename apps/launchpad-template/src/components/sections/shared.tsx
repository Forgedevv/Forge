import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { content } from '@/content';
import { onchainConfig } from '@/forge/config';
import { cn } from '@/lib/utils';

/**
 * Building blocks shared by the section variants (FREE ZONE). Every section reads its copy from
 * `content` by default and takes the same copy as props, so a site can use it as is or override a
 * line. Colours, fonts and radii come from the theme variables only: a section follows the brand.
 */

/** Heading font with the tight tracking the sections share. */
export const HEADING_FONT = 'font-[family-name:var(--font-heading)] tracking-[-0.045em]';

/** Muted body text. */
export const MUTED = 'text-[var(--color-text-muted)]';

/** A stable id for `aria-labelledby`, unique even when a section appears twice on a page. */
export function useSectionId(name: string): string {
  return `${name}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

interface SectionProps {
  /** Id of the element that names the section (its heading). */
  labelledBy?: string;
  /** Accessible name when the section has no visible heading. */
  label?: string;
  /** Anchor for in-page links, for example `markets`. */
  id?: string;
  className?: string;
  children: ReactNode;
}

/** A page section with the site gutter and generous vertical rhythm. */
export function Section({ labelledBy, label, id, className, children }: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={cn(
        'relative isolate px-[var(--page-gutter)] py-[clamp(3.5rem,8vw,7rem)]',
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Small uppercase label above a heading. */
export function Eyebrow({ children, className }: { children?: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p
      className={cn(
        'mb-4 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-text-muted)]',
        className,
      )}
    >
      {children}
    </p>
  );
}

interface SectionTitleProps {
  id: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  align?: 'left' | 'center';
  className?: string;
}

/** Eyebrow, heading (`h2`) and optional intro of a section. */
export function SectionTitle({
  id,
  eyebrow,
  title,
  intro,
  align = 'left',
  className,
}: SectionTitleProps) {
  return (
    <header
      className={cn(
        'mb-[clamp(2rem,5vw,3.5rem)] max-w-3xl',
        align === 'center' && 'mx-auto text-center',
        className,
      )}
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2
        id={id}
        className={cn(HEADING_FONT, 'text-[clamp(2rem,4.6vw,3.75rem)] leading-[0.98] text-balance')}
      >
        {title}
      </h2>
      {intro ? (
        <p className={cn(MUTED, 'mt-5 max-w-[52ch] text-base leading-relaxed')}>{intro}</p>
      ) : null}
    </header>
  );
}

interface ActionProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/** Filled call to action in the brand colour, with the contrast text colour of the theme. */
export function PrimaryAction({ href, children, className }: ActionProps) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex min-h-11 items-center gap-3 rounded-[var(--radius)] bg-primary px-5 py-3 text-sm font-medium text-primary-950 transition duration-200 hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]',
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Outlined secondary action. */
export function GhostAction({ href, children, className }: ActionProps) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex min-h-11 items-center gap-3 rounded-[var(--radius)] border border-[var(--color-border)] px-5 py-3 text-sm text-[var(--color-text)] transition duration-200 hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Link of the launchpad coin page once FORGE wrote the coin in `forge.config.json`, else null. */
export function launchpadCoinHref(): string | null {
  const mint = onchainConfig?.launchpadCoinMint;
  return mint ? `/token/${encodeURIComponent(mint)}` : null;
}

/** First letters of a name or ticker, for monograms (coins, rings, ASCII art). */
export function monogramOf(value: string, length = 1): string {
  const letters = [...value.replace(/^\$/, '').trim()];
  return letters.slice(0, length).join('').toUpperCase() || 'F';
}

/** Copy every hero variant takes. */
export interface HeroCopy {
  name?: string;
  tagline?: string;
  eyebrow?: string;
  primaryAction?: string;
  secondaryAction?: string;
  /** One to three characters drawn by the 3D and ASCII heroes. Default: the first letter of `name`. */
  monogram?: string;
  className?: string;
}

/** Hero copy with the site defaults filled in. */
export function heroCopy(props: HeroCopy) {
  const name = props.name ?? content.name;
  return {
    name,
    tagline: props.tagline ?? content.tagline,
    eyebrow: props.eyebrow ?? content.strings.homeEyebrow,
    primaryAction: props.primaryAction ?? content.strings.createCoin,
    secondaryAction: props.secondaryAction ?? content.strings.homeAction,
    monogram: props.monogram ?? monogramOf(name),
  };
}

/** The two hero actions: create a coin, and explore the market. */
export function HeroActions({
  primary,
  secondary,
  className,
}: {
  primary: string;
  secondary: string;
  className?: string;
}) {
  return (
    <div className={cn('mt-8 flex flex-wrap items-center gap-3', className)}>
      <PrimaryAction href="/create-pool">
        {primary}
        <span aria-hidden="true">↗</span>
      </PrimaryAction>
      <GhostAction href="/#markets">
        {secondary}
        <span aria-hidden="true">↓</span>
      </GhostAction>
    </div>
  );
}

export type ValueItem = { icon?: string; title: string; body: string };
export type StepItem = { title: string; body: string };
export type FaqItem = { question: string; answer: string };

/** Links of the site, shared by the footer variants. */
export function footerLinks() {
  return [
    { href: '/#markets', label: content.strings.explore },
    { href: '/create-pool', label: content.strings.createCoin },
    { href: '/about', label: content.strings.aboutTitle },
    { href: '/creator-fees', label: content.strings.creatorFees },
  ];
}
