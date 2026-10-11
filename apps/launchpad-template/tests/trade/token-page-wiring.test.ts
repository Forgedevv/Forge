import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('coin page wiring', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../../src/pages/token/[tokenId].tsx', import.meta.url)),
    'utf8',
  );

  it('renders the FORGE trade panel (fee before graduation), not the bare Jupiter plugin', () => {
    expect(page).toMatch(/import\('@\/forge\/CoinTradePanel'\)/);
    expect(page).toMatch(/<CoinTradePanel\s+mint=\{tokenId\}/);
    expect(page).not.toMatch(/JupiterTrade/);
  });
});
