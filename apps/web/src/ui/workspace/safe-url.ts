/**
 * What to show for a site link: the hostname of the real URL (a relative development preview
 * path is shown as is). `null` when the URL is not safe to link to.
 */
export function siteHost(value: string | null | undefined): string | null {
  const url = safeUrl(value);
  if (!url) return null;
  if (url.startsWith('/')) return url;
  return new URL(url).hostname;
}

export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
