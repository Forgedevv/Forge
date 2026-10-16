// @vitest-environment node
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';
import { buildCspDirectives, HSTS_VALUE, originOf, securityHeaders } from './security-headers';

const ENV = {
  NEXT_PUBLIC_APP_URL: 'https://forge.example/app',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co/',
  R2_PUBLIC_URL: 'https://pub-123.r2.dev/launchpads',
  CLIENTS_DOMAIN: 'Forge-Sites.app',
};

function header(headers: { key: string; value: string }[], key: string): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}

describe('securityHeaders', () => {
  it('enforces no framing, no sniffing, a strict referrer and a minimal permissions policy', () => {
    const headers = securityHeaders(false, ENV);
    expect(header(headers, 'Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(header(headers, 'X-Frame-Options')).toBe('DENY');
    expect(header(headers, 'X-Content-Type-Options')).toBe('nosniff');
    expect(header(headers, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header(headers, 'Permissions-Policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
  });

  it('sends Strict-Transport-Security on https deployments only', () => {
    expect(header(securityHeaders(false, ENV), 'Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(HSTS_VALUE).toBe('max-age=31536000; includeSubDomains');
    // Never in development, for a plain-http app URL (a local production build) or without one.
    expect(header(securityHeaders(true, ENV), 'Strict-Transport-Security')).toBeUndefined();
    for (const url of ['http://localhost:3000', 'http://forge.example', 'not a url', '']) {
      expect(
        header(
          securityHeaders(false, { ...ENV, NEXT_PUBLIC_APP_URL: url }),
          'Strict-Transport-Security',
        ),
        url,
      ).toBeUndefined();
    }
    expect(header(securityHeaders(false, {}), 'Strict-Transport-Security')).toBeUndefined();
  });

  it('reports (without enforcing) the source allowlist of the app', () => {
    const csp = header(securityHeaders(false, ENV), 'Content-Security-Policy-Report-Only')!;
    const directives = Object.fromEntries(
      csp.split('; ').map((d) => {
        const [name, ...sources] = d.split(' ');
        return [name, sources];
      }),
    );
    expect(directives['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives['connect-src']).toEqual([
      "'self'",
      'https://forge.example',
      'https://abcd.supabase.co',
      'wss://abcd.supabase.co',
    ]);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https://pub-123.r2.dev']);
    expect(directives['frame-src']).toEqual([
      "'self'",
      'https://*.vercel.app',
      'https://*.forge-sites.app',
    ]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
  });

  it('allows eval and local dev servers only in development', () => {
    const dev = buildCspDirectives(true, {});
    expect(dev['script-src']).toContain("'unsafe-eval'");
    expect(dev['connect-src']).toContain('ws://localhost:*');
    const prod = buildCspDirectives(false, {});
    expect(prod['script-src']).not.toContain("'unsafe-eval'");
    expect(prod['connect-src']).toEqual(["'self'"]);
  });

  it('never widens the policy with a malformed or plain-http value', () => {
    expect(originOf('http://abcd.supabase.co')).toBeNull();
    expect(originOf('http://localhost:54321', true)).toBe('http://localhost:54321');
    expect(originOf('http://localhost:54321', false)).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf('  ')).toBeNull();
    const directives = buildCspDirectives(false, {
      NEXT_PUBLIC_SUPABASE_URL: 'javascript:alert(1)',
      SUPABASE_URL: 'https://fallback.supabase.co',
      R2_PUBLIC_URL: 'ftp://files.example',
      CLIENTS_DOMAIN: "evil.app 'unsafe-eval'",
    });
    expect(directives['connect-src']).toEqual([
      "'self'",
      'https://fallback.supabase.co',
      'wss://fallback.supabase.co',
    ]);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(directives['frame-src']).toEqual(["'self'", 'https://*.vercel.app']);
  });
});

describe('next.config', () => {
  it('applies the security headers to every route', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*');
    const keys = rules[0]!.headers.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'Content-Security-Policy',
        'Content-Security-Policy-Report-Only',
        'X-Frame-Options',
        'X-Content-Type-Options',
        'Referrer-Policy',
        'Permissions-Policy',
      ]),
    );
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
