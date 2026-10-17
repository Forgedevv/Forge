import type { PrepareStep } from '../flow';
import { CREATE_COIN_TEXT } from '../copy';

const TEXT = CREATE_COIN_TEXT.steps;

type StepId = PrepareStep | 'review';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'sign', label: TEXT.sign },
  { id: 'upload', label: TEXT.upload },
  { id: 'check', label: TEXT.check },
  { id: 'review', label: TEXT.review },
];

/** Small spinner drawn with borders (theme colours, still under reduced motion). */
export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none ${className}`}
    />
  );
}

/**
 * LOCKED ZONE. Progress of the preparation: sign a free message, upload the image, check the
 * transaction, then the review. The first step says plainly that the signature is free.
 */
export function PrepareSteps({ current }: { current: PrepareStep }) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <div role="status" aria-live="polite" data-forge="create-coin-steps">
      <p className="sr-only">{TEXT.label}</p>
      <ol className="grid gap-2 sm:grid-cols-4 sm:gap-3">
        {STEPS.map((step, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'pending';
          return (
            <li
              key={step.id}
              aria-current={state === 'current' ? 'step' : undefined}
              data-state={state}
              className="flex items-center gap-2 text-sm sm:flex-col sm:items-start sm:gap-1.5"
            >
              <span
                aria-hidden="true"
                className={[
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold',
                  state === 'done' ? 'border-primary bg-primary text-primary-950' : '',
                  state === 'current' ? 'border-primary text-primary' : '',
                  state === 'pending' ? 'border-neutral-750 text-neutral-500' : '',
                ].join(' ')}
              >
                {state === 'done' ? (
                  <span className="iconify ph--check-bold h-3.5 w-3.5" />
                ) : state === 'current' ? (
                  <Spinner className="h-3 w-3" />
                ) : (
                  i + 1
                )}
              </span>
              <span className={state === 'pending' ? 'text-neutral-500' : 'text-foreground'}>
                {step.label}
                <span className="sr-only">
                  {' '}
                  (
                  {state === 'done' ? TEXT.done : state === 'current' ? TEXT.current : TEXT.pending}
                  )
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {current === 'sign' && (
        <p className="mt-3 text-xs leading-relaxed text-neutral-400">{TEXT.signNote}</p>
      )}
    </div>
  );
}
