// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/forge/TradePanel', () => ({
  TradePanel: (p: Record<string, unknown>) => (
    <div
      data-testid="trade-panel"
      data-mint={String(p.mint)}
      data-props={Object.keys(p).sort().join(',')}
      data-symbol={String(p.symbol ?? '')}
      data-decimals={p.displayDecimals === undefined ? 'default' : String(p.displayDecimals)}
    />
  ),
}));

import { CoinTradePanel, saneDecimals } from '../../src/forge/CoinTradePanel';

afterEach(() => {
  cleanup();
});

describe('CoinTradePanel', () => {
  it('renders the FORGE TradePanel for the mint, with no pool: the panel derives it', () => {
    render(<CoinTradePanel mint="MINT" symbol="MOON" displayDecimals={6} />);
    const panel = screen.getByTestId('trade-panel');
    expect(panel.dataset.mint).toBe('MINT');
    expect(panel.dataset.props).not.toContain('pool');
    expect(panel.dataset.symbol).toBe('MOON');
    expect(panel.dataset.decimals).toBe('6');
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
