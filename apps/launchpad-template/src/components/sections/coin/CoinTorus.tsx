import { WovenTorus } from '@/components/library/backgrounds/WovenTorus';
import { cn } from '@/lib/utils';
import { Eyebrow, HEADING_FONT, MUTED, Section, useSectionId } from '../shared';
import { CoinAction, coinCopy, type CoinSectionProps } from './CoinSpotlight';

/**
 * The launchpad coin beside a ring woven from glowing threads that turns slowly and tilts towards
 * the pointer. Tech, premium and dark launchpads.
 */
export function CoinTorus(props: CoinSectionProps) {
  const copy = coinCopy(props);
  const id = useSectionId('coin');
  return (
    <Section labelledBy={id} className={props.className}>
      <div className="relative isolate grid min-h-[26rem] items-center overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] md:grid-cols-2">
        <div className="relative z-10 p-[clamp(1.5rem,4vw,3.5rem)]">
          <Eyebrow>{copy.eyebrow}</Eyebrow>
          <h2 id={id} className={cn(HEADING_FONT, 'text-[clamp(2.2rem,5vw,4rem)] leading-none')}>
            {copy.name}
          </h2>
          {copy.ticker ? (
            <p className="mt-3 font-mono text-sm tracking-[0.2em] text-[var(--color-primary)]">
              {copy.ticker}
            </p>
          ) : null}
          <p className={cn(MUTED, 'mt-5 max-w-[42ch] leading-relaxed')}>{copy.description}</p>
          <CoinAction
            href={copy.href}
            tradeAction={copy.tradeAction}
            pendingNote={copy.pendingNote}
            className="mt-8"
          />
        </div>
        <div aria-hidden="true" className="relative h-72 md:h-full">
          <WovenTorus followPointer x={0.5} />
        </div>
      </div>
    </Section>
  );
}

export default CoinTorus;
