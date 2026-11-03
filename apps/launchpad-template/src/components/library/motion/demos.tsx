import { useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DemoStage } from '../text/demos';
import { ArcGauge } from './ArcGauge';
import { BarList } from './BarList';
import { CardDeck } from './CardDeck';
import { DragMarquee } from './DragMarquee';
import { HoverPreviewList } from './HoverPreviewList';
import { MagneticButton } from './MagneticButton';
import { PillNav } from './PillNav';
import { ProgressRing } from './ProgressRing';
import { Reveal } from './Reveal';
import { ScrollProgress } from './ScrollProgress';
import { SmoothAccordion } from './SmoothAccordion';
import { SmoothScroll, useSmoothScroll } from './SmoothScroll';
import { SpotlightGrid } from './SpotlightGrid';
import { StackCards } from './StackCards';
import { StaggeredMenu } from './StaggeredMenu';
import { TiltCard } from './TiltCard';

/**
 * Showcase demos of the `motion` family (sample launchpad content, local gradient art only). Only
 * the /library page renders them; site code imports the effects themselves.
 */

/** Local stand-in for coin or community art: theme gradients, no image. */
function Art({
  seed = 0,
  label,
  className,
}: {
  seed?: number;
  label?: string;
  className?: string;
}) {
  const angle = (seed * 67) % 360;
  const x = 20 + ((seed * 37) % 60);
  const y = 20 + ((seed * 53) % 60);
  const style: CSSProperties = {
    background: `radial-gradient(circle at ${x}% ${y}%, var(--color-accent), transparent 55%), linear-gradient(${angle}deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 25%, var(--color-bg)))`,
  };
  return (
    <span
      className={cn('grid h-full w-full place-items-center font-bold text-primary-950', className)}
      style={style}
    >
      {label}
    </span>
  );
}

const COINS = [
  { symbol: 'PEPE', name: 'Pepe the Frog', cap: '$2.1M', change: '+12.4%' },
  { symbol: 'BONK', name: 'Bonk Inu', cap: '$1.4M', change: '+8.1%' },
  { symbol: 'NAPS', name: 'Nap Season', cap: '$860K', change: '+31.7%' },
  { symbol: 'WIF', name: 'Hat Dog', cap: '$640K', change: '-2.3%' },
  { symbol: 'MOON', name: 'Moon Mission', cap: '$410K', change: '+4.9%' },
];

const STEPS = [
  { title: 'Create', description: 'Pick a name, a symbol and an image. No code, about a minute.' },
  { title: 'Share', description: 'Your coin gets its own page and link. Bring your community.' },
  { title: 'Trade', description: 'Everyone buys on the same bonding curve, from the first block.' },
  { title: 'Graduate', description: 'At the target, liquidity moves to a public pool, locked.' },
];

const FAQ = [
  {
    question: 'What does it cost to launch a coin?',
    answer:
      'Launching is free. A small fee is taken on each trade, and part of it goes back to the creator.',
  },
  {
    question: 'When does my coin graduate?',
    answer: 'When the bonding curve is full, liquidity moves to a public pool automatically.',
  },
  {
    question: 'Is there a presale?',
    answer: 'No. Everyone, including the creator, buys on the same curve at the same price.',
  },
  {
    question: 'Which wallets work?',
    answer: 'Any Solana wallet that supports the wallet standard, such as Phantom or Solflare.',
  },
];

function JumpButtons() {
  const { scrollTo } = useSmoothScroll();
  return (
    <div className="sticky top-0 z-10 flex gap-2 bg-[color-mix(in_srgb,var(--color-surface)_90%,transparent)] px-6 py-3 backdrop-blur">
      {['how', 'stats', 'faq'].map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => scrollTo(`#fx-smooth-${id}`, -56)}
          className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text)] hover:border-[var(--color-primary)]"
        >
          {id === 'how' ? 'How it works' : id === 'stats' ? 'Stats' : 'FAQ'}
        </button>
      ))}
    </div>
  );
}

function DemoSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className="flex min-h-[320px] flex-col gap-3 border-b border-[var(--color-border)] px-6 py-10"
    >
      <h3 className="text-2xl font-semibold text-[var(--color-text)]">{title}</h3>
      {children}
    </section>
  );
}

export function SmoothScrollDemo() {
  return (
    <SmoothScroll contained lerp={0.08}>
      <JumpButtons />
      <DemoSection id="fx-smooth-hero" title="Scroll with the wheel">
        <p className="text-sm text-[var(--color-text-muted)]">
          The wheel glides with a weighted ease; the buttons travel with the same curve.
        </p>
      </DemoSection>
      <DemoSection id="fx-smooth-how" title="How it works">
        <ol className="list-decimal pl-5 text-sm text-[var(--color-text-muted)]">
          {STEPS.map((s) => (
            <li key={s.title}>{s.description}</li>
          ))}
        </ol>
      </DemoSection>
      <DemoSection id="fx-smooth-stats" title="1,284 coins launched">
        <p className="text-sm text-[var(--color-text-muted)]">$12.4M traded on the curve.</p>
      </DemoSection>
      <DemoSection id="fx-smooth-faq" title="FAQ">
        <p className="text-sm text-[var(--color-text-muted)]">{FAQ[0]?.answer}</p>
      </DemoSection>
    </SmoothScroll>
  );
}

