/**
 * Process-level environment of the signer (docs/INTERFACES.md §8, apps/signer/.env.example).
 *
 * Parsed once at startup with zod; anything malformed stops the process before a key is opened.
 * Errors name the variables, never their values. The per-job variables (SIGNER_CLAIMS_*,
 * SIGNER_CASHBOX_*, SIGNER_REFUNDS_*, WATCH_*, CONVERT_*, BUYBACK_*) are parsed by the jobs' own
 * `...FromEnv` functions, also at startup. FORGE addresses are read by `requireAddresses` of
 * @forge/core, the HMAC server settings by `loadSignerServerEnv` (server.ts).
 *
 * On mainnet-beta, and in production (NODE_ENV other than `development` / `test`), the signer
 * refuses to start without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID: an alert that only reaches
 * the log is an alert nobody reads.
 */
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_KEYSTORE_DIR } from '../keystore.js';
import { isProductionEnv } from '../server.js';
import {
  DEFAULT_JOURNAL_DIR,
  DEFAULT_MIN_PAYMENT_LAMPORTS,
  MAX_COMPUTE_UNIT_PRICE,
  MAX_SIGNER_PRIORITY_FEE_LAMPORTS,
  type PaymentMinimums,
} from '../jobs/shared.js';
import { DEFAULT_SIGNER_PRIORITY_FEE, type SignerPriorityFeeConfig } from '../jobs/priority.js';
import { DEFAULT_MAX_LAUNCHPADS_PER_DAY, MAX_LAUNCHPADS_PER_DAY } from '../routes/budget.js';

export type EnvSource = Readonly<Record<string, string | undefined>>;

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return fallback;
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      ctx.addIssue({ code: 'custom', message: 'must be true or false' });
      return z.NEVER;
    });

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return fallback;
      if (!/^[0-9]{1,9}$/.test(v) || Number(v) < min || Number(v) > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return Number(v);
    });

/** Lamports: a non-negative integer of at most 18 digits (never through floating point). */
const lamports = (fallback: bigint) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return fallback;
      if (!/^[0-9]{1,18}$/.test(v)) {
        ctx.addIssue({ code: 'custom', message: 'must be an integer number of lamports' });
        return z.NEVER;
      }
      return BigInt(v);
    });

function isLocalHost(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

const httpsUrl = (name: string) =>
  z.string({ error: `${name} is required` }).refine(
    (v) => {
      try {
        const url = new URL(v);
        return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url));
      } catch {
        return false;
      }
    },
    { message: `${name} must be an https URL` },
  );

/** Roles whose fee balances the conversion job may swap to SOL. Never the buyback bot. */
export const CONVERT_ROLES = ['cashbox', 'payer'] as const;
export type ConvertRole = (typeof CONVERT_ROLES)[number];

