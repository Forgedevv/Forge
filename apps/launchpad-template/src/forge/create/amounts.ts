/**
 * LOCKED ZONE. Exact SOL <-> lamports conversions. Amounts are bigint lamports everywhere;
 * floating point numbers never carry money.
 */

export const LAMPORTS_PER_SOL = BigInt(1000000000);
const SOL_DECIMALS = 9;

const SOL_INPUT = /^(\d+)(?:\.(\d{1,9}))?$/;

/**
 * Parses a user-typed SOL amount ("1", "0.5", "0.000000001") to lamports.
 * Returns null for anything else (empty, negative, exponent, more than 9 decimals).
 */
export function parseSolToLamports(input: string): bigint | null {
  const match = SOL_INPUT.exec(input.trim());
  if (!match) return null;
  const whole = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? '').padEnd(SOL_DECIMALS, '0') || '0');
  return whole * LAMPORTS_PER_SOL + fraction;
}

/** Formats lamports as a SOL decimal string without trailing zeros ("1.5", "0.000005"). */
export function formatSol(lamports: bigint): string {
  const negative = lamports < BigInt(0);
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = (abs % LAMPORTS_PER_SOL)
    .toString()
    .padStart(SOL_DECIMALS, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

/** Converts a config value expressed in SOL (e.g. `poolCreationFeeSol`) to lamports, exactly. */
export function solNumberToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) throw new Error('Invalid SOL amount');
  // toFixed(9) rounds to the nearest lamport without exponent notation for realistic values.
  const lamports = parseSolToLamports(sol.toFixed(SOL_DECIMALS));
  if (lamports === null) throw new Error('Invalid SOL amount');
  return lamports;
}
