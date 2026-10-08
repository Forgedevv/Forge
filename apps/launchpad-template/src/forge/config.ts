import { z } from 'zod';
import { ForgeSiteConfig, toSiteConfig, type SiteConfig } from '@forge/shared';
import rawConfig from '../../forge.config.json';

/**
 * LOCKED ZONE. Reads and validates `forge.config.json` (docs/INTERFACES.md section 3).
 * The JSON file is bundled at build time: there is no filesystem or network access at runtime.
 * An invalid file fails the build.
 */
export const forgeConfig: ForgeSiteConfig = ForgeSiteConfig.parse(rawConfig);

/** UI-facing read-only view (no on-chain data). */
export const siteConfig: SiteConfig = toSiteConfig(forgeConfig);

/** On-chain block. Absent until the on-chain setup of the launchpad is done. */
export const onchainConfig = forgeConfig.onchain;

/** Coin creation fee: 0 (no fee) or between 0.001 and 1 SOL (INTERFACES.md section 1). */
const PoolCreationFeeSol = z.number().refine((v) => v === 0 || (v >= 0.001 && v <= 1), {
  message: 'poolCreationFeeSol must be 0 or between 0.001 and 1 SOL',
});

/**
 * Reads `onchain.poolCreationFeeSol` from a raw forge.config.json. `undefined` when absent (the
 * authoritative amount then comes from the prepared transaction summary). Throws when invalid, so a
 * bad file fails the build.
 */
export function readPoolCreationFeeSol(raw: unknown): number | undefined {
  const onchain = (raw as { onchain?: { poolCreationFeeSol?: unknown } } | null)?.onchain;
  const value = onchain?.poolCreationFeeSol;
  if (value === undefined) return undefined;
  return PoolCreationFeeSol.parse(value);
}

/** Coin creation fee in SOL as configured for this launchpad, if present in the config. */
export const poolCreationFeeSol: number | undefined = readPoolCreationFeeSol(rawConfig);

/** Solana cluster of this launchpad (explorer links). Defaults to mainnet-beta before setup. */
export const cluster = onchainConfig?.cluster ?? 'mainnet-beta';

/**
 * FORGE RPC relay origin used by the browser (never the RPC provider directly). Read with a literal
 * `process.env.NEXT_PUBLIC_*` so that Next inlines it at build time. `undefined` when unset.
 */
export const rpcRelayUrl: string | undefined =
  process.env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL || undefined;
