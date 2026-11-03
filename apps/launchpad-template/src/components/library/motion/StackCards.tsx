import { motion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { useRef, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useCalm } from './internal';

export interface StackCardItem {
  /** Small label above the title, for example "Step 1". Defaults to the card number. */
  kicker?: string;
  title: string;
  description?: ReactNode;
  /** Optional art on the right side of the card (SVG, gradient shape, icon). */
  visual?: ReactNode;
}

export interface StackCardsProps {
  items: readonly StackCardItem[];
  /** Scrolling element when the cards live in a scroll box (with `position: relative`). */
  container?: RefObject<HTMLElement | null>;
  /** Distance from the top of the screen where cards stick, in pixels. Default 24. */
  top?: number;
  /** How much of each previous card stays visible above the next, in pixels. Default 18. */
  peek?: number;
  /** Scroll distance between two cards, in pixels. Default 120. */
  spacing?: number;
  className?: string;
  cardClassName?: string;
}

/**
 * Cards that pile up as the visitor scrolls: each one sticks near the top, and the next slides
 * over it while the previous ones shrink and dim into a neat stack. Made for "How it works"
 * (Create, Share, Trade, Graduate), a roadmap or tokenomics steps. Plain sticky cards without the
 * shrinking for reduced motion.
 */
export function StackCards({
  items,
  container,
  top = 24,
  peek = 18,
  spacing = 120,
  className,
  cardClassName,
}: StackCardsProps) {
  const list = useRef<HTMLOListElement>(null);
  const calm = useCalm();
  const { scrollYProgress } = useScroll({
    target: list,
    container,
    offset: ['start start', 'end end'],
  });

  return (
    <ol ref={list} className={cn('fx-stack-cards relative m-0 list-none p-0', className)}>
      {items.map((item, i) => (
        <StackCard
          key={`${item.title}-${i}`}
          item={item}
          index={i}
          count={items.length}
          progress={scrollYProgress}
          calm={calm}
          top={top + i * peek}
          spacing={i < items.length - 1 ? spacing : 0}
          className={cardClassName}
        />
      ))}
    </ol>
  );
}

interface StackCardProps {
  item: StackCardItem;
  index: number;
  count: number;
  progress: MotionValue<number>;
  calm: boolean;
  top: number;
  spacing: number;
  className?: string;
}

function StackCard({
  item,
  index,
  count,
  progress,
  calm,
  top,
  spacing,
  className,
}: StackCardProps) {
  const above = count - 1 - index;
  const range = [index / count, 1];
  const scale = useTransform(progress, range, [1, 1 - above * 0.045]);
  const shade = useTransform(progress, range, [0, Math.min(0.5, above * 0.14)]);

  return (
    <li className="sticky" style={{ top, marginBottom: spacing }}>
      <motion.article
        className={cn(
          'relative grid origin-top items-center gap-4 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-6 sm:grid-cols-[1fr_auto]',
          className,
        )}
        style={{
          scale: calm ? 1 : scale,
          borderRadius: 'var(--radius-card)',
          boxShadow: '0 -18px 40px -24px color-mix(in srgb, var(--color-bg) 85%, transparent)',
          backgroundImage:
            'radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--color-primary) 16%, transparent), transparent 60%)',
        }}
      >
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">
            {item.kicker ?? String(index + 1).padStart(2, '0')}
          </span>
          <h3 className="text-2xl font-semibold leading-tight text-[var(--color-text)]">
            {item.title}
          </h3>
          {item.description && (
            <div className="max-w-prose text-sm text-[var(--color-text-muted)]">
              {item.description}
            </div>
          )}
        </div>
        {item.visual && <div aria-hidden="true">{item.visual}</div>}
        {/* Darkens the cards further down the pile. */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[var(--color-bg)]"
          style={{ opacity: calm ? 0 : shade }}
        />
      </motion.article>
    </li>
  );
}

export default StackCards;
