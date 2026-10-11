import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Client projects receive no secret (the builder only injects public values). Nothing in the site
 * may read an RPC provider URL, storage write keys or a Jupiter API key at runtime.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const FORBIDDEN = [
  'RPC_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'JUPITER_API_KEY',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

const files = [...sourceFiles(join(root, 'src')), join(root, 'next.config.ts')];

describe('no runtime secrets in the client site', () => {
  for (const name of FORBIDDEN) {
    it(`never reads ${name}`, () => {
      const pattern = new RegExp(`(?<![A-Z_])${name}(?![A-Z_])`);
      const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
      expect(offenders.map((file) => relative(root, file))).toEqual([]);
    });
  }

  it('does not import a storage SDK', () => {
    const offenders = files.filter((file) => /@aws-sdk\//.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });

  it('documents only public variables in .env.example', () => {
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    const names = example
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => line.split('=')[0]);
    for (const name of FORBIDDEN) expect(names).not.toContain(name);
    expect(names).toEqual(
      expect.arrayContaining([
        'SOLANA_CLUSTER',
        'NEXT_PUBLIC_SOLANA_CLUSTER',
        'NEXT_PUBLIC_FORGE_RPC_RELAY_URL',
        'NEXT_PUBLIC_FORGE_API_URL',
        'NEXT_PUBLIC_POOL_CONFIG_KEY',
        'R2_PUBLIC_URL',
        'NEXT_PUBLIC_R2_PUBLIC_URL',
        'NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT',
        'NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET',
        'NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT',
      ]),
    );
  });
});
