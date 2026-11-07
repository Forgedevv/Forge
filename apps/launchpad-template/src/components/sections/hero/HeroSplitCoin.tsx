import { BlurWords } from '@/components/library/text/BlurWords';
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

/**
 * Hero: the name rises letter by letter beside a spinning 3D coin stamped with the monogram, the
 * tagline comes into focus word by word. Playful to premium, depending on the palette and font.
 */
export function HeroSplitCoin(props: HeroCopy) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  return (
    <Section
      labelledBy={id}
      className={cn(
        'grid min-h-[min(88vh,52rem)] items-center gap-8 md:grid-cols-[1.05fr_0.95fr]',
        props.className,
      )}
    >
      <div className="relative z-10">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h1
          id={id}
          className={cn(
            HEADING_FONT,
            'text-[clamp(3.2rem,8vw,7.5rem)] leading-[0.9] [overflow-wrap:anywhere]',
          )}
        >
          <SplitReveal as="span" text={copy.name} className="block" />
        </h1>
        <BlurWords
          text={copy.tagline}
          delay={0.35}
          className={cn(MUTED, 'mt-6 max-w-[34ch] text-[clamp(1rem,1.4vw,1.2rem)] leading-relaxed')}
        />
        <HeroActions primary={copy.primaryAction} secondary={copy.secondaryAction} />
      </div>
      <div className="relative aspect-square w-full max-w-[34rem] justify-self-center">
        <div
          aria-hidden="true"
          className="absolute inset-[14%] rounded-full bg-[radial-gradient(circle,rgb(var(--primary)/0.3),transparent_68%)] blur-2xl"
        />
        <FloatingCoin monogram={copy.monogram} sparkles />
      </div>
    </Section>
  );
}

export default HeroSplitCoin;
