// @vitest-environment jsdom
import '../helpers/dom-setup';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reduced: false }));

// Every effect reads the preference through the shared hook.
vi.mock('@/components/library/shared/useReducedMotion', () => ({
  useReducedMotion: () => h.reduced,
}));

import { entries } from '@/components/library/text';
import { BlurWords } from '@/components/library/text/BlurWords';
import { CountUp } from '@/components/library/text/CountUp';
import { FlipText } from '@/components/library/text/FlipText';
import { MarkerHighlight } from '@/components/library/text/MarkerHighlight';
import { MaskLines } from '@/components/library/text/MaskLines';
import { Odometer } from '@/components/library/text/Odometer';
import { RotatingWords } from '@/components/library/text/RotatingWords';
import { ScrambleText } from '@/components/library/text/ScrambleText';
import { ScrollWords } from '@/components/library/text/ScrollWords';
import { ShimmerText } from '@/components/library/text/ShimmerText';
import { SplitReveal } from '@/components/library/text/SplitReveal';
import { TypewriterText } from '@/components/library/text/TypewriterText';

const SRC = join(process.cwd(), 'src');

beforeEach(() => {
  h.reduced = false;
});

/** The single element with this text that assistive technology can reach (fails if 0 or 2+). */
function readable(text: string): HTMLElement {
  const found = screen.queryAllByText(text).filter((el) => !el.closest('[aria-hidden="true"]'));
  expect(found, text).toHaveLength(1);
  return found[0] as HTMLElement;
}

describe('text family catalogue', () => {
  it('has unique kebab-case ids and complete entries', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.family).toBe('text');
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.moods.length).toBeGreaterThan(0);
      expect(['light', 'medium']).toContain(entry.weight);
    }
  });

  it('points every importPath at a file that exports the named component', async () => {
    for (const entry of entries) {
      expect(entry.importPath).toBe(`@/components/library/text/${entry.exportName}`);
      const file = join(SRC, `${entry.importPath.replace('@/', '')}.tsx`);
      expect(existsSync(file), file).toBe(true);
      const mod = (await import(/* @vite-ignore */ entry.importPath)) as Record<string, unknown>;
      expect(typeof mod[entry.exportName], entry.exportName).toBe('function');
    }
  });

  it('renders every demo', () => {
    for (const entry of entries) {
      const { unmount, container } = render(<entry.Demo />);
      expect(container.textContent?.length, entry.id).toBeGreaterThan(0);
      unmount();
    }
  });

  it('renders every demo with reduced motion', () => {
    h.reduced = true;
    for (const entry of entries) {
      const { unmount } = render(<entry.Demo />);
      unmount();
    }
  });
});