export function ScrollProgressDemo() {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="relative h-full overflow-y-auto text-[var(--color-text)]">
      <ScrollProgress container={box} thickness={4} />
      <article className="mx-auto flex max-w-lg flex-col gap-4 px-6 py-8">
        <h3 className="text-2xl font-semibold">How a fair launch works</h3>
        {[...STEPS, ...STEPS].map((s, i) => (
          <p key={i} className="text-sm leading-relaxed text-[var(--color-text-muted)]">
            <strong className="text-[var(--color-text)]">{s.title}. </strong>
            {s.description} Scroll on: the bar at the top of this box follows your reading.
          </p>
        ))}
      </article>
    </div>
  );
}

export function RevealDemo() {
  return (
    <div className="h-full overflow-y-auto px-6 py-8 text-[var(--color-text)]">
      <Reveal>
        <h3 className="text-center text-2xl font-semibold">Why launch here</h3>
      </Reveal>
      <p className="mt-2 text-center text-xs text-[var(--color-text-muted)]">Scroll down</p>
      <div className="h-48" />
      <Reveal as="ul" stagger={0.08} className="m-0 grid list-none grid-cols-2 gap-3 p-0">
        {[
          'Fair launch',
          'Instant liquidity',
          'Creator fees',
          'No code',
          'Locked pool',
          'Live charts',
        ].map((title) => (
          <div
            key={title}
            className="border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4 text-sm font-medium"
            style={{ borderRadius: 'var(--radius-card)' }}
          >
            {title}
          </div>
        ))}
      </Reveal>
      <div className="h-24" />
    </div>
  );
}

export function StackCardsDemo() {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="relative h-full overflow-y-auto px-6 pb-24 pt-6">
      <p className="mb-4 text-center text-xs uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
        How it works: scroll
      </p>
      <StackCards
        container={box}
        top={12}
        spacing={90}
        items={STEPS.map((s, i) => ({
          kicker: `Step ${i + 1}`,
          title: s.title,
          description: s.description,
          visual: (
            <span className="block h-20 w-20 overflow-hidden rounded-full">
              <Art seed={i + 2} />
            </span>
          ),
        }))}
      />
    </div>
  );
}

function CoinChip({ symbol, change }: { symbol: string; change: string }) {
  const up = change.startsWith('+');
  return (
    <a
      href={`#coin-${symbol.toLowerCase()}`}
      className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1.5 pl-1.5 pr-4 text-sm font-semibold text-[var(--color-text)]"
    >
      <span className="h-7 w-7 overflow-hidden rounded-full">
        <Art seed={symbol.length * 3 + symbol.charCodeAt(0)} />
      </span>
      ${symbol}
      <span style={{ color: up ? 'var(--color-success)' : 'var(--color-danger)' }}>{change}</span>
    </a>
  );
}

export function DragMarqueeDemo() {
  return (
    <div className="flex h-full flex-col justify-center gap-6 py-6">
      <DragMarquee label="Trending coins">
        {[...COINS, { symbol: 'POPCAT', change: '+6.6%' }, { symbol: 'FROG', change: '+1.2%' }].map(
          (c) => (
            <CoinChip key={c.symbol} symbol={c.symbol} change={c.change} />
          ),
        )}
      </DragMarquee>
      <DragMarquee
        label="Launchpad slogans"
        direction="right"
        speed={28}
        gap={56}
        pauseButton={false}
      >
        {['Fair launch', 'No presale', 'Creator fees', 'Instant liquidity'].map((w) => (
          <span
            key={w}
            className="inline-flex items-center gap-14 whitespace-nowrap text-4xl font-semibold text-[var(--color-text-muted)]"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            {w}
            <span aria-hidden="true" className="text-[var(--color-accent)]">
              ✦
            </span>
          </span>
        ))}
      </DragMarquee>
    </div>
  );
}

export function TiltCardDemo() {
  return (
    <DemoStage replay={false}>
      <div className="mx-auto w-64">
        <TiltCard>
          <div className="h-36 overflow-hidden">
            <Art seed={4} label="$NAPS" className="text-3xl" />
          </div>
          <div className="flex flex-col gap-1 p-4">
            <span className="text-lg font-semibold text-[var(--color-text)]">Nap Season</span>
            <span className="flex justify-between text-sm text-[var(--color-text-muted)]">
              <span>Market cap</span>
              <span className="tabular-nums text-[var(--color-text)]">$860K</span>
            </span>
            <span className="flex justify-between text-sm text-[var(--color-text-muted)]">
              <span>Curve</span>
              <span className="tabular-nums text-[var(--color-accent)]">72%</span>
            </span>
          </div>
        </TiltCard>
      </div>
    </DemoStage>
  );
}

function BigFigure({ children }: { children: ReactNode }) {
  return (
    <span
      className="block bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] bg-clip-text text-4xl font-semibold text-transparent"
      style={{ fontFamily: 'var(--font-heading)' }}
    >
      {children}
    </span>
  );
}

