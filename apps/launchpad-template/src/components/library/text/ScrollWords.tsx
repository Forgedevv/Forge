import { useMotionValueEvent, useScroll } from 'motion/react';
import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useCalm } from '../motion/internal';

type TextTag = 'h2' | 'h3' | 'p' | 'div';

export interface ScrollWordsProps {
  /** The full paragraph. Screen readers read it once, as plain text. */
  text: string;
  /** Element to render. Default `p`. */
  as?: TextTag;
  /**
   * Scrolling element when the text lives inside a scroll box instead of the page (the showcase
   * demo, a modal); give that box `position: relative`. Leave empty for the page.
   */
  container?: RefObject<HTMLElement | null>;
  /** Dim words keep a little blur until they light up. Default true. */
  blur?: boolean;
  className?: string;
}

/**
 * A manifesto paragraph that lights up word by word as the visitor scrolls: words start dim and
 * slightly blurred and turn full colour when the reading point reaches them. Made for a mission
 * statement ("We built the fairest place to launch a coin...") between two sections.
 */
export function ScrollWords({
  text,
  as: Tag = 'p',
  container,
  blur = true,
  className,
}: ScrollWordsProps) {
  const ref = useRef<HTMLElement>(null);
  const calm = useCalm();
  const { scrollYProgress } = useScroll({
    target: ref,
    container,
    offset: ['start 85%', 'end 45%'],
  });
  const words = text.split(/\s+/).filter(Boolean);

  // The progress goes straight into a CSS variable: no React render while scrolling.
  useMotionValueEvent(scrollYProgress, 'change', (value) => {
    if (!calm) ref.current?.style.setProperty('--fx-p', value.toFixed(4));
  });
  useEffect(() => {
    ref.current?.style.setProperty('--fx-p', calm ? '1' : scrollYProgress.get().toFixed(4));
  }, [calm, scrollYProgress]);

  const n = words.length;
  return (
    <Tag
      ref={ref as never}
      className={cn('fx-scroll-words', className)}
      style={{ '--fx-p': 0 } as CSSProperties}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, i) => {
          // k goes from 0 to 1 as the reading point passes this word (4 words of soft edge).
          const k = `clamp(0, calc(var(--fx-p) * ${n + 4} - ${i}), 1)`;
          return (
            <span key={`${word}-${i}`}>
              <span
                className="inline-block transition-[color,opacity,filter] duration-150"
                style={{
                  opacity: `calc(0.22 + 0.78 * ${k})`,
                  color: `color-mix(in srgb, var(--color-text) calc(${k} * 100%), var(--color-text-muted))`,
                  filter: blur ? `blur(calc((1 - ${k}) * 2.5px))` : undefined,
                }}
              >
                {word}
              </span>
              {i < n - 1 ? ' ' : null}
            </span>
          );
        })}
      </span>
    </Tag>
  );
}

export default ScrollWords;
