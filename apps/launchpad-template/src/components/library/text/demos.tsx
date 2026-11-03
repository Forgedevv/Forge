import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { BlurWords } from './BlurWords';
import { CountUp } from './CountUp';
import { FlipText } from './FlipText';
import { MarkerHighlight } from './MarkerHighlight';
import { MaskLines } from './MaskLines';
import { Odometer } from './Odometer';
import { RotatingWords } from './RotatingWords';
import { ScrambleText } from './ScrambleText';
import { ScrollWords } from './ScrollWords';
import { ShimmerText } from './ShimmerText';
import { SplitReveal } from './SplitReveal';
import { TypewriterText } from './TypewriterText';

/**
 * Showcase demos of the `text` family (sample launchpad copy). Only the /library page renders
 * them; site code imports the effects themselves.
 */

/** Centred demo box with an optional "Replay" button that remounts the effect. */
export function DemoStage({
  children,
  replay = true,
  className,
}: {
  children: ReactNode;
  replay?: boolean;
  className?: string;
}) {
  const [run, setRun] = useState(0);
  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center justify-center overflow-hidden p-8 text-[var(--color-text)]',
        className,
      )}
    >
      <div key={run} className="w-full">
        {children}
      </div>
      {replay && (
        <button
          type="button"
          onClick={() => setRun((n) => n + 1)}
          className="absolute right-3 top-3 rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Replay
        </button>
      )}
    </div>
  );
}

const headline = 'text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl';

export function SplitRevealDemo() {
  return (
    <DemoStage>
      <SplitReveal
        as="h2"
        text="Launch your coin in one minute"
        className={cn(headline, 'text-center')}
      />
      <SplitReveal
        as="p"
        split="words"
        effect="flip"
        delay={0.6}
        text="No code. No presale. Fair from block one."
        className="mt-4 text-center text-lg text-[var(--color-text-muted)]"
      />
    </DemoStage>
  );
}

export function BlurWordsDemo() {
  return (
    <DemoStage>
      <BlurWords
        as="h2"
        text="Fair launches. Instant liquidity. Fees that come back to creators."
        className="mx-auto max-w-xl text-center text-3xl font-semibold leading-tight"
      />
      <BlurWords
        text="1,284 coins launched this month"
        blur={3}
        delay={0.7}
        className="mt-4 text-center text-sm uppercase tracking-[0.2em] text-[var(--color-text-muted)]"
      />
    </DemoStage>
  );
}

export function ScrollWordsDemo() {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="relative h-full overflow-y-auto px-8 text-[var(--color-text)]">
      <p className="pt-10 text-center text-xs uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
        Scroll inside this box
      </p>
      <div className="h-64" />
      <ScrollWords
        container={box}
        text="We built the fairest place to launch a coin. Every launch starts at the same price, liquidity is locked from the first trade, and creators earn a share of every swap. No insiders, no presale, just a curve and a community."
        className="mx-auto max-w-xl text-2xl font-semibold leading-snug"
      />
      <div className="h-72" />
    </div>
  );
}

export function ScrambleTextDemo() {
  return (
    <DemoStage>
      <div className="flex flex-col items-center gap-4 text-center font-mono">
        <ScrambleText as="h2" text="$NAPS IS LIVE" className="text-4xl font-bold tracking-widest" />
        <span className="text-sm text-[var(--color-text-muted)]">
          Contract: <ScrambleText text="7xKX...q9pump" trigger="both" duration={800} />
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          Hover the text to decode again
        </span>
      </div>
    </DemoStage>
  );
}

export function ShimmerTextDemo() {
  return (
    <DemoStage replay={false}>
      <div className="flex flex-col items-center gap-5 text-center">
        <ShimmerText as="h2" variant="gradient" className={headline}>
          Launch your coin
        </ShimmerText>
        <ShimmerText className="text-base font-medium">Bonding curve filling... 72%</ShimmerText>
      </div>
    </DemoStage>
  );
}

