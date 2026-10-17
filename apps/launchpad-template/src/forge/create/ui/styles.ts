/**
 * LOCKED ZONE. Class names of the coin creation flow. Only theme tokens: the Tailwind colour
 * scales backed by the theme's CSS variables (`primary`, `neutral`, `rose`, `background`...) and
 * the radius variables of `src/theme/theme.css` (`--radius` for controls, `--radius-card` for
 * framed blocks), so every launchpad brand (colours, corners, light or dark) restyles the flow.
 * A site can also target the `data-forge="create-coin-*"` attributes from its own CSS.
 */

export const ui = {
  /** One block of the form; blocks are separated by a rule, never framed (no card in a card). */
  section: 'min-w-0 border-t border-neutral-850 pt-6 first:border-t-0 first:pt-0',
  sectionTitle: 'mb-4 text-lg font-semibold text-foreground md:text-xl',
  label: 'mb-1.5 block text-sm font-medium text-neutral-200',
  hint: 'mt-1.5 text-xs leading-relaxed text-neutral-500',
  fieldError: 'mt-1.5 text-xs font-medium text-rose',
  input:
    'block w-full min-w-0 rounded-[var(--radius)] border border-neutral-750 bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-neutral-500 transition-colors focus:border-primary/70 focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-rose/70',
  primaryButton:
    'inline-flex min-h-[2.75rem] items-center justify-center gap-2 rounded-[var(--radius)] bg-primary px-5 py-2.5 text-sm font-semibold text-primary-950 transition-[background-color,transform,opacity] hover:bg-primary-300 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none',
  secondaryButton:
    'inline-flex min-h-[2.75rem] items-center justify-center gap-2 rounded-[var(--radius)] border border-neutral-750 bg-transparent px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/60 hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none',
  textButton:
    'inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-[var(--radius)] px-2 text-xs font-medium text-neutral-300 underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50',
  chip: 'inline-flex min-h-[2.25rem] items-center justify-center rounded-[var(--radius)] border border-neutral-750 px-3 text-xs font-medium text-neutral-300 transition-colors hover:border-primary/60 hover:text-foreground aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
  /** A framed block that stands on its own (the coin preview, the success summary). */
  frame: 'rounded-[var(--radius-card)] border border-neutral-850 bg-background',
  alert: 'rounded-[var(--radius)] border border-rose/40 bg-rose/10 px-4 py-3 text-sm text-rose',
  note: 'rounded-[var(--radius)] border border-neutral-850 bg-neutral-900/60 px-4 py-3 text-sm text-neutral-300',
  dl: 'space-y-2 text-sm',
  muted: 'text-neutral-400',
} as const;
