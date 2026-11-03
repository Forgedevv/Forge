import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SpotlightGridItem {
  title: string;
  description?: ReactNode;
  /** Small label above the title. */
  kicker?: string;
  /** Art or figure shown at the top of the card (SVG, gradient, a big number). */
  visual?: ReactNode;
  /** Footprint in the grid. Default `normal` (one cell). */
  size?: 'normal' | 'wide' | 'tall' | 'large';
}

export interface SpotlightGridProps {
  items: readonly SpotlightGridItem[];
  /** Columns on wide screens (one column on phones). Default 3. */
  columns?: number;
  /** Radius of the light, in pixels. Default 280. */
  radius?: number;
  className?: string;
  cardClassName?: string;
}

const SPAN: Record<NonNullable<SpotlightGridItem['size']>, string> = {
  normal: '',
  wide: 'sm:col-span-2',
  tall: 'sm:row-span-2',
  large: 'sm:col-span-2 sm:row-span-2',
};

/**
 * A bento grid of value cards lit by one shared spotlight: as the pointer moves over the grid, a
 * soft glow follows it, lighting the borders of every card it passes near and warming the nearest
 * card's face. For "Why launch here" (fair launch, instant liquidity, creator fees, no code) or a
 * features overview. Pointer only, no animation loop; nothing moves for reduced motion.
 */
export function SpotlightGrid({
  items,
  columns = 3,
  radius = 280,
  className,
  cardClassName,
}: SpotlightGridProps) {
  const grid = useRef<HTMLDivElement>(null);

  // Each card gets the pointer position in its own coordinates, written as CSS variables.
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const cards = grid.current?.querySelectorAll<HTMLElement>('[data-spotlight-card]');
    cards?.forEach((card) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--fx-mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--fx-my', `${e.clientY - r.top}px`);
    });
    grid.current?.style.setProperty('--fx-on', '1');
  };
  const onLeave = () => grid.current?.style.setProperty('--fx-on', '0');

  return (
    <div
      ref={grid}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      className={cn('fx-spotlight-grid grid auto-rows-[minmax(150px,auto)] gap-3', className)}
      style={
        {
          '--fx-on': 0,
          '--fx-r': `${radius}px`,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        } as CSSProperties
      }
    >
      {items.map((item, i) => (
        <article
          key={`${item.title}-${i}`}
          data-spotlight-card=""
          className={cn(
            'relative max-sm:col-span-full',
            SPAN[item.size ?? 'normal'],
            cardClassName,
          )}
          style={{
            borderRadius: 'var(--radius-card)',
            padding: 1,
            // The border: a base line plus the travelling light, seen through the 1px padding.
            background:
              'radial-gradient(var(--fx-r) circle at var(--fx-mx, -999px) var(--fx-my, -999px), color-mix(in srgb, var(--color-primary) calc(var(--fx-on) * 85%), transparent), transparent 70%), var(--color-border)',
          }}
        >
          <div
            className="relative flex h-full flex-col gap-2 overflow-hidden p-5"
            style={{
              borderRadius: 'calc(var(--radius-card) - 1px)',
              background:
                'radial-gradient(calc(var(--fx-r) * 0.8) circle at var(--fx-mx, -999px) var(--fx-my, -999px), color-mix(in srgb, var(--color-primary) calc(var(--fx-on) * 12%), transparent), transparent 70%), var(--color-surface-raised)',
            }}
          >
            {item.visual && (
              <div aria-hidden="true" className="mb-auto">
                {item.visual}
              </div>
            )}
            {item.kicker && (
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-accent)]">
                {item.kicker}
              </span>
            )}
            <h3 className="text-lg font-semibold leading-snug text-[var(--color-text)]">
              {item.title}
            </h3>
            {item.description && (
              <div className="text-sm text-[var(--color-text-muted)]">{item.description}</div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

export default SpotlightGrid;
