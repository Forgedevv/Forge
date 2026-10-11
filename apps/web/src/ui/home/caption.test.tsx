import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterCaption } from './caption';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('caption lifecycle', () => {
  it('provides the readable text immediately and fades only the animated copy', () => {
    const { container } = render(<ChapterCaption text="Build your world." paused={false} />);
    expect(container.querySelector('.forge-sr-only')).toHaveTextContent('Build your world.');
    const visual = container.querySelector('.forge-subtitle-visual')!;
    act(() => vi.advanceTimersByTime(1100));
    expect(visual).toHaveTextContent('Build your world.');
    act(() => vi.advanceTimersByTime(3500));
    expect(visual).toHaveAttribute('data-visible', 'false');
    expect(container.querySelector('.forge-sr-only')).toHaveTextContent('Build your world.');
  });

  it('keeps captions readable when motion is paused', () => {
    const { container, rerender } = render(<ChapterCaption text="Build your world." paused={false} />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<ChapterCaption text="Build your world." paused />);
    act(() => vi.advanceTimersByTime(10000));
    expect(container.querySelector('.forge-subtitle-visual')).toHaveTextContent('Build your world.');
    expect(container.querySelector('.forge-subtitle-visual')).toHaveAttribute('data-visible', 'true');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not advance in a hidden tab and releases its timer on unmount', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { container, unmount } = render(<ChapterCaption text="Build your world." paused={false} />);
    const visual = container.querySelector('.forge-subtitle-visual')!;
    const initial = visual.textContent;
    act(() => vi.advanceTimersByTime(6000));
    expect(visual.textContent).toBe(initial);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
