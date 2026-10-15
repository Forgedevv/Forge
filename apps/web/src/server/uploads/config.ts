import { createRpcMintChecker } from './chain';
import { UploadHttpError } from './contract';
import { createUploadService, type UploadService } from './service';
import { createR2Storage, type R2StorageOptions } from './storage';
import { createServiceUploadStore } from './supabase-store';

/*
 * Upload configuration from the server environment. Messages name variables, never values.
 *
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   write access (server only)
 *   R2_PUBLIC_URL                                                      public https base of the bucket
 *   R2_ENDPOINT (optional)       S3 endpoint, default https://<account>.r2.cloudflarestorage.com
 *   CLIENTS_DOMAIN               client sites live at <slug>.<CLIENTS_DOMAIN> (optional: a
 *                                launchpad's recorded site_host is accepted without it)
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 *   RPC_URL (optional)           enables the on-chain "mint is fresh" check
 */

export class UploadConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`missing or invalid: ${variables.join(', ')}`);
    this.name = 'UploadConfigError';
  }
}

type Env = Record<string, string | undefined>;

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function httpsBase(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function readR2Options(env: Env): Omit<R2StorageOptions, 'fetch' | 'now' | 'sleep'> {
  const bad: string[] = [];
  const accountId = env.R2_ACCOUNT_ID ?? '';
  if (!/^[0-9a-f]{32}$/.test(accountId)) bad.push('R2_ACCOUNT_ID');
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? '';
  if (!/^[A-Za-z0-9]{16,128}$/.test(accessKeyId)) bad.push('R2_ACCESS_KEY_ID');
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? '';
  if (secretAccessKey.length < 16 || /\s/.test(secretAccessKey)) bad.push('R2_SECRET_ACCESS_KEY');
  const bucket = env.R2_BUCKET ?? '';
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) bad.push('R2_BUCKET');
  const publicBaseUrl = httpsBase(env.R2_PUBLIC_URL);
  if (!publicBaseUrl) bad.push('R2_PUBLIC_URL');
  let endpoint: string | undefined;
  if (env.R2_ENDPOINT) {
    const parsed = httpsBase(env.R2_ENDPOINT);
    if (!parsed || new URL(parsed).pathname !== '/') bad.push('R2_ENDPOINT');
    else endpoint = new URL(parsed).origin;
  }
  if (bad.length > 0) throw new UploadConfigError(bad);
  return {
    accountId,
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    publicBaseUrl: publicBaseUrl as string,
    ...(endpoint ? { endpoint } : {}),
  };
}

export function readClientsDomain(env: Env): string | null {
  const value = env.CLIENTS_DOMAIN?.trim().toLowerCase();
  if (!value) return null;
  if (!HOSTNAME.test(value)) throw new UploadConfigError(['CLIENTS_DOMAIN']);
  return value;
}

export function createUploadServiceFromEnv(env: Env = process.env): UploadService {
  const storage = createR2Storage(readR2Options(env));
  const clientsDomain = readClientsDomain(env);
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const missing: string[] = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) throw new UploadConfigError(missing);
  const rpcUrl = env.RPC_URL;
  return createUploadService({
    store: createServiceUploadStore(supabaseUrl as string, serviceRoleKey as string),
    storage,
    clientsDomain,
    allowLocalHosts: env.NODE_ENV !== 'production',
    mintChecker: rpcUrl ? createRpcMintChecker({ rpcUrl }) : null,
  });
}

let cached: UploadService | null = null;

/** Process-wide service built from the environment; 503 NOT_CONFIGURED when incomplete. */
export function getDefaultUploadService(): UploadService {
  if (cached) return cached;
  try {
    cached = createUploadServiceFromEnv();
  } catch (error) {
    if (error instanceof UploadConfigError) {
      console.error(`[uploads] configuration error: ${error.message}`);
      throw new UploadHttpError(503, 'NOT_CONFIGURED', 'Coin uploads are not configured yet.');
    }
    throw error;
  }
  return cached;
}
