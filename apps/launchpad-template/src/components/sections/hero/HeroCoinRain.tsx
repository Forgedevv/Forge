import { content } from '@/content';
import { SplitReveal } from '@/components/library/text/SplitReveal';
import { CoinRain } from '@/components/library/three/CoinRain';
import { cn } from '@/lib/utils';
import { HEADING_FONT, HeroActions, MUTED, Section, heroCopy, type HeroCopy } from '../shared';

export interface HeroCoinRainProps extends HeroCopy {
  /** Number of falling coins, 6 to 120. Default 44. */
  count?: number;
}

/**
 * Hero: a launch-day poster. 3D coins stamped with the monogram tumble down the whole hero behind
 * a framed poster on the page colour, where the name drops in letter by letter between two rules
 * of small print. Playful and bold launchpads, meme coins and loud briefs.
 */
export function HeroCoinRain({ count = 44, ...props }: HeroCoinRainProps) {
  const copy = heroCopy(props);
  const points = content.values.map((value) => value.title);
  return (
    <Section
      label={copy.name}
      className={cn(
        'flex min-h-[min(96vh,60rem)] flex-col items-center justify-center overflow-hidden py-[clamp(4rem,10vw,8rem)]',
        props.className,
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        <CoinRain monogram={copy.monogram} count={count} />
      </div>
      <div className="w-full max-w-4xl border-2 border-[var(--color-text)] bg-[var(--color-bg)] p-2 shadow-[8px_8px_0_0_var(--color-primary)] md:shadow-[12px_12px_0_0_var(--color-primary)]">
        <div className="border border-[var(--color-border)] px-[clamp(1.25rem,5vw,3.5rem)] py-[clamp(1.5rem,5vw,3.5rem)] text-center">
          <p className="flex items-center justify-between gap-4 border-b border-[var(--color-border)] pb-3 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
            <span>{copy.eyebrow}</span>
            <span aria-hidden="true">{content.strings.network}</span>
          </p>
          <SplitReveal
            as="h1"
            text={copy.name}
            effect="drop"
            className={cn(
              HEADING_FONT,
              'mx-auto mt-[clamp(1.5rem,4vw,2.5rem)] max-w-[12ch] text-[clamp(3rem,11vw,9rem)] uppercase leading-[0.86] [overflow-wrap:anywhere]',
            )}
          />
          <p
            className={cn(
              MUTED,
              'mx-auto mt-6 max-w-[40ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed',
            )}
          >
            {copy.tagline}
          </p>
          <HeroActions
            primary={copy.primaryAction}
            secondary={copy.secondaryAction}
            className="justify-center"
          />
          <ul className="mt-[clamp(1.5rem,4vw,2.5rem)] flex flex-wrap justify-center gap-x-5 gap-y-2 border-t border-[var(--color-border)] pt-3 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
            {points.map((point) => (
              <li key={point} className="flex items-center gap-5">
                <span aria-hidden="true" className="text-[var(--color-primary)]">
                  ✦
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

export default HeroCoinRain;