describe('text effects accessibility', () => {
  it('split text is read once, as the whole string', () => {
    render(<SplitReveal as="h1" text="Launch your coin in one minute" />);
    expect(screen.getByRole('heading', { name: 'Launch your coin in one minute' })).toBeVisible();
    // The full string exists once; the letters are hidden from assistive technology.
    expect(screen.getByText('Launch your coin in one minute')).toHaveClass('sr-only');
    const letters = screen.getByRole('heading').querySelector('[aria-hidden="true"]');
    expect(letters?.textContent?.replace(/\s/g, '')).toBe('Launchyourcoininoneminute');
  });

  it('blur words, scramble and flip labels keep one accessible string', () => {
    render(
      <>
        <BlurWords as="h2" text="Fair launches. Instant liquidity." />
        <ScrambleText as="h3" text="$NAPS IS LIVE" />
        <button type="button" data-flip-host="">
          <FlipText text="Launch your coin" />
        </button>
      </>,
    );
    expect(screen.getByRole('heading', { name: 'Fair launches. Instant liquidity.' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '$NAPS IS LIVE' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Launch your coin' })).toBeTruthy();
    expect(readable('$NAPS IS LIVE')).toHaveClass('sr-only');
  });

  it('numbers expose their final value as text', () => {
    render(
      <>
        <Odometer value={1284} />
        <CountUp
          value={12_400_000}
          format={{ style: 'currency', currency: 'USD', notation: 'compact' }}
        />
      </>,
    );
    expect(readable('1,284')).toHaveClass('sr-only');
    expect(readable('$12M')).toHaveClass('sr-only');
  });

  it('rotating words and typewriter give screen readers a stable text', () => {
    render(
      <>
        <RotatingWords words={['meme coin', 'community']} />
        <TypewriterText phrases={['deploying $NAPS...', 'trading is live']} />
      </>,
    );
    expect(readable('meme coin, community')).toHaveClass('sr-only');
    expect(readable('deploying $NAPS..., trading is live')).toHaveClass('sr-only');
  });

  it('masked lines read as one title and marker text stays plain text', () => {
    render(
      <>
        <MaskLines as="h2" lines={['The fairest launchpad', 'on Solana.']} />
        <p>
          Launch in <MarkerHighlight>one minute</MarkerHighlight>
        </p>
        <ShimmerText>Bonding curve filling</ShimmerText>
      </>,
    );
    expect(screen.getByRole('heading', { name: 'The fairest launchpad on Solana.' })).toBeTruthy();
    expect(screen.getByText('one minute')).toBeTruthy();
    expect(screen.getByText('Bonding curve filling')).toBeTruthy();
  });
});

describe('text effects with reduced motion', () => {
  beforeEach(() => {
    h.reduced = true;
  });

  it('show their final state at once', () => {
    const { container } = render(
      <>
        <SplitReveal text="Launch your coin" />
        <BlurWords text="Fair launches" />
        <MaskLines lines={['The fairest launchpad']} />
        <MarkerHighlight>one minute</MarkerHighlight>
      </>,
    );
    const states = [...container.querySelectorAll('[data-state]')].map((el) =>
      el.getAttribute('data-state'),
    );
    expect(states).toHaveLength(4);
    expect(states.every((s) => s === 'shown')).toBe(true);
  });

  it('count-up prints the final number without counting', () => {
    const { container } = render(<CountUp value={1284} suffix=" coins" />);
    const layers = container.querySelectorAll('[aria-hidden="true"]');
    expect([...layers].map((l) => l.textContent)).toEqual(['1,284 coins', '1,284 coins']);
  });

  it('odometer columns sit on the final digits', () => {
    const { container } = render(<Odometer value={42} />);
    const stacks = [...container.querySelectorAll<HTMLElement>('.absolute')];
    expect(stacks.map((s) => s.style.transform)).toEqual(['translateY(-4em)', 'translateY(-2em)']);
  });

  it('typewriter shows the first phrase complete, scramble shows the real text', () => {
    const { container } = render(
      <>
        <TypewriterText phrases={['trading is live', 'pool created']} />
        <ScrambleText text="$NAPS" />
      </>,
    );
    expect(container.textContent).toContain('trading is live');
    expect(container.textContent).toContain('$NAPS');
  });

  it('rotating words hold the first word', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <RotatingWords words={['meme coin', 'community']} interval={100} />,
      );
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const shown = [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(
        (el) => el.style.opacity === '1',
      );
      expect(shown.map((el) => el.textContent)).toEqual(['meme coin']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scroll-lit words are fully lit', () => {
    const { container } = render(<ScrollWords text="We built the fairest launchpad" />);
    const host = container.querySelector<HTMLElement>('.fx-scroll-words');
    expect(host?.style.getPropertyValue('--fx-p')).toBe('1');
  });
});

describe('rotating words with motion', () => {
  it('cycles to the next word', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <RotatingWords words={['meme coin', 'community']} interval={100} />,
      );
      act(() => {
        vi.advanceTimersByTime(120);
      });
      const shown = [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(
        (el) => el.style.opacity === '1',
      );
      expect(shown.map((el) => el.textContent)).toEqual(['community']);
    } finally {
      vi.useRealTimers();
    }
  });
});
