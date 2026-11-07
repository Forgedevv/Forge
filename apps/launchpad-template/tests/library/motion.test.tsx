// @vitest-environment jsdom
import '../helpers/dom-setup';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reduced: false }));

// Every effect reads the preference through the shared hook.
vi.mock('@/components/library/shared/useReducedMotion', () => ({
  useReducedMotion: () => h.reduced,
}));

import { entries } from '@/components/library/motion';
import { entries as textEntries } from '@/components/library/text';
import { ArcGauge } from '@/components/library/motion/ArcGauge';
import { BarList } from '@/components/library/motion/BarList';
import { CardDeck } from '@/components/library/motion/CardDeck';
import { DragMarquee } from '@/components/library/motion/DragMarquee';
import { HoverPreviewList } from '@/components/library/motion/HoverPreviewList';
import { MagneticButton } from '@/components/library/motion/MagneticButton';
import { PillNav } from '@/components/library/motion/PillNav';
import { ProgressRing } from '@/components/library/motion/ProgressRing';
import { Reveal } from '@/components/library/motion/Reveal';
import { SmoothAccordion } from '@/components/library/motion/SmoothAccordion';
import { SmoothScroll } from '@/components/library/motion/SmoothScroll';
import { SpotlightGrid } from '@/components/library/motion/SpotlightGrid';
import { StackCards } from '@/components/library/motion/StackCards';
import { StaggeredMenu } from '@/components/library/motion/StaggeredMenu';
import { TiltCard } from '@/components/library/motion/TiltCard';

const SRC = join(process.cwd(), 'src');

beforeEach(() => {
  h.reduced = false;
});

describe('motion family catalogue', () => {
  it('has unique kebab-case ids, also across the text family', () => {
    const ids = [...entries, ...textEntries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.family).toBe('motion');
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.moods.length).toBeGreaterThan(0);
      expect(['light', 'medium']).toContain(entry.weight);
    }
  });

  it('points every importPath at a file that exports the named component', async () => {
    for (const entry of entries) {
      expect(entry.importPath).toBe(`@/components/library/motion/${entry.exportName}`);
      const file = join(SRC, `${entry.importPath.replace('@/', '')}.tsx`);
      expect(existsSync(file), file).toBe(true);
      const mod = (await import(/* @vite-ignore */ entry.importPath)) as Record<string, unknown>;
      expect(typeof mod[entry.exportName], entry.exportName).toBe('function');
    }
  });

  it('renders every demo, with and without reduced motion', () => {
    for (const reduced of [false, true]) {
      h.reduced = reduced;
      for (const entry of entries) {
        const { unmount, container } = render(<entry.Demo />);
        expect(container.textContent?.length, entry.id).toBeGreaterThan(0);
        unmount();
      }
    }
  });
});

const COINS = ['$PEPE', '$BONK', '$NAPS'];

