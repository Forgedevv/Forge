/**
 * What free-zone code may import from FORGE's locked zone (`src/forge/`), and where a relative or
 * `@/` import of a free-zone file really points.
 *
 * `src/forge/` holds the money, wallet and transaction logic (swap core and its platform fee, the
 * server relay token, coin creation, claims). Free-zone files (`src/theme`, `src/content`,
 * `src/components`, `src/pages`) may only use its public surface: the components and helpers
 * listed in `FORGE_PUBLIC_API`, by module path and export name. Everything else under
 * `src/forge/` is refused, whatever the import form (named, default, namespace, `export * from`,
 * re-export, `import()`, `require()`). The list does not depend on the props a component has
 * today: a component is rendered with the props listed here and nothing else.
 */

/** How a public export may be used by free-zone code. */
export type ForgeExportRule =
  /** Any use (constants, formatting helpers, hooks, read-only site config). */
  | { kind: 'value' }
  /**
   * A component: only rendered as a JSX element (`<Name ... />`), with these props only (`key`
   * is always allowed, `children` only when listed), never spread props, never used as a value
   * (aliased, wrapped, passed to `createElement`, re-exported).
   */
  | { kind: 'component'; props: readonly string[] };

const value: ForgeExportRule = { kind: 'value' };
const component = (...props: string[]): ForgeExportRule => ({ kind: 'component', props });

const COIN_TRADE_PANEL = component('mint', 'symbol', 'displayDecimals', 'className');
const CREATE_COIN = component();
const CLAIM_CREATOR_FEES = component();

/**
 * The public FORGE surface for free-zone code: module (repo path without extension, a folder
 * stands for its `index`) -> export name -> rule. `default` is the default export.
 *
 * Deliberately absent (refused): the trade internals (`trade/*`: swap core, `setSwapCore`,
 * `createCoreSwapCore`, `TradeForm`, `useTradeExecution`...), `TradePanel` and `BuyButton` (they
 * take a raw pool address), `JupiterTrade` (it took any mint, so a page could trade another
 * launchpad's coin; `CoinTradePanel` routes graduated coins to it), coin creation and claim
 * internals (`create/*`, `claims/*`), the server
 * modules (`server-relay`, `relay`, `security-headers`, `mode-guard`), the data API client
 * (`data/client`), mocks and fixtures, `forgeConfig` / `onchainConfig` / `rpcRelayEndpoint`, the
 * app shell and mode pages.
 */
export const FORGE_PUBLIC_API: Readonly<Record<string, Readonly<Record<string, ForgeExportRule>>>> =
  {
    // Trade panel of a coin: derives the pool from this launchpad's config and the mint, and
    // routes a graduated coin to the Jupiter plugin with the FORGE referral fee.
    'src/forge/CoinTradePanel': { CoinTradePanel: COIN_TRADE_PANEL, default: COIN_TRADE_PANEL },
    'src/forge/CreateCoin': { CreateCoin: CREATE_COIN, default: CREATE_COIN },
    'src/forge/ClaimCreatorFees': {
      ClaimCreatorFees: CLAIM_CREATOR_FEES,
      default: CLAIM_CREATOR_FEES,
    },
    // Read-only, UI-facing site config (no on-chain block).
    'src/forge/config': { siteConfig: value, cluster: value, poolCreationFeeSol: value },
    // Market data of this launchpad (stream filtered on its pool configs).
    'src/forge/data/DataStreamProvider': {
      DataStreamProvider: component('children'),
      useDataStream: value,
      useDataStreamListener: value,
    },
    'src/forge/token-icon': {
      TrenchesTokenIcon: component(
        'token',
        'width',
        'height',
        'hideLaunchpad',
        'launchpadClassName',
        'className',
        'style',
        'children',
      ),
      TrenchesTokenIconRoot: component(
        'token',
        'width',
        'height',
        'hideLaunchpad',
        'className',
        'style',
        'children',
      ),
      // Never `src`, `srcSet`...: the image URL comes from the token.
      TrenchesTokenIconImage: component('className', 'style'),
    },
    'src/forge/token-icon/TokenIcon': {
      TrenchesPoolTokenIcon: component(
        'pool',
        'width',
        'height',
        'gap',
        'hideLaunchpad',
        'className',
        'style',
      ),
    },
    'src/forge/token-icon/Context': { useTrenchesTokenIconContext: value },
    'src/forge/chart/TokenChart': {
      TokenChart: component('renderingId', 'style', 'positions', 'opt'),
    },
    // Formatting helpers (pure).
    'src/forge/chart/formatter': {
      formatChartPrice: value,
      formatNumber: value,
      getPrecisionTick: value,
      getPrecisionTickSizeText: value,
    },
    'src/forge/trade/amounts': { formatUnits: value, formatBps: value },
    'src/forge/create/amounts': { formatSol: value },
  };

