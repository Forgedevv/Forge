import { BlurWords } from '@/components/library/text/BlurWords';
import { ScrambleText } from '@/components/library/text/ScrambleText';
import { ParticleBlob } from '@/components/library/three/ParticleBlob';
import { cn } from '@/lib/utils';
import { HEADING_FONT, HeroActions, MUTED, Section, heroCopy, type HeroCopy } from '../shared';

/**
 * Hero: a breathing sphere of thousands of theme-coloured particles behind a centred headline;
 * the eyebrow decodes like a signal. Tech and premium launchpads.
 */
export function HeroParticleField(props: HeroCopy) {
  const copy = heroCopy(props);
  return (
    <Section
      label={copy.name}
      className={cn(
        'flex min-h-[min(92vh,56rem)] flex-col items-center justify-center overflow-hidden text-center',
        props.className,
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10 opacity-90">
        <ParticleBlob />
      </div>
      {/* Light mode only: a calm eye of the page colour keeps the copy readable over the sphere. */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -z-10 aspect-[3/2] w-[min(100vw,52rem)] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-bg)_65%,transparent)_45%,transparent)] dark:hidden"
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 -z-10 h-1/3 bg-gradient-to-t from-[var(--color-bg)] to-transparent"
      />
      <ScrambleText
        as="p"
        text={copy.eyebrow}
        trigger="view"
        className="mb-6 font-mono text-xs uppercase tracking-[0.3em] text-[var(--color-primary)]"
      />
      <BlurWords
        as="h1"
        text={copy.name}
        blur={14}
        className={cn(
          HEADING_FONT,
          'max-w-[14ch] text-[clamp(3rem,9vw,8.5rem)] leading-[0.88] [overflow-wrap:anywhere]',
        )}
      />
      <p className={cn(MUTED, 'mt-6 max-w-[40ch] text-[clamp(1rem,1.4vw,1.2rem)] leading-relaxed')}>
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

export default HeroParticleField;
