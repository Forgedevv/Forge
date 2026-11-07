import { content } from '@/content';
import { DotGrid } from '@/components/library/backgrounds/DotGrid';
import { RotatingWords } from '@/components/library/text/RotatingWords';
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

export interface HeroDotFieldProps extends HeroCopy {
  /** Words that rotate in the second line. Default: the titles of `content.values`. */
  words?: readonly string[];
}

/**
 * Hero: a calm field of dots that light up around the pointer, a big name and a second line that
 * rotates through the selling points in the brand gradient. Tech, calm and premium launchpads.
 */
export function HeroDotField({ words, ...props }: HeroDotFieldProps) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  const rotating = words ?? content.values.map((value) => value.title);
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[min(88vh,52rem)] flex-col justify-center overflow-hidden',
        props.className,
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        <DotGrid followPointer />
      </div>
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_left,var(--color-bg)_20%,transparent_70%)]"
      />
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <h1
        id={id}
        className={cn(
          HEADING_FONT,
          'max-w-[12ch] text-[clamp(3rem,8vw,7.5rem)] leading-[0.9] [overflow-wrap:anywhere]',
        )}
      >
        {copy.name}
      </h1>
      <p className={cn(HEADING_FONT, 'mt-4 text-[clamp(1.6rem,3.6vw,3rem)] leading-tight')}>
        <RotatingWords words={rotating} />
      </p>
      <p className={cn(MUTED, 'mt-6 max-w-[38ch] text-[clamp(1rem,1.3vw,1.1rem)] leading-relaxed')}>
        {copy.tagline}
      </p>
      <HeroActions primary={copy.primaryAction} secondary={copy.secondaryAction} />
    </Section>
  );
}

export default HeroDotField;