const PUBLIC_BY_ID = new Map(
  Object.entries(FORGE_PUBLIC_API).map(([module, exports]) => [
    module.toLowerCase(),
    { module, exports },
  ]),
);

/** The public module a canonical `src/forge/...` id names, if any (case-insensitive). */
export function publicForgeModule(
  id: string,
): { module: string; exports: Readonly<Record<string, ForgeExportRule>> } | undefined {
  return PUBLIC_BY_ID.get(id.toLowerCase());
}

/** Rule of `exportName` of a `src/forge/` module, `undefined` when it is not public. */
export function forgeExportRule(id: string, exportName: string): ForgeExportRule | undefined {
  const mod = publicForgeModule(id);
  return mod && Object.hasOwn(mod.exports, exportName) ? mod.exports[exportName] : undefined;
}

/** Public export names of a module (for messages). */
export function publicExportNames(id: string): string[] {
  const mod = publicForgeModule(id);
  return mod ? Object.keys(mod.exports).filter((n) => n !== 'default') : [];
}

export type LocalImport =
  /** Not a path: a package (bare specifier), checked by the package rules. */
  | { kind: 'package' }
  /** A file of the site: repo-relative POSIX path, `.` and `..` resolved. */
  | { kind: 'file'; path: string }
  | { kind: 'invalid'; reason: string };

/**
 * Resolves a module specifier written in `fromPath` the way the template's bundler does: `@/x`
 * is `src/x` (tsconfig `paths`), `./x` and `../x` are relative to the importing file. A resource
 * query or fragment (`?raw`, `#x`) names the same file. Only the path is resolved here, not the
 * extension: `forgeModuleId` and `importTarget` take any extension into account.
 */
export function resolveLocalImport(fromPath: string, spec: string): LocalImport {
  const clean = spec.replace(/[?#].*$/s, '');
  let base: string[];
  let rest: string;
  if (clean.startsWith('@/')) {
    base = ['src'];
    rest = clean.slice(2);
  } else if (clean === '.' || clean === '..' || clean.startsWith('./') || clean.startsWith('../')) {
    base = fromPath.split('/').slice(0, -1);
    rest = clean;
  } else if (clean === '~' || clean.startsWith('~/')) {
    return {
      kind: 'invalid',
      reason: `unknown path alias in "${spec}" (use @/ or a relative path)`,
    };
  } else {
    return { kind: 'package' };
  }
  const out = [...base];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return { kind: 'invalid', reason: `import "${spec}" leaves the site` };
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return { kind: 'file', path: out.join('/') };
}

/** Extensions the bundler resolves to code modules (stripped from a `src/forge/` path). */
const CODE_EXTENSION_RE = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts)$/i;

/**
 * Canonical id of a path under `src/forge/` (`src/forge/token-icon/index.tsx` and
 * `src/forge/token-icon` are both `src/forge/token-icon`), or `null` for a path outside it.
 * Case-insensitive, like the file systems some builds run on.
 */
export function forgeModuleId(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower !== 'src/forge' && !lower.startsWith('src/forge/')) return null;
  let id = path.replace(CODE_EXTENSION_RE, '');
  if (/\/index$/i.test(id)) id = id.slice(0, -'/index'.length);
  return id;
}

export type ImportTarget =
  /** A file of the site that free-zone code may import (free zones, template modules, assets). */
  | { kind: 'site' }
  /** A module of the locked zone: only its public exports may be used. */
  | { kind: 'forge'; module: string }
  | { kind: 'blocked'; reason: string };

/** What a resolved local import points to. */
export function importTarget(path: string): ImportTarget {
  const forge = forgeModuleId(path);
  if (forge !== null) return { kind: 'forge', module: forge };
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  if (segments.includes('node_modules')) {
    return { kind: 'blocked', reason: `import of "${path}" reaches into node_modules by path` };
  }
  if (lower === 'src/pages/api' || lower.startsWith('src/pages/api/')) {
    return { kind: 'blocked', reason: `import of the API route "${path}" (server code)` };
  }
  if (lower.startsWith('src/') || lower.startsWith('public/')) return { kind: 'site' };
  return {
    kind: 'blocked',
    reason: `import of "${path}": free-zone code may only import files under src/ or public/ (use siteConfig from @/forge/config for the site config)`,
  };
}
