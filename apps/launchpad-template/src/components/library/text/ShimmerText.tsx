import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type TextTag = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'span' | 'div';

export interface ShimmerTextProps {
  children: ReactNode;
  /** Element to render. Default `span`. */
  as?: TextTag;
  /**
   * `shimmer`: muted text with a bright band sweeping across it (status labels, "Launching...").
   * `gradient`: the brand gradient (primary to accent) flowing slowly through the letters.
   */
  variant?: 'shimmer' | 'gradient';
  /** Seconds per sweep. Default 2.4 for `shimmer`, 6 for `gradient`. */
  duration?: number;
  className?: string;
}

// Plain CSS: the effect costs no JavaScript at all. Both loops stop for reduced motion.
const CSS = `
@keyframes fx-shimmer-sweep { from { background-position: 100% 0; } to { background-position: 0% 0; } }
.fx-shimmer {
  color: transparent;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  animation: fx-shimmer-sweep var(--fx-shimmer-duration) linear infinite;
}
.fx-shimmer[data-variant='shimmer'] {
  background-image: linear-gradient(100deg,
    var(--color-text-muted) 0%, var(--color-text-muted) 40%,
    var(--color-text) 50%,
    var(--color-text-muted) 60%, var(--color-text-muted) 100%);
  background-size: 250% 100%;
}
.fx-shimmer[data-variant='gradient'] {
  background-image: linear-gradient(90deg,
    var(--color-primary), var(--color-accent), var(--color-primary),
    var(--color-accent), var(--color-primary));
  background-size: 200% 100%;
  animation-direction: reverse;
}
@media (prefers-reduced-motion: reduce) {
  .fx-shimmer { animation: none; background-position: 30% 0; }
}
`;

/**
 * Text filled with moving light, in pure CSS. `shimmer` sweeps a bright band across muted text,
 * for live status labels ("Bonding curve filling..."), `gradient` flows the brand colours through a
 * headline word ("Launch your coin"). The text stays real, selectable text.
 */
export function ShimmerText({
  children,
  as: Tag = 'span',
  variant = 'shimmer',
  duration,
  className,
}: ShimmerTextProps) {
  const seconds = duration ?? (variant === 'gradient' ? 6 : 2.4);
  return (
    <>
      <style>{CSS}</style>
      <Tag
        className={cn('fx-shimmer', className)}
        data-variant={variant}
        style={{ '--fx-shimmer-duration': `${seconds}s` } as CSSProperties}
      >
        {children}
      </Tag>
    </>
  );
}

export default ShimmerText;
