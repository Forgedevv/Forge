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
