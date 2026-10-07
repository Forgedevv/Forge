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
