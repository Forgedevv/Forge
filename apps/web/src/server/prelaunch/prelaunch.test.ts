// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handlePreview,
  isPreviewCookie,
  isPreviewKey,
  prelaunchActive,
  prelaunchMode,
  previewKey,
  previewToken,
} from '.';

const KEY = 'k'.repeat(16) + '0123456789abcdef0123';
const ON = { FORGE_PRELAUNCH: 'on', FORGE_PRELAUNCH_PREVIEW_KEY: KEY };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('prelaunchMode', () => {
  it('is off unless asked, and treats any unknown value as on', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(prelaunchMode({})).toBe('off');
    expect(prelaunchMode({ FORGE_PRELAUNCH: ' OFF ' })).toBe('off');
    expect(prelaunchMode({ FORGE_PRELAUNCH: 'On' })).toBe('on');
    expect(prelaunchMode({ FORGE_PRELAUNCH: 'yes' })).toBe('on');
  });
});

describe('preview key and cookie', () => {
  it('ignores a key shorter than 32 characters', () => {
    expect(previewKey({ FORGE_PRELAUNCH_PREVIEW_KEY: 'short' })).toBeNull();
    expect(previewKey({ FORGE_PRELAUNCH_PREVIEW_KEY: ` ${KEY} ` })).toBe(KEY);
  });

  it('accepts the exact key only', () => {
    expect(isPreviewKey(KEY, ON)).toBe(true);
    expect(isPreviewKey(`${KEY}x`, ON)).toBe(false);
    expect(isPreviewKey('', ON)).toBe(false);
    expect(isPreviewKey(KEY, { FORGE_PRELAUNCH: 'on' })).toBe(false);
  });

  it('stores a token derived from the key, never the key', () => {
    const token = previewToken(KEY);
    expect(token).not.toContain(KEY);
    expect(isPreviewCookie(token, ON)).toBe(true);
    expect(isPreviewCookie(KEY, ON)).toBe(false);
    expect(isPreviewCookie(previewToken(`${KEY}x`), ON)).toBe(false);
    expect(isPreviewCookie(undefined, ON)).toBe(false);
  });

  it('shows "Coming soon" while on, except with a valid preview cookie', () => {
    expect(prelaunchActive(null, {})).toBe(false);
    expect(prelaunchActive(null, ON)).toBe(true);
    expect(prelaunchActive('forged', ON)).toBe(true);
    expect(prelaunchActive(previewToken(KEY), ON)).toBe(false);
    // Without a configured key no cookie opens the site.
    expect(prelaunchActive(previewToken(KEY), { FORGE_PRELAUNCH: 'on' })).toBe(true);
  });
});

describe('GET /api/preview', () => {
  const get = (query: string, env: Record<string, string> = ON) =>
    handlePreview(new Request(`https://app.forgelaunch.dev/api/preview${query}`), env);

  it('does not exist without a configured key', () => {
    expect(get(`?key=${KEY}`, { FORGE_PRELAUNCH: 'on' }).status).toBe(404);
  });

  it('sets the preview cookie for the right key and goes home', () => {
    const response = get(`?key=${KEY}`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`__Host-forge_preview=${previewToken(KEY)}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain(KEY);
  });

  it('goes home without a cookie for a wrong or missing key', () => {
    for (const query of ['', '?key=', `?key=${KEY}x`]) {
      const response = get(query);
      expect(response.status).toBe(303);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('clears the cookie on ?off', () => {
    const cookie = get('?off').headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-forge_preview=;');
    expect(cookie).toContain('Max-Age=0');
  });
});
