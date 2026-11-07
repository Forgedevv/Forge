import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useVelocity,
} from 'motion/react';
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { isExternalHref, safeHref } from '../shared/safeHref';
import { EASE_OUT, useCalm } from './internal';

export interface HoverPreviewItem {
  /** Stable key. */
  id: string;
  /** Main text of the row (coin name, question, article title). */
  title: ReactNode;
  /** Small text before the title (symbol, index). */
  lead?: ReactNode;
  /** Right-hand detail (market cap, change, date). */
  trail?: ReactNode;
  /**
   * Link target: a path of this site or an allowed social or explorer page (`safeHref`). Without
   * it, or with another target, the row is a button calling `onSelect`.
   */
  href?: string;
  /** Card that floats next to the pointer while the row is hovered or focused. */
  preview?: ReactNode;
}

export interface HoverPreviewListProps {
  items: readonly HoverPreviewItem[];
  /** Called when a row without `href` is activated. */
  onSelect?: (id: string) => void;
  /** Accessible name of the list. */
  label?: string;
  /** Size of the floating card, in pixels. Default 180 x 120. */
  previewSize?: { width: number; height: number };
  className?: string;
}

/**
 * A list of rows that shows a floating preview card next to the pointer: the card follows the hand
 * on a spring and leans into fast moves. Rows slide a little and light up on hover. For a coin list
 * ($PEPE, $BONK, $NAPS with their art), recent launches or blog posts. Keyboard focus shows the
 * card beside the focused row; touch screens just get the rows.
 */
export function HoverPreviewList({
  items,
  onSelect,
  label,
  previewSize = { width: 180, height: 120 },
  className,
}: HoverPreviewListProps) {
  const host = useRef<HTMLDivElement>(null);
  const calm = useCalm();
  const [active, setActive] = useState<number | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 170, damping: 22, mass: 0.6 });
  const sy = useSpring(y, { stiffness: 170, damping: 22, mass: 0.6 });
  const rotate = useTransform(useVelocity(sx), [-1600, 1600], [-9, 9]);
  const current = active === null ? null : items[active];

  const place = (clientX: number, clientY: number) => {
    const r = host.current?.getBoundingClientRect();
    if (!r) return;
    const px = clientX - r.left;
    // Right of the pointer, or left of it when the card would overflow the list.
    x.set(px + 24 + previewSize.width > r.width ? px - previewSize.width - 24 : px + 24);
    y.set(clientY - r.top - previewSize.height / 2);
  };
  const onRowPointer = (e: PointerEvent, i: number) => {
    if (e.pointerType === 'touch') return;
    place(e.clientX, e.clientY);
    setActive(i);
  };
  const onRowFocus = (target: HTMLElement, i: number) => {
    const r = host.current?.getBoundingClientRect();
    const row = target.getBoundingClientRect();
    if (!r) return;
    // Beside the focused row, on its right third.
    x.jump(row.left - r.left + row.width * 0.62);
    y.jump(row.top - r.top + row.height / 2 - previewSize.height / 2);
    sx.jump(x.get());
    sy.jump(y.get());
    setActive(i);
  };

  return (
    <div
      ref={host}
      className={cn('fx-hover-list relative', className)}
      onPointerMove={(e) => {
        if (e.pointerType !== 'touch' && active !== null) place(e.clientX, e.clientY);
      }}
      onPointerLeave={() => setActive(null)}
    >
      <ul aria-label={label} className="m-0 list-none border-t border-[var(--color-border)] p-0">
        {items.map((item, i) => {
          const rowClass = cn(
            'group flex w-full items-center gap-4 border-b border-[var(--color-border)] px-2 py-4 text-left transition-[background-color,padding] duration-300 outline-none',
            'hover:bg-[color-mix(in_srgb,var(--color-primary)_7%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]',
            !calm && 'hover:pl-4 focus-visible:pl-4',
          );
          const content = (
            <>
              {item.lead && (
                <span className="w-16 shrink-0 font-mono text-xs text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)]">
                  {item.lead}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-lg font-medium text-[var(--color-text)]">
                {item.title}
              </span>
              {item.trail && (
                <span className="shrink-0 text-sm tabular-nums text-[var(--color-text-muted)]">
                  {item.trail}
                </span>
              )}
              <span
                aria-hidden="true"
                className="shrink-0 text-[var(--color-text-muted)] transition-transform duration-300 group-hover:translate-x-1 group-hover:text-[var(--color-accent)]"
              >
                →
              </span>
            </>
          );
          const handlers = {
            onPointerEnter: (e: PointerEvent) => onRowPointer(e, i),
            onFocus: (e: { currentTarget: HTMLElement }) => onRowFocus(e.currentTarget, i),
            onBlur: () => setActive(null),
          };
          // Only paths of this site and allowed social or explorer pages (`safeHref`).
          const href = safeHref(item.href);
          return (
            <li key={item.id}>
              {href ? (
                <a
                  href={href}
                  rel={isExternalHref(href) ? 'noopener noreferrer' : undefined}
                  className={rowClass}
                  {...handlers}
                >
                  {content}
                </a>
              ) : (
                <button
                  type="button"
                  className={rowClass}
                  onClick={() => onSelect?.(item.id)}
                  {...handlers}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-10"
        style={{
          x: calm ? x : sx,
          y: calm ? y : sy,
          rotate: calm ? 0 : rotate,
          width: previewSize.width,
          height: previewSize.height,
        }}
      >
        <AnimatePresence>
          {current?.preview && (
            <motion.div
              key={current.id}
              className="absolute inset-0 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-2xl"
              style={{ borderRadius: 'var(--radius-card)' }}
              initial={calm ? { opacity: 0 } : { opacity: 0, scale: 0.8, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={calm ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -8 }}
              transition={{ duration: calm ? 0 : 0.4, ease: EASE_OUT }}
            >
              {current.preview}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

export default HoverPreviewList;
