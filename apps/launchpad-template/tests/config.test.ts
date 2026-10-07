import { describe, expect, it } from 'vitest';
import { ForgeSiteConfig } from '@forge/shared';
import raw from '../forge.config.json';
import { buildCsp, securityHeaders } from '../src/forge/security-headers';
import { buildThemeCss } from '../src/theme';

describe('forge.config.json', () => {
  it('matches the shared schema', () => {
    expect(ForgeSiteConfig.safeParse(raw).success).toBe(true);
  });
});

describe('security headers', () => {
  it('forbids framing and objects, allows only listed origins', () => {
    const csp = buildCsp(false, {});
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain('https://plugin.jup.ag');
  });

  it('adds the R2 origin from the environment', () => {
    expect(buildCsp(false, { R2_PUBLIC_URL: 'https://pub-x.r2.dev/path' })).toContain(
      'https://pub-x.r2.dev',
    );
  });

  it('exposes the standard headers', () => {
    const keys = securityHeaders(false).map((h) => h.key);
    expect(keys).toContain('Content-Security-Policy');
    expect(keys).toContain('X-Content-Type-Options');
  });
});

describe('theme', () => {
  it('derives CSS variables from the colours', () => {
    const css = buildThemeCss({ primaryColor: '#7C3AED', accentColor: '#F59E0B' });
    expect(css).toContain('--color-primary: #7C3AED;');
    expect(css).toContain('--primary: 124 58 237;');
  });
});
