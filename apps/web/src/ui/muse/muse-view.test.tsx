import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Muse } from './muse-view';
import { viewCount } from './loop';

beforeEach(() => {
  // jsdom has no 2D canvas; the loop simply skips drawing.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('is decorative by default and named when labeled', () => {
  const { container } = render(<Muse size={40} />);
  expect(container.querySelector('.muse')).toHaveAttribute('aria-hidden', 'true');
  render(<Muse size={40} label="Orbit's Muse" primary="#827bdf" accent="#c3caff" />);
  expect(screen.getByRole('img', { name: "Orbit's Muse" })).toBeInTheDocument();
});

it('never renders below the minimum size and lets the glow bleed past small boxes', () => {
  const { container } = render(<Muse size={10} />);
  const box = container.querySelector<HTMLElement>('.muse')!;
  expect(box.style.getPropertyValue('--muse-box')).toBe('24px');
  expect(box.style.getPropertyValue('--muse-canvas')).toBe('42px');
});

it('shares one loop between instances and releases it on unmount', () => {
  const before = viewCount();
  const first = render(<Muse mood="building" />);
  const second = render(<Muse mood="thinking" />);
  expect(viewCount()).toBe(before + 2);
  fireEvent.pointerDown(first.container.querySelector('.muse')!);
  first.unmount();
  second.unmount();
  expect(viewCount()).toBe(before);
});
