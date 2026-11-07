import { content } from '@/content';
import { ShimmerText } from '@/components/library/text/ShimmerText';
import { FloatingCoin } from '@/components/library/three/FloatingCoin';
import { cn } from '@/lib/utils';
import {
  Eyebrow,
  HEADING_FONT,
  MUTED,
  PrimaryAction,
  Section,
  launchpadCoinHref,
  monogramOf,
  useSectionId,
} from '../shared';

export interface CoinSectionProps {
  eyebrow?: string;
  name?: string;
  symbol?: string;
  description?: string;
  tradeAction?: string;
  pendingNote?: string;
  className?: string;
}

/** Copy of a launchpad coin section with the site defaults and the coin link filled in. */
export function coinCopy(props: CoinSectionProps) {
  const base = content.launchpadCoin;
  const name = props.name ?? base.name;
  const symbol = props.symbol ?? base.symbol;
  return {
    eyebrow: props.eyebrow ?? base.eyebrow,
    name,
    symbol,
    ticker: symbol ? `$${symbol}` : '',
    monogram: monogramOf(symbol || name),
    description: props.description ?? base.description,
    tradeAction: props.tradeAction ?? base.tradeAction,
    pendingNote: props.pendingNote ?? base.pendingNote,
    href: launchpadCoinHref(),
  };
}

/** The trade link once the coin exists, else the "trading opens at launch" note. */
export function CoinAction({
  href,
  tradeAction,
  pendingNote,
  className,
}: {
  href: string | null;
  tradeAction: string;
  pendingNote: string;
  className?: string;
}) {
  return href ? (
    <PrimaryAction href={href} className={className}>
      {tradeAction}
      <span aria-hidden="true">↗</span>
    </PrimaryAction>
  ) : (
    <p
      className={cn(
        'inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]"
      />
      {pendingNote}
    </p>
  );
}

/**
 * The launchpad coin on a stage: a 3D coin stamped with its ticker spins in a pool of light, the
 * ticker flows in the brand gradient. The centrepiece of a playful or premium home page.
 */
export function CoinSpotlight(props: CoinSectionProps) {
  const copy = coinCopy(props);
  const id = useSectionId('coin');
  return (
    <Section labelledBy={id} className={props.className}>
      <div className="grid items-center gap-8 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[clamp(1.5rem,4vw,3.5rem)] md:grid-cols-[0.9fr_1.1fr]">
        <div className="relative mx-auto aspect-square w-full max-w-[22rem]">
          <div
            aria-hidden="true"
            className="absolute inset-[10%] rounded-full bg-[radial-gradient(circle,rgb(var(--accent)/0.35),transparent_70%)] blur-2xl"
          />
          <FloatingCoin monogram={copy.monogram} sparkles />
        </div>
        <div>
          <Eyebrow>{copy.eyebrow}</Eyebrow>
          <h2 id={id} className={cn(HEADING_FONT, 'text-[clamp(2.2rem,5vw,4rem)] leading-none')}>
            {copy.name}
          </h2>
          {copy.ticker ? (
            <p className={cn(HEADING_FONT, 'mt-3 text-[clamp(1.4rem,3vw,2.2rem)]')}>
              <ShimmerText variant="gradient">{copy.ticker}</ShimmerText>
            </p>
          ) : null}
          <p className={cn(MUTED, 'mt-5 max-w-[46ch] leading-relaxed')}>{copy.description}</p>
          <CoinAction
            href={copy.href}
            tradeAction={copy.tradeAction}
            pendingNote={copy.pendingNote}
            className="mt-8"
          />
        </div>
      </div>
    </Section>
  );
}

export default CoinSpotlight;