export function SpotlightGridDemo() {
  return (
    <div className="h-full overflow-y-auto p-5">
      <SpotlightGrid
        items={[
          {
            kicker: 'Fair launch',
            title: 'Everyone buys on the same curve',
            description: 'No presale, no insiders, no team allocation.',
            visual: <BigFigure>0% presale</BigFigure>,
            size: 'wide',
          },
          {
            kicker: 'Speed',
            title: 'Live in one minute',
            visual: <BigFigure>60s</BigFigure>,
            size: 'tall',
          },
          { kicker: 'Liquidity', title: 'Locked when the coin graduates' },
          { kicker: 'Creators', title: 'A share of every trade' },
          {
            kicker: 'Community',
            title: '1,284 coins launched',
            description: 'Join the builders shipping every day.',
            size: 'wide',
          },
        ]}
      />
    </div>
  );
}

export function HoverPreviewListDemo() {
  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <HoverPreviewList
        label="Top coins"
        items={COINS.map((c, i) => ({
          id: c.symbol,
          lead: `$${c.symbol}`,
          title: c.name,
          trail: c.cap,
          href: `#coin-${c.symbol.toLowerCase()}`,
          preview: <Art seed={i * 5 + 1} label={`$${c.symbol}`} className="text-2xl" />,
        }))}
      />
    </div>
  );
}

export function CardDeckDemo() {
  const moments = [
    { title: 'First 100 holders', caption: '$NAPS, day one' },
    { title: 'Meme of the week', caption: 'by the community' },
    { title: 'Graduation day', caption: '$BONK hits the pool' },
    { title: 'Spaces recap', caption: 'Friday, 9 pm' },
    { title: 'Hackathon winners', caption: '12 coins shipped' },
  ];
  return (
    <div className="h-full p-4">
      <CardDeck
        label="Community moments"
        items={moments.map((m, i) => ({
          id: m.title,
          title: m.title,
          caption: m.caption,
          art: <Art seed={i * 7 + 3} />,
        }))}
      />
    </div>
  );
}

export function StaggeredMenuDemo() {
  return (
    <div className="relative h-full overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
        <span className="font-semibold text-[var(--color-text)]">MoonPad</span>
        <StaggeredMenu
          contained
          items={[
            { label: 'Explore', href: '#explore' },
            { label: 'Create a coin', href: '#create' },
            { label: 'Leaderboard', href: '#leaderboard' },
            { label: 'Docs', href: '#docs' },
          ]}
          socials={[
            { label: 'X', href: '#x' },
            { label: 'Telegram', href: '#telegram' },
            { label: 'Discord', href: '#discord' },
          ]}
        />
      </div>
      <p className="px-6 pt-10 text-center text-sm text-[var(--color-text-muted)]">
        Open the menu (Escape closes it).
      </p>
    </div>
  );
}

export function PillNavDemo() {
  return (
    <DemoStage replay={false}>
      <div className="flex justify-center">
        <PillNav
          items={[
            { label: 'Explore', href: '#explore' },
            { label: 'Create', href: '#create' },
            { label: 'Leaderboard', href: '#leaderboard' },
            { label: 'Docs', href: '#docs' },
          ]}
          onNavigate={(_, e) => e.preventDefault()}
        />
      </div>
    </DemoStage>
  );
}

export function MagneticButtonDemo() {
  return (
    <DemoStage replay={false}>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <MagneticButton>Launch your coin →</MagneticButton>
        <MagneticButton variant="ghost">Buy $NAPS</MagneticButton>
      </div>
    </DemoStage>
  );
}

export function ProgressRingDemo() {
  return (
    <DemoStage>
      <div className="flex flex-wrap items-center justify-center gap-8">
        <ProgressRing value={72} label="Bonding curve progress" />
        <ProgressRing value={38} label="Holder goal" size={120} thickness={8} ticks={false}>
          <span className="text-xl font-semibold tabular-nums text-[var(--color-text)]">380</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">of 1,000 holders</span>
        </ProgressRing>
      </div>
    </DemoStage>
  );
}

export function ArcGaugeDemo() {
  return (
    <DemoStage>
      <div className="flex justify-center">
        <ArcGauge value={64} label="Hype meter" />
      </div>
    </DemoStage>
  );
}

export function BarListDemo() {
  return (
    <DemoStage>
      <div className="mx-auto max-w-md">
        <BarList
          label="Top coins by volume"
          items={COINS.map((c, i) => ({
            name: `$${c.symbol}`,
            value: [4_200_000, 2_900_000, 1_700_000, 950_000, 420_000][i] ?? 0,
            display: ['$4.2M', '$2.9M', '$1.7M', '$950K', '$420K'][i],
            icon: (
              <span className="h-5 w-5 overflow-hidden rounded-full">
                <Art seed={i * 5 + 1} />
              </span>
            ),
          }))}
        />
      </div>
    </DemoStage>
  );
}

export function SmoothAccordionDemo() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <SmoothAccordion items={FAQ} defaultOpen={[0]} />
    </div>
  );
}
