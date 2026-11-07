import { CoinRain } from '@/components/library/three/CoinRain';
import { cn } from '@/lib/utils';
import { Eyebrow, HEADING_FONT, MUTED, Section, useSectionId } from '../shared';
import { CoinAction, coinCopy, type CoinSectionProps } from './CoinSpotlight';

/**
 * The launchpad coin as a celebration banner: 3D coins stamped with its ticker tumble down behind
 * a centred name and the trade button. Playful, meme and bold launchpads.
 */
export function CoinRainBanner(props: CoinSectionProps) {
  const copy = coinCopy(props);
  const id = useSectionId('coin');
  return (
    <Section labelledBy={id} className={props.className}>
      <div className="relative isolate flex min-h-[28rem] flex-col items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-16 text-center">
        <div aria-hidden="true" className="absolute inset-0 -z-10">
          <CoinRain monogram={copy.monogram} count={36} />
        </div>
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,var(--color-surface)_25%,transparent_75%)]"
        />
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h2 id={id} className={cn(HEADING_FONT, 'text-[clamp(2.4rem,6vw,5rem)] leading-none')}>
          {copy.name}
          {copy.ticker ? (
            <span className="ml-3 text-[0.5em] text-[var(--color-primary)]">{copy.ticker}</span>
          ) : null}
        </h2>
        <p className={cn(MUTED, 'mt-5 max-w-[46ch] leading-relaxed')}>{copy.description}</p>
        <CoinAction
          href={copy.href}
          tradeAction={copy.tradeAction}
          pendingNote={copy.pendingNote}
          className="mt-8"
        />
      </div>
    </Section>
  );
}

export default CoinRainBanner;
