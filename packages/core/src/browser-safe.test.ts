import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Client sites bundle @forge/core for the browser (Next.js): a Node built-in imported by any
// module of the package fails their build ("node:crypto ... UnhandledSchemeError").
const SRC = join(__dirname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('browser-safe package sources', () => {
  it('import no Node built-in module', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /from\s+['"](node:[a-z_/]+|crypto|fs|path|os|child_process)['"]|require\(\s*['"](node:|crypto['"])/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
