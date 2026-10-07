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
export const formatUsd: WebClient['formatUsd'] = (value) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
export const shortAddress: WebClient['shortAddress'] = (value) =>
  value.length <= 14 ? value : `${value.slice(0, 5)}…${value.slice(-4)}`;
export const explorerTxUrl: WebClient['explorerTxUrl'] = (signature) =>
  `/dev/states?receipt=${encodeURIComponent(signature)}`;
