/**
 * Trade-specific configuration read from the public environment. Nothing FORGE-owned is hard-coded:
 * the RPC relay URL, the FORGE fee accounts and the cluster all come from the environment.
 *
 * `process.env.NEXT_PUBLIC_*` must be written as literal member expressions so Next.js can inline
 * them in the browser bundle: do not pass `process.env` around.
 */
import { onchainConfig } from '../config';
import { canonicalAddress } from '../tx/programs';

export { resolveRelayUrl } from '../relay';

export interface TradeEnv {
  relayUrl?: string;
  jupiterReferral?: string;
  /** FORGE platform fee wallet: the only recipient of the 0.3% transfer in a curve swap. */
  platformFeeWallet?: string;
  /** FORGE Meteora referral token account expected in the DBC swap (checked when set). */
  meteoraReferral?: string;
  cluster?: string;
}

export function readTradeEnv(): TradeEnv {
  return {
    relayUrl: process.env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL,
    jupiterReferral:
      process.env.NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT ??
      // Not inlined in the browser; only resolves on the server and in tests.
      process.env.FORGE_JUPITER_REFERRAL_ACCOUNT,
    platformFeeWallet: process.env.NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET,
    meteoraReferral: process.env.NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT,
    cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
  };
}

/** Jupiter referral account: a valid, canonical, non-default public key, or null. */
export function resolveJupiterReferral(raw: string | undefined): string | null {
  return canonicalAddress(raw);
}

/** Any FORGE address read from the public environment: canonical and non-default, or null. */
export function resolveForgeAddress(raw: string | undefined): string | null {
  return canonicalAddress(raw);
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
