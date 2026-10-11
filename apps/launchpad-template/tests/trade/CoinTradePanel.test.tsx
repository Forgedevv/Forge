// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  onchain: { launchpadConfig: 'CONFIG' } as { launchpadConfig?: string } | undefined,
  pools: new Map<string, string>([['MINT|CONFIG', 'POOL']]),
}));

vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
}));

// PDA derivation is covered in node by pool-address.test.ts (jsdom breaks it).
vi.mock('../../src/forge/trade/pool-address', () => ({
  launchpadPoolForMint: (mint: string, config?: string) =>
    state.pools.get(`${mint}|${config ?? ''}`) ?? null,
}));

vi.mock('../../src/forge/TradePanel', () => ({
  TradePanel: (p: { mint: string; pool: string; symbol?: string; tokenDecimals?: number }) => (
    <div
      data-testid="trade-panel"
      data-mint={p.mint}
      data-pool={p.pool}
      data-symbol={p.symbol ?? ''}
      data-decimals={p.tokenDecimals === undefined ? 'default' : String(p.tokenDecimals)}
    />
  ),
}));

import { CoinTradePanel, saneDecimals } from '../../src/forge/CoinTradePanel';

afterEach(() => {
  cleanup();
  state.onchain = { launchpadConfig: 'CONFIG' };
});

describe('CoinTradePanel', () => {
  it('renders the FORGE TradePanel with the pool derived from the launchpad config', () => {
    render(<CoinTradePanel mint="MINT" symbol="MOON" tokenDecimals={6} />);
    const panel = screen.getByTestId('trade-panel');
    expect(panel.dataset.mint).toBe('MINT');
    expect(panel.dataset.pool).toBe('POOL');
    expect(panel.dataset.symbol).toBe('MOON');
    expect(panel.dataset.decimals).toBe('6');
  });

  it('passes no pool (panel fails closed) for a coin that is not on this launchpad', () => {
    render(<CoinTradePanel mint="OTHER" />);
    expect(screen.getByTestId('trade-panel').dataset.pool).toBe('');
  });

  it('passes no pool before the on-chain setup', () => {
    state.onchain = undefined;
    render(<CoinTradePanel mint="MINT" />);
    expect(screen.getByTestId('trade-panel').dataset.pool).toBe('');
  });

  it('ignores insane decimals from the data API', () => {
    expect(saneDecimals(9)).toBe(9);
    expect(saneDecimals(0)).toBe(0);
    expect(saneDecimals(10)).toBeUndefined();
    expect(saneDecimals(-1)).toBeUndefined();
    expect(saneDecimals(6.5)).toBeUndefined();
    expect(saneDecimals(undefined)).toBeUndefined();
  });
});
