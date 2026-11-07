import { SplitReveal } from '@/components/library/text/SplitReveal';
import { cn } from '@/lib/utils';
import { Eyebrow, HEADING_FONT, MUTED, Section, useSectionId } from '../shared';
import { CoinAction, coinCopy, type CoinSectionProps } from './CoinSpotlight';

/**
 * The launchpad coin as pure type: its ticker in giant outlined letters that drop in one by one,
 * the name and description beneath. Bold, retro and editorial launchpads. Light: no canvas.
 */
export function CoinTicker(props: CoinSectionProps) {
  const copy = coinCopy(props);
  const id = useSectionId('coin');
  const big = copy.ticker || copy.name;
  return (
    <Section labelledBy={id} className={cn('overflow-hidden', props.className)}>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <p
        aria-hidden="true"
        className={cn(
          HEADING_FONT,
          'text-[clamp(4rem,17vw,15rem)] uppercase leading-[0.82] text-transparent [-webkit-text-stroke:1.5px_var(--color-primary)] [overflow-wrap:anywhere]',
        )}
      >
        <SplitReveal as="span" text={big} effect="drop" className="block" />
      </p>
      <div className="mt-8 grid gap-6 border-t border-[var(--color-border)] pt-6 md:grid-cols-[1fr_1fr_auto] md:items-start">
        <h2 id={id} className={cn(HEADING_FONT, 'text-[clamp(1.6rem,3vw,2.4rem)] leading-tight')}>
          {copy.name}
        </h2>
        <p className={cn(MUTED, 'max-w-[44ch] leading-relaxed')}>{copy.description}</p>
        <CoinAction
          href={copy.href}
          tradeAction={copy.tradeAction}
          pendingNote={copy.pendingNote}
        />
      </div>
    </Section>
  );
}

export default CoinTicker;
