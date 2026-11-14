import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Pre-launch mode, read from the environment on every request:
 *
 *   FORGE_PRELAUNCH              `on` | `off` (default `off`). While on, the site shows "Coming soon"
 *                                wherever a visitor would connect a wallet or start a launchpad.
 *   FORGE_PRELAUNCH_PREVIEW_KEY  optional, at least 32 characters. Opening /api/preview?key=<key>
 *                                once sets a cookie that shows the full site to the team.
 *
 * This is an interface gate only: the API stays protected by the private beta allowlist
 * (src/server/beta), which refuses every wallet that is not invited, preview cookie or not.
 * An unknown FORGE_PRELAUNCH value counts as `on`, so a typo never opens the site.
 */

/** Reads FORGE_PRELAUNCH and FORGE_PRELAUNCH_PREVIEW_KEY. */
export type PrelaunchEnv = Readonly<Record<string, string | undefined>>;

export const PREVIEW_COOKIE = 'forge_preview';
export const MIN_PREVIEW_KEY_LENGTH = 32;
/** The preview cookie lasts 30 days. */
export const PREVIEW_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

let warned: string | null = null;

export function prelaunchMode(env: PrelaunchEnv = process.env): 'on' | 'off' {
  const raw = (env.FORGE_PRELAUNCH ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw !== 'on' && warned !== raw) {
    warned = raw;
    console.error('[prelaunch] FORGE_PRELAUNCH must be "on" or "off": treated as "on"');
  }
  return 'on';
}

/** The configured preview key, or null when absent or too short to be safe. */
export function previewKey(env: PrelaunchEnv = process.env): string | null {
  const key = (env.FORGE_PRELAUNCH_PREVIEW_KEY ?? '').trim();
  return key.length >= MIN_PREVIEW_KEY_LENGTH ? key : null;
}

/** Cookie value proving the key was given once (the key itself never reaches the browser). */
export function previewToken(key: string): string {
  return createHmac('sha256', key).update('forge-preview-v1').digest('base64url');
}

function sameDigest(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** Whether `candidate` is the configured preview key (constant time). */
export function isPreviewKey(candidate: string, env: PrelaunchEnv = process.env): boolean {
  const key = previewKey(env);
  return key !== null && candidate !== '' && sameDigest(candidate, key);
}

/** Whether a preview cookie value is valid for the configured key. */
export function isPreviewCookie(
  value: string | null | undefined,
  env: PrelaunchEnv = process.env,
): boolean {
  const key = previewKey(env);
  return (
    key !== null &&
    typeof value === 'string' &&
    value !== '' &&
    sameDigest(value, previewToken(key))
  );
}

/** Whether this visitor sees "Coming soon": mode on and no valid preview cookie. */
export function prelaunchActive(
  cookie: string | null | undefined,
  env: PrelaunchEnv = process.env,
): boolean {
  return prelaunchMode(env) === 'on' && !isPreviewCookie(cookie, env);
}