export function FlipTextDemo() {
  return (
    <DemoStage replay={false}>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <a
          href="#launch"
          data-flip-host=""
          className="inline-flex h-12 items-center rounded-full bg-[var(--color-primary)] px-6 font-semibold text-primary-950"
        >
          <FlipText text="Launch your coin" hoverColor="currentColor" />
        </a>
        <a
          href="#explore"
          data-flip-host=""
          className="inline-flex h-12 items-center rounded-full border border-[var(--color-border)] px-6 font-semibold"
        >
          <FlipText text="Explore coins" />
        </a>
      </div>
    </DemoStage>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-4xl font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
        {children}
      </span>
      <span className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
        {label}
      </span>
    </div>
  );
}

export function OdometerDemo() {
  const [coins, setCoins] = useState(1284);
  const [volume, setVolume] = useState(48.2);
  // The demo keeps the numbers moving, like live stats would.
  useEffect(() => {
    const id = window.setInterval(() => {
      setCoins((n) => n + 1 + Math.floor(Math.random() * 3));
      setVolume((v) => Math.round((v + Math.random() * 0.9) * 10) / 10);
    }, 2600);
    return () => window.clearInterval(id);
  }, []);
  return (
    <DemoStage>
      <div className="grid grid-cols-2 gap-8">
        <Stat label="Coins launched">
          <Odometer value={coins} />
        </Stat>
        <Stat label="Volume">
          <Odometer
            value={volume}
            prefix="$"
            suffix="M"
            format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
          />
        </Stat>
      </div>
    </DemoStage>
  );
}

export function CountUpDemo() {
  return (
    <DemoStage>
      <div className="grid grid-cols-3 gap-6">
        <Stat label="Coins launched">
          <CountUp value={1284} />
        </Stat>
        <Stat label="Volume">
          <CountUp
            value={12_400_000}
            format={{
              style: 'currency',
              currency: 'USD',
              notation: 'compact',
              maximumFractionDigits: 1,
            }}
          />
        </Stat>
        <Stat label="Holders">
          <CountUp value={48_920} suffix="+" duration={2.4} />
        </Stat>
      </div>
    </DemoStage>
  );
}

export function RotatingWordsDemo() {
  return (
    <DemoStage replay={false}>
      <h2 className={cn(headline, 'text-center')}>
        Launch your <RotatingWords words={['meme coin', 'community', 'next big idea']} />
      </h2>
    </DemoStage>
  );
}

export function TypewriterTextDemo() {
  return (
    <DemoStage replay={false}>
      <div
        className="mx-auto max-w-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5 font-mono text-sm"
        style={{ borderRadius: 'var(--radius-card)' }}
      >
        <div className="mb-3 flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-2.5 w-2.5 rounded-full bg-[var(--color-border)]" />
          ))}
        </div>
        <p className="m-0 text-[var(--color-text-muted)]">$ forge launch --symbol NAPS</p>
        <p className="m-0 mt-1">
          <span className="text-[var(--color-accent)]">&gt; </span>
          <TypewriterText
            phrases={['deploying $NAPS...', 'pool created on the curve', 'trading is live']}
          />
        </p>
      </div>
    </DemoStage>
  );
}

export function MaskLinesDemo() {
  return (
    <DemoStage>
      <MaskLines
        as="h2"
        className={headline}
        lines={[
          'The fairest launchpad',
          <>
            on <span className="text-[var(--color-primary)]">Solana</span>.
          </>,
        ]}
      />
      <MaskLines
        as="p"
        effect="curtain"
        delay={0.5}
        className="mt-4 text-lg text-[var(--color-text-muted)]"
        lines={['Launch in one minute. Trade from the first block.']}
      />
    </DemoStage>
  );
}

export function MarkerHighlightDemo() {
  return (
    <DemoStage>
      <p className="mx-auto max-w-lg text-center text-2xl font-semibold leading-relaxed">
        Launch a coin in <MarkerHighlight>one minute</MarkerHighlight>, with{' '}
        <MarkerHighlight variant="circle" delay={0.4}>
          zero
        </MarkerHighlight>{' '}
        presale and{' '}
        <MarkerHighlight variant="underline" delay={0.8}>
          fees shared with creators
        </MarkerHighlight>
        .
      </p>
    </DemoStage>
  );
}
