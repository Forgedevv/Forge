import { MaskLines } from '@/components/library/text/MaskLines';
import { GlossySculpture } from '@/components/library/three/GlossySculpture';
import { cn } from '@/lib/utils';
import {
  Eyebrow,
  HEADING_FONT,
  HeroActions,
  MUTED,
  Section,
  heroCopy,
  type HeroCopy,
} from '../shared';

export interface HeroSculptureProps extends HeroCopy {
  /** `knot`, `torus` or `gem`. Default `knot`. */
  shape?: 'knot' | 'torus' | 'gem';
  /** Put the sculpture on the left and the copy on the right. Default false. */
  reverse?: boolean;
}

/**
 * Hero: a glossy 3D sculpture turning slowly in studio light beside the name, which is uncovered
 * like a curtain pulled aside. Premium, calm and luxury launchpads; pairs well with a serif font.
 */
export function HeroSculpture({ shape = 'knot', reverse = false, ...props }: HeroSculptureProps) {
  const copy = heroCopy(props);
  return (
    <Section
      label={copy.name}
      className={cn(
        'grid min-h-[min(88vh,52rem)] items-center gap-8 md:grid-cols-2',
        props.className,
      )}
    >
      <div className={cn('relative z-10', reverse && 'md:order-2')}>
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <MaskLines
          as="h1"
          effect="curtain"
          lines={[copy.name]}
          className={cn(
            HEADING_FONT,
            'text-[clamp(3rem,7.5vw,7rem)] leading-[0.92] [overflow-wrap:anywhere]',
          )}
        />
        <div
          aria-hidden="true"
          className="mt-8 h-px w-24 bg-[var(--color-primary)] text-primary-950"
        />
        <p
          className={cn(
            MUTED,
            'mt-6 max-w-[34ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed',
          )}
        >
          {copy.tagline}
        </p>
        <HeroActions primary={copy.primaryAction} secondary={copy.secondaryAction} />
      </div>
      <div className="relative aspect-square w-full max-w-[36rem] justify-self-center">
        <GlossySculpture shape={shape} />
      </div>
    </Section>
  );
}

export default HeroSculpture;
