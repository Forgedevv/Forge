import type { CSSProperties, ReactNode } from 'react';

interface DemoStageProps {
  /** The effect, stretched behind the copy. */
  children: ReactNode;
  title?: string;
  eyebrow?: string;
  cta?: string;
  /** Where the copy sits over the effect. */
  align?: 'center' | 'left' | 'bottom' | 'top';
  /** Hides the copy, for effects that are the subject themselves. */
  bare?: boolean;
}

const STAGE: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  isolation: 'isolate',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
};

const LAYER: CSSProperties = { position: 'absolute', inset: 0, zIndex: 0 };

/**
 * Showcase frame for the library: the effect behind a sample launchpad headline and button, all in
 * the theme variables, so each palette and mode can be checked in context.
 */
export function DemoStage({
  children,
  title = 'Launch your coin',
  eyebrow = 'Fair launch on Solana',
  cta = 'Create a coin',
  align = 'center',
  bare = false,
}: DemoStageProps) {
  const copy: CSSProperties = {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.9rem',
    height: '100%',
    boxSizing: 'border-box',
    padding: '2rem',
    pointerEvents: 'none',
    alignItems: align === 'left' ? 'flex-start' : 'center',
    justifyContent: align === 'bottom' ? 'flex-end' : align === 'top' ? 'flex-start' : 'center',
    textAlign: align === 'left' ? 'left' : 'center',
  };
  return (
    <div style={STAGE}>
      <div style={LAYER}>{children}</div>
      {!bare && (
        <div style={copy}>
          <span
            style={{
              fontSize: '0.7rem',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
            }}
          >
            {eyebrow}
          </span>
          <span
            role="heading"
            aria-level={3}
            style={{
              margin: 0,
              maxWidth: '14ch',
              font: '600 clamp(1.9rem, 4.2vw, 2.9rem)/1.02 var(--font-heading)',
              letterSpacing: '-0.03em',
            }}
          >
            {title}
          </span>
          <span
            style={{
              marginTop: '0.4rem',
              padding: '0.65rem 1.2rem',
              borderRadius: 'var(--radius)',
              background: 'var(--color-primary)',
              color: 'var(--color-bg)',
              font: '600 0.85rem/1 var(--font-body)',
              pointerEvents: 'auto',
              boxShadow: '0 10px 30px -12px var(--color-primary)',
            }}
          >
            {cta}
          </span>
        </div>
      )}
    </div>
  );
}
