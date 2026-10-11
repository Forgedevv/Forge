import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('no raw relay URL in the browser components', () => {
  const src = fileURLToPath(new URL('../../src', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it('config exports only the normalised endpoint', async () => {
    const config = await import('@/forge/config');
    expect('rpcRelayUrl' in config).toBe(false);
    for (const file of files(src)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\brpcRelayUrl\b/);
    }
  });
});
