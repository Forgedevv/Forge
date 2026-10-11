import type { Connection, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';

/** SPL Token and Token-2022 program ids: the only owners a coin mint may have. */
export const TOKEN_PROGRAM_IDS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PE5ZG5JSmhMvbW',
] as const;

/** SPL mint layout: `decimals` (u8) at offset 44, `isInitialized` (bool) at 45, 82 bytes. */
const MINT_SIZE = 82;
const DECIMALS_OFFSET = 44;
const INITIALIZED_OFFSET = 45;
const MAX_DECIMALS = 18;

export class MintReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintReadError';
  }
}

/**
 * Decimals of a mint, from its on-chain account data. Throws `MintReadError` when the account is
 * missing, not owned by a token program, too short or not initialized.
 */
export function parseMintDecimals(
  account: { owner: PublicKey | string; data: Uint8Array } | null,
): number {
  if (!account) throw new MintReadError('The coin mint does not exist on this cluster.');
  const owner = typeof account.owner === 'string' ? account.owner : account.owner.toBase58();
  if (!(TOKEN_PROGRAM_IDS as readonly string[]).includes(owner)) {
    throw new MintReadError('This address is not a token mint.');
  }
  // Token-2022 mints may carry extensions after the base layout; the base fields do not move.
  if (account.data.length < MINT_SIZE) throw new MintReadError('The coin mint data is invalid.');
  if (account.data[INITIALIZED_OFFSET] !== 1) {
    throw new MintReadError('The coin mint is not initialized.');
  }
  const decimals = account.data[DECIMALS_OFFSET] as number;
  if (decimals > MAX_DECIMALS) throw new MintReadError('The coin mint data is invalid.');
  return decimals;
}

export interface ReadMintOptions {
  /** Attempts on network errors (not on an invalid mint). */
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads the mint through the relay connection, with backoff on network errors. */
export async function readMintDecimals(
  connection: Pick<Connection, 'getAccountInfo'>,
  mint: PublicKey,
  options: ReadMintOptions = {},
): Promise<number> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let account;
    try {
      account = await connection.getAccountInfo(mint, 'confirmed');
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    return parseMintDecimals(account);
  }
  throw new MintReadError(
    `Could not read the coin mint: ${lastError instanceof Error ? lastError.message : 'network error'}`,
  );
}

export type MintDecimalsState =
  | { status: 'idle' | 'loading'; decimals: null; error: null }
  | { status: 'ready'; decimals: number; error: null }
  | { status: 'error'; decimals: null; error: string };

/**
 * Decimals of the coin, read from its on-chain mint. Every raw amount the form builds (sell input,
 * Max) uses this value; an indexer value is a display fallback only.
 */
export function useMintDecimals(
  connection: Connection | null,
  mint: PublicKey | null,
  options?: ReadMintOptions,
): { state: MintDecimalsState; retry: () => void } {
  const [state, setState] = useState<MintDecimalsState>({
    status: 'idle',
    decimals: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const mintKey = mint?.toBase58() ?? null;

  useEffect(() => {
    if (!connection || !mint) {
      setState({ status: 'idle', decimals: null, error: null });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', decimals: null, error: null });
    readMintDecimals(connection, mint, options).then(
      (decimals) => {
        if (!cancelled) setState({ status: 'ready', decimals, error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof MintReadError ? error.message : 'Could not read the coin mint.';
        setState({ status: 'error', decimals: null, error: message });
      },
    );
    return () => {
      cancelled = true;
    };
    // `mint` is tracked through its address; options are read on each attempt.
  }, [connection, mintKey, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
