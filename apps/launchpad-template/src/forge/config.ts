import { ForgeSiteConfig, toSiteConfig, type SiteConfig } from '@forge/shared';
import rawConfig from '../../forge.config.json';
import { resolveRelayUrl } from './relay';

/** Freezes an object and everything in it (the parsed config is plain JSON data). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * LOCKED ZONE. Reads and validates `forge.config.json` (docs/INTERFACES.md section 3).
 * The JSON file is bundled at build time: there is no filesystem or network access at runtime.
 * An invalid file fails the build. The result is deeply frozen: no code of the site (free zones
 * included) can change at runtime the configs the trade panel and coin creation accept.
 */
export const forgeConfig: ForgeSiteConfig = deepFreeze(ForgeSiteConfig.parse(rawConfig));

/** UI-facing read-only view (no on-chain data). */
export const siteConfig: SiteConfig = toSiteConfig(forgeConfig);

/** On-chain block. Absent until the on-chain setup of the launchpad is done. */
export const onchainConfig = forgeConfig.onchain;

/**
 * Coin creation fee charged by this launchpad (`onchain.poolCreationFeeSol`, validated by the
 * shared schema: 0 or between 0.001 and 1 SOL). `undefined` when the builder did not write it:
 * coin creation then refuses to run, since the fee in a prepared transaction could not be checked.
 */
export const poolCreationFeeSol: number | undefined = onchainConfig?.poolCreationFeeSol;

/** Validates and reads the optional creation fee from an untrusted config-like value. */
export function readPoolCreationFeeSol(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const onchain = (value as { onchain?: unknown }).onchain;
  if (!onchain || typeof onchain !== 'object') return undefined;
  const fee = (onchain as { poolCreationFeeSol?: unknown }).poolCreationFeeSol;
  if (fee === undefined) return undefined;
  if (typeof fee !== 'number' || !Number.isFinite(fee) || (fee !== 0 && (fee < 0.001 || fee > 1))) {
    throw new Error('onchain.poolCreationFeeSol must be 0 or between 0.001 and 1 SOL');
  }
  return fee;
}

/**
 * Solana cluster of this launchpad (explorer links, wallet network). Before the on-chain setup it
 * is devnet unless `NEXT_PUBLIC_SOLANA_CLUSTER` is explicitly `mainnet-beta` (PLANEXECUTE rule 4).
 */
export const cluster: 'devnet' | 'mainnet-beta' =
  onchainConfig?.cluster ??
  (process.env.NEXT_PUBLIC_SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet');

/**
 * JSON-RPC endpoint of the FORGE RPC relay used by the browser (never the RPC provider directly),
 * normalised exactly like the trade panel does (a bare origin gets `/api/rpc`; anything that is not
 * http(s) is refused). Null when unusable. The raw variable is read with a literal
 * `process.env.NEXT_PUBLIC_*` so that Next inlines it at build time; it is not exported, so no
 * component can send JSON-RPC to the bare origin.
 */
export const rpcRelayEndpoint: string | null = resolveRelayUrl(
  process.env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL || undefined,
);
