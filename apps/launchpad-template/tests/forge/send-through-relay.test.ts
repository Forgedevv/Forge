import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('no server-side send route', () => {
  it('the /api/send-transaction route is gone', () => {
    expect(existsSync(join(root, 'src/pages/api/send-transaction.ts'))).toBe(false);
  });

  it('nothing in the site calls it', () => {
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('send-transaction');
    }
  });
});

describe('no generic sign-and-send helper', () => {
  it('src/forge/useSendTransaction.ts is gone and nothing refers to it', () => {
    expect(existsSync(join(root, 'src/forge/useSendTransaction.ts'))).toBe(false);
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('useSendTransaction');
    }
  });
});
