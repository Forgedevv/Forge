import { motion, useMotionValue, useSpring } from 'motion/react';
import { useRef, type MouseEventHandler, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useCalm } from './internal';

export interface MagneticButtonProps {
  children: ReactNode;
  /** Renders a link when set, a button otherwise. */
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  /** How far the button follows the pointer, as a share of the pointer offset. Default 0.35. */
  strength?: number;
  /** `primary`: filled with the primary colour (default). `ghost`: outlined. */
  variant?: 'primary' | 'ghost';
  /** Show the glow ring that wakes up on hover. Default true for `primary`. */
  glow?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}

/**
 * A call-to-action that is pulled toward the pointer like a magnet when the hand comes close, its
 * label drifting a little further for depth, then springs back. For the one action that matters:
 * "Launch your coin", "Buy $NAPS", "Connect wallet". Real button or link; stays put for touch and
 * reduced motion.
 */
export function MagneticButton({
  children,
  href,
  onClick,
  strength = 0.35,
  variant = 'primary',
  glow,
  type = 'button',
  className,
}: MagneticButtonProps) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const spring = { stiffness: 220, damping: 15, mass: 0.5 };
  const sx = useSpring(x, spring);
  const sy = useSpring(y, spring);
  const lx = useSpring(useMotionValue(0), spring);
  const ly = useSpring(useMotionValue(0), spring);
  const showGlow = glow ?? variant === 'primary';

  const onMove = (e: PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el || calm || e.pointerType === 'touch') return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    x.set(dx * strength);
    y.set(dy * strength);
    lx.set(dx * strength * 0.4);
    ly.set(dy * strength * 0.4);
  };
  const onLeave = () => {
    x.set(0);
    y.set(0);
    lx.set(0);
    ly.set(0);
  };

  const classes = cn(
    'relative inline-flex h-12 items-center justify-center rounded-full px-7 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
    variant === 'primary'
      ? 'bg-[var(--color-primary)] text-primary-950'
      : 'border border-[var(--color-border)] bg-transparent text-[var(--color-text)] hover:border-[var(--color-primary)]',
    className,
  );
  const label = (
    <motion.span className="relative inline-flex items-center gap-2" style={{ x: lx, y: ly }}>
      {children}
    </motion.span>
  );

  // The outer span catches the pointer in a margin around the button, so the pull starts early.
  return (
    <span
      className="fx-magnetic group relative isolate inline-block p-3"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      {showGlow && (
        // A blurred brand gradient behind the button, following it.
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-3 -z-10 rounded-full opacity-0 blur-lg transition-opacity duration-500 group-focus-within:opacity-60 group-hover:opacity-60"
          style={{
            x: sx,
            y: sy,
            background: 'linear-gradient(90deg, var(--color-primary), var(--color-accent))',
          }}
        />
      )}
      {href ? (
        <motion.a
          ref={ref as never}
          href={href}
          onClick={onClick}
          className={classes}
          style={{ x: sx, y: sy }}
        >
          {label}
        </motion.a>
      ) : (
        <motion.button
          ref={ref as never}
          type={type}
          onClick={onClick}
          className={classes}
          style={{ x: sx, y: sy }}
        >
          {label}
        </motion.button>
      )}
    </span>
  );
}

export default MagneticButton;
