import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOutDir, checkPort, REPO_ROOT, ToolError } from './layout.js';
import { parseCli } from './options.js';
import { specFromBrief } from './prepare.js';
import { toolCreated } from './scan.js';

describe('site test tool', () => {
  it('refuses an output folder inside the repository', () => {
    expect(() => checkOutDir(path.join(REPO_ROOT, 'tmp-site'))).toThrow(ToolError);
    expect(() => checkOutDir(REPO_ROOT)).toThrow(ToolError);
    expect(() => checkOutDir(path.dirname(REPO_ROOT))).toThrow(/must not contain/);
    const outside = path.join(path.dirname(REPO_ROOT), 'w6d-sitetest-out', 'neko');
    expect(checkOutDir(outside)).toBe(outside);
  });

  it('never uses the reserved ports', () => {
    for (const port of [3001, 3002, 8899, 80, 70_000]) expect(() => checkPort(port, 'p')).toThrow();
    expect(checkPort(3100, 'p')).toBe(3100);
    expect(() => parseCli(['serve', '--out', '/x', '--port', '3002'])).toThrow(/reserved/);
    expect(() =>
      parseCli(['serve', '--out', '/x', '--port', '3200', '--rpc-port', '3200']),
    ).toThrow();
  });

  it('parses commands and the production defaults', () => {
    const o = parseCli(['all', '--out', '/tmp/x', '--brief', 'b.json']);
    expect(o).toMatchObject({ command: 'all', sitePort: 3100, rpcPort: 3101 });
    expect(o.agent).toMatchObject({ bin: 'claude', model: 'claude-sonnet-5-5', maxTurns: 80 });
    expect(parseCli(['agent', '--out', '/tmp/x', '--model', 'other-model']).agent.model).toBe(
      'other-model',
    );
    expect(() => parseCli(['prepare', '--out', '/tmp/x'])).toThrow(/--brief/);
    expect(() => parseCli(['nope', '--out', '/tmp/x'])).toThrow(/usage/);
    expect(() => parseCli(['scan', '--out', '/tmp/x', '--eval', '1'])).toThrow(/unknown option/);
  });

  it('fills a partial brief with valid dummies', () => {
    const spec = specFromBrief({
      name: 'Neko Pad',
      slug: 'neko-pad',
      theme: { primaryColor: '#FF2D95', darkMode: true, designNotes: 'Cats.' },
      launchpadCoin: { name: 'Neko', symbol: 'NEKO' },
    });
    expect(spec).toMatchObject({ name: 'Neko Pad', slug: 'neko-pad', quote: 'SOL', version: 1 });
    expect(spec.theme.primaryColor).toBe('#FF2D95');
    expect(spec.launchpadCoin.symbol).toBe('NEKO');
    expect(spec.ownerWallet).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(specFromBrief({ name: 'Neko Pad', slug: 'neko-pad' }).ownerWallet).not.toBe(
      spec.ownerWallet,
    );
    expect(() => specFromBrief({ name: 'X', slug: 'Bad Slug' })).toThrow(/slug|name/);
  });

  it('skips only what the tool created', () => {
    const base = { version: 1 as const, captures: [] };
    expect([
      ...toolCreated({ ...base, linkedNodeModules: false, envLocal: false, nextDev: false }),
    ]).toEqual([]);
    expect(
      [...toolCreated({ ...base, linkedNodeModules: true, envLocal: true, nextDev: true })].sort(),
    ).toEqual(['.env.local', '.next', 'node_modules', 'tsconfig.tsbuildinfo']);
  });
});
