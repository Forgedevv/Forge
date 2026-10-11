'use client';

import { useId } from 'react';
import { homeContent as copy } from './content';

/** The circular fill starts at the pointer; keyboard focus uses its central resting position. */
export function ScrollCue({ onClick }: { onClick(): void }) {
  const id = useId().replace(/:/g, '');
  return (
    <button
      className="forge-scroll"
      aria-label={copy.scroll}
      onClick={onClick}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty('--cue-x', `${event.clientX - bounds.left}px`);
        event.currentTarget.style.setProperty('--cue-y', `${event.clientY - bounds.top}px`);
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.removeProperty('--cue-x');
        event.currentTarget.style.removeProperty('--cue-y');
      }}
    >
      <i className="forge-scroll-fill" aria-hidden="true" />
      <svg className="forge-scroll-ring" viewBox="0 0 200 200" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-ring`}>
            <stop stopColor="currentColor" stopOpacity="0" />
            <stop offset="1" stopColor="currentColor" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="98" stroke={`url(#${id}-ring)`} strokeWidth="2" />
      </svg>
      <span>{copy.scrollButton}</span>
    </button>
  );
}
