import { describe, expect, it } from 'vitest';
import { SandboxError } from './errors.js';
import {
  assertNoHostSecrets,
  assertSafeEnv,
  assertSafeSecrets,
  collectHostSecrets,
} from './policy.js';

const GATEWAY_TOKEN = `forge_gw_${'A'.repeat(43)}`;
const PACKAGES_TOKEN = `ghp_${'b'.repeat(36)}`;

function expectUnsafe(fn: () => unknown, message?: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe('unsafe_option');
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected an unsafe_option SandboxError');
}

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJlLXNpZw`;
}

describe('assertSafeEnv', () => {
  it('accepts plain configuration variables', () => {
    expect(() =>
      assertSafeEnv({ CI: 'true', NODE_OPTIONS: '--max-old-space-size=3072' }),
    ).not.toThrow();
  });

  it('refuses credential-looking, reserved and malformed names', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GITHUB_APP_PRIVATE_KEY',
      'VERCEL_TOKEN',
      'NODE_AUTH_TOKEN',
      'MY_SECRET',
      'DB_PASSWORD',
      'HOME',
      'PATH',
      'HTTPS_PROXY',
      'NO_PROXY',
      'ANTHROPIC_BASE_URL',
      'DOCKER_HOST',
      'NPM_CONFIG_REGISTRY',
      'PNPM_HOME',
      'LD_PRELOAD',
      'lower_case',
      '1ABC',
      'A-B',
    ]) {
      expectUnsafe(() => assertSafeEnv({ [name]: 'x' }));
    }
    expectUnsafe(() => assertSafeEnv({ OK: 'a\u0000b' }));
    expectUnsafe(() => assertSafeEnv({ OK: 'x'.repeat(40_000) }));
  });
});

describe('assertSafeSecrets', () => {
  it('accepts the two designated secrets with their presets', () => {
    expect(() =>
      assertSafeSecrets({ gatewayToken: GATEWAY_TOKEN }, 'allowlist', ['gateway']),
    ).not.toThrow();
    expect(() =>
      assertSafeSecrets({ packagesToken: PACKAGES_TOKEN }, 'allowlist', ['npm', 'github-packages']),
    ).not.toThrow();
    expect(() =>
      assertSafeSecrets({ packagesToken: `github_pat_${'c'.repeat(82)}` }, 'allowlist', [
        'github-packages',
      ]),
    ).not.toThrow();
  });

  it('refuses secrets of the wrong kind or without their network', () => {
    expectUnsafe(() =>
      assertSafeSecrets({ gatewayToken: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxx' }, 'allowlist', [
        'gateway',
      ]),
    );
    expectUnsafe(() => assertSafeSecrets({ gatewayToken: GATEWAY_TOKEN }, 'none', []));
    expectUnsafe(() => assertSafeSecrets({ gatewayToken: GATEWAY_TOKEN }, 'allowlist', ['npm']));
    expectUnsafe(() =>
      assertSafeSecrets({ packagesToken: `ghs_${'d'.repeat(36)}` }, 'allowlist', [
        'github-packages',
      ]),
    );
    expectUnsafe(() =>
      assertSafeSecrets({ packagesToken: 'vercel-token-123456789012' }, 'allowlist', [
        'github-packages',
      ]),
    );
    expectUnsafe(() => assertSafeSecrets({ packagesToken: PACKAGES_TOKEN }, 'allowlist', ['npm']));
  });
});

describe('assertNoHostSecrets', () => {
  const hostEnv = {
    ANTHROPIC_API_KEY: 'sk-ant-api03-REALKEY-0123456789',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-value-abcdefgh',
    VERCEL_TOKEN: 'vercelTokenValue1234567',
    GITHUB_APP_PRIVATE_KEY:
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    FORGE_PACKAGES_TOKEN: PACKAGES_TOKEN,
    SOME_OTHER_SECRET: 'other-secret-value-1',
    PATH: '/usr/bin',
    SHORT_KEY: 'abc',
  };
  const hostSecrets = collectHostSecrets(hostEnv);

  it('collects host secrets by name', () => {
    expect(hostSecrets.never).toContain(hostEnv.ANTHROPIC_API_KEY);
    expect(hostSecrets.never).toContain(hostEnv.VERCEL_TOKEN);
    expect(hostSecrets.sensitive).toContain(hostEnv.SOME_OTHER_SECRET);
    expect(hostSecrets.sensitive).toContain(PACKAGES_TOKEN);
    expect([...hostSecrets.never, ...hostSecrets.sensitive]).not.toContain('/usr/bin');
    expect([...hostSecrets.never, ...hostSecrets.sensitive]).not.toContain('abc');
  });

  const base = { env: {}, command: ['pnpm', 'build'], secrets: {}, hostSecrets };

  it('lets the designated packages token through even if it lives in the host env', () => {
    expect(() =>
      assertNoHostSecrets({ ...base, secrets: { packagesToken: PACKAGES_TOKEN } }),
    ).not.toThrow();
  });

  it('refuses host secret values anywhere', () => {
    expectUnsafe(
      () => assertNoHostSecrets({ ...base, env: { X: `a${hostEnv.VERCEL_TOKEN}b` } }),
      /env X/,
    );
    expectUnsafe(
      () => assertNoHostSecrets({ ...base, command: ['echo', hostEnv.SUPABASE_SERVICE_ROLE_KEY] }),
      /command\[1\]/,
    );
    expectUnsafe(() =>
      assertNoHostSecrets({ ...base, command: ['echo', hostEnv.SOME_OTHER_SECRET] }),
    );
    // A NEVER_IN_SANDBOX value cannot be smuggled in as a designated secret.
    const sneaky = collectHostSecrets({ VERCEL_TOKEN: PACKAGES_TOKEN });
    expectUnsafe(() =>
      assertNoHostSecrets({
        ...base,
        hostSecrets: sneaky,
        secrets: { packagesToken: PACKAGES_TOKEN },
      }),
    );
  });

  it('refuses well-known secret formats even when unknown to the host env', () => {
    const empty = collectHostSecrets({});
    for (const value of [
      'sk-ant-api03-abcdefghijklmnop',
      '-----BEGIN PRIVATE KEY-----',
      'sb_secret_abcdefghijkl',
      `ghs_${'e'.repeat(36)}`,
      `gho_${'e'.repeat(36)}`,
      jwt({ role: 'service_role', iss: 'supabase' }),
    ]) {
      expectUnsafe(() =>
        assertNoHostSecrets({ ...base, hostSecrets: empty, command: ['x', value] }),
      );
    }
    // An anon JWT is not a secret.
    expect(() =>
      assertNoHostSecrets({ ...base, hostSecrets: empty, command: ['x', jwt({ role: 'anon' })] }),
    ).not.toThrow();
  });
});
