import { describe, expect, it } from 'vitest';
import { scanDiff } from '../scan/index.js';
import { scanInput } from './scan-input.js';
import { configScanBaseline } from './site-config.js';
import type { BaselineFile, TreeEntry } from './workdir.js';

const reference = JSON.stringify({
  version: 1,
  name: 'Example Pad',
  slug: 'example-pad',
  mode: 'live',
  theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
  content: { tagline: 'Sample', about: 'Sample' },
});
const next = (content: Record<string, string>) =>
  JSON.stringify({
    version: 1,
    name: 'MoonPad',
    slug: 'moonpad',
    mode: 'live',
    onchain: { cluster: 'devnet' },
    theme: { primaryColor: '#112233', accentColor: '#F59E0B', darkMode: true },
    content,
  });

describe('forge.config.json scan baseline', () => {
  it('keeps the locked fields of the new file and the theme/content of the reference', () => {
    const base = JSON.parse(configScanBaseline(reference, next({ tagline: 'x', about: 'y' }))!);
    expect(base).toMatchObject({
      name: 'MoonPad',
      slug: 'moonpad',
      onchain: { cluster: 'devnet' },
    });
    expect(base.theme.primaryColor).toBe('#7C3AED');
    expect(base.content.tagline).toBe('Sample');
  });

  it('falls back to the reference for a file that is not a JSON object', () => {
    expect(configScanBaseline(reference, '{ nope')).toBe(reference);
    expect(configScanBaseline(null, '[]')).toBeNull();
  });
});

describe('scan input', () => {
  const file = (s: string): BaselineFile => ({ content: Buffer.from(s), executable: false });
  const entry = (path: string, s: string): TreeEntry => ({
    path,
    mode: '100644',
    content: Buffer.from(s),
  });

  it('always includes forge.config.json, compared on theme/content only', () => {
    const cfg = next({ tagline: 'Launch', about: 'About' });
    const baseline = new Map([
      ['forge.config.json', file(cfg)],
      ['src/a.ts', file('export const a = 1;\n')],
    ]);
    const tree = [entry('forge.config.json', cfg), entry('src/a.ts', 'export const a = 1;\n')];
    const changes = scanInput({ baseline, tree, configReference: reference });
    expect(changes.map((c) => [c.path, c.status])).toEqual([['forge.config.json', 'modified']]);
    expect(scanDiff(changes)).toEqual({ ok: true });
  });

  it('lets the scan refuse unsafe content written from the spec', () => {
    const cfg = next({ tagline: '<script>alert(1)</script>', about: 'About' });
    const changes = scanInput({
      baseline: new Map([['forge.config.json', file(cfg)]]),
      tree: [entry('forge.config.json', cfg)],
      configReference: reference,
    });
    const result = scanDiff(changes);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.violations.map((v) => v.rule)).toContain(
      'forge-config-unsafe-value',
    );
  });

  it('keeps a deleted or replaced forge.config.json as is, for the scan to refuse', () => {
    const cfg = next({ tagline: 'a', about: 'b' });
    const deleted = scanInput({
      baseline: new Map([['forge.config.json', file(cfg)]]),
      tree: [],
      configReference: reference,
    });
    expect(deleted).toEqual([
      expect.objectContaining({ path: 'forge.config.json', status: 'deleted' }),
    ]);
    const link = scanInput({
      baseline: new Map([['forge.config.json', file(cfg)]]),
      tree: [{ path: 'forge.config.json', mode: '120000', content: Buffer.from('/etc/passwd') }],
      configReference: reference,
    });
    expect(scanDiff(link).ok).toBe(false);
  });
});
