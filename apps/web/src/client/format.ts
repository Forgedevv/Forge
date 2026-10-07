import type { FormatSolOptions, Lamports } from '@forge/shared';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_MAX_FRACTION_DIGITS = 4;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Formats lamports (decimal string) as SOL without any floating point math. */
export function formatSol(lamports: Lamports, opts: FormatSolOptions = {}): string {
  const unit = opts.withUnit ? ' SOL' : '';
  if (typeof lamports !== 'string' || !/^\d+$/.test(lamports)) return `-${unit}`;
  const maxDigits = Math.min(
    9,
    Math.max(0, Math.trunc(opts.maxFractionDigits ?? DEFAULT_MAX_FRACTION_DIGITS)),
  );
  const total = BigInt(lamports);
  const scale = 10n ** BigInt(9 - maxDigits);
  // round half up at the requested precision
  const rounded = ((total + scale / 2n) / scale) * scale;
  if (total > 0n && rounded === 0n) {
    const smallest = maxDigits === 0 ? '1' : `0.${'0'.repeat(maxDigits - 1)}1`;
    return `<${smallest}${unit}`;
  }
  const whole = rounded / LAMPORTS_PER_SOL;
  const fraction = (rounded % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, maxDigits);
  const trimmed = fraction.replace(/0+$/, '');
  const text = groupThousands(whole.toString()) + (trimmed ? `.${trimmed}` : '');
  return `${text}${unit}`;
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return usd.format(n);
}

export function shortAddress(a: string): string {
  if (a.length <= 10) return a;
  return `${a.slice(0, 4)}...${a.slice(-4)}`;
}

export function explorerTxUrl(sig: string): string {
  const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(sig)}`;
  return cluster === 'mainnet-beta' || cluster === 'mainnet' ? base : `${base}?cluster=devnet`;
}
