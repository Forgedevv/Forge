import { motion } from 'motion/react';
import { Fragment, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { EASE_CURTAIN, EASE_EXPO, useCalm, useEntered } from '../motion/internal';

type TextTag = 'h1' | 'h2' | 'h3' | 'p' | 'div';

export interface MaskLinesProps {
  /** One entry per line. Lines may hold markup, for example an accent `<em>` word. */
  lines: readonly ReactNode[];
  /** Element to render. Default `h2`. */
  as?: TextTag;
  /** Seconds between two lines. Default 0.12. */
  stagger?: number;
  /** Seconds before the first line. */
  delay?: number;
  /**
   * `rise`: each line slides up out of its mask (default).
   * `curtain`: each line is uncovered left to right, like a curtain pulled aside.
   */
  effect?: 'rise' | 'curtain';
  className?: string;
}

/**
 * A multi-line title whose lines appear one after the other from behind invisible masks: they slide
 * up from below the baseline, or are uncovered left to right. The editorial way to open a section
 * ("The fairest launchpad / on Solana."). Lines are given explicitly, so the break never depends on
 * measuring text; screen readers read them as one normal title.
 */
export function MaskLines({
  lines,
  as: Tag = 'h2',
  stagger = 0.12,
  delay = 0,
  effect = 'rise',
  className,
}: MaskLinesProps) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.3 });
  const shown = calm || entered;

  return (
    <Tag
      ref={ref as never}
      className={cn('fx-mask-lines', className)}
      data-state={shown ? 'shown' : 'hidden'}
    >
      {lines.map((line, i) => {
        const transition = calm
          ? { duration: 0 }
          : {
              duration: effect === 'rise' ? 1.1 : 1.2,
              ease: effect === 'rise' ? EASE_EXPO : EASE_CURTAIN,
              delay: delay + i * stagger,
            };
        return (
          <Fragment key={i}>
            {/* A space between lines, so read or copied text never glues two words together. */}
            {i > 0 ? ' ' : null}
            <span
              className="block overflow-hidden"
              style={{ paddingBottom: '0.1em', marginBottom: '-0.1em' }}
            >
              {effect === 'rise' ? (
                <motion.span
                  className="block will-change-transform"
                  initial={{ y: '110%' }}
                  animate={{ y: shown ? '0%' : '110%' }}
                  transition={transition}
                >
                  {line}
                </motion.span>
              ) : (
                <motion.span
                  className="block"
                  initial={{ clipPath: 'inset(0% 100% 0% 0%)' }}
                  animate={{ clipPath: shown ? 'inset(0% 0% 0% 0%)' : 'inset(0% 100% 0% 0%)' }}
                  transition={transition}
                >
                  {line}
                </motion.span>
              )}
            </span>
          </Fragment>
        );
      })}
    </Tag>
  );
}

export default MaskLines;
