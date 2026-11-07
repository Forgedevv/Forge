import { content } from '@/content';
import { DragMarquee } from '@/components/library/motion/DragMarquee';
import { MaskLines } from '@/components/library/text/MaskLines';
import { cn } from '@/lib/utils';
import { HEADING_FONT, HeroActions, MUTED, Section, heroCopy, type HeroCopy } from '../shared';

export interface HeroPosterTypeProps extends HeroCopy {
  /** Words of the ticker band under the poster. Default: the titles of `content.values`. */
  tickerWords?: readonly string[];
}

/**
 * Hero: a poster. The name fills the width in giant type, one word per line rising out of its
 * mask, the last word in the brand colour; a draggable ticker band runs underneath. Bold, meme and
 * retro launchpads; strongest with a condensed or display heading font.
 */
export function HeroPosterType({ tickerWords, ...props }: HeroPosterTypeProps) {
  const copy = heroCopy(props);
  const words = copy.name.split(/\s+/).filter(Boolean).slice(0, 3);
  const lines = words.map((word, index) =>
    index === words.length - 1 && words.length > 1 ? (
      <em key={word} className="not-italic text-[var(--color-primary)]">
        {word}
      </em>
    ) : (
      word
    ),
  );
  const ticker = tickerWords ?? content.values.map((value) => value.title);
  return (
    <Section
      label={copy.name}
      className={cn(
        'flex min-h-[min(92vh,56rem)] flex-col justify-between gap-10 pb-0',
        props.className,
      )}
    >
      <p className="flex justify-between border-b border-[var(--color-border)] pb-3 text-xs uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
        <span>{copy.eyebrow}</span>
        <span aria-hidden="true">{content.strings.network}</span>
      </p>
      <MaskLines
        as="h1"
        lines={lines}
        className={cn(
          HEADING_FONT,
          'text-[clamp(3.6rem,15vw,13rem)] uppercase leading-[0.84] [overflow-wrap:anywhere]',
        )}
      />
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <p className={cn(MUTED, 'max-w-[36ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed')}>
          {copy.tagline}
        </p>
        <HeroActions
          primary={copy.primaryAction}
          secondary={copy.secondaryAction}
          className="mt-0"
        />
      </div>
      <div className="-mx-[var(--page-gutter)] border-y border-[var(--color-border)] py-4">
        <DragMarquee label={content.strings.valuesLabel} speed={36} gap={48}>
          {ticker.map((word) => (
            <span
              key={word}
              className={cn(
                HEADING_FONT,
                'flex items-center gap-12 text-2xl uppercase md:text-3xl',
              )}
            >
              {word}
              <span aria-hidden="true" className="text-[var(--color-primary)]">
                ✦
              </span>
            </span>
          ))}
        </DragMarquee>
      </div>
    </Section>
  );
}

export default HeroPosterType;
