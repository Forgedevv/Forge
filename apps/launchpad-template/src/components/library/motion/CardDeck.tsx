import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_OUT, useCalm } from './internal';

export interface CardDeckItem {
  id: string;
  /** Caption of the card, also its accessible name. */
  title: string;
  /** Second caption line (author, date, member count). */
  caption?: string;
  /** The face of the card: a gradient, an SVG, a local image. */
  art: ReactNode;
}

export interface CardDeckProps {
  items: readonly CardDeckItem[];
  /** Accessible name of the deck, for example "Community moments". */
  label: string;
  /** Index of the card in front at first. Default: the middle card. */
  initialIndex?: number;
  /** Card width, in pixels. Default 210. */
  cardWidth?: number;
  /** Horizontal distance between fanned cards, in pixels. Default 42% of the card width. */
  spread?: number;
  /** Also bring a card to the front when the mouse rests on it. Default false. */
  selectOnHover?: boolean;
  /** Called with the index of the card brought to the front. */
  onChange?: (index: number) => void;
  className?: string;
}

/**
 * A fanned hand of cards: the one in front stands straight and tall, the others lean away on both
 * sides. Clicking (or hovering, as an option) or the arrow keys bring a card to the front with a
 * smooth deal. For a community wall, memes of the week, featured launches or team members. Plain
 * CSS transitions; cards simply snap for reduced motion.
 */
export function CardDeck({
  items,
  label,
  initialIndex,
  cardWidth = 210,
  spread,
  selectOnHover = false,
  onChange,
  className,
}: CardDeckProps) {
  const calm = useCalm();
  const [selected, setSelected] = useState(initialIndex ?? Math.floor(items.length / 2));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const step = spread ?? cardWidth * 0.42;

  const select = (i: number, focus = false) => {
    const next = Math.max(0, Math.min(items.length - 1, i));
    setSelected(next);
    onChange?.(next);
    if (focus) buttons.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowLeft: selected - 1,
      ArrowRight: selected + 1,
      Home: 0,
      End: items.length - 1,
    };
    const target = keys[e.key];
    if (target === undefined) return;
    e.preventDefault();
    select(target, true);
  };

  return (
    <div
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('fx-card-deck relative h-full min-h-[300px] w-full', className)}
    >
      {items.map((item, i) => {
        const offset = i - selected;
        const distance = Math.abs(offset);
        const front = offset === 0;
        return (
          <button
            key={item.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            aria-pressed={front}
            tabIndex={front ? 0 : -1}
            onClick={() => select(i)}
            onPointerEnter={(e) => {
              if (selectOnHover && e.pointerType === 'mouse' && i !== selected) select(i);
            }}
            className="absolute left-1/2 top-1/2 flex flex-col overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              width: cardWidth,
              borderRadius: 'var(--radius-card)',
              zIndex: items.length - distance,
              transform: `translate(-50%, -50%) translateX(${offset * step}px) translateY(${front ? -6 : distance * 12}px) rotate(${offset * 6}deg) scale(${1 - distance * 0.07})`,
              transition: calm
                ? 'none'
                : `transform 0.6s ${CSS_EASE_OUT}, box-shadow 0.6s ${CSS_EASE_OUT}, filter 0.6s ${CSS_EASE_OUT}`,
              boxShadow: front
                ? '0 28px 60px -24px color-mix(in srgb, var(--color-primary) 55%, transparent)'
                : '0 12px 30px -18px color-mix(in srgb, var(--color-bg) 90%, transparent)',
              filter: front ? 'none' : `brightness(${1 - Math.min(0.35, distance * 0.12)})`,
            }}
          >
            <span
              aria-hidden="true"
              className="relative block aspect-[4/3] w-full overflow-hidden"
              style={{ borderRadius: 'calc(var(--radius-card) - 4px)' }}
            >
              {item.art}
            </span>
            <span className="px-1 pb-1 pt-2">
              <span className="block truncate text-sm font-semibold text-[var(--color-text)]">
                {item.title}
              </span>
              {item.caption && (
                <span className="block truncate text-xs text-[var(--color-text-muted)]">
                  {item.caption}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default CardDeck;
