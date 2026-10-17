import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { ChatScreen, STREAM_SCROLL_MS } from './chat';
import { WorkspaceProvider } from './provider';
import { NEAR_BOTTOM_PX, isNearBottom, useStickToBottom } from './scroll';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.setConfig({ testTimeout: 30_000 });

/** A scroll box with a fixed height: 300 px visible, `content` px of messages. */
function box(content = 1000) {
  return { scrollHeight: content, clientHeight: 300, scrollTop: 0 } as unknown as HTMLDivElement;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('conversation scroll', () => {
  it('counts the reader as at the end within the threshold', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 })).toBe(true);
    expect(
      isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 - NEAR_BOTTOM_PX }),
    ).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 200 })).toBe(false);
  });

  it('follows new content while the reader is at the end, and stops when they scroll up', () => {
    const element = box();
    const { result, rerender } = renderHook(({ content }) => useStickToBottom(content), {
      initialProps: { content: 0 },
    });
    result.current.ref.current = element;
    rerender({ content: 1 });
    expect(element.scrollTop).toBe(1000);
    // The reader scrolls up to read an earlier message.
    element.scrollTop = 100;
    result.current.onScroll();
    Object.assign(element, { scrollHeight: 1400 });
    rerender({ content: 2 });
    expect(element.scrollTop).toBe(100);
    // Sending a message of their own brings them back to the end.
    result.current.pin();
    rerender({ content: 3 });
    expect(element.scrollTop).toBe(1400);
  });

  it('spaces the scrolls while a reply streams in, the last one always landing', () => {
    const element = box();
    const { result, rerender } = renderHook(
      ({ content }) => useStickToBottom(content, STREAM_SCROLL_MS),
      { initialProps: { content: 0 } },
    );
    result.current.ref.current = element;
    rerender({ content: 1 });
    expect(element.scrollTop).toBe(1000);
    for (let token = 2; token < 10; token++) {
      Object.assign(element, { scrollHeight: 1000 + token * 10 });
      rerender({ content: token });
    }
    // Eight tokens within the throttle window: no move yet.
    expect(element.scrollTop).toBe(1000);
    act(() => {
      vi.advanceTimersByTime(STREAM_SCROLL_MS);
    });
    expect(element.scrollTop).toBe(1090);
  });

  it('never scrolls the page while a reply streams', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(
      <WorkspaceProvider controller={createMockController('chat:streaming')}>
        <ChatScreen />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
