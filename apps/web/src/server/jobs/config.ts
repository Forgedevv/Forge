/*
 * Environment of the job and launchpad routes (docs/INTERFACES.md §8). Read lazily, at the first
 * request, so that a build without secrets still succeeds. Error messages name variables, never
 * their values.
 */

export type Env = Readonly<Record<string, string | undefined>>;
export type Cluster = 'devnet' | 'mainnet-beta';

export class RoutesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutesConfigError';
  }
}

export interface RoutesConfig {
  cluster: Cluster;
  rpcUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Domain of the client sites (`<slug>.<domain>`), when configured. */
  clientsDomain: string | null;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new RoutesConfigError(`${name} is not set`);
  return value;
}

/** Devnet unless SOLANA_CLUSTER=mainnet-beta is explicitly set (PLANEXECUTE.md rule 4). */
export function readCluster(env: Env): Cluster {
  const value = env.SOLANA_CLUSTER?.trim() || 'devnet';
  if (value !== 'devnet' && value !== 'mainnet-beta') {
    throw new RoutesConfigError('SOLANA_CLUSTER must be devnet or mainnet-beta');
  }
  return value;
}

/**
 * The RPC URL must match the cluster: a devnet URL contains "devnet", a mainnet one contains
 * neither "devnet" nor "testnet". The genesis hash is compared at runtime before any send.
 */
export function readRpcUrl(env: Env, cluster: Cluster): string {
  const url = required(env, 'RPC_URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RoutesConfigError('RPC_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RoutesConfigError('RPC_URL must be an http(s) URL');
  }
  const lower = url.toLowerCase();
  if (cluster === 'devnet' && !lower.includes('devnet')) {
    throw new RoutesConfigError('RPC_URL does not look like a devnet endpoint (SOLANA_CLUSTER)');
  }
  if (cluster === 'mainnet-beta' && (lower.includes('devnet') || lower.includes('testnet'))) {
    throw new RoutesConfigError(
      'RPC_URL looks like a test cluster while SOLANA_CLUSTER is mainnet-beta',
    );
  }
  return url;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Optional CLIENTS_DOMAIN (same variable as the builder): a lowercase host name. */
export function readClientsDomain(env: Env): string | null {
  const value = env.CLIENTS_DOMAIN?.trim().toLowerCase();
  if (value === undefined || value === '') return null;
  if (!HOST_RE.test(value)) throw new RoutesConfigError('CLIENTS_DOMAIN is not a valid host name');
  return value;
}

export function readRoutesConfig(env: Env = process.env): RoutesConfig {
  const cluster = readCluster(env);
  return {
    cluster,
    rpcUrl: readRpcUrl(env, cluster),
    supabaseUrl: required(env, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    clientsDomain: readClientsDomain(env),
  };
}
