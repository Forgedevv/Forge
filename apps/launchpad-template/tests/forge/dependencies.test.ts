import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };

describe('template dependencies', () => {
  it('takes the money logic from @forge/core', () => {
    expect(pkg.dependencies['@forge/core']).toBe('workspace:*');
  });

  it('holds no storage SDK (uploads go through the FORGE upload endpoint)', () => {
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith('@aws-sdk/'))).toEqual(
      [],
    );
  });
});
