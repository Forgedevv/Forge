/**
 * LOCKED ZONE. Visible texts of the chart (`ChartUnavailable`), in one place like the other
 * locked-zone copy (`create/copy.ts`, `trade/copy.ts`, `claims/copy.ts`). It imports nothing from
 * the free zones.
 */
export const CHART_UNAVAILABLE_COPY = {
  unavailable: {
    title: 'Chart temporarily unavailable',
    body: 'Price history could not be loaded. Prices and trading still work.',
    retry: 'Retry',
  },
  devnet: {
    title: 'No chart on devnet',
    body: 'Price history comes from Jupiter, which does not index devnet. Prices and trading still work.',
  },
} as const;
