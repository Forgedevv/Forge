/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clientProjectVars, pickProjectEnv, PROJECT_ENV_REQUIRED } from './vercel.js';

/**
 * Regression (wave 5 review): the template reads public variables that the builder never set on
 * client projects, so curve trading was dead on every client site. Every `NEXT_PUBLIC_*` name the
 * template source reads must be set by the builder, or listed here with the reason it may stay
 * unset.
 */
const TEMPLATE_SRC = fileURLToPath(new URL('../../launchpad-template/src', import.meta.url));

/** Public names the template reads that the builder deliberately does not set. */
const OPTIONAL_TEMPLATE_ENV: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_VERCEL_BRANCH_URL:
    'Vercel system variable, set by Vercel itself; the template falls back to the page origin',
  NEXT_PUBLIC_FORGE_API_URL:
    'optional override of the FORGE upload API; the template falls back to the RPC relay origin',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** `NEXT_PUBLIC_*` names read as `process.env.X`, `env.X` or `env['X']`, with their files. */
function templatePublicEnvNames(): Map<string, string[]> {
  const names = new Map<string, string[]>();
  const re = /\benv(?:\.|\[\s*['"`])(NEXT_PUBLIC_[A-Z0-9_]+)/g;
  for (const file of sourceFiles(TEMPLATE_SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const name = m[1]!;
      const files = names.get(name) ?? [];
      files.push(relative(TEMPLATE_SRC, file).replace(/\\/g, '/'));
      names.set(name, files);
    }
  }
  return names;
}

const ADDR = (n: number): string => `${'1'.repeat(31)}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[n]!}`;

/** What the builder host provides (no explicit NEXT_PUBLIC twins: they must be derived). */
const HOST_ENV: Record<string, string> = {
  SOLANA_CLUSTER: 'devnet',
  FORGE_MULTISIG_VAULT: ADDR(1),
  FORGE_METEORA_REFERRAL_ACCOUNT: ADDR(2),
  FORGE_PLATFORM_FEE_WALLET: ADDR(3),
  FORGE_JUPITER_REFERRAL_ACCOUNT: ADDR(4),
  NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://forge.example/api/rpc',
  R2_PUBLIC_URL: 'https://cdn.forge.example',
};

describe('client project variables cover what the template reads', () => {
  it('finds the template source', () => {
    const names = templatePublicEnvNames();
    expect(names.size).toBeGreaterThan(0);
    // The two names of the review finding are read by the trade configuration.
    expect(names.get('NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET')).toBeDefined();
    expect(names.get('NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT')).toBeDefined();
  });

  it('sets every NEXT_PUBLIC_* name the template reads (or lists it as optional)', () => {
    const picked = pickProjectEnv(HOST_ENV);
    expect(picked.missing).toEqual([]);
    expect(picked.invalid).toEqual([]);
    const vars = clientProjectVars(picked.vars, {
      slug: 'moonpad',
      poolKeys: `${ADDR(5)},${ADDR(6)}`,
      relayTokenSecret: 'relay-secret-for-tests-0123456789abcdef',
    });
    const unset: string[] = [];
    for (const [name, files] of templatePublicEnvNames()) {
      if (name in OPTIONAL_TEMPLATE_ENV) continue;
      if (vars[name] === undefined || vars[name] === '') unset.push(`${name} (${files[0]})`);
    }
    expect(unset).toEqual([]);
  });

  it('derives the public fee accounts from the FORGE values and requires them', () => {
    const { vars } = pickProjectEnv(HOST_ENV);
    expect(vars.NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET).toBe(HOST_ENV.FORGE_PLATFORM_FEE_WALLET);
    expect(vars.NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT).toBe(
      HOST_ENV.FORGE_METEORA_REFERRAL_ACCOUNT,
    );
    expect(PROJECT_ENV_REQUIRED).toContain('NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET');
    expect(PROJECT_ENV_REQUIRED).toContain('NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT');
  });

  it('refuses a public twin that is not an address or differs from its FORGE value', () => {
    const bad = pickProjectEnv({
      ...HOST_ENV,
      NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET: 'not-an-address',
      NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT: ADDR(9),
    });
    expect(bad.invalid).toEqual([
      'NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT',
      'NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET',
    ]);
    expect(bad.vars.NEXT_PUBLIC_FORGE_PLATFORM_FEE_WALLET).toBeUndefined();
    expect(bad.vars.NEXT_PUBLIC_FORGE_METEORA_REFERRAL_ACCOUNT).toBeUndefined();
  });

  it('every optional name has a reason and is never sent by the builder', () => {
    const { vars } = pickProjectEnv({ ...HOST_ENV, ...OPTIONAL_TEMPLATE_ENV });
    for (const [name, reason] of Object.entries(OPTIONAL_TEMPLATE_ENV)) {
      expect(reason.length, name).toBeGreaterThan(10);
      expect(vars[name], name).toBeUndefined();
    }
  });
});
