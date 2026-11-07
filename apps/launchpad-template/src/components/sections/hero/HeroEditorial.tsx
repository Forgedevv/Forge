import { content } from '@/content';
import { BlurWords } from '@/components/library/text/BlurWords';
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

export interface HeroEditorialProps extends HeroCopy {
  /** The short index in the side column. Default: `content.values`. */
  points?: readonly ValueItem[];
}

/**
 * Hero: a calm editorial page. A thin rule and a quiet masthead, the name set large in the heading
 * font rising line by line, the tagline coming into focus under a second rule, and a short index
 * of the selling points in the margin. No background effect: made for light themes and serif
 * fonts. Calm, organic and premium launchpads.
 */
export function HeroEditorial({ points, ...props }: HeroEditorialProps) {
  const copy = heroCopy(props);
  const index = (points ?? content.values).slice(0, 4);
  const words = copy.name.split(/\s+/).filter(Boolean);
  // Two balanced lines for a long name, one line otherwise.
  const half = Math.ceil(words.length / 2);
  const lines =
    words.length > 2 ? [words.slice(0, half).join(' '), words.slice(half).join(' ')] : [copy.name];
  return (
    <Section
      label={copy.name}
      className={cn('flex min-h-[min(88vh,52rem)] flex-col justify-center', props.className)}
    >
      <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-border)] pb-3 text-xs uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
        <span>{copy.eyebrow}</span>
        <span aria-hidden="true">{content.strings.network}</span>
      </div>
      <div className="mt-[clamp(2.5rem,7vw,6rem)] grid gap-12 md:grid-cols-12 md:gap-8">
        <aside className="order-2 md:order-1 md:col-span-3">
          <ol className="text-sm">
            {index.map((point, i) => (
              <li
                key={`${point.title}-${i}`}
                className="flex items-baseline gap-4 border-t border-[var(--color-border)] py-3 first:border-t-0 first:pt-0"
              >
                <span className="font-mono text-xs text-[var(--color-text-muted)]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-[var(--color-text)]">{point.title}</span>
              </li>
            ))}
          </ol>
        </aside>
        <div className="order-1 min-w-0 md:order-2 md:col-span-9">
          <MaskLines
            as="h1"
            lines={lines}
            stagger={0.16}
            className={cn(
              HEADING_FONT,
              'text-[clamp(3rem,8vw,7.5rem)] font-normal leading-[0.95] [overflow-wrap:anywhere]',
            )}
          />
          <div
            aria-hidden="true"
            className="mt-[clamp(2rem,4vw,3rem)] h-px w-full bg-[var(--color-border)]"
          />
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <BlurWords
              text={copy.tagline}
              blur={3}
              distance={8}
              delay={0.4}
              className={cn(
                MUTED,
                'max-w-[42ch] text-[clamp(1.1rem,1.8vw,1.45rem)] leading-relaxed',
              )}
            />
            <HeroActions
              primary={copy.primaryAction}
              secondary={copy.secondaryAction}
              className="mt-0"
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

export default HeroEditorial;
