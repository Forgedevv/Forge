import type { SiteMode } from '@forge/shared';
import { currentMode, modeNotice } from './mode-guard';

/**
 * LOCKED ZONE. Banner explaining why actions are unavailable when the site is `sleeping` or
 * `disabled`. Renders nothing when live. Styled through the theme's CSS variables / utility classes.
 */
export function ModeBanner({
  mode = currentMode(),
  className,
}: {
  mode?: SiteMode;
  className?: string;
}) {
  const notice = modeNotice(mode);
  if (!notice) return null;
  return (
    <div
      role="status"
      data-forge-mode={mode}
      className={
        className ??
        'rounded-lg border border-neutral-750 bg-neutral-925 p-4 text-sm text-neutral-300'
      }
    >
      <p className="font-semibold text-foreground">{notice.title}</p>
      <p className="mt-1">{notice.body}</p>
    </div>
  );
}
