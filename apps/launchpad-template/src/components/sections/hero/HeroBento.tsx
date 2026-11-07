import type { ReactNode } from 'react';
import { content } from '@/content';
import { ProgressRing } from '@/components/library/motion/ProgressRing';
import { TiltCard } from '@/components/library/motion/TiltCard';
import { cn } from '@/lib/utils';
import {
  Eyebrow,
  GhostAction,
  HEADING_FONT,
  SafeLink,
  Section,
  heroCopy,
  useSectionId,
  type HeroCopy,
} from '../shared';

export interface HeroBentoProps extends HeroCopy {
  /** Steps listed in the curve card. Default: the titles of `content.howItWorks.steps`. */
  steps?: readonly string[];
}

/** One cell of the bento: a tilting card that fills its grid area. */
function Cell({
  className,
  cardClassName,
  surface = true,
  children,
}: {
  className?: string;
  cardClassName?: string;
  surface?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('min-w-0 [&>.fx-tilt-card]:h-full', className)}>
      <TiltCard
        maxTilt={5}
        surface={surface}
        className={cn('h-full p-[clamp(1.25rem,3vw,2rem)]', cardClassName)}
      >
        {children}
      </TiltCard>
    </div>
  );
}

/**
 * Hero: a bento of tilting cards. The name fills the big card, the tagline and the market link sit
 * in a second one, a curve card shows a ring filling up and the steps of a coin, and the call to
 * action is a whole card in the brand colour. Tech, playful and premium launchpads.
 */
export function HeroBento({ steps, ...props }: HeroBentoProps) {
  const copy = heroCopy(props);
  const id = useSectionId('hero');
  const stepTitles = (steps ?? content.howItWorks.steps.map((step) => step.title)).slice(0, 4);
  return (
    <Section
      labelledBy={id}
      className={cn('flex min-h-[min(92vh,56rem)] flex-col justify-center', props.className)}
    >
      <div className="grid gap-3 md:grid-cols-4 md:gap-4">
        <Cell className="md:col-span-3" cardClassName="flex flex-col justify-between gap-10">
          <div className="flex items-start justify-between gap-4">
            <Eyebrow className="mb-0">{copy.eyebrow}</Eyebrow>
            <span
              aria-hidden="true"
              className="flex items-center gap-2 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-[var(--color-text-muted)]"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-[var(--color-success)] opacity-60 motion-reduce:animate-none" />
                <span className="relative h-2 w-2 rounded-full bg-[var(--color-success)]" />
              </span>
              {content.strings.network}
            </span>
          </div>
          <h1
            id={id}
            className={cn(
              HEADING_FONT,
              'text-[clamp(3rem,8.5vw,8rem)] leading-[0.88] [overflow-wrap:anywhere]',
            )}
          >
            {copy.name}
          </h1>
        </Cell>
        <Cell
          className="md:row-span-2"
          cardClassName="flex flex-col items-center justify-between gap-6"
        >
          <div aria-hidden="true" className="grid place-items-center">
            <ProgressRing
              value={100}
              label={stepTitles.at(-1) ?? copy.name}
              size={148}
              thickness={8}
            >
              <span className={cn(HEADING_FONT, 'text-4xl text-[var(--color-text)]')}>
                {copy.monogram}
              </span>
            </ProgressRing>
          </div>
          <ol className="w-full divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] text-sm">
            {stepTitles.map((title, index) => (
              <li key={title} className="flex items-baseline gap-3 py-3">
                <span className="font-mono text-xs text-[var(--color-primary)]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="text-[var(--color-text)]">{title}</span>
              </li>
            ))}
          </ol>
        </Cell>
        <Cell className="md:col-span-2" cardClassName="flex flex-col justify-between gap-8">
          <p
            className={cn(
              HEADING_FONT,
              'max-w-[30ch] text-[clamp(1.35rem,2.4vw,2rem)] leading-snug tracking-[-0.02em]',
            )}
          >
            {copy.tagline}
          </p>
          <div>
            <GhostAction href="/#markets">
              {copy.secondaryAction}
              <span aria-hidden="true">↓</span>
            </GhostAction>
          </div>
        </Cell>
        <Cell surface={false} cardClassName="rounded-[var(--radius-card)] p-0">
          <SafeLink
            href="/create-pool"
            className="group flex h-full min-h-44 flex-col justify-between gap-8 rounded-[var(--radius-card)] bg-primary p-[clamp(1.25rem,3vw,2rem)] text-primary-950 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            <span
              aria-hidden="true"
              className="self-end text-4xl leading-none transition duration-300 group-hover:-translate-y-1 group-hover:translate-x-1"
            >
              ↗
            </span>
            <span className={cn(HEADING_FONT, 'text-[clamp(1.5rem,2.4vw,2.1rem)] leading-tight')}>
              {copy.primaryAction}
            </span>
          </SafeLink>
        </Cell>
      </div>
    </Section>
  );
}

export default HeroBento;
