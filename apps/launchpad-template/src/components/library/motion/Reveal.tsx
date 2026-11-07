import { motion } from 'motion/react';
import { Children, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { EASE_OUT, useCalm, useEntered } from './internal';

type BlockTag = 'div' | 'section' | 'ul' | 'ol' | 'article' | 'header' | 'footer';

export interface RevealProps {
  children: ReactNode;
  /** Element to render. Use `ul`/`ol` with `stagger`: each child is then wrapped in an `li`. */
  as?: BlockTag;
  /** Seconds between two direct children. When set, children appear one after the other. */
  stagger?: number;
  /** Seconds before the first move. */
  delay?: number;
  /** Rise distance in pixels. Default 28. */
  distance?: number;
  /** Starting blur in pixels; 0 for a plain fade. Default 6. */
  blur?: number;
  /** Starting scale. Default 1 (no zoom); 0.96 adds a subtle zoom in. */
  scale?: number;
  /** Seconds. Default 0.9. */
  duration?: number;
  className?: string;
  /** Classes for each wrapped child, when `stagger` is set. */
  itemClassName?: string;
}

/**
 * Generic scroll reveal: a block (or each of its children, staggered) fades in, rises and comes
 * into focus when it scrolls into view. The everyday workhorse for sections, card grids ("Why
 * launch here"), stats rows and footers. Plays once; shows everything at once for reduced motion.
 */
export function Reveal({
  children,
  as = 'div',
  stagger,
  delay = 0,
  distance = 28,
  blur = 6,
  scale = 1,
  duration = 0.9,
  className,
  itemClassName,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.15 });
  const shown = calm || entered;

  const hidden = {
    opacity: 0,
    y: distance,
    scale,
    filter: blur ? `blur(${blur}px)` : 'blur(0px)',
  };
  const visible = { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' };
  const transition = (i: number) =>
    calm ? { duration: 0 } : { duration, ease: EASE_OUT, delay: delay + i * (stagger ?? 0) };

  const Tag = as;
  if (stagger === undefined) {
    const MotionTag = motion[Tag];
    return (
      <MotionTag
        ref={ref as never}
        className={cn('fx-reveal', className)}
        data-state={shown ? 'shown' : 'hidden'}
        initial={hidden}
        animate={shown ? visible : hidden}
        transition={transition(0)}
      >
        {children}
      </MotionTag>
    );
  }

  const Item = as === 'ul' || as === 'ol' ? motion.li : motion.div;
  return (
    <Tag
      ref={ref as never}
      className={cn('fx-reveal', className)}
      data-state={shown ? 'shown' : 'hidden'}
    >
      {Children.toArray(children).map((child, i) => (
        <Item
          key={i}
          className={itemClassName}
          initial={hidden}
          animate={shown ? visible : hidden}
          transition={transition(i)}
        >
          {child}
        </Item>
      ))}
    </Tag>
  );
}

export default Reveal;
