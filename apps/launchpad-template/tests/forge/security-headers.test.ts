import { describe, expect, it } from 'vitest';
import { buildCsp, buildCspDirectives, originOf, securityHeaders } from '@/forge/security-headers';

const env = {
  R2_PUBLIC_URL: 'https://pub-abc123.r2.dev/launchpad',
  NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://forge.example/api/rpc',
} as unknown as NodeJS.ProcessEnv;

function directive(csp: string, name: string): string[] {
  const found = csp.split('; ').find((d) => d.startsWith(`${name} `) || d === name);
  return found ? found.split(' ').slice(1) : [];
}

describe('production CSP', () => {
  const csp = buildCsp(false, env);

  it('has no unsafe-eval anywhere', () => {
    expect(csp).not.toContain('unsafe-eval');
  });

  it('forbids framing, plugins and foreign form targets', () => {
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'form-action')).toEqual(["'self'"]);
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
  });

  it('limits connect-src to self, the RPC relay and explicit Jupiter hosts', () => {
    const connect = directive(csp, 'connect-src');
    expect(connect).toContain("'self'");
    expect(connect).toContain('https://forge.example');
    expect(connect).toContain('https://datapi.jup.ag');
    expect(connect).toContain('wss://trench-stream.jup.ag');
    expect(connect.some((s) => s.includes('*'))).toBe(false);
    expect(connect.some((s) => s.includes('localhost'))).toBe(false);
    expect(connect).not.toContain('https:');
  });

  it('allows images only from self, data/blob, the image proxy, the storage domain and Jupiter', () => {
    const img = directive(csp, 'img-src');
    expect(img).toContain('https://pub-abc123.r2.dev');
    expect(img).toContain('https://wsrv.nl');
    expect(img.some((s) => s.includes('*'))).toBe(false);
    expect(img).not.toContain('https:');
  });

  it('keeps scripts to self and the Jupiter plugin hosts', () => {
    const script = directive(csp, 'script-src');
    expect(script).toContain('https://plugin.jup.ag');
    expect(script).not.toContain("'unsafe-eval'");
    expect(script.some((s) => s.includes('*'))).toBe(false);
  });

  it('lists exactly the Jupiter hosts the plugin and the site call', () => {
    expect(directive(csp, 'connect-src')).toEqual([
      "'self'",
      'https://forge.example',
      'https://datapi.jup.ag',
      'https://ultra-api.jup.ag',
      'https://worker.jup.ag',
      'wss://trench-stream.jup.ag',
    ]);
    // The plugin loads Inter from Google Fonts and the Jupiter logo from jup.ag.
    expect(directive(csp, 'style-src')).toContain('https://fonts.googleapis.com');
    expect(directive(csp, 'font-src')).toContain('https://fonts.gstatic.com');
    expect(directive(csp, 'img-src')).toContain('https://jup.ag');
    // static.jup.ag serves the TradingView chart library (src/forge/chart).
    expect(directive(csp, 'script-src')).toContain('https://static.jup.ag');
  });

  it('drops the retired and unused Jupiter hosts and frames no origin', () => {
    const sources = csp.split('; ').flatMap((d) => d.split(' ').slice(1));
    for (const host of [
      'https://quote-api.jup.ag',
      'https://price.jup.ag',
      'https://tokens.jup.ag',
      'https://api.jup.ag',
      'https://lite-api.jup.ag',
      'https://img-cdn.jup.ag',
      'https://unified.jup.ag',
      'https://station.jup.ag',
    ]) {
      expect(sources, host).not.toContain(host);
    }
    // The Jupiter Plugin renders in the page: it needs no frame. Only the blob: frame the
    // TradingView chart library creates for its widget is allowed.
    expect(directive(csp, 'frame-src')).not.toContain('https://plugin.jup.ag');
    expect(directive(csp, 'frame-src')).toEqual(['blob:']);
  });

  it('is a single policy string with no empty directive', () => {
    for (const part of csp.split('; ')) expect(part.trim()).not.toBe('');
  });
});

describe('development CSP', () => {
  it('adds eval and localhost only in development', () => {
    const dev = buildCsp(true, env);
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toContain('ws://localhost:*');
    expect(buildCsp(false, env)).not.toContain('localhost');
  });
});

describe('configured origins', () => {
  it('ignores unset, malformed and non-https values', () => {
    expect(originOf(undefined)).toEqual([]);
    expect(originOf('')).toEqual([]);
    expect(originOf('not a url')).toEqual([]);
    expect(originOf('http://evil.example')).toEqual([]);
    expect(originOf('javascript:alert(1)')).toEqual([]);
    expect(originOf('https://ok.example/path?q=1')).toEqual(['https://ok.example']);
  });

  it('accepts http localhost only in development', () => {
    expect(originOf('http://localhost:3000/api/rpc', false)).toEqual([]);
    expect(originOf('http://localhost:3000/api/rpc', true)).toEqual(['http://localhost:3000']);
  });

  it('adds nothing for a missing relay or storage domain', () => {
    const bare = buildCspDirectives(false, {} as NodeJS.ProcessEnv);
    expect(bare['connect-src']).not.toContain('https://forge.example');
    expect(bare['img-src']).not.toContain('https://pub-abc123.r2.dev');
  });

  it('cannot be widened by an injected directive separator', () => {
    const hostile = {
      NEXT_PUBLIC_FORGE_RPC_RELAY_URL: "https://x.example; script-src 'unsafe-eval'",
    } as unknown as NodeJS.ProcessEnv;
    expect(buildCsp(false, hostile)).not.toContain('unsafe-eval');
  });
});

describe('securityHeaders', () => {
  it('exposes the standard headers', () => {
    const headers = Object.fromEntries(securityHeaders(false, env).map((h) => [h.key, h.value]));
    expect(headers['Content-Security-Policy']).toBe(buildCsp(false, env));
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
  });

  it('does not send HSTS in development', () => {
    const keys = securityHeaders(true, env).map((h) => h.key);
    expect(keys).not.toContain('Strict-Transport-Security');
  });
});
