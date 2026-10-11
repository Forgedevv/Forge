import {
  ForgeAddressError,
  GatingError as CoreGatingError,
  getForgeBalance,
  passesForgeGate,
  type AddressEnv,
  type ForgeBalance,
} from '@forge/core';
import { Connection, PublicKey } from '@solana/web3.js';

/*
 * Token gate for the design chat (docs/PRODUCT.md: hold FORGE_GATING_AMOUNT of FORGE_MINT,
 * rechecked on each use). Disabled while FORGE_MINT is not set. The balance is read with
 * `getForgeBalance` of @forge/core (the wallet's associated token account, classic SPL Token or
 * Token-2022) through the server RPC URL, and cached briefly. Fails closed on any error.
 */

export interface GatingResult {
  enabled: boolean;
  ok: boolean;
}

export type GatingCheck = (wallet: string) => Promise<GatingResult>;

export class GatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatingError';
  }
}

/** Reads the $FORGE balance of `wallet` (seam for tests). */
export type BalanceReader = (wallet: PublicKey, env: AddressEnv) => Promise<ForgeBalance>;

const CACHE_TTL_MS = 30_000;
const RAW_AMOUNT = /^\d{1,30}$/;

function defaultReader(env: AddressEnv): BalanceReader {
  let connection: Connection | null = null;
  return (wallet) => {
    const rpcUrl = env.RPC_URL;
    if (rpcUrl === undefined || rpcUrl === '') throw new GatingError('RPC_URL is not configured');
    connection ??= new Connection(rpcUrl, { commitment: 'confirmed' });
    return getForgeBalance(connection, wallet, { env });
  };
}

export function createGatingCheck(
  env: AddressEnv = process.env,
  readBalance: BalanceReader = defaultReader(env),
  now: () => number = Date.now,
): GatingCheck {
  const cache = new Map<string, { at: number; balance: ForgeBalance }>();

  return async (wallet) => {
    const mint = env.FORGE_MINT;
    if (mint === undefined || mint === '') return { enabled: false, ok: true };

    const requiredRaw = env.FORGE_GATING_AMOUNT;
    if (requiredRaw === undefined || !RAW_AMOUNT.test(requiredRaw)) {
      throw new GatingError('FORGE_GATING_AMOUNT is not configured');
    }
    const required = BigInt(requiredRaw);
    if (required === 0n) return { enabled: true, ok: true };

    const hit = cache.get(wallet);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      return { enabled: true, ok: passesForgeGate(hit.balance, required) };
    }

    let balance: ForgeBalance;
    try {
      balance = await readBalance(new PublicKey(wallet), env);
    } catch (error) {
      if (error instanceof GatingError) throw error;
      // Names only: RPC errors may echo the endpoint (and its API key).
      if (error instanceof ForgeAddressError) throw new GatingError('FORGE_MINT is invalid');
      if (error instanceof CoreGatingError) throw new GatingError(`FORGE_MINT: ${error.code}`);
      throw new GatingError('RPC request failed');
    }
    cache.set(wallet, { at: now(), balance });
    return { enabled: true, ok: passesForgeGate(balance, required) };
  };
}
