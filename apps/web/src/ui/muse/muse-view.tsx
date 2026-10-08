'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { FORGE_ACCENT, FORGE_PRIMARY, Muse as MuseEngine } from './engine';
import { addView, touchView } from './loop';
import type { MuseMood } from './moods';
import { isHexColor } from './paint';
import './muse.css';

/** The smallest size at which a Muse stays readable (docs/BRAND.md). */
export const MUSE_MIN_SIZE = 24;
/** Below this size a Muse uses its "mini" rig: fewer details, bigger features. */
const MINI_BELOW = 96;
/** Small Muses draw on a canvas this much larger than their box so the glow can breathe. */
const MINI_BLEED = 1.75;

export interface MuseProps {
  mood?: MuseMood;
  /** Box size in CSS pixels (at least 24). */
  size?: number;
  /** `cursor`: the eyes follow the pointer. `none`: an idle wander. */
  gaze?: 'cursor' | 'none';
  /** Body color, for example a launchpad's theme primary. Defaults to FORGE violet. */
  primary?: string | null;
  /** Rim and spark color, for example a launchpad's theme accent. Defaults to FORGE magenta. */
  accent?: string | null;
  /** Accessible name. Without it the Muse is decorative and hidden from assistive tech. */
  label?: string;
  /** React to clicks (happy squash, wake-up, dizzy after five fast clicks). */
  interactive?: boolean;
  className?: string;
}

/** Tracks the `prefers-reduced-motion` media query. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const apply = () => setReduced(media.matches);
    apply();
    media.addEventListener?.('change', apply);
    return () => media.removeEventListener?.('change', apply);
  }, []);
  return reduced;
}

/** The FORGE Muse, drawn live on a canvas. */
export function Muse({
  mood = 'idle',
  size = 40,
  gaze = 'cursor',
  primary,
  accent,
  label,
  interactive = true,
  className = '',
}: MuseProps) {
  const box = Math.max(MUSE_MIN_SIZE, Math.round(size));
  const mini = box < MINI_BELOW;
  const canvasSize = Math.round(mini ? box * MINI_BLEED : box);
  const rf = mini ? 0.36 / MINI_BLEED : 0.25;
  const reduced = useReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<MuseEngine | null>(null);
  const body = isHexColor(primary) ? primary : FORGE_PRIMARY;
  const rim = isHexColor(accent) ? accent : FORGE_ACCENT;
  const latest = useRef({ mood, body, rim });
  latest.current = { mood, body, rim };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const muse = new MuseEngine({
      mini,
      reduced,
      primary: latest.current.body,
      accent: latest.current.rim,
    });
    muse.setMood(latest.current.mood);
    muse.snap();
    engine.current = muse;
    const remove = addView({ canvas: element, muse, canvasSize, rf, gaze: gaze === 'cursor' });
    return () => {
      remove();
      if (engine.current === muse) engine.current = null;
    };
  }, [mini, reduced, canvasSize, rf, gaze]);

  useEffect(() => {
    engine.current?.setMood(mood);
    if (canvas.current) touchView(canvas.current);
  }, [mood]);
  useEffect(() => {
    engine.current?.setColors(body, rim);
    if (canvas.current) touchView(canvas.current);
  }, [body, rim]);

  return (
    <span
      className={`muse ${interactive ? 'muse-interactive' : ''} ${className}`}
      style={{ '--muse-box': `${box}px`, '--muse-canvas': `${canvasSize}px` } as CSSProperties}
      data-mood={mood}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      onPointerDown={
        interactive
          ? () => {
              engine.current?.poke();
              if (canvas.current) touchView(canvas.current);
            }
          : undefined
      }
    >
      <canvas ref={canvas} />
    </span>
  );
}
