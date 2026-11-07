import { content } from '@/content';
import { AsciiMonogram } from '@/components/library/backgrounds/AsciiMonogram';
import { ScrambleText } from '@/components/library/text/ScrambleText';
import { TypewriterText } from '@/components/library/text/TypewriterText';
import { cn } from '@/lib/utils';
import { HEADING_FONT, HeroActions, MUTED, Section, heroCopy, type HeroCopy } from '../shared';

export interface HeroTerminalProps extends HeroCopy {
  /** Lines typed in turn under the name. Default: the tagline, then the titles of `content.values`. */
  phrases?: readonly string[];
}

/**
 * Hero: a terminal mood. The monogram is drawn in live ASCII glyphs that ripple around the pointer,
 * the eyebrow decodes like a prompt and short lines type themselves under the name. Tech, retro and
 * dark launchpads.
 */
export function HeroTerminal({ phrases, ...props }: HeroTerminalProps) {
  const copy = heroCopy(props);
  const lines = phrases ?? [copy.tagline, ...content.values.map((value) => value.title)];
  return (
    <Section
      label={copy.name}
      className={cn(
        'grid min-h-[min(88vh,52rem)] items-center gap-8 overflow-hidden md:grid-cols-2',
        props.className,
      )}
    >
      <div className="relative z-10">
        <p className="mb-6 font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-primary)]">
          <span aria-hidden="true">&gt; </span>
          <ScrambleText text={copy.eyebrow} />
        </p>
        <h1
          className={cn(
            HEADING_FONT,
            'text-[clamp(3rem,7.5vw,7rem)] leading-[0.9] [overflow-wrap:anywhere]',
          )}
        >
          {copy.name}
        </h1>
        <p className="mt-6 min-h-[3.5em] max-w-[38ch] font-mono text-[clamp(0.95rem,1.3vw,1.1rem)] leading-relaxed">
          <TypewriterText phrases={lines} caret="block" />
        </p>
        <HeroActions primary={copy.primaryAction} secondary={copy.secondaryAction} />
      </div>
      <div className="relative h-[clamp(18rem,42vw,34rem)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <AsciiMonogram text={copy.monogram} followPointer />
        <p
          aria-hidden="true"
          className={cn(
            MUTED,
            'absolute bottom-3 left-4 font-mono text-[0.65rem] uppercase tracking-[0.2em]',
          )}
        >
          {content.strings.network} · {copy.monogram}
        </p>
      </div>
    </Section>
  );
}

export default HeroTerminal;
