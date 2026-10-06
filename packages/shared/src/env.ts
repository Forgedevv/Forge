/*
 * Environment variable names per app (docs/INTERFACES.md §8). Names only, never values.
 * `R2_*` is expanded to the variables of the fun-launch scaffold (docs/METEORA.md).
 */

export const R2_ENV = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET'] as const;

/** Variables that may be absent. FORGE_MINT is absent before the $FORGE launch. */
export const OPTIONAL_ENV = ['FORGE_MINT'] as const;

/**
 * apps/web. RPC_URL and SUPABASE_SERVICE_ROLE_KEY are server-only.
 * FORGE_GATING_AMOUNT is required only when FORGE_MINT is set.
 */
export const WEB_ENV = [
  'SOLANA_CLUSTER',
  'RPC_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'FORGE_MINT',
  'FORGE_GATING_AMOUNT',
  'FORGE_CASHBOX_WALLET',
  'JUPITER_API_KEY',
  ...R2_ENV,
] as const;

/** apps/launchpad-template. RPC_URL is server-only; FORGE_* addresses are read through @forge/core. */
export const TEMPLATE_ENV = [
  'SOLANA_CLUSTER',
  'RPC_URL',
  'FORGE_MULTISIG_VAULT',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'JUPITER_API_KEY',
  ...R2_ENV,
] as const;

/** Variables the builder does not use itself but copies into each client Vercel project. */
export const BUILDER_VERCEL_INJECTED_ENV = [
  'FORGE_MULTISIG_VAULT',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'JUPITER_API_KEY',
  ...R2_ENV,
] as const;

/** apps/builder. ANTHROPIC_API_KEY is used by the gateway only. */
export const BUILDER_ENV = [
  'SOLANA_CLUSTER',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  ...BUILDER_VERCEL_INJECTED_ENV,
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_ORG',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'SIGNER_URL',
  'SIGNER_HMAC_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
] as const;

/** apps/signer. FORGE_MINT is used for the buyback (simulation mode when absent). */
export const SIGNER_ENV = [
  'SOLANA_CLUSTER',
  'RPC_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'FORGE_MINT',
  'FORGE_CASHBOX_WALLET',
  'FORGE_MULTISIG_VAULT',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'JUPITER_API_KEY',
  'SIGNER_URL',
  'SIGNER_HMAC_SECRET',
  'SIGNER_KEYSTORE_PASSPHRASE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
] as const;

export type WebEnvName = (typeof WEB_ENV)[number];
export type TemplateEnvName = (typeof TEMPLATE_ENV)[number];
export type BuilderEnvName = (typeof BUILDER_ENV)[number];
export type SignerEnvName = (typeof SIGNER_ENV)[number];
export type EnvName = WebEnvName | TemplateEnvName | BuilderEnvName | SignerEnvName;
