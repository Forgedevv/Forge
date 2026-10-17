// @vitest-environment jsdom
import '../helpers/dom-setup';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span data-testid="next-image">{alt}</span>,
}));

import { LAUNCHPAD_INFOS } from '@/components/LaunchpadIndicator/info';
import { TrenchesTokenIcon } from '@/forge/token-icon';
import { TrenchesPoolTokenIcon } from '@/forge/token-icon/TokenIcon';

const asset = {
  id: 'mint',
  name: 'Moon Nap',
  symbol: 'NAP',
  icon: 'https://storage.example/coin-images/nap.png',
  launchpad: 'met-dbc',
};

describe('token icons', () => {
  it('draw no launchpad chip on a coin icon', () => {
    render(<TrenchesTokenIcon token={asset as never} launchpadClassName="x" />);
    expect(screen.getByRole('img', { name: 'NAP' })).toBeTruthy();
    expect(screen.queryByLabelText('Meteora DBC')).toBeNull();
    // The compatibility prop never reaches the DOM.
    expect(document.querySelector('[launchpadclassname]')).toBeNull();
  });

  it('draw no launchpad chip on a pool icon', () => {
    const pool = { bondingCurve: 40, createdAt: '2026-10-17T00:00:00Z', baseAsset: asset };
    render(<TrenchesPoolTokenIcon pool={pool as never} />);
    expect(screen.queryByLabelText('Meteora DBC')).toBeNull();
  });

  it('bundle no other launchpad brand', () => {
    expect(LAUNCHPAD_INFOS.map((l) => l.launchpad)).toEqual(['met-dbc']);
    // jsdom tests have no file `import.meta.url`: paths are relative to the template root.
    const source = readFileSync(
      join(process.cwd(), 'src/components/LaunchpadIndicator/info.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/pump|believe|boop|virtuals|raydium|letsbonk/i);
    const icons = readdirSync(join(process.cwd(), 'src/icons'));
    expect(icons.filter((f) => /pumpfun|believe|boop|virtuals/i.test(f))).toEqual([]);
  });
});
