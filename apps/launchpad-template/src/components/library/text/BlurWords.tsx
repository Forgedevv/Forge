import { motion } from 'motion/react';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { EASE_OUT, useCalm, useEntered } from '../motion/internal';

type TextTag = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'span' | 'div';

export interface BlurWordsProps {
  /** The full string. Screen readers read it once, as plain text. */
  text: string;
  /** Element to render. Default `p`. */
  as?: TextTag;
  /** Seconds between two words. Default 0.06. */
  stagger?: number;
  /** Seconds before the first word. */
  delay?: number;
  /** Starting blur, in pixels. Default 10 (a soft focus pull); 3 feels subtler, editorial. */
  blur?: number;
  /** Starting offset, in pixels. Default 14. */
  distance?: number;
  className?: string;
}

/**
 * Words that come into focus one after the other: each rises a few pixels while its blur clears,
 * like a camera pulling focus. Fits a hero subtitle, a manifesto line or a section intro
 * ("Fair launches. Instant liquidity. No presale.").
 */
export function BlurWords({
  text,
  as: Tag = 'p',
  stagger = 0.06,
  delay = 0,
  blur = 10,
  distance = 14,
  className,
}: BlurWordsProps) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const entered = useEntered(ref, { amount: 0.4 });
  const shown = calm || entered;
  const words = text.split(/\s+/).filter(Boolean);

  return (
    <Tag
      ref={ref as never}
      className={cn('fx-blur-words', className)}
      data-state={shown ? 'shown' : 'hidden'}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, i) => (
          <span key={`${word}-${i}`}>
            <motion.span
              className="inline-block will-change-[transform,filter]"
              initial={{ opacity: 0, y: distance, filter: `blur(${blur}px)` }}
              animate={
                shown
                  ? { opacity: 1, y: 0, filter: 'blur(0px)' }
                  : { opacity: 0, y: distance, filter: `blur(${blur}px)` }
              }
              transition={
                calm
                  ? { duration: 0 }
                  : { duration: 0.7, ease: EASE_OUT, delay: delay + i * stagger }
              }
            >
              {word}
            </motion.span>
            {i < words.length - 1 ? ' ' : null}
          </span>
        ))}
      </span>
    </Tag>
  );
}

export default BlurWords;
