/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { analyzeCode } from './code.js';
import { resolveConfig } from './config.js';
import { FORGE_PUBLIC_API, forgeModuleId, importTarget, resolveLocalImport } from './forge-api.js';
import { added, modified, renamed, rulesOf, scan } from './test-helpers.js';
import type { Violation } from './types.js';

/**
 * Regression (audit, reproduced with scanDiff returning ok: true): relative and `@/` imports were
 * never checked, so free-zone code could import FORGE's internal modules, e.g. replace the swap
 * core with one whose platform fee wallet comes from an `env` override, read the server relay
 * token from a page and publish it through getStaticProps, or render the trade panel with a raw
 * pool address. Free-zone files may now only use the public FORGE surface (FORGE_PUBLIC_API).
 */

const COMPONENT = 'src/components/Promo.tsx';
const PAGE = 'src/pages/promo.tsx';

function violationsOf(source: string, path = COMPONENT): Violation[] {
  const result = scan([added(path, source)]);
  return result.ok ? [] : result.violations;
}

const importFindings = (source: string, path = COMPONENT): Violation[] =>
  violationsOf(source, path).filter((v) => v.rule === 'forbidden-import');

describe('audit probes: internal FORGE modules imported from a free zone', () => {
  it('refuses the swap core override (setSwapCore + createCoreSwapCore with an env override)', () => {
    const src = [
      `import { createCoreSwapCore, setSwapCore } from '@/forge/trade/core-adapter';`,
      `setSwapCore(createCoreSwapCore({ env: { platformFeeWallet: process.env.NEXT_PUBLIC_OWNER } }));`,
      `export function Promo() {`,
      `  return <main>Promo</main>;`,
      `}`,
    ].join('\n');
    const found = importFindings(src);
    const reasons = found.map((v) => v.reason).join(' | ');
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(reasons).toMatch(/src\/forge\/trade\/core-adapter/);
    expect(found.every((v) => v.line === 1)).toBe(true);
  });

  it('refuses the relay token published through getStaticProps', () => {
    const src = [
      `import { readServerRelayToken } from '@/forge/server-relay';`,
      `export async function getStaticProps() {`,
      `  return { props: { token: readServerRelayToken() } };`,
      `}`,
      `export default function Promo({ token }: { token: string }) {`,
      `  return <main data-t={token}>Promo</main>;`,
      `}`,
    ].join('\n');
    const rules = violationsOf(src, PAGE).map((v) => v.rule);
    expect(rules).toContain('forbidden-import');
    expect(rules).toContain('server-response');
  });

  it('refuses the trade panel and the buy button with a raw pool address', () => {
    for (const [module, name] of [
      ['@/forge/TradePanel', 'TradePanel'],
      ['@/forge/BuyButton', 'BuyButton'],
    ] as const) {
      const src = [
        `import { ${name} } from '${module}';`,
        `export function Promo({ mint, pool }: { mint: string; pool: string }) {`,
        `  return <${name} mint={mint} pool={pool} />;`,
        `}`,
      ].join('\n');
      expect(importFindings(src).length, name).toBeGreaterThan(0);
    }
  });

  const refused: Record<string, string> = {
    'relative path to the swap core': `import { setSwapCore } from '../forge/trade/core-adapter'; setSwapCore(null as any);`,
    'relative path from a nested folder': `import { setSwapCore } from '../../../forge/trade/core-adapter'; setSwapCore(null as any);`,
    'alias through a free-zone folder': `import { setSwapCore } from '@/components/../forge/trade/core-adapter'; setSwapCore(null as any);`,
    'alias with empty and dot segments': `import { setSwapCore } from '@/forge//trade/./core-adapter'; setSwapCore(null as any);`,
    'alias with an extension': `import { setSwapCore } from '@/forge/trade/core-adapter.ts'; setSwapCore(null as any);`,
    'alias in another case': `import { setSwapCore } from '@/Forge/Trade/core-adapter'; setSwapCore(null as any);`,
    'alias with a resource query': `import { setSwapCore } from '@/forge/trade/core-adapter?x=1'; setSwapCore(null as any);`,
    'alias through a public folder': `import { setSwapCore } from '@/forge/token-icon/../trade/core-adapter'; setSwapCore(null as any);`,
    'default import': `import core from '@/forge/trade/core-adapter'; export const c = core;`,
    'default import named as an export': `import { default as core } from '@/forge/trade/core-adapter'; export const c = core;`,
    'namespace import': `import * as core from '@/forge/trade/core-adapter'; core.setSwapCore(null as any);`,
    're-export by name': `export { setSwapCore } from '@/forge/trade/core-adapter';`,
    're-export renamed': `export { setSwapCore as configure } from '@/forge/trade/core-adapter';`,
    're-export of a string name': `export { 'setSwapCore' as configure } from '@/forge/trade/core-adapter';`,
    'export star': `export * from '@/forge/trade/core-adapter';`,
    'export star of a public module': `export * from '@/forge/config';`,
    'export star as a namespace': `export * as core from '@/forge/trade/core-adapter';`,
    'dynamic import': `export const load = () => import('@/forge/trade/core-adapter').then((m) => m.setSwapCore(null as any));`,
    'dynamic import of a public module': `export const load = () => import('@/forge/config');`,
    'dynamic import with a folded specifier': `const base = '@/forge/'; export const load = () => import(base + 'server-relay');`,
    'dynamic import picking an internal export': `import dynamic from 'next/dynamic'; const Form = dynamic(() => import('@/forge/trade/TradeForm').then((m) => m.TradeForm)); export const P = () => <Form />;`,
    'dynamic import of the trade panel': `import dynamic from 'next/dynamic'; const Panel = dynamic(() => import('@/forge/TradePanel')); export const P = () => <Panel mint="m" pool="p" />;`,
    require: `const relay = require('@/forge/server-relay'); export const t = relay.readServerRelayToken();`,
    'import equals require': `import relay = require('@/forge/server-relay'); export const t = relay;`,
    'side-effect import of a mock': `import '@/forge/trade/core-adapter.mock';`,
    'mock module': `import { createMockSwapCore } from '@/forge/trade/core-adapter.mock'; export const m = createMockSwapCore;`,
    'inline type names only (the statement may still load the module)': `import { type SwapCore } from '@/forge/trade/core-adapter'; export type S = SwapCore;`,
    'server relay token': `import { readServerRelayToken } from '@/forge/server-relay'; export const t = readServerRelayToken;`,
    'unfiltered data client': `import { ApeClient } from '@/forge/data/client'; export const list = () => ApeClient.getGemsTokenList({});`,
    'on-chain config block': `import { onchainConfig } from '@/forge/config'; export const c = onchainConfig;`,
    'whole forge config': `import { forgeConfig } from '@/forge/config'; export const c = forgeConfig;`,
    'relay endpoint': `import { rpcRelayEndpoint } from '@/forge/config'; export const c = rpcRelayEndpoint;`,
    'trade form': `import { TradeForm } from '@/forge/trade/TradeForm'; export const F = TradeForm;`,
    'trade execution hook': `import { useTradeExecution } from '@/forge/trade/useTradeExecution'; export const u = useTradeExecution;`,
    'pool derivation': `import { launchpadPoolForMint } from '@/forge/trade/pool-address'; export const p = launchpadPoolForMint;`,
    'creation internals': `import { createHttpLaunchApi } from '@/forge/create/api'; export const a = createHttpLaunchApi;`,
    'creation server handler': `import { createPrepareHandler } from '@/forge/create/prepare-handler'; export const h = createPrepareHandler;`,
    'claims core': `import { claimsCore } from '@/forge/claims/core-adapter'; export const c = claimsCore;`,
    'app providers': `import { AppProviders } from '@/forge/AppProviders'; export const A = AppProviders;`,
    'the forge folder itself': `import * as forge from '@/forge'; export const f = forge;`,
    'loader syntax': `import token from '!!raw-loader!@/forge/server-relay'; export const t = token;`,
    'backslash path': `import { setSwapCore } from '@/forge\\\\trade\\\\core-adapter'; setSwapCore(null as any);`,
    'unknown alias': `import { siteConfig } from '~/forge/config'; export const s = siteConfig;`,
    'the site config file by path': `import config from '../../forge.config.json'; export const c = config.onchain;`,
    'a package by path': `import { Keypair } from '../../node_modules/@solana/web3.js'; export const k = Keypair;`,
    'a path that leaves the site': `import x from '../../../../outside'; export const y = x;`,
    'an API route module': `import handler from '@/pages/api/upload'; export const h = handler;`,
    'a webpack context of the forge folder': `const ctx = (import.meta as any).webpackContext('../forge', { recursive: true }); export const k = ctx.keys();`,
    'a require context of the forge folder': `const ctx = (require as any).context('../forge', true); export const k = ctx.keys();`,
  };
  for (const [name, src] of Object.entries(refused)) {
    it(`refuses: ${name}`, () => {
      expect(importFindings(src).length, src).toBeGreaterThan(0);
    });
  }

  it('refuses the same probes in pages, content and theme files', () => {
    const src = `import { setSwapCore } from '@/forge/trade/core-adapter'; setSwapCore(null as any);`;
    for (const path of ['src/pages/index.tsx', 'src/content/index.ts', 'src/theme/index.ts']) {
      expect(importFindings(src, path).length, path).toBeGreaterThan(0);
    }
    // `../forge/...` from src/pages/ is the same module.
    expect(
      importFindings(
        `import { setSwapCore } from '../forge/trade/core-adapter'; setSwapCore(null as any);`,
        'src/pages/index.tsx',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a free-zone file re-exporting an internal module to another one', () => {
    const result = scan([
      added('src/components/core.ts', `export * from '../forge/trade/core-adapter';\n`),
      added(
        'src/components/Promo.tsx',
        `import { setSwapCore } from './core';\nsetSwapCore(null as any);\nexport const Promo = () => null;\n`,
      ),
    ]);
    expect(rulesOf(result)).toContain('forbidden-import');
    expect(result.ok ? [] : result.violations.map((v) => v.file)).toContain(
      'src/components/core.ts',
    );
  });
});

describe('public FORGE components: JSX only, listed props only', () => {
  const refused: Record<string, string> = {
    'a raw pool on the coin trade panel': `import { CoinTradePanel } from '@/forge/CoinTradePanel'; export const P = ({ m }: { m: string }) => <CoinTradePanel mint={m} pool="x" />;`,
    'spread props on the coin trade panel': `import { CoinTradePanel } from '@/forge/CoinTradePanel'; export const P = (p: any) => <CoinTradePanel {...p} />;`,
    'a test override on the creation form': `import CreateCoin from '@/forge/CreateCoin'; export const P = () => <CreateCoin launchpadConfig="x" />;`,
    'a fake api on the creation form': `import { CreateCoin } from '@/forge/CreateCoin'; const api = { prepare: async () => ({}) }; export const P = () => <CreateCoin api={api as any} />;`,
    'a mode override on the claim list': `import { ClaimCreatorFees } from '@/forge/ClaimCreatorFees'; export const P = () => <ClaimCreatorFees mode="live" />;`,
    'children on the creation form': `import CreateCoin from '@/forge/CreateCoin'; export const P = () => <CreateCoin><span>x</span></CreateCoin>;`,
    'an image src on the token icon': `import { TrenchesTokenIconImage } from '@/forge/token-icon'; export const P = ({ u }: { u: string }) => <TrenchesTokenIconImage src={u} />;`,
    'a token on the pool icon': `import { TrenchesPoolTokenIcon } from '@/forge/token-icon/TokenIcon'; export const P = ({ p, t }: any) => <TrenchesPoolTokenIcon pool={p} token={t} />;`,
    'an alias of a component': `import CreateCoin from '@/forge/CreateCoin'; const Form = CreateCoin; export const P = () => <Form launchpadConfig="x" />;`,
    'createElement of a component': `import { createElement } from 'react'; import CreateCoin from '@/forge/CreateCoin'; export const P = () => createElement(CreateCoin, { launchpadConfig: 'x' });`,
    'a component called as a function': `import CreateCoin from '@/forge/CreateCoin'; export const P = () => CreateCoin({ launchpadConfig: 'x' });`,
    'a component wrapped': `import { memo } from 'react'; import { CoinTradePanel } from '@/forge/CoinTradePanel'; export const P = memo(CoinTradePanel);`,
    'a component passed in an object': `import { CoinTradePanel } from '@/forge/CoinTradePanel'; export const parts = { CoinTradePanel };`,
    'a component re-exported locally': `import { CoinTradePanel } from '@/forge/CoinTradePanel'; export { CoinTradePanel };`,
    'a component as the default export': `import { CoinTradePanel } from '@/forge/CoinTradePanel'; export default CoinTradePanel;`,
    'a component re-exported from the module': `export { CoinTradePanel } from '@/forge/CoinTradePanel';`,
    'a default component re-exported from the module': `export { default } from '@/forge/CreateCoin';`,
    'a dynamic component not bound to a const': `import dynamic from 'next/dynamic'; export default dynamic(() => import('@/forge/CreateCoin'));`,
    'an exported dynamic component': `import dynamic from 'next/dynamic'; export const Create = dynamic(() => import('@/forge/CreateCoin'));`,
    'a dynamic component rendered with an override': `import dynamic from 'next/dynamic'; const C = dynamic(() => import('@/forge/CreateCoin'), { ssr: false }); export const P = () => <C launchpadConfig="x" />;`,
    'a loader that is not next/dynamic': `const load = (f: any) => f; const C = load(() => import('@/forge/CoinTradePanel')); export const P = () => <C mint="m" />;`,
    'a shadowed dynamic': `import dynamic from 'next/dynamic'; export function P() { const dynamic = (f: any) => f; const C = dynamic(() => import('@/forge/CoinTradePanel')); return <C mint="m" />; }`,
    'a loader with a body': `import dynamic from 'next/dynamic'; const C = dynamic(async () => { const m = await import('@/forge/CreateCoin'); return m.CreateCoin; }); export const P = () => <C />;`,
    'a loader that wraps the component': `import dynamic from 'next/dynamic'; const C = dynamic(() => import('@/forge/CreateCoin').then((m) => (p: any) => <m.CreateCoin {...p} launchpadConfig="x" />)); export const P = () => <C />;`,
  };
  for (const [name, src] of Object.entries(refused)) {
    it(`refuses: ${name}`, () => {
      expect(importFindings(src).length, src).toBeGreaterThan(0);
    });
  }

  it('names the props that are allowed', () => {
    const [v] = importFindings(
      `import { CoinTradePanel } from '@/forge/CoinTradePanel'; export const P = ({ m }: { m: string }) => <CoinTradePanel mint={m} pool="x" />;`,
    );
    expect(v?.reason).toMatch(/"pool"/);
    expect(v?.reason).toMatch(/mint, symbol, displayDecimals, className/);
  });
});

describe('public FORGE surface and free-zone imports stay allowed', () => {
  const allowed: Record<string, string> = {
    'the coin trade panel': `import { CoinTradePanel } from '@/forge/CoinTradePanel'; export const P = ({ m, s }: { m: string; s?: string }) => <CoinTradePanel key={m} mint={m} symbol={s} displayDecimals={6} className="panel" />;`,
    'the coin trade panel loaded with next/dynamic (template token page)': `import dynamic from 'next/dynamic'; const CoinTradePanel = dynamic(() => import('@/forge/CoinTradePanel'), { ssr: false }); export const P = ({ m }: { m: string }) => <CoinTradePanel mint={m} />;`,
    'a named export loaded with next/dynamic': `import dynamic from 'next/dynamic'; const Chart = dynamic(() => import('@/forge/chart/TokenChart').then((m) => m.TokenChart), { ssr: false }); export const P = () => <Chart />;`,
    'a component loaded with React lazy': `import { lazy } from 'react'; const Claims = lazy(() => import('@/forge/ClaimCreatorFees')); export const P = () => <Claims />;`,
    'the creation form (template create page)': `import CreateCoin from '@/forge/CreateCoin'; export default function Page() { return <main><CreateCoin /></main>; }`,
    'the creator fee claims': `import { ClaimCreatorFees } from '@/forge/ClaimCreatorFees'; export const P = () => <ClaimCreatorFees />;`,
    'the graduated trade': `import JupiterTrade from '@/forge/JupiterTrade'; export const P = ({ m }: { m: string }) => <JupiterTrade mint={m} />;`,
    'the public site config': `import { siteConfig, cluster, poolCreationFeeSol } from '@/forge/config'; export const s = [siteConfig.name, cluster, poolCreationFeeSol];`,
    'the site config by a relative path': `import { siteConfig } from '../forge/config'; export const name = siteConfig.name;`,
    'a value re-export': `export { siteConfig } from '@/forge/config';`,
    'the data stream (template market)': `import { DataStreamProvider, useDataStream, useDataStreamListener } from '@/forge/data/DataStreamProvider'; export const P = () => { useDataStream(); useDataStreamListener; return <DataStreamProvider><div /></DataStreamProvider>; };`,
    'the token icons (template header and cards)': `import { TrenchesTokenIcon, TrenchesTokenIconImage } from '@/forge/token-icon'; import { TrenchesPoolTokenIcon } from '@/forge/token-icon/TokenIcon'; import { useTrenchesTokenIconContext } from '@/forge/token-icon/Context'; export const P = ({ t, p }: any) => { useTrenchesTokenIconContext; return <div><TrenchesTokenIcon className="rounded-lg" token={t}><TrenchesTokenIconImage className="rounded-lg" /></TrenchesTokenIcon><TrenchesPoolTokenIcon width={54} height={54} pool={p} /></div>; };`,
    'the token icon folder by its index file': `import { TrenchesTokenIcon } from '@/forge/token-icon/index'; export const P = ({ t }: any) => <TrenchesTokenIcon token={t} />;`,
    'the chart': `import { TokenChart } from '@/forge/chart/TokenChart'; export const P = () => <TokenChart opt={{ showVolume: true }} />;`,
    'formatting helpers': `import { formatUnits, formatBps } from '@/forge/trade/amounts'; import { formatSol } from '@/forge/create/amounts'; import { formatNumber } from '@/forge/chart/formatter'; export const f = [formatUnits, formatBps, formatSol, formatNumber];`,
    'a type-only import of an internal module': `import type { SwapQuote } from '@/forge/trade/core-adapter'; export type Q = SwapQuote;`,
    'a type-only re-export of an internal module': `export type { TradePanelProps } from '@/forge/TradePanel';`,
    'a component type in a type position': `import { CoinTradePanel } from '@/forge/CoinTradePanel'; import type { ComponentProps } from 'react'; export type Props = ComponentProps<typeof CoinTradePanel>;`,
    'imports between free-zone files': `import { Hero } from './home/Hero'; import { content } from '@/content'; import { theme } from '../theme'; export const x = [Hero, content, theme];`,
    'template modules outside the free zones': `import { cn } from '@/lib/utils'; import { useTokenInfo } from '@/hooks/queries'; import { Pool } from '@/contexts/types'; export const x = [cn, useTokenInfo] as unknown as Pool;`,
    'styles and public assets': `import '@/styles/globals.css'; import logo from '../../public/logo.png'; export const l = logo;`,
  };
  for (const [name, src] of Object.entries(allowed)) {
    it(`allows: ${name}`, () => {
      expect(importFindings(src), src).toEqual([]);
    });
  }

  it('lets the agent edit a template file that already used an internal export', () => {
    const base = `import { ApeClient } from '@/forge/data/client';\nexport const list = () => ApeClient.getGemsTokenList({});\n`;
    const next = `import { ApeClient } from '../../forge/data/client';\n\nexport const list = () => ApeClient.getGemsTokenList({ recent: undefined });\n`;
    expect(scan([modified('src/components/Explore/queries.ts', base, next)])).toEqual({ ok: true });
    // A rename keeps the same module: still the same import.
    expect(
      scan([
        renamed('src/components/Explore/queries.ts', 'src/components/Market/queries.ts', base),
      ]),
    ).toEqual({ ok: true });
    // A new internal export in the same file is new.
    const more = `import { ApeClient } from '@/forge/data/client';\nimport { onchainConfig } from '@/forge/config';\nexport const list = () => ApeClient.getGemsTokenList({ c: onchainConfig });\n`;
    expect(rulesOf(scan([modified('src/components/Explore/queries.ts', base, more)]))).toEqual([
      'forbidden-import',
    ]);
  });
});

describe('import resolution', () => {
  it('resolves aliases and relative paths', () => {
    expect(resolveLocalImport('src/components/a/B.tsx', '../../forge/x')).toEqual({
      kind: 'file',
      path: 'src/forge/x',
    });
    expect(resolveLocalImport('src/pages/x.tsx', '@/forge/a/../b')).toEqual({
      kind: 'file',
      path: 'src/forge/b',
    });
    expect(resolveLocalImport('src/pages/x.tsx', './y?raw')).toEqual({
      kind: 'file',
      path: 'src/pages/y',
    });
    expect(resolveLocalImport('src/pages/x.tsx', 'react')).toEqual({ kind: 'package' });
    expect(resolveLocalImport('src/pages/x.tsx', '../../../a').kind).toBe('invalid');
  });

  it('gives one id per module, whatever the extension or index form', () => {
    expect(forgeModuleId('src/forge/token-icon/index.tsx')).toBe('src/forge/token-icon');
    expect(forgeModuleId('src/forge/token-icon')).toBe('src/forge/token-icon');
    expect(forgeModuleId('src/forge/config.ts')).toBe('src/forge/config');
    expect(forgeModuleId('src/forge/trade/core-adapter.mock.ts')).toBe(
      'src/forge/trade/core-adapter.mock',
    );
    expect(forgeModuleId('src/forgery/x')).toBeNull();
    expect(importTarget('src/forge/config.json')).toEqual({
      kind: 'forge',
      module: 'src/forge/config.json',
    });
  });

  it('lists only modules of src/forge/ that exist in the template', () => {
    const root = fileURLToPath(new URL('../../../launchpad-template/', import.meta.url));
    for (const module of Object.keys(FORGE_PUBLIC_API)) {
      const candidates = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) =>
        join(root, `${module}${ext}`),
      );
      expect(
        candidates.some((p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        }),
        module,
      ).toBe(true);
    }
  });
});

