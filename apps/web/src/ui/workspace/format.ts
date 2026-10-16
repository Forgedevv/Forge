import type { WebClient } from '@forge/shared';

// Display-only conversion. Amounts, prices, and fee totals come from the client.
export const formatSol: WebClient['formatSol'] = (lamports, opts = {}) => {
  const digits = Math.max(0, Math.min(9, opts.maxFractionDigits ?? 4));
  const unit = opts.withUnit === false ? '' : ' SOL';
  if (!/^\d+$/.test(lamports)) return `—${unit}`;
  const scale = 10n ** BigInt(9 - digits);
  const rounded = (BigInt(lamports) + scale / 2n) / scale;
  const raw = rounded.toString().padStart(digits + 1, '0');
  const whole = digits ? raw.slice(0, -digits) : raw;
  const fraction = digits
    ? raw.slice(-digits).replace(/0+$/, '').padEnd(Math.min(2, digits), '0')
    : '';
  if (BigInt(lamports) > 0n && rounded === 0n)
    return `<${(1 / 10 ** digits).toFixed(digits)}${unit}`;
  return `${whole}${fraction ? `.${fraction}` : ''}${unit}`;
};

/** Decimals of $FORGE, like every FORGE coin (FORGE_TOKEN_SETTINGS.tokenBaseDecimal, @forge/core). */
export const FORGE_TOKEN_DECIMALS = 6;

/**
 * Raw token units (a decimal string, as the API sends them) in whole tokens, for display only:
 * integer math on the digits, never a float. Exact: every significant fraction digit is kept,
 * trailing zeros are dropped and thousands are grouped (`1234500000` with 6 decimals is
 * `1,234.5`). Anything but digits shows a dash.
 */
export function formatTokenAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return '—';
  }
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction =
    decimals === 0 ? '' : (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export const formatUsd: WebClient['formatUsd'] = (value) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
export const shortAddress: WebClient['shortAddress'] = (value) =>
  value.length <= 14 ? value : `${value.slice(0, 5)}…${value.slice(-4)}`;
export const explorerTxUrl: WebClient['explorerTxUrl'] = (signature) =>
  `/dev/states?receipt=${encodeURIComponent(signature)}`;
