/**
 * What may enter a sandbox container. Only two secrets ever do: the job's short-lived
 * AI gateway token and a read-only packages token. The Anthropic key, the Supabase
 * service key, the GitHub App key, the Vercel token and every other host secret are
 * refused, by name and by value.
 */
import { SandboxError } from './errors.js';

/** Env var names the sandbox receives its two secrets under. */
export const SECRET_ENV = {
  gatewayToken: 'ANTHROPIC_AUTH_TOKEN',
  packagesToken: 'NODE_AUTH_TOKEN',
} as const;

/** Host variables that must never reach a container, whatever their value looks like. */
export const NEVER_IN_SANDBOX = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'VERCEL_TOKEN',
  'SIGNER_HMAC_SECRET',
  'SIGNER_KEYSTORE_PASSPHRASE',
  'TELEGRAM_BOT_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'JUPITER_API_KEY',
  'SESSION_SECRET',
  'RPC_URL',
] as const;

/** A name that looks like a credential. Such values only enter through `secrets`. */
export const SENSITIVE_NAME_RE =
  /KEY|SECRET|TOKEN|PRIVATE|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION|MNEMONIC|SEED/i;

/** Names set by the runner itself, or that would change the docker CLI's behaviour. */
const RESERVED_NAMES = new Set([
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'PWD',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HOSTNAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
  'NODE_USE_ENV_PROXY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);
const RESERVED_PREFIXES = ['DOCKER_', 'BUILDKIT_', 'COMPOSE_', 'NPM_CONFIG_', 'PNPM_', 'COREPACK_'];

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_ENV_VALUE = 32 * 1024;
const MAX_ENV_COUNT = 64;

/** Format of the tokens issued by apps/builder/src/gateway (`forge_gw_` + base64url). */
const GATEWAY_TOKEN_RE = /^forge_gw_[A-Za-z0-9_-]{20,200}$/;
/**
 * GitHub Packages needs a personal access token with `read:packages` only. GitHub App
 * installation tokens (`ghs_`), OAuth and user-to-server tokens are refused.
 */
const PACKAGES_TOKEN_RE = /^(?:ghp_[A-Za-z0-9]{30,60}|github_pat_[A-Za-z0-9_]{40,120})$/;

/** Secret formats that must never appear in a value given to a container. */
const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, 'an Anthropic API key'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsb_secret_[A-Za-z0-9_-]{8,}/, 'a Supabase secret key'],
  [/\bghs_[A-Za-z0-9]{20,}/, 'a GitHub App installation token'],
  [/\bgh[our]_[A-Za-z0-9]{20,}/, 'a GitHub OAuth/user token'],
];

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.([A-Za-z0-9_-]{5,})\.[A-Za-z0-9_-]{5,}/g;

/** True if `value` contains a JWT whose payload grants the Supabase service role. */
function containsServiceRoleJwt(value: string): boolean {
  for (const match of value.matchAll(JWT_RE)) {
    try {
      const payload = Buffer.from(match[1]!, 'base64url').toString('utf8');
      if (/"role"\s*:\s*"service_role"/.test(payload)) return true;
    } catch {
      // not a JWT
    }
  }
  return false;
}

export interface SandboxSecrets {
  gatewayToken?: string | undefined;
  packagesToken?: string | undefined;
}

/** Validates the non-secret environment of a run. */
export function assertSafeEnv(env: Record<string, string>): void {
  const names = Object.keys(env);
  if (names.length > MAX_ENV_COUNT) {
    throw new SandboxError('unsafe_option', `too many env variables (max ${MAX_ENV_COUNT})`);
  }
  for (const name of names) {
    if (!ENV_NAME_RE.test(name)) {
      throw new SandboxError('unsafe_option', `env name "${name.slice(0, 64)}" is not allowed`);
    }
    if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
      throw new SandboxError('unsafe_option', `env name "${name}" is reserved by the sandbox`);
    }
    if (SENSITIVE_NAME_RE.test(name)) {
      throw new SandboxError(
        'unsafe_option',
        `env name "${name}" looks like a credential: secrets only enter through \`secrets\``,
      );
    }
    const value = env[name]!;
    if (value.length > MAX_ENV_VALUE || value.includes('\u0000')) {
      throw new SandboxError('unsafe_option', `env value of "${name}" is too long or invalid`);
    }
  }
}

