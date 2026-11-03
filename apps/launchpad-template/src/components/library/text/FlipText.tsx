import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_BACK } from '../motion/internal';

export interface FlipTextProps {
  /** The label. Screen readers read it once, as plain text. */
  text: string;
  /** Colour of the face that rolls in. Default the accent colour. */
  hoverColor?: string;
  /** Milliseconds between two letters. Default 22. */
  stagger?: number;
  className?: string;
}

const CSS = `
.fx-flip { display: inline-flex; perspective: 600px; }
.fx-flip-l {
  position: relative; display: inline-block; line-height: 1;
  transform-style: preserve-3d; transform: translateZ(-0.5em);
  transition: transform 0.55s ${CSS_EASE_BACK};
}
.fx-flip-l > span { display: block; backface-visibility: hidden; transform: translateZ(0.5em); }
.fx-flip-l > span + span {
  position: absolute; inset: 0;
  transform: rotateX(90deg) translateZ(0.5em);
  color: var(--fx-flip-color);
}
.fx-flip:hover .fx-flip-l,
[data-flip-host]:hover .fx-flip-l,
[data-flip-host]:focus-visible .fx-flip-l { transform: translateZ(-0.5em) rotateX(-90deg); }
@media (prefers-reduced-motion: reduce) { .fx-flip-l { transition: none; } }
`;

/**
 * A label whose letters roll over like little cubes, one after the other, revealing a second
 * coloured face on hover. Pure CSS. Put it inside a button or link and mark that parent with
 * `data-flip-host` so the whole control triggers it (keyboard focus too): "Launch your coin",
 * "Connect wallet", navigation links.
 */
export function FlipText({ text, hoverColor, stagger = 22, className }: FlipTextProps) {
  const letters = Array.from(text);
  return (
    <>
      <style>{CSS}</style>
      <span
        className={cn('fx-flip', className)}
        style={{ '--fx-flip-color': hoverColor ?? 'var(--color-accent)' } as CSSProperties}
      >
        <span className="sr-only">{text}</span>
        {letters.map((letter, i) => {
          const ch = letter === ' ' ? ' ' : letter;
          return (
            <span
              key={i}
              aria-hidden="true"
              className="fx-flip-l"
              style={{ transitionDelay: `${i * stagger}ms` }}
            >
              <span>{ch}</span>
              <span>{ch}</span>
            </span>
          );
        })}
      </span>
    </>
  );
}

export default FlipText;
