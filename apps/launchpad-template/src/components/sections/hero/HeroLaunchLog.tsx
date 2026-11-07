import { content } from '@/content';
import { ProgressRing } from '@/components/library/motion/ProgressRing';
import { Reveal } from '@/components/library/motion/Reveal';
import { TypewriterText } from '@/components/library/text/TypewriterText';
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

export interface HeroLaunchLogProps extends HeroCopy {
  /** Lines of the log, printed in turn after the command. Default: the titles of `content.howItWorks.steps`. */
  lines?: readonly string[];
}

/**
 * Hero: a launch, run from the command line. Under a centred name, a wide terminal window types a
 * launch command, prints a checklist of the steps one line after the other and fills a ring when
 * the coin is live. Tech, dark and retro launchpads.
 */
export function HeroLaunchLog({ lines, ...props }: HeroLaunchLogProps) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  const log = (lines ?? content.howItWorks.steps.map((step) => step.title)).slice(0, 5);
  const command = `launch --coin "${copy.name}" --network ${content.strings.network.toLowerCase()}`;
  return (
    <Section
      labelledBy={id}
      className={cn(
        'flex min-h-[min(92vh,56rem)] flex-col items-center justify-center overflow-hidden text-center',
        props.className,
      )}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[linear-gradient(var(--color-border)_1px,transparent_1px)] bg-[length:100%_2.25rem] [mask-image:linear-gradient(to_bottom,transparent,#000_30%,#000_70%,transparent)]"
      />
      <Eyebrow className="font-mono tracking-[0.25em] text-[var(--color-primary)]">
        {copy.eyebrow}
      </Eyebrow>
      <h1
        id={id}
        className={cn(
          HEADING_FONT,
          'max-w-[14ch] text-[clamp(3rem,8vw,7rem)] leading-[0.9] [overflow-wrap:anywhere]',
        )}
      >
        {copy.name}
      </h1>
      <p
        className={cn(MUTED, 'mt-5 max-w-[42ch] text-[clamp(1rem,1.4vw,1.15rem)] leading-relaxed')}
      >
        {copy.tagline}
      </p>
      <HeroActions
        primary={copy.primaryAction}
        secondary={copy.secondaryAction}
        className="justify-center"
      />
      <div
        aria-hidden="true"
        className="mt-[clamp(2.5rem,6vw,4rem)] w-full max-w-3xl overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] text-left shadow-[0_30px_80px_-40px_rgb(var(--primary)/0.45)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-danger)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-accent)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-success)]" />
          <span className="ml-3 font-mono text-xs text-[var(--color-text-muted)]">launch.log</span>
        </div>
        <div className="grid gap-6 p-[clamp(1rem,3vw,1.75rem)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0 font-mono text-[clamp(0.78rem,1.2vw,0.9rem)] leading-relaxed">
            <p className="text-[var(--color-text)] [overflow-wrap:anywhere]">
              <span className="text-[var(--color-primary)]">$ </span>
              <TypewriterText phrases={[command]} typeSpeed={32} caret="underscore" />
            </p>
            <Reveal
              as="ol"
              stagger={0.35}
              delay={1.6}
              distance={8}
              blur={0}
              className="mt-3 space-y-1.5"
            >
              {log.map((line, index) => (
                <span key={`${line}-${index}`} className="flex items-baseline gap-3">
                  <span className="text-[var(--color-success)]">✓</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">
                    {line}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">ok</span>
                </span>
              ))}
            </Reveal>
          </div>
          <div className="flex items-center gap-4 sm:flex-col sm:gap-2">
            <ProgressRing
              value={100}
              label={log.at(-1) ?? copy.name}
              size={104}
              thickness={6}
              ticks={false}
            >
              <span className={cn(HEADING_FONT, 'text-2xl text-[var(--color-text)]')}>
                {copy.monogram}
              </span>
            </ProgressRing>
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-primary)]">
              live
            </span>
          </div>
        </div>
      </div>
    </Section>
  );
}

export default HeroLaunchLog;
