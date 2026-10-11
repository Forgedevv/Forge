'use client';

import { useEffect, useRef, useState } from 'react';
import { captionAt, CAPTION_TICK_MS } from './choreography';

/** The readable caption remains available to assistive technology throughout its visual reveal. */
export function ChapterCaption({ text, paused }: { text: string; paused: boolean }) {
  const elapsed = useRef(0);
  const [frame, setFrame] = useState(() => captionAt(text, 0));

  useEffect(() => {
    if (paused) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (!document.hidden) {
        elapsed.current += Math.min(100, now - previous);
        const next = captionAt(text, elapsed.current);
        setFrame(next);
        if (next.complete) window.clearInterval(timer);
      }
      previous = now;
    }, CAPTION_TICK_MS);
    return () => window.clearInterval(timer);
  }, [text, paused]);

  return (
    <p className="forge-subtitle">
      <span className="forge-sr-only">{text}</span>
      <span className="forge-subtitle-visual" data-visible={paused || frame.visible} aria-hidden="true">
        {paused ? text : frame.text || '\u00a0'}
      </span>
    </p>
  );
}
