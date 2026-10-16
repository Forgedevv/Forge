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

/** Full gate state, as returned by GET /api/gating (raw units). */
export interface GatingStatus extends GatingResult {
  /** Required raw amount (FORGE_GATING_AMOUNT); 0 when gating is disabled. */
  required: bigint;
  /** The wallet's raw balance; 0 when gating is disabled or nothing is required (no RPC read). */
  balance: bigint;
  /** Decimals of the $FORGE mint, when its balance was read on-chain. */
  decimals?: number;
}

export type GatingCheck = (wallet: string) => Promise<GatingResult>;
export type GatingStatusCheck = (wallet: string) => Promise<GatingStatus>;

export class GatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatingError';
  }
}

/** Reads the $FORGE balance of `wallet` (seam for tests). */
export type BalanceReader = (wallet: PublicKey, env: AddressEnv) => Promise<ForgeBalance>;

const CACHE_TTL_MS = 30_000;
/** Bounds the balance cache (oldest entry dropped first). */
const MAX_CACHED_WALLETS = 10_000;
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
): GatingStatusCheck {
  const cache = new Map<string, { at: number; balance: ForgeBalance }>();
  const status = (balance: ForgeBalance, required: bigint): GatingStatus => ({
    enabled: true,
    ok: passesForgeGate(balance, required),
    required,
    balance: balance.enabled ? balance.balance : 0n,
    ...(balance.enabled ? { decimals: balance.decimals } : {}),
  });

  return async (wallet) => {
    const mint = env.FORGE_MINT;
    if (mint === undefined || mint === '') {
      return { enabled: false, ok: true, required: 0n, balance: 0n };
    }

    const requiredRaw = env.FORGE_GATING_AMOUNT;
    if (requiredRaw === undefined || !RAW_AMOUNT.test(requiredRaw)) {
      throw new GatingError('FORGE_GATING_AMOUNT is not configured');
    }
    const required = BigInt(requiredRaw);
    if (required === 0n) return { enabled: true, ok: true, required, balance: 0n };

    const hit = cache.get(wallet);
    if (hit && now() - hit.at < CACHE_TTL_MS) return status(hit.balance, required);

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
    if (cache.size >= MAX_CACHED_WALLETS) cache.delete(cache.keys().next().value as string);
    cache.set(wallet, { at: now(), balance });
    return status(balance, required);
  };
}

const DEFAULT_KEY = Symbol.for('forge.web.gating.check');

/**
 * Process-wide gate built from the environment (one balance cache shared by the chat, the spec
 * confirmation, the modifications and GET /api/gating; survives dev hot reloads).
 */
export function getDefaultGatingCheck(): GatingStatusCheck {
  const g = globalThis as unknown as Record<symbol, GatingStatusCheck | undefined>;
  let check = g[DEFAULT_KEY];
  if (!check) {
    check = createGatingCheck();
    g[DEFAULT_KEY] = check;
  }
  return check;
}
