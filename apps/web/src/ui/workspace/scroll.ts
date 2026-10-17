'use client';
import { useCallback, useEffect, useRef } from 'react';

/** How close to the end (px) still counts as "reading the latest". */
export const NEAR_BOTTOM_PX = 96;

type Scrollable = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>;

export function isNearBottom(element: Scrollable, threshold = NEAR_BOTTOM_PX): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

/**
 * Keeps a scrollable log at its end as `content` changes, without ever scrolling the page: only
 * the log itself moves (`scrollIntoView` would scroll every ancestor, the window included, which
 * on a phone yanks the page on every streamed token). It follows only while the reader is near the
 * end; scrolling up to read stops it until they come back down or `pin()` is called (a message of
 * their own). `throttleMs` spaces the moves while content streams in; the last one always lands.
 */
export function useStickToBottom<T extends HTMLElement>(content: unknown, throttleMs = 0) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element) pinned.current = isNearBottom(element);
  }, []);
  const pin = useCallback(() => {
    pinned.current = true;
  }, []);

  useEffect(() => {
    if (!ref.current || !pinned.current || timer.current) return;
    const scroll = () => {
      timer.current = null;
      const element = ref.current;
      if (!element || !pinned.current) return;
      last.current = Date.now();
      element.scrollTop = element.scrollHeight;
    };
    const wait = throttleMs - (Date.now() - last.current);
    if (wait <= 0) scroll();
    else timer.current = setTimeout(scroll, wait);
  }, [content, throttleMs]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { ref, onScroll, pin };
}