/** Validates the two secrets and checks they match the network they need. */
export function assertSafeSecrets(
  secrets: SandboxSecrets,
  network: 'none' | 'allowlist',
  allow: readonly string[],
): void {
  if (secrets.gatewayToken !== undefined) {
    if (!GATEWAY_TOKEN_RE.test(secrets.gatewayToken)) {
      throw new SandboxError('unsafe_option', 'gatewayToken is not an AI gateway token');
    }
    if (network !== 'allowlist' || !allow.includes('gateway')) {
      throw new SandboxError('unsafe_option', 'gatewayToken requires the "gateway" egress preset');
    }
  }
  if (secrets.packagesToken !== undefined) {
    if (!PACKAGES_TOKEN_RE.test(secrets.packagesToken)) {
      throw new SandboxError(
        'unsafe_option',
        'packagesToken must be a read-only packages personal access token',
      );
    }
    if (network !== 'allowlist' || !allow.includes('github-packages')) {
      throw new SandboxError(
        'unsafe_option',
        'packagesToken requires the "github-packages" egress preset',
      );
    }
  }
}

/** Values of host variables that look like credentials (min 8 chars). */
export function collectHostSecrets(
  hostEnv: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): { never: string[]; sensitive: string[] } {
  const never: string[] = [];
  const sensitive: string[] = [];
  const neverNames = new Set<string>(NEVER_IN_SANDBOX);
  for (const [name, value] of Object.entries(hostEnv)) {
    if (typeof value !== 'string' || value.length < 8) continue;
    const upper = name.toUpperCase();
    if (neverNames.has(upper)) never.push(value);
    else if (SENSITIVE_NAME_RE.test(upper)) sensitive.push(value);
  }
  for (const value of extra) if (value.length >= 8) never.push(value);
  return { never, sensitive };
}

/**
 * Refuses a run if any value given to the container (env values, command arguments,
 * secrets) carries a host secret or a known secret format.
 */
export function assertNoHostSecrets(input: {
  env: Record<string, string>;
  command: readonly string[];
  secrets: SandboxSecrets;
  hostSecrets: { never: readonly string[]; sensitive: readonly string[] };
}): void {
  const provided = [input.secrets.gatewayToken, input.secrets.packagesToken].filter(
    (v): v is string => typeof v === 'string',
  );
  const values: Array<[string, string]> = [
    ...Object.entries(input.env).map(([k, v]): [string, string] => [`env ${k}`, v]),
    ...input.command.map((v, i): [string, string] => [`command[${i}]`, v]),
    ...provided.map((v, i): [string, string] => [`secret #${i + 1}`, v]),
  ];
  // A designated secret may also live in the host env under a sensitive name (e.g. the
  // packages token): that alone is fine. The NEVER_IN_SANDBOX values are never exempt.
  const sensitive = input.hostSecrets.sensitive.filter((s) => !provided.includes(s));
  for (const [where, value] of values) {
    for (const secret of input.hostSecrets.never) {
      if (value.includes(secret)) {
        throw new SandboxError('unsafe_option', `${where} contains a host secret`);
      }
    }
    for (const secret of sensitive) {
      if (value.includes(secret)) {
        throw new SandboxError('unsafe_option', `${where} contains a host secret`);
      }
    }
    for (const [pattern, label] of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        throw new SandboxError('unsafe_option', `${where} contains ${label}`);
      }
    }
    if (containsServiceRoleJwt(value)) {
      throw new SandboxError('unsafe_option', `${where} contains a Supabase service role key`);
    }
  }
}
