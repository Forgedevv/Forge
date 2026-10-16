import { describe, expect, it } from 'vitest';

import { scanComponent } from './test-helpers.js';

/**
 * Regression (devnet run): the brief gives the coin image URL (hosted on the R2 public host) and
 * the builder brief lets the agent show it in an `<img>`. Read through `content`, the `src` is a
 * dynamic URL and the scan blocks it, so every attempt failed. The brief now asks for the URL as a
 * literal in `src`; these tests pin both sides of that rule.
 */
const OPTIONS = { rpcRelayHost: 'app.forge.example', r2PublicHost: 'media.forge.example' };
const URL = 'https://media.forge.example/coin-images/abc.png';
const PATH = 'src/components/home/LaunchpadCoin.tsx';

describe('brief image URLs in <img>', () => {
  it('allows the exact URL typed in src, or held in a const of the same file', () => {
    expect(
      scanComponent(
        `export function C() { return <img src="${URL}" width={64} height={64} alt="" />; }`,
        OPTIONS,
        PATH,
      ),
    ).toEqual([]);
    expect(
      scanComponent(
        `const IMAGE = '${URL}';\nexport function C() { return <img src={IMAGE} width={64} height={64} alt="" />; }`,
        OPTIONS,
        PATH,
      ),
    ).toEqual([]);
  });

  it('still blocks a src read from content (a dynamic URL)', () => {
    expect(
      scanComponent(
        `import { content } from '@/content';\nexport function C() { const copy = content.launchpadCoin; return <img src={copy.imageUrl} width={64} height={64} alt="" />; }`,
        OPTIONS,
        PATH,
      ),
    ).toContain('embed-external');
  });
});
