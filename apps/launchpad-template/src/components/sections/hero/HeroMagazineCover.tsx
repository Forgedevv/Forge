import { content } from '@/content';
import { MarkerHighlight } from '@/components/library/text/MarkerHighlight';
import { MaskLines } from '@/components/library/text/MaskLines';
import { cn } from '@/lib/utils';
import {
  HEADING_FONT,
  HeroActions,
  MUTED,
  Section,
  heroCopy,
  type HeroCopy,
  type ValueItem,
} from '../shared';

export interface HeroMagazineCoverProps extends HeroCopy {
  /** Issue number printed in the masthead. Default 1. */
  issue?: number;
  /** Cover lines on the right. Default: `content.values`. */
  coverLines?: readonly ValueItem[];
}

/** The tagline split before its last words, which get the highlighter stroke. */
function splitTagline(tagline: string): [string, string] {
  const words = tagline.trim().split(/\s+/);
  let tail = words.length > 1 ? words.slice(-2) : words;
  // A long tail would not wrap under the stroke: keep it short.
  if (tail.join(' ').length > 22) tail = words.slice(-1);
  const head = words.slice(0, words.length - tail.length).join(' ');
  return [head, tail.join(' ')];
}

/** Bars of a decorative barcode, drawn from the letters of the name. */
function barcode(seed: string): { bars: { x: number; width: number }[]; length: number } {
  const bars: { x: number; width: number }[] = [];
  let x = 0;
  for (const letter of Array.from(`${seed}FORGE`).slice(0, 18)) {
    const code = letter.codePointAt(0) ?? 0;
    const width = 1 + (code % 3);
    bars.push({ x, width });
    x += width + 1 + ((code >> 2) % 2);
  }
  return { bars, length: x };
}

/**
 * Hero: a magazine cover. A masthead with the issue number, the name as the giant title of the
 * cover, the tagline as the cover story with a highlighter stroke on its last words, numbered
 * cover lines and a small barcode. Premium, bold and organic launchpads; best with a serif font.
 */
export function HeroMagazineCover({ issue = 1, coverLines, ...props }: HeroMagazineCoverProps) {
  const copy = heroCopy(props);
  const [head, tail] = splitTagline(copy.tagline);
  const lines = (coverLines ?? content.values).slice(0, 3);
  const code = barcode(copy.name);
  const issueText = `Nº ${String(Math.max(1, Math.round(issue))).padStart(2, '0')}`;
  return (
    <Section
      label={copy.name}
      className={cn('flex min-h-[min(94vh,58rem)] flex-col justify-center', props.className)}
    >
      <div className="border-y-2 border-[var(--color-text)] py-2">
        <p className="flex items-center justify-between gap-4 text-[0.7rem] font-medium uppercase tracking-[0.25em] text-[var(--color-text)]">
          <span>{issueText}</span>
          <span className="hidden text-[var(--color-text-muted)] sm:inline">{copy.eyebrow}</span>
          <span aria-hidden="true">{content.strings.network}</span>
        </p>
      </div>
      <MaskLines
        as="h1"
        lines={[copy.name]}
        className={cn(
          HEADING_FONT,
          'mt-4 text-[clamp(3.4rem,15vw,14rem)] font-semibold uppercase leading-[0.82] tracking-[-0.06em] [overflow-wrap:anywhere]',
        )}
      />
      <p className="mt-3 text-xs uppercase tracking-[0.25em] text-[var(--color-text-muted)] sm:hidden">
        {copy.eyebrow}
      </p>
      <div className="mt-[clamp(2rem,5vw,3.5rem)] grid gap-10 border-t border-[var(--color-border)] pt-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-12">
        <div className="min-w-0">
          <p
            className={cn(
              HEADING_FONT,
              'max-w-[24ch] text-[clamp(1.6rem,3.4vw,2.9rem)] italic leading-[1.08] tracking-[-0.03em]',
            )}
          >
            <span className="sr-only">{copy.tagline}</span>
            <span aria-hidden="true">
              {head ? `${head} ` : null}
              <MarkerHighlight delay={0.5}>{tail}</MarkerHighlight>
            </span>
          </p>
          <HeroActions primary={copy.primaryAction} secondary={copy.secondaryAction} />
        </div>
        <div className="flex min-w-0 flex-col justify-between gap-8">
          <ol className="space-y-5">
            {lines.map((line, index) => (
              <li key={`${line.title}-${index}`} className="grid grid-cols-[2.5rem_1fr] gap-3">
                <span
                  className={cn(HEADING_FONT, 'text-3xl leading-none text-[var(--color-primary)]')}
                >
                  {index + 1}
                </span>
                <span>
                  <span className="block font-medium uppercase tracking-[0.08em] text-[var(--color-text)]">
                    {line.title}
                  </span>
                  <span className={cn(MUTED, 'mt-1 block text-sm leading-relaxed')}>
                    {line.body}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <div aria-hidden="true" className="flex items-end gap-3 self-end">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
              {issueText}
            </span>
            <svg viewBox={`0 0 ${code.length} 40`} className="h-10 w-28">
              {code.bars.map((bar) => (
                <rect
                  key={bar.x}
                  x={bar.x}
                  y="0"
                  width={bar.width}
                  height="40"
                  style={{ fill: 'var(--color-text)' }}
                />
              ))}
            </svg>
          </div>
        </div>
      </div>
    </Section>
  );
}

export default HeroMagazineCover;
