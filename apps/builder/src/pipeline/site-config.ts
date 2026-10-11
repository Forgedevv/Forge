import {
  ForgeSiteConfig,
  type LaunchpadSpec,
  type SiteMode,
  type SolanaCluster,
} from '@forge/shared';
import { deepEqual, parseStrictJson } from '../scan/manifest.js';
import type { Violation } from '../scan/index.js';
import { PipelineError } from './errors.js';

/**
 * `forge.config.json` handling (docs/INTERFACES.md §3).
 *
 * The builder writes the file; the agent may change `theme` and `content` only. `onchain` and `mode`
 * are written by the builder alone, in builder-owned commits. The file is handled as a raw JSON
 * object so that extra theme/content keys the agent added are preserved, and validated against
 * the shared `ForgeSiteConfig` schema every time it is read or written.
 */

export const SITE_CONFIG_PATH = 'forge.config.json';

/** Keys the agent may change. */
const AGENT_KEYS = new Set(['theme', 'content']);

export type RawSiteConfig = Record<string, unknown>;
export type OnchainConfig = NonNullable<ForgeSiteConfig['onchain']>;

/** Config of a new launchpad, from its spec. No `onchain` until the on-chain step. */
export function initialSiteConfig(spec: LaunchpadSpec): RawSiteConfig {
  const config: ForgeSiteConfig = {
    version: 1,
    name: spec.name,
    slug: spec.slug,
    mode: 'live',
    theme: {
      primaryColor: spec.theme.primaryColor,
      accentColor: spec.theme.accentColor,
      darkMode: spec.theme.darkMode,
    },
    content: {
      tagline: spec.theme.tagline,
      about: spec.launchpadCoin.description,
    },
  };
  return ForgeSiteConfig.parse(config) as RawSiteConfig;
}

/** Stable serialization (2-space indent, trailing newline). */
export function serializeSiteConfig(config: RawSiteConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function isPlainObject(v: unknown): v is RawSiteConfig {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parses and validates the file. Duplicate keys are refused (parsers disagree on them). */
export function parseSiteConfig(text: string): RawSiteConfig {
  const parsed = parseStrictJson(SITE_CONFIG_PATH, text);
  if (!parsed.ok) throw new PipelineError(`forge.config.json is invalid: ${parsed.reason}`);
  if (!isPlainObject(parsed.value)) {
    throw new PipelineError('forge.config.json must be a JSON object');
  }
  const check = ForgeSiteConfig.safeParse(parsed.value);
  if (!check.success) {
    const fields = [...new Set(check.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new PipelineError(`forge.config.json does not match the schema: ${fields.join(', ')}`);
  }
  return parsed.value;
}

/** Validated typed view of a raw config. */
export function typedSiteConfig(config: RawSiteConfig): ForgeSiteConfig {
  return ForgeSiteConfig.parse(config);
}

/**
 * Second line of defence after the scan: checks the agent's version of the file against the
 * baseline the builder wrote. Only `theme` and `content` may differ, and the result must still be
 * a valid `ForgeSiteConfig` (a site with a broken config would not render).
 */
export function checkAgentSiteConfig(baseline: string, next: string | null): Violation[] {
  const v = (reason: string, rule: Violation['rule']): Violation => ({
    rule,
    file: SITE_CONFIG_PATH,
    line: null,
    reason,
  });
  if (next === null) return [v('forge.config.json was deleted', 'forge-config-locked-field')];
  const before = parseStrictJson(SITE_CONFIG_PATH, baseline);
  const after = parseStrictJson(SITE_CONFIG_PATH, next);
  if (!before.ok || !isPlainObject(before.value)) {
    return [v('baseline forge.config.json is invalid', 'forge-config-invalid')];
  }
  if (!after.ok) return [v(`invalid JSON (${after.reason})`, 'forge-config-invalid')];
  if (!isPlainObject(after.value)) {
    return [v('forge.config.json must be a JSON object', 'forge-config-invalid')];
  }
  const out: Violation[] = [];
  const keys = new Set([...Object.keys(before.value), ...Object.keys(after.value)]);
  for (const key of keys) {
    if (AGENT_KEYS.has(key)) continue;
    if (!deepEqual(before.value[key], after.value[key])) {
      out.push(v(`field "${key}" may only be written by the builder`, 'forge-config-locked-field'));
    }
  }
  const schema = ForgeSiteConfig.safeParse(after.value);
  if (!schema.success) {
    const fields = [...new Set(schema.error.issues.map((i) => i.path.join('.') || '(root)'))];
    out.push(v(`schema mismatch at ${fields.join(', ')}`, 'forge-config-invalid'));
  }
  return out;
}

/** Same config with `mode` set (builder only). */
export function withMode(config: RawSiteConfig, mode: SiteMode): RawSiteConfig {
  return { ...config, mode };
}

/** Same config with `onchain` set (builder only). */
export function withOnchain(config: RawSiteConfig, onchain: OnchainConfig): RawSiteConfig {
  return { ...config, onchain };
}

/** The `onchain` block written after the signer created the configs and prepared the launch. */
export function onchainBlock(input: {
  cluster: SolanaCluster;
  launchpadConfig: string;
  launchpadCoinConfig: string;
  launchpadCoinMint: string;
  spec: LaunchpadSpec;
}): OnchainConfig {
  const block: OnchainConfig = {
    cluster: input.cluster,
    launchpadConfig: input.launchpadConfig,
    launchpadCoinConfig: input.launchpadCoinConfig,
    launchpadCoinMint: input.launchpadCoinMint,
    ownerWallet: input.spec.ownerWallet,
    poolCreationFeeSol: input.spec.poolCreationFeeSol,
  };
  // Validated by the shared schema (addresses, cluster, fee bounds).
  const check = ForgeSiteConfig.shape.onchain.safeParse(block);
  if (!check.success)
    throw new PipelineError('on-chain addresses returned by the signer are invalid');
  return block;
}

/** Deep equality of two `onchain` blocks (absent = undefined). */
export function sameOnchain(a: unknown, b: unknown): boolean {
  return deepEqual(a, b);
}