/** Free-zone code files of the template (what the agent starts from). */
const TEMPLATE_ROOT = fileURLToPath(new URL('../../../launchpad-template', import.meta.url));
const FREE_ZONES = ['src/pages', 'src/components', 'src/content', 'src/theme'];

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...codeFiles(path));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(name)) out.push(path);
  }
  return out;
}

/**
 * Internal FORGE exports the template's own free-zone files still use. A baseline line never
 * blocks a job (findings are diff-aware); the agent cannot add them anywhere else.
 */
const TOLERATED = new Set([
  'src/components/Explore/queries.ts|src/forge/data/client|ApeClient',
  'src/components/home/LaunchpadCoin.tsx|src/forge/config|onchainConfig',
]);

describe('the template free zones', () => {
  it('use nothing of src/forge/ beyond the public surface (and the tolerated baseline)', () => {
    const config = resolveConfig({});
    const files = FREE_ZONES.flatMap((z) => codeFiles(join(TEMPLATE_ROOT, z)))
      .map((f) => relative(TEMPLATE_ROOT, f).replace(/\\/g, '/'))
      .filter((p) => !/^src\/pages\/(?:api\/|_app\.|_document\.|creator-fees\.)/.test(p))
      .filter((p) => !p.startsWith('src/components/modes/'));
    expect(files.length).toBeGreaterThan(10);
    const offending: string[] = [];
    for (const path of files) {
      const text = readFileSync(join(TEMPLATE_ROOT, path), 'utf8');
      for (const f of analyzeCode(path, text, config)) {
        // Local imports only (the header's wallet adapter import is a package rule).
        if (!/^forbidden-import\|(?:forge-|import\|local\|)/.test(f.key)) continue;
        const m = /^forbidden-import\|forge-import\|([^|]+)\|([^|]+)$/.exec(f.key);
        if (!m || !TOLERATED.has(`${path}|${m[1]}|${m[2]}`)) {
          offending.push(`${path}:${f.line} ${f.reason}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});