describe('drag marquee', () => {
  it('is a named, focusable ticker whose items are reachable once', () => {
    render(
      <DragMarquee label="Trending coins">
        {COINS.map((c) => (
          <a key={c} href={`#${c}`}>
            {c}
          </a>
        ))}
      </DragMarquee>,
    );
    const region = screen.getByRole('region', { name: 'Trending coins' });
    // The second lap is hidden from assistive technology: each coin is reachable once.
    for (const coin of COINS)
      expect(within(region).getAllByRole('link', { name: coin })).toHaveLength(1);
    expect(region.querySelectorAll('[inert]')).toHaveLength(1);
    const pause = screen.getByRole('button', { name: 'Pause Trending coins' });
    fireEvent.click(pause);
    expect(screen.getByRole('button', { name: 'Play Trending coins' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const viewport = region.querySelector<HTMLElement>('[tabindex="0"]');
    expect(viewport).not.toBeNull();
    fireEvent.keyDown(viewport as HTMLElement, { key: 'ArrowRight' });
  });

  it('becomes a plain scroller with reduced motion', () => {
    h.reduced = true;
    render(
      <DragMarquee label="Trending coins">
        {COINS.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </DragMarquee>,
    );
    const region = screen.getByRole('region', { name: 'Trending coins' });
    expect(region.querySelectorAll('[inert]')).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
    expect(region.querySelector('.overflow-x-auto')).not.toBeNull();
  });
});

describe('card deck', () => {
  it('moves the front card with the arrow keys', () => {
    const items = ['Moment one', 'Moment two', 'Moment three'].map((title) => ({
      id: title,
      title,
      art: <span />,
    }));
    render(<CardDeck label="Community moments" items={items} />);
    const group = screen.getByRole('group', { name: 'Community moments' });
    const front = () => within(group).getByRole('button', { pressed: true });
    expect(front()).toHaveAccessibleName('Moment two');
    front().focus();
    fireEvent.keyDown(front(), { key: 'ArrowRight' });
    expect(front()).toHaveAccessibleName('Moment three');
    expect(front()).toHaveFocus();
    fireEvent.keyDown(front(), { key: 'Home' });
    expect(front()).toHaveAccessibleName('Moment one');
    fireEvent.click(within(group).getByRole('button', { name: 'Moment three' }));
    expect(front()).toHaveAccessibleName('Moment three');
  });
});

describe('staggered menu', () => {
  it('opens a dialog, closes on Escape and gives focus back', async () => {
    h.reduced = true;
    render(
      <StaggeredMenu
        contained
        items={[
          { label: 'Explore', href: '#explore' },
          { label: 'Create a coin', href: '#create' },
        ]}
        socials={[{ label: 'Telegram', href: '#telegram' }]}
      />,
    );
    const trigger = screen.getByRole('button', { name: /menu/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(dialog).getByRole('link', { name: /Create a coin/ })).toBeTruthy();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(within(dialog).getByRole('link', { name: /Explore/ })).toHaveFocus(),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});

describe('navigation and buttons', () => {
  it('pill nav marks the current link', () => {
    render(
      <PillNav
        items={[
          { label: 'Explore', href: '#explore' },
          { label: 'Create', href: '#create' },
        ]}
        onNavigate={(_, e) => e.preventDefault()}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Explore' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.click(within(nav).getByRole('link', { name: 'Create' }));
    expect(within(nav).getByRole('link', { name: 'Create' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Explore' })).not.toHaveAttribute('aria-current');
  });

  it('magnetic button is a real button, or a link with href', () => {
    const onClick = vi.fn();
    render(
      <>
        <MagneticButton onClick={onClick}>Launch your coin</MagneticButton>
        <MagneticButton href="#buy">Buy $NAPS</MagneticButton>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Launch your coin' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Buy $NAPS' })).toHaveAttribute('href', '#buy');
  });

  it('accordion toggles answers and moves between questions with the arrows', () => {
    render(
      <SmoothAccordion
        items={[
          { question: 'What does it cost?', answer: 'Launching is free.' },
          { question: 'Is there a presale?', answer: 'No.' },
        ]}
      />,
    );
    const first = screen.getByRole('button', { name: 'What does it cost?' });
    const second = screen.getByRole('button', { name: 'Is there a presale?' });
    expect(first).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'What does it cost?' })).toHaveTextContent(
      'Launching is free.',
    );
    fireEvent.click(second);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    second.focus();
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
  });

  it('hover list rows are links and show their preview on focus', () => {
    render(
      <HoverPreviewList
        label="Top coins"
        items={[
          { id: 'pepe', title: 'Pepe', href: '#pepe', preview: <span>Pepe art</span> },
          { id: 'bonk', title: 'Bonk', href: '#bonk', preview: <span>Bonk art</span> },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Top coins' });
    const bonk = within(list).getByRole('link', { name: /Bonk/ });
    expect(screen.queryByText('Bonk art')).toBeNull();
    fireEvent.focus(bonk);
    expect(screen.getByText('Bonk art')).toBeTruthy();
  });
});

describe('gauges and lists', () => {
  it('progress ring and arc gauge expose their values', () => {
    render(
      <>
        <ProgressRing value={72} label="Bonding curve progress" />
        <ArcGauge value={64} label="Hype meter" />
      </>,
    );
    const ring = screen.getByRole('progressbar', { name: 'Bonding curve progress' });
    expect(ring).toHaveAttribute('aria-valuenow', '72');
    const gauge = screen.getByRole('meter', { name: 'Hype meter' });
    expect(gauge).toHaveAttribute('aria-valuenow', '64');
    expect(gauge).toHaveAttribute('aria-valuetext', '64%');
  });

  it('bar list keeps names and values as text', () => {
    render(
      <BarList
        label="Top coins by volume"
        items={[
          { name: '$PEPE', value: 4_200_000, display: '$4.2M' },
          { name: '$BONK', value: 2_100_000, display: '$2.1M' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Top coins by volume' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('$4.2M')).toBeTruthy();
  });
});

describe('reduced motion', () => {
  beforeEach(() => {
    h.reduced = true;
  });

  it('reveals content at once and draws gauges at their value', () => {
    const { container } = render(
      <>
        <Reveal>
          <p>Why launch here</p>
        </Reveal>
        <Reveal stagger={0.1}>
          <p>Fair launch</p>
          <p>Creator fees</p>
        </Reveal>
        <BarList
          label="Top"
          items={[
            { name: 'A', value: 2 },
            { name: 'B', value: 1 },
          ]}
        />
      </>,
    );
    const reveals = [...container.querySelectorAll('.fx-reveal')];
    expect(reveals.map((el) => el.getAttribute('data-state'))).toEqual(['shown', 'shown']);
    const bars = [...container.querySelectorAll<HTMLElement>('.fx-bar-list [aria-hidden="true"]')];
    expect(bars.map((b) => b.style.transform)).toEqual(['scaleX(1)', 'scaleX(0.5)']);
    expect(bars.every((b) => b.style.transition === 'none' || b.style.transition === '')).toBe(
      true,
    );
  });

  it('keeps cards, grids and the smooth scroll provider static and readable', () => {
    render(
      <SmoothScroll contained>
        <StackCards items={[{ title: 'Create' }, { title: 'Trade' }]} />
        <SpotlightGrid items={[{ title: 'Fair launch' }]} />
        <TiltCard>
          <p>$NAPS</p>
        </TiltCard>
      </SmoothScroll>,
    );
    expect(screen.getByRole('heading', { name: 'Create' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Fair launch' })).toBeTruthy();
    expect(screen.getByText('$NAPS')).toBeTruthy();
  });
});
