import { isCanonicalPublicKey } from '../auth/base58';

/*
 * Private beta policy, read from the environment:
 *
 *   FORGE_BETA_MODE       `on` | `off`. Default: `on` in production builds, `off` otherwise.
 *   FORGE_BETA_ALLOWLIST  comma-separated base58 wallet addresses allowed in while the beta is on.
 *
 * Fails closed: when the mode is on (or the mode value is unknown) and the list is missing, empty
 * or holds one invalid entry, nobody is allowed in. Log lines name the variable and the position
 * of a bad entry, never an address.
 */

export type BetaPolicy =
  | { readonly mode: 'off' }
  | { readonly mode: 'on'; readonly allowlist: ReadonlySet<string> }
  /** Configuration unusable: every wallet is refused. `problem` never contains a value. */
  | { readonly mode: 'closed'; readonly problem: string };

export interface BetaEnv {
  FORGE_BETA_MODE?: string | undefined;
  FORGE_BETA_ALLOWLIST?: string | undefined;
  NODE_ENV?: string | undefined;
}

/** Upper bound of the list, so a pasted blob cannot make every request slow. */
export const MAX_BETA_WALLETS = 10_000;

/** A canonical base58 encoding of a 32-byte public key. */
export function isWalletAddress(value: string): boolean {
  return isCanonicalPublicKey(value);
}

export function parseBetaPolicy(env: BetaEnv): BetaPolicy {
  const rawMode = (env.FORGE_BETA_MODE ?? '').trim().toLowerCase();
  let mode: 'on' | 'off';
  if (rawMode === '') mode = env.NODE_ENV === 'production' ? 'on' : 'off';
  else if (rawMode === 'on' || rawMode === 'off') mode = rawMode;
  else return { mode: 'closed', problem: 'FORGE_BETA_MODE must be "on" or "off"' };
  if (mode === 'off') return { mode: 'off' };

  const entries = (env.FORGE_BETA_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    return { mode: 'closed', problem: 'FORGE_BETA_ALLOWLIST is empty while the beta is on' };
  }
  if (entries.length > MAX_BETA_WALLETS) {
    return {
      mode: 'closed',
      problem: `FORGE_BETA_ALLOWLIST has more than ${MAX_BETA_WALLETS} entries`,
    };
  }
  const allowlist = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!isWalletAddress(entry)) {
      return {
        mode: 'closed',
        problem: `FORGE_BETA_ALLOWLIST entry #${index + 1} is not a valid wallet address`,
      };
    }
    allowlist.add(entry);
  }
  return { mode: 'on', allowlist };
}

let cached: { key: string; policy: BetaPolicy } | null = null;

/**
 * Policy of the current process environment. Re-read on every call (so an updated list applies
 * to the very next request, sessions included); parsed again only when a value changed.
 */
export function currentBetaPolicy(env: BetaEnv = process.env): BetaPolicy {
  const key = JSON.stringify([env.FORGE_BETA_MODE, env.FORGE_BETA_ALLOWLIST, env.NODE_ENV]);
  if (cached?.key === key) return cached.policy;
  const policy = parseBetaPolicy(env);
  if (policy.mode === 'closed') {
    console.error(`[beta] ${policy.problem}: sign-in is closed for every wallet`);
  }
  cached = { key, policy };
  return policy;
}

export type BetaAccess = 'allowed' | 'not_invited' | 'unavailable';

/** Whether `wallet` may sign in and use authenticated routes. */
export function checkBetaAccess(wallet: string, env: BetaEnv = process.env): BetaAccess {
  const policy = currentBetaPolicy(env);
  if (policy.mode === 'off') return 'allowed';
  if (policy.mode === 'closed') return 'unavailable';
  return policy.allowlist.has(wallet) ? 'allowed' : 'not_invited';
}
