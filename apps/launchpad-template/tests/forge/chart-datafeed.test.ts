import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getChart: vi.fn() }));
vi.mock('@/forge/data/client', () => ({ ApeClient: { getChart: h.getChart } }));

import { createDataFeed } from '../../src/forge/chart/datafeed';

const ref = <T>(current: T) => ({ current });

function feed() {
  return createDataFeed(
    ref({ id: 'mint', symbol: 'MOON' } as never),
    ref({}),
    ref(undefined),
    ref('price' as never),
    ref(undefined),
    ref(undefined),
    ref(false),
    ref(false),
    ref(false),
    ref({}),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  h.getChart.mockReset();
});

describe('chart datafeed', () => {
  it('reports an empty period as no data, without logging an error', async () => {
    h.getChart.mockResolvedValue({ candles: [] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onHistory = vi.fn();
    const onError = vi.fn();
    await feed().getBars(
      {} as never,
      '1' as never,
      { from: 0, to: 60, countBack: 10, firstDataRequest: true } as never,
      onHistory,
      onError,
    );
    expect(onHistory).toHaveBeenCalledWith([], { noData: true });
    expect(onError).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
