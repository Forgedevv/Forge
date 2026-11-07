import { motion, useMotionTemplate, useMotionValue, useSpring } from 'motion/react';
import { useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useCalm } from './internal';

export interface TiltCardProps {
  children: ReactNode;
  /** Maximum tilt, in degrees. Default 10. */
  maxTilt?: number;
  /**
   * `lift`: the card turns its face toward the pointer (default).
   * `sink`: the card presses down under the pointer, like a soft button.
   */
  mode?: 'lift' | 'sink';
  /** A light reflection that follows the pointer. Default true. */
  glare?: boolean;
  /** Use the default card surface (border, background, radius). Default true. */
  surface?: boolean;
  className?: string;
}

/**
 * A card that tilts in 3D toward the pointer on a soft spring, with a glossy reflection gliding
 * across its face. Made for a featured coin, a launch tier or a value card ("Fair launch",
 * "Instant liquidity"). Ignores touch; stays flat for reduced motion.
 */
export function TiltCard({
  children,
  maxTilt = 10,
  mode = 'lift',
  glare = true,
  surface = true,
  className,
}: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const calm = useCalm();
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const scale = useMotionValue(1);
  const gx = useMotionValue(50);
  const gy = useMotionValue(30);
  const glow = useMotionValue(0);
  const spring = { stiffness: 170, damping: 18, mass: 0.6 };
  const srx = useSpring(rx, spring);
  const sry = useSpring(ry, spring);
  const sscale = useSpring(scale, spring);
  const sglow = useSpring(glow, { stiffness: 120, damping: 20 });
  const glareImage = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 58%)`;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || calm || e.pointerType === 'touch') return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    // `sink` pushes the point under the pointer away; `lift` raises it toward the viewer.
    const sign = mode === 'sink' ? 1 : -1;
    rx.set(-y * maxTilt * 2 * sign);
    ry.set(x * maxTilt * 2 * sign);
    scale.set(mode === 'lift' ? 1.03 : 0.98);
    gx.set((x + 0.5) * 100);
    gy.set((y + 0.5) * 100);
    glow.set(1);
  };
  const onLeave = () => {
    rx.set(0);
    ry.set(0);
    scale.set(1);
    glow.set(0);
  };

  return (
    <div style={{ perspective: 900 }} className="fx-tilt-card">
      <motion.div
        ref={ref}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        className={cn(
          'relative overflow-hidden',
          surface && 'border border-[var(--color-border)] bg-[var(--color-surface-raised)]',
          className,
        )}
        style={{
          rotateX: srx,
          rotateY: sry,
          scale: sscale,
          transformStyle: 'preserve-3d',
          borderRadius: surface ? 'var(--radius-card)' : undefined,
        }}
      >
        {children}
        {glare && (
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ backgroundImage: glareImage, opacity: sglow }}
          />
        )}
      </motion.div>
    </div>
  );
}

export default TiltCard;
