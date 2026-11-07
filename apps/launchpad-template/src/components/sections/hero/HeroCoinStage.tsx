import { SplitReveal } from '@/components/library/text/SplitReveal';
import { FloatingCoin } from '@/components/library/three/FloatingCoin';
import { cn } from '@/lib/utils';
import {
  Eyebrow,
  HEADING_FONT,
  HeroActions,
  MUTED,
  Section,
  heroCopy,
  useSectionId,
  type HeroCopy,
} from '../shared';

/** Letters of the ring around the coin: the name repeated until the circle is full. */
function ringLetters(name: string): string[] {
  const unit = `${name.toUpperCase()} ✦ `;
  const repeat = Math.max(2, Math.ceil(52 / unit.length));
  return Array.from(unit.repeat(repeat));
}

/**
 * Hero: a giant 3D coin stamped with the monogram turns centre stage inside a slow ring of the
 * name set in small capitals; the name lands in huge type right under it. Playful, bold and
 * premium launchpads: the coin is the whole show.
 */
export function HeroCoinStage(props: HeroCopy) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  const letters = ringLetters(copy.name);
  const step = 360 / letters.length;
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[min(96vh,60rem)] flex-col items-center justify-center overflow-hidden text-center',
        props.className,
      )}
    >
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <div className="relative aspect-square w-[min(78vw,30rem)]">
        {/* Crisp rings and the name turning around the coin. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-full border border-[var(--color-border)]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-[9%] rounded-full border border-dashed border-[color-mix(in_srgb,var(--color-primary)_45%,transparent)]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-[2.5%] animate-[spin_60s_linear_infinite] font-mono text-[clamp(0.6rem,1.6vw,0.8rem)] font-medium text-[var(--color-text-muted)] motion-reduce:animate-none"
        >
          {letters.map((letter, index) => (
            <span
              key={index}
              className="absolute left-1/2 top-0 -ml-[0.5ch] h-1/2 w-[1ch] origin-bottom text-center"
              style={{ transform: `rotate(${(index * step).toFixed(2)}deg)` }}
            >
              {letter}
            </span>
          ))}
        </div>
        <div
          aria-hidden="true"
          className="absolute inset-x-[22%] bottom-[8%] h-[8%] rounded-[50%] bg-[radial-gradient(closest-side,rgb(var(--primary)/0.35),transparent)]"
        />
        <div aria-hidden="true" className="absolute inset-[12%]">
          <FloatingCoin monogram={copy.monogram} sparkles={false} />
        </div>
      </div>
      <h1
        id={id}
        className={cn(
          HEADING_FONT,
          'relative z-10 mt-[clamp(0.5rem,2vw,1.5rem)] max-w-[14ch] text-[clamp(3rem,11vw,9.5rem)] uppercase leading-[0.86] [overflow-wrap:anywhere]',
        )}
      >
        <SplitReveal as="span" text={copy.name} className="block" />
      </h1>
      <p
        className={cn(MUTED, 'mt-6 max-w-[40ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed')}
      >
        {copy.tagline}
      </p>
      <HeroActions
        primary={copy.primaryAction}
        secondary={copy.secondaryAction}
        className="justify-center"
      />
    </Section>
  );
}

export default HeroCoinStage;
