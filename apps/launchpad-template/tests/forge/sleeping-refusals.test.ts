import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A sleeping site with everything configured: the upload route must still refuse.
vi.mock('@/forge/config', async () => {
  const { FIXTURE_LAUNCHPAD_CONFIG } = await import('@/forge/create/test-fixtures');
  const onchain = {
    cluster: 'devnet',
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(),
    poolCreationFeeSol: 0.01,
  };
  return {
    siteConfig: {
      name: 'Sleepy Pad',
      slug: 'sleepy-pad',
      mode: 'sleeping',
      theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
      content: { tagline: '', about: '' },
    },
    onchainConfig: onchain,
    forgeConfig: { onchain },
    poolCreationFeeSol: 0.01,
    cluster: 'devnet',
    rpcRelayEndpoint: 'https://forge.example/api/rpc',
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fakeRequest() {
  return Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    headers: { host: 'sleepy.example', 'content-type': 'application/json' },
    socket: { remoteAddress: '10.0.0.1' },
  });
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader() {},
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

describe('sleeping site: the upload route stays refused', () => {
  it('answers 503 without touching the relay or the FORGE API, even fully configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_RPC_RELAY_URL', 'https://forge.example');
    vi.stubEnv('NEXT_PUBLIC_FORGE_API_URL', 'https://forge.example');
    vi.stubEnv('FORGE_RPC_RELAY_TOKEN', 'v1.sleepy-pad.token');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { default: upload } = await import('../../src/pages/api/upload');
    const res = fakeResponse();
    await upload(fakeRequest() as never, res as never);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'This site is not available.' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// Everything the sleeping page can load, followed through its imports inside src/.
const root = fileURLToPath(new URL('../../', import.meta.url));
const src = join(root, 'src');

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(src, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (candidate.startsWith(src) && existsSync(candidate) && /\.tsx?$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [join(src, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1] as string,
    );
    for (const spec of specs) {
      const next = resolveImport(file, spec);
      if (next) stack.push(next);
    }
  }
  return [...seen].map((file) => relative(src, file).replace(/\\/g, '/')).sort();
}

describe('sleeping page: the claim is the only action it can load', () => {
  const files = reachable('forge/modes/SleepingPage.tsx');
  // (`create/flow` and `create/api` are reached: the claim shares the launch's sign-send-confirm
  // sequence. Nothing there runs unless coin creation is used, and `/api/upload` answers 503.)

  it('reaches the claim widget and the wallet provider', () => {
    expect(files).toContain('forge/modes/SleepingClaim.tsx');
    expect(files).toContain('forge/ClaimCreatorFees.tsx');
    expect(files).toContain('forge/AppProviders.tsx');
  });

  it('never reaches the trade panel, coin creation, indexer data or a free zone', () => {
    const forbidden = [
      /^forge\/(TradePanel|CoinTradePanel|JupiterTrade|BuyButton|CreateCoin)\.tsx$/,
      /^forge\/(data|chart|token-icon)\//,
      /^forge\/create\/(upload-client|prepare-handler|launch-builder|image)\.ts$/,
      /^forge\/trade\/(useQuote|useTradeExecution|TradeForm|send|core-adapter)\b/,
      /^pages\//,
      /^(components|contexts|hooks|content|theme|lib)\//,
    ];
    for (const file of files) {
      for (const rule of forbidden) expect(file, `sleeping page reaches ${file}`).not.toMatch(rule);
    }
  });
});
