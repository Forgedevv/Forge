/**
 * Trade-specific configuration read from the public environment. Nothing FORGE-owned is hard-coded:
 * the RPC relay URL, the Jupiter referral account and the cluster all come from the environment.
 *
 * `process.env.NEXT_PUBLIC_*` must be written as literal member expressions so Next.js can inline
 * them in the browser bundle: do not pass `process.env` around.
 */
import { PublicKey } from '@solana/web3.js';
import { onchainConfig } from '../config';

export interface TradeEnv {
  relayUrl?: string;
  jupiterReferral?: string;
  cluster?: string;
}

export function readTradeEnv(): TradeEnv {
  return {
    relayUrl: process.env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL,
    jupiterReferral:
      process.env.NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT ??
      // Not inlined in the browser; only resolves on the server and in tests.
      process.env.FORGE_JUPITER_REFERRAL_ACCOUNT,
    cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
  };
}

/**
 * JSON-RPC endpoint of the FORGE relay. A bare origin gets the relay path appended
 * (docs/INTERFACES.md: `POST /api/rpc`). Returns null when unset or not an http(s) URL.
 */
export function resolveRelayUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/api/rpc';
    return url.toString();
  } catch {
    return null;
  }
}

/** Jupiter referral account: a valid, canonical, non-default public key, or null. */
export function resolveJupiterReferral(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const key = new PublicKey(raw);
    if (key.toBase58() !== raw || key.equals(PublicKey.default)) return null;
    return raw;
  } catch {
    return null;
  }
}

export type ExplorerCluster = 'devnet' | 'mainnet-beta';

export function resolveCluster(env: TradeEnv = readTradeEnv()): ExplorerCluster {
  if (onchainConfig?.cluster) return onchainConfig.cluster;
  return env.cluster === 'devnet' ? 'devnet' : 'mainnet-beta';
}

export function explorerTxUrl(signature: string, cluster: ExplorerCluster): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${suffix}`;
}
