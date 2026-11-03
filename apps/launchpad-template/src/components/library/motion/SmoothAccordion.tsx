import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CSS_EASE_OUT, useCalm } from './internal';

export interface SmoothAccordionItem {
  question: string;
  answer: ReactNode;
}

export interface SmoothAccordionProps {
  items: readonly SmoothAccordionItem[];
  /** Let several answers stay open at once. Default false (opening one closes the other). */
  multiple?: boolean;
  /** Indexes open at first. */
  defaultOpen?: readonly number[];
  className?: string;
}

/**
 * Questions that open with a smooth, natural height animation: the answer unfolds and fades in,
 * the plus turns into a cross and the open row gets a soft brand tint. The FAQ of a launchpad
 * ("What does it cost to launch?", "When does my coin graduate?"). Real buttons with
 * `aria-expanded`; arrow keys move between questions; opens instantly for reduced motion.
 */
export function SmoothAccordion({
  items,
  multiple = false,
  defaultOpen = [],
  className,
}: SmoothAccordionProps) {
  const calm = useCalm();
  const base = useId();
  const [open, setOpen] = useState<number[]>(() => [...defaultOpen]);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const toggle = (i: number) =>
    setOpen((current) =>
      current.includes(i) ? current.filter((n) => n !== i) : multiple ? [...current, i] : [i],
    );
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const last = items.length - 1;
    const target =
      e.key === 'ArrowDown'
        ? (i + 1) % items.length
        : e.key === 'ArrowUp'
          ? (i - 1 + items.length) % items.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (target === null) return;
    e.preventDefault();
    buttons.current[target]?.focus();
  };
  const duration = calm ? '0s' : '0.5s';

  return (
    <div className={cn('fx-accordion flex flex-col gap-2', className)}>
      {items.map((item, i) => {
        const isOpen = open.includes(i);
        const headId = `${base}-q${i}`;
        const panelId = `${base}-a${i}`;
        return (
          <div
            key={`${item.question}-${i}`}
            className="border border-[var(--color-border)] transition-colors duration-300"
            style={{
              borderRadius: 'var(--radius-card)',
              background: isOpen
                ? 'color-mix(in srgb, var(--color-primary) 7%, var(--color-surface-raised))'
                : 'var(--color-surface-raised)',
            }}
          >
            <h3 className="m-0 text-base">
              <button
                ref={(el) => {
                  buttons.current[i] = el;
                }}
                id={headId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left font-medium text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                style={{ borderRadius: 'var(--radius-card)' }}
              >
                <span>{item.question}</span>
                <span
                  aria-hidden="true"
                  className="relative grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--color-border)]"
                  style={{
                    transform: isOpen ? 'rotate(135deg)' : 'none',
                    transition: `transform ${duration} ${CSS_EASE_OUT}`,
                    color: isOpen ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  }}
                >
                  <span className="absolute h-[1.5px] w-2.5 rounded bg-current" />
                  <span className="absolute h-2.5 w-[1.5px] rounded bg-current" />
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={headId}
              className="grid"
              style={{
                gridTemplateRows: isOpen ? '1fr' : '0fr',
                // Hidden once closed, so a closed answer is skipped by Tab and screen readers.
                visibility: isOpen ? 'visible' : 'hidden',
                transition: `grid-template-rows ${duration} ${CSS_EASE_OUT}, visibility 0s linear ${isOpen ? '0s' : duration}`,
              }}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className="px-5 pb-5 text-sm leading-relaxed text-[var(--color-text-muted)]"
                  style={{
                    opacity: isOpen ? 1 : 0,
                    transform: isOpen ? 'none' : 'translateY(-6px)',
                    transition: `opacity ${duration} ${CSS_EASE_OUT}, transform ${duration} ${CSS_EASE_OUT}`,
                  }}
                >
                  {item.answer}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SmoothAccordion;
