import { PublicKey } from '@solana/web3.js';
import type { PaymentCluster } from './core-adapter';
import { PaymentConfigError } from './errors';

/*
 * Environment of the payment routes (docs/INTERFACES.md §8). Read lazily, at the first request,
 * so that a build without secrets still succeeds. Error messages name variables, never values.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface PaymentsConfig {
  cluster: PaymentCluster;
  rpcUrl: string;
  /** TODO(merge): read through `getCashboxWallet()` of @forge/core (PLANEXECUTE.md rule 7). */
  cashbox: PublicKey;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  jupiterApiKey: string | undefined;
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new PaymentConfigError(`${name} is not set`);
  }
  return value.trim();
}

/** Devnet unless SOLANA_CLUSTER=mainnet-beta is explicitly set (PLANEXECUTE.md rule 4). */
export function readCluster(env: Env): PaymentCluster {
  const value = env.SOLANA_CLUSTER?.trim() || 'devnet';
  if (value !== 'devnet' && value !== 'mainnet-beta') {
    throw new PaymentConfigError('SOLANA_CLUSTER must be devnet or mainnet-beta');
  }
  return value;
}

/**
 * The RPC URL must match the cluster: a devnet URL contains "devnet", a mainnet one contains
 * neither "devnet" nor "testnet". The adapter also compares the genesis hash at runtime.
 */
export function readRpcUrl(env: Env, cluster: PaymentCluster): string {
  const url = required(env, 'RPC_URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PaymentConfigError('RPC_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PaymentConfigError('RPC_URL must be an http(s) URL');
  }
  const lower = url.toLowerCase();
  if (cluster === 'devnet' && !lower.includes('devnet')) {
    throw new PaymentConfigError('RPC_URL does not look like a devnet endpoint (SOLANA_CLUSTER)');
  }
  if (cluster === 'mainnet-beta' && (lower.includes('devnet') || lower.includes('testnet'))) {
    throw new PaymentConfigError(
      'RPC_URL looks like a test cluster while SOLANA_CLUSTER is mainnet-beta',
    );
  }
  return url;
}

/** Same validation as `requireAddresses` of @forge/core: canonical base58, 32 bytes, not zero. */
export function readCashbox(env: Env): PublicKey {
  const value = required(env, 'FORGE_CASHBOX_WALLET');
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    throw new PaymentConfigError('FORGE_CASHBOX_WALLET is not a valid Solana public key');
  }
  if (key.toBase58() !== value || key.equals(PublicKey.default)) {
    throw new PaymentConfigError('FORGE_CASHBOX_WALLET is not a valid Solana public key');
  }
  return key;
}

export function readPaymentsConfig(env: Env = process.env): PaymentsConfig {
  const cluster = readCluster(env);
  const jupiterApiKey = env.JUPITER_API_KEY?.trim();
  return {
    cluster,
    rpcUrl: readRpcUrl(env, cluster),
    cashbox: readCashbox(env),
    supabaseUrl: required(env, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    jupiterApiKey: jupiterApiKey ? jupiterApiKey : undefined,
  };
}
