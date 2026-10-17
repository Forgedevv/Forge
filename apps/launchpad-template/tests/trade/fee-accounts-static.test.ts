import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const src = join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(src);
const readers = (pattern: RegExp) =>
  files
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file).replace(/\\/g, '/'))
    .sort();

describe('FORGE fee accounts of the site', () => {
  it('are read from the environment in the swap adapter only (and the creation fee module)', () => {
    expect(readers(/NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET/)).toEqual([
      'src/forge/create/platform-fee.ts',
      'src/forge/trade/core-adapter.ts',
    ]);
    expect(readers(/NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT/)).toEqual([
      'src/forge/trade/core-adapter.ts',
    ]);
    expect(readers(/NEXT_PUBLIC_FORGE_REVENUE_WALLET/)).toEqual([
      'src/forge/trade/core-adapter.ts',
    ]);
    expect(readers(/NEXT_PUBLIC_FORGE_MULTISIG_VAULT/)).toEqual([]);
  });

  it('cannot be overridden: no env option on the swap core, setSwapCore gated to tests', () => {
    const adapter = readFileSync(join(src, 'forge/trade/core-adapter.ts'), 'utf8');
    expect(adapter).toMatch(/export function createCoreSwapCore\(\): SwapCore/);
    expect(adapter).not.toMatch(/options\.env/);
    expect(adapter).toMatch(/process\.env\.NODE_ENV === 'test'/);
  });

  it('no public trade component takes a pool address', () => {
    for (const file of [
      'forge/TradePanel.tsx',
      'forge/BuyButton.tsx',
      'forge/CoinTradePanel.tsx',
    ]) {
      expect(readFileSync(join(src, file), 'utf8')).not.toMatch(/\bpool(\?)?: string/);
    }
    for (const file of ['forge/trade/TradeForm.tsx', 'forge/trade/useTradeExecution.ts']) {
      expect(readFileSync(join(src, file), 'utf8')).not.toMatch(/\bpool: (string|PublicKey)/);
    }
  });
});
