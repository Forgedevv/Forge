'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HeroHandle, HeroMuse } from '../muse/three/hero-scene';
import type { FigureAction } from '../muse/three/figure';
import { Muse, type MuseMood } from '../muse';
import { dashboardCopy as copy } from './content/dashboard';

export type HeroAction = FigureAction;

const FALLBACK_MOOD: Record<HeroAction, MuseMood> = {
  welcome: 'idle',
  building: 'building',
  live: 'success',
  idle: 'idle',
};

function webglAvailable() {
  if (typeof window === 'undefined' || typeof WebGLRenderingContext === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(gl);
  } catch {
    return false;
  }
}

/**
 * The dashboard hero: the full-body FORGE Muse in a small 3D scene with the user's own
 * launchpad Muses around it. Falls back to the 2D Muse when WebGL is unavailable.
 */
export function MuseHero({
  action,
  muses,
  forceFallback = false,
  children,
}: {
  action: HeroAction;
  muses: HeroMuse[];
  /** Development gallery: show the 2D fallback. */
  forceFallback?: boolean;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const handle = useRef<HeroHandle | null>(null);
  const [fallback, setFallback] = useState(forceFallback);
  const [reduced, setReduced] = useState<boolean | null>(null);
  const latest = useRef({ action, muses });
  latest.current = { action, muses };
  const museKey = muses.map((m) => `${m.id}:${m.primary}:${m.accent}`).join('|');

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    setReduced(Boolean(media?.matches));
    const apply = () => setReduced(Boolean(media?.matches));
    media?.addEventListener?.('change', apply);
    return () => media?.removeEventListener?.('change', apply);
  }, []);

  useEffect(() => {
    const element = stage.current;
    if (fallback || reduced === null || !element) return;
    if (!webglAvailable()) {
      setFallback(true);
      return;
    }
    let cancelled = false;
    void import('../muse/three/hero-scene')
      .then(({ createHeroScene }) => {
        if (cancelled) return;
        handle.current = createHeroScene(element, { ...latest.current, reduced });
      })
      .catch(() => {
        if (!cancelled) setFallback(true);
      });
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
    };
  }, [fallback, reduced]);

  useEffect(() => {
    handle.current?.setAction(action);
  }, [action]);
  useEffect(() => {
    handle.current?.setMuses(latest.current.muses);
  }, [museKey]);

  return (
    <section className="fw-card fw-muse-hero" data-action={action} aria-label={copy.hero.label}>
      <div
        ref={stage}
        className="fw-muse-hero-stage"
        onPointerDown={() => handle.current?.poke()}
        data-fallback={fallback}
      >
        {fallback && (
          <div className="fw-muse-hero-fallback">
            <Muse size={170} mood={FALLBACK_MOOD[action]} />
            {muses.length > 0 && (
              <div className="fw-muse-hero-family">
                {muses.slice(0, 6).map((m) => (
                  <Muse key={m.id} size={36} primary={m.primary} accent={m.accent} gaze="none" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="fw-muse-hero-copy">
        <p className="fw-eyebrow">{copy.hero.eyebrow}</p>
        <h2>{copy.hero[action].title}</h2>
        <p>{copy.hero[action].body}</p>
        {children}
      </div>
    </section>
  );
}