const RuntimeEnvSchema = z.object({
  // Devnet unless mainnet-beta is explicitly set (PLANEXECUTE.md, environments).
  SOLANA_CLUSTER: z.preprocess(
    (v) => (v === undefined || v === '' ? 'devnet' : v),
    z.enum(['devnet', 'mainnet-beta'], { error: 'SOLANA_CLUSTER must be devnet or mainnet-beta' }),
  ),
  RPC_URL: httpsUrl('RPC_URL'),
  SUPABASE_URL: httpsUrl('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ error: 'SUPABASE_SERVICE_ROLE_KEY is required' })
    .min(20, { message: 'SUPABASE_SERVICE_ROLE_KEY is too short' }),
  SIGNER_KEYSTORE_PASSPHRASE: z
    .string({ error: 'SIGNER_KEYSTORE_PASSPHRASE is required' })
    .min(32, { message: 'SIGNER_KEYSTORE_PASSPHRASE must be at least 32 characters' }),
  SIGNER_KEYSTORE_DIR: optionalString,
  SIGNER_JOURNAL_DIR: optionalString,
  SIGNER_HOST: optionalString,
  SIGNER_COIN_METADATA_URL: z.string({ error: 'SIGNER_COIN_METADATA_URL is required' }).min(1, {
    message: 'SIGNER_COIN_METADATA_URL is required',
  }),
  // Priority fees (jobs/priority.ts): floor, cap per CU, percentile, cap per transaction.
  SIGNER_PRIORITY_FEE_MICRO_LAMPORTS: integer(
    DEFAULT_SIGNER_PRIORITY_FEE.floorMicroLamports,
    0,
    Number(MAX_COMPUTE_UNIT_PRICE),
  ),
  SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS: integer(
    DEFAULT_SIGNER_PRIORITY_FEE.maxMicroLamports,
    0,
    Number(MAX_COMPUTE_UNIT_PRICE),
  ),
  SIGNER_PRIORITY_FEE_PERCENTILE: integer(DEFAULT_SIGNER_PRIORITY_FEE.percentile, 0, 100),
  SIGNER_PRIORITY_FEE_MAX_LAMPORTS: lamports(DEFAULT_SIGNER_PRIORITY_FEE.maxLamports),
  SIGNER_ROUTES_PAUSED: bool(false),
  SIGNER_MAX_LAUNCHPADS_PER_DAY: integer(DEFAULT_MAX_LAUNCHPADS_PER_DAY, 1, MAX_LAUNCHPADS_PER_DAY),
  SIGNER_MIN_CREATION_PAYMENT_LAMPORTS: lamports(DEFAULT_MIN_PAYMENT_LAMPORTS.creation),
  SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS: lamports(DEFAULT_MIN_PAYMENT_LAMPORTS.modification),
  SIGNER_CONVERT_ROLES: optionalString,
  SIGNER_CONVERT_INTERVAL_HOURS: integer(24, 1, 24 * 30),
  SIGNER_SHUTDOWN_TIMEOUT_SECONDS: integer(120, 1, 3_600),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .optional()
    .default('info'),
});

export interface RuntimeEnv {
  cluster: 'devnet' | 'mainnet-beta';
  rpcUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  keystorePassphrase: string;
  keystoreDir: string;
  journalDir: string;
  /** Bind address of the HMAC server (default 0.0.0.0: the IP allowlist decides). */
  host: string;
  coinMetadataUrl: string;
  /** Priority fees of the signer's transactions (SIGNER_PRIORITY_FEE_*, jobs/priority.ts). */
  priorityFee: SignerPriorityFeeConfig;
  routesPaused: boolean;
  /** New launchpads the signing routes create accounts for per UTC day (default 20). */
  maxLaunchpadsPerDay: number;
  /**
   * Floors on the payment rows the signer acts on, per kind (SIGNER_MIN_*_PAYMENT_LAMPORTS):
   * the routes refuse a confirmed creation payment below its floor before any payer spend, the
   * refunds job leaves such a payment to manual handling.
   */
  minPaymentLamports: PaymentMinimums;
  convertRoles: ConvertRole[];
  convertIntervalMs: number;
  shutdownTimeoutMs: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export class RuntimeConfigError extends Error {
  override readonly name = 'RuntimeConfigError';
  /** One line per problem, variable names only. */
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`signer configuration error: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

function parseConvertRoles(value: string | undefined): ConvertRole[] {
  const entries = (value ?? 'cashbox')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: ConvertRole[] = [];
  for (const entry of entries) {
    if (!(CONVERT_ROLES as readonly string[]).includes(entry)) {
      throw new RuntimeConfigError([
        'SIGNER_CONVERT_ROLES may only list cashbox and payer (never the buyback wallet)',
      ]);
    }
    if (!out.includes(entry as ConvertRole)) out.push(entry as ConvertRole);
  }
  return out;
}

/** The Telegram variables the operator alerts depend on (alerts.ts). */
export const ALERTING_VARIABLES = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;

/**
 * Secrets the process only needs while it builds its configuration: the keystore passphrase
 * (held by the keystore, zeroed on close) and the Supabase service role key (held by the
 * PostgREST client). Once parsed they are removed from the environment, so a core dump, a child
 * process or a `/proc/<pid>/environ` read no longer finds them. (Pair it with `LimitCORE=0` in
 * the service unit: no core dump at all.)
 */
export const PARSED_SECRET_VARIABLES = [
  'SIGNER_KEYSTORE_PASSPHRASE',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

/**
 * Secrets consumed later in the startup by the component that keeps them: the HMAC server
 * (SIGNER_HMAC_SECRET), the Telegram alerter (TELEGRAM_BOT_TOKEN) and the Jupiter clients of the
 * buyback and conversion jobs (JUPITER_API_KEY). Dropped once those are built
 * (`dropConsumedSecrets`): nothing reads them from the environment afterwards.
 */
export const CONSUMED_SECRET_VARIABLES = [
  'SIGNER_HMAC_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'JUPITER_API_KEY',
] as const;

function dropVariables(
  names: readonly string[],
  envs: ReadonlyArray<EnvSource | undefined>,
): void {
  for (const env of envs) {
    if (!env) continue;
    for (const name of names) delete (env as Record<string, unknown>)[name];
  }
}

/** Deletes `PARSED_SECRET_VARIABLES` from every given environment object (process.env included). */
export function dropParsedSecrets(...envs: ReadonlyArray<EnvSource | undefined>): void {
  dropVariables(PARSED_SECRET_VARIABLES, envs);
}

/** Deletes `CONSUMED_SECRET_VARIABLES` from every given environment object (process.env included). */
export function dropConsumedSecrets(...envs: ReadonlyArray<EnvSource | undefined>): void {
  dropVariables(CONSUMED_SECRET_VARIABLES, envs);
}

/**
 * True when alerts MUST reach the operator: on mainnet-beta, and whenever NODE_ENV is not
 * `development` or `test` (same fail-closed rule as the HMAC server's IP allowlist).
 */
export function alertingRequired(env: EnvSource): boolean {
  return env.SOLANA_CLUSTER === 'mainnet-beta' || isProductionEnv(env.NODE_ENV);
}

/** Problems (variable names only) when alerting is required but not configured. */
function alertingProblems(env: EnvSource): string[] {
  if (!alertingRequired(env)) return [];
  return ALERTING_VARIABLES.filter((name) => (env[name] ?? '').trim() === '').map(
    (name) =>
      `${name} is required on mainnet-beta and in production (alerts would only be logged without it)`,
  );
}

/** Parses the process-level variables. Throws RuntimeConfigError listing every problem. */
export function parseRuntimeEnv(env: EnvSource): RuntimeEnv {
  const parsed = RuntimeEnvSchema.safeParse(env);
  // Messages are ours (variable names, rules); zod never echoes the values here.
  const problems: string[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => {
        const name = issue.path.map(String).join('.') || 'environment';
        return issue.message.includes(name) ? issue.message : `${name} ${issue.message}`;
      });
  problems.push(...alertingProblems(env));
  if (parsed.success) {
    const p = parsed.data;
    if (p.SIGNER_PRIORITY_FEE_MICRO_LAMPORTS > p.SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS) {
      problems.push(
        'SIGNER_PRIORITY_FEE_MICRO_LAMPORTS (the floor) must not be above SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS',
      );
    }
    if (p.SIGNER_PRIORITY_FEE_MAX_LAMPORTS > MAX_SIGNER_PRIORITY_FEE_LAMPORTS) {
      problems.push(
        `SIGNER_PRIORITY_FEE_MAX_LAMPORTS must be at most ${MAX_SIGNER_PRIORITY_FEE_LAMPORTS} lamports`,
      );
    }
  }
  if (!parsed.success || problems.length > 0) {
    throw new RuntimeConfigError([...new Set(problems)]);
  }
  const p = parsed.data;
  return {
    cluster: p.SOLANA_CLUSTER,
    rpcUrl: p.RPC_URL,
    supabaseUrl: p.SUPABASE_URL,
    supabaseServiceRoleKey: p.SUPABASE_SERVICE_ROLE_KEY,
    keystorePassphrase: p.SIGNER_KEYSTORE_PASSPHRASE,
    keystoreDir: path.resolve(p.SIGNER_KEYSTORE_DIR ?? DEFAULT_KEYSTORE_DIR),
    journalDir: path.resolve(p.SIGNER_JOURNAL_DIR ?? DEFAULT_JOURNAL_DIR),
    host: p.SIGNER_HOST ?? '0.0.0.0',
    coinMetadataUrl: p.SIGNER_COIN_METADATA_URL,
    priorityFee: {
      floorMicroLamports: p.SIGNER_PRIORITY_FEE_MICRO_LAMPORTS,
      maxMicroLamports: p.SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS,
      percentile: p.SIGNER_PRIORITY_FEE_PERCENTILE,
      maxLamports: p.SIGNER_PRIORITY_FEE_MAX_LAMPORTS,
    },
    routesPaused: p.SIGNER_ROUTES_PAUSED,
    maxLaunchpadsPerDay: p.SIGNER_MAX_LAUNCHPADS_PER_DAY,
    minPaymentLamports: {
      creation: p.SIGNER_MIN_CREATION_PAYMENT_LAMPORTS,
      modification: p.SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS,
    },
    convertRoles: parseConvertRoles(p.SIGNER_CONVERT_ROLES),
    convertIntervalMs: p.SIGNER_CONVERT_INTERVAL_HOURS * 60 * 60_000,
    shutdownTimeoutMs: p.SIGNER_SHUTDOWN_TIMEOUT_SECONDS * 1_000,
    logLevel: p.LOG_LEVEL,
  };
}
