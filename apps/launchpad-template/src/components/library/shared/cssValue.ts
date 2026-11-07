/**
 * Guards for string props written into CSS. On the server, React only escapes style values for
 * HTML, so a value such as `1px;background-image:url(...)` would become a real declaration.
 */

/** A CSS length or length expression (`34rem`, `min(80vmin, 34rem)`, `calc(100% - 2rem)`). */
export function cssLength(value: string | undefined, fallback: string): string {
  return value !== undefined && /^[\w\s().,%+*/-]{1,80}$/.test(value) ? value : fallback;
}

/** A font-family list (`'Syne Variable', system-ui, sans-serif`, `var(--font-heading)`). */
export function cssFontFamily(value: string | undefined): string | undefined {
  return value !== undefined && /^[\w\s,'"().-]{1,160}$/.test(value) && !/url\s*\(/i.test(value)
    ? value
    : undefined;
}
