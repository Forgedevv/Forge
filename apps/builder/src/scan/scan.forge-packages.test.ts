/**
 * FORGE packages installed from npm through exact aliases (decision D26):
 * `"@forge/core": "npm:@forgedevv/core@x.y.z"`, `"@forge/shared": "npm:@forgedevv/shared@x.y.z"`.
 * Every change to their spec, override, resolution, patch or lockfile entry is refused, under
 * either name.
 */
import { describe, expect, it } from 'vitest';

import { decodeLockEscapes } from './manifest.js';
import { added, modified, rulesOf, scan } from './test-helpers.js';

type Json = Record<string, unknown>;

const BASE_PKG: Json = {
  name: 'moonpad',
  private: true,
  scripts: { build: 'next build' },
  dependencies: {
    '@forge/core': 'npm:@forgedevv/core@0.1.0',
    '@forge/shared': 'npm:@forgedevv/shared@0.1.0',
    '@solana/web3.js': '1.99.0',
    next: '15.5.27',
    react: '19.3.0',
  },
  devDependencies: { typescript: '6.0.3' },
};
const PKG = `${JSON.stringify(BASE_PKG, null, 2)}\n`;

function pkgWith(edit: (p: Json & { dependencies: Record<string, string> }) => void): string {
  const p = structuredClone(BASE_PKG) as Json & { dependencies: Record<string, string> };
  edit(p);
  return `${JSON.stringify(p, null, 2)}\n`;
}

function pkgRules(next: string, base = PKG): string[] {
  return rulesOf(scan([modified('package.json', base, next)]));
}

describe('package.json: FORGE package specs (alias and npm names, core and shared)', () => {
  const refused: Record<string, string> = {
    'core version bump': pkgWith((p) => {
      p.dependencies['@forge/core'] = 'npm:@forgedevv/core@0.1.1';
    }),
    'core alias swapped to another package': pkgWith((p) => {
      p.dependencies['@forge/core'] = 'npm:evil@1.0.0';
    }),
    'shared alias swapped to another package': pkgWith((p) => {
      p.dependencies['@forge/shared'] = 'npm:evil@1.0.0';
    }),
    'shared version bump': pkgWith((p) => {
      p.dependencies['@forge/shared'] = 'npm:@forgedevv/shared@0.2.0';
    }),
    'shared range instead of the exact version': pkgWith((p) => {
      p.dependencies['@forge/shared'] = 'npm:@forgedevv/shared@^0.1.0';
    }),
    'shared removed': pkgWith((p) => {
      delete p.dependencies['@forge/shared'];
    }),
    'shared as a local link': pkgWith((p) => {
      p.dependencies['@forge/shared'] = 'link:./src/components/shared';
    }),
    'shared from a git repository': pkgWith((p) => {
      p.dependencies['@forge/shared'] = 'github:evil/shared';
    }),
    'core moved to devDependencies': pkgWith((p) => {
      delete p.dependencies['@forge/core'];
      (p.devDependencies as Record<string, string>)['@forge/core'] = 'npm:@forgedevv/core@0.1.0';
    }),
    'second alias of the npm package': pkgWith((p) => {
      p.dependencies['forge-core-next'] = 'npm:@forgedevv/core@0.0.9';
    }),
    'browser field remapping the alias': pkgWith((p) => {
      p.browser = { '@forge/core': './src/components/fake-core.js' };
    }),
  };
  for (const [name, next] of Object.entries(refused)) {
    it(`refuses: ${name}`, () => {
      expect(pkgRules(next)).toContain('forge-core-dependency');
    });
  }

  it('accepts the unchanged alias form (an unrelated edit is only the package.json lock)', () => {
    const next = pkgWith((p) => {
      p.dependencies.react = '19.3.1';
    });
    const r = pkgRules(next);
    expect(r).toContain('zone-outside-allowed');
    expect(r).not.toContain('forge-core-dependency');
    expect(r).not.toContain('patch-package');
  });

  it('accepts the same aliases reformatted and reordered', () => {
    const p = structuredClone(BASE_PKG) as Json & { dependencies: Record<string, string> };
    const reordered = {
      ...p,
      dependencies: Object.fromEntries(Object.entries(p.dependencies).reverse()),
    };
    expect(pkgRules(JSON.stringify(reordered))).not.toContain('forge-core-dependency');
  });
});

describe('package.json: overrides, resolutions and patches', () => {
  const refused: Record<string, string> = {
    'overrides keyed @forgedevv/core': pkgWith((p) => {
      p.overrides = { '@forgedevv/core': 'npm:evil@1.0.0' };
    }),
    'overrides keyed @forgedevv/shared': pkgWith((p) => {
      p.overrides = { '@forgedevv/shared': 'npm:evil@1.0.0' };
    }),
    'nested npm override under the alias': pkgWith((p) => {
      p.overrides = { '@forge/core': { '@forgedevv/shared': 'npm:evil@1.0.0' } };
    }),
    'pnpm.overrides keyed @forgedevv/core': pkgWith((p) => {
      p.pnpm = { overrides: { '@forgedevv/core': 'npm:evil@1.0.0' } };
    }),
    'pnpm.overrides keyed @forgedevv/shared with a version selector': pkgWith((p) => {
      p.pnpm = { overrides: { '@forgedevv/shared@0.1.0': 'npm:evil@1.0.0' } };
    }),
    'pnpm.overrides parent>child selector': pkgWith((p) => {
      p.pnpm = { overrides: { '@forgedevv/core>@forgedevv/shared': 'link:./src/content' } };
    }),
    'resolutions keyed @forgedevv/core': pkgWith((p) => {
      p.resolutions = { '@forgedevv/core': 'npm:evil@1.0.0' };
    }),
    'resolutions keyed **/@forgedevv/shared': pkgWith((p) => {
      p.resolutions = { '**/@forgedevv/shared': 'npm:evil@1.0.0' };
    }),
    'pnpm.patchedDependencies on @forgedevv/core': pkgWith((p) => {
      p.pnpm = { patchedDependencies: { '@forgedevv/core@0.1.0': 'src/content/notes.txt' } };
    }),
    'pnpm.patchedDependencies on @forgedevv/shared': pkgWith((p) => {
      p.pnpm = { patchedDependencies: { '@forgedevv/shared@0.1.0': 'src/content/notes.txt' } };
    }),
    'bun patchedDependencies on @forgedevv/core': pkgWith((p) => {
      p.patchedDependencies = { '@forgedevv/core@0.1.0': 'src/content/notes.txt' };
    }),
    'pnpm.packageExtensions on @forgedevv/core': pkgWith((p) => {
      p.pnpm = { packageExtensions: { '@forgedevv/core': { dependencies: { evil: '1.0.0' } } } };
    }),
    'override of a dependency FORGE code runs (@solana/web3.js)': pkgWith((p) => {
      p.pnpm = { overrides: { '@solana/web3.js': 'npm:evil@1.0.0' } };
    }),
    'override of the Meteora SDK': pkgWith((p) => {
      p.overrides = { '@meteora-ag/dynamic-bonding-curve-sdk': 'npm:evil@1.0.0' };
    }),
    'override key spelled with a JSON escape': PKG.replace(
      '"private": true,',
      '"private": true,\n  "overrides": { "\\u0040forgedevv\\u002fcore": "npm:evil@1.0.0" },',
    ),
    'patchedDependencies key spelled with a JSON escape': PKG.replace(
      '"private": true,',
      '"private": true,\n  "pnpm": { "patchedDependenci\\u0065s": { "@forgedevv/c\\u006fre@0.1.0": "src/content/a.txt" } },',
    ),
  };
  for (const [name, next] of Object.entries(refused)) {
    it(`refuses: ${name}`, () => {
      expect(pkgRules(next)).toContain('forge-core-dependency');
    });
  }

  it('refuses a change to an override that was already there', () => {
    const base = pkgWith((p) => {
      p.pnpm = { overrides: { react: '19.3.0' } };
    });
    const next = pkgWith((p) => {
      p.pnpm = { overrides: { react: '19.3.1' } };
    });
    expect(pkgRules(next, base)).toContain('forge-core-dependency');
    expect(pkgRules(base, base)).not.toContain('forge-core-dependency');
  });
});

const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@forge/core':
        specifier: npm:@forgedevv/core@0.1.0
        version: '@forgedevv/core@0.1.0(typescript@6.0.3)'
      '@forge/shared':
        specifier: npm:@forgedevv/shared@0.1.0
        version: '@forgedevv/shared@0.1.0'
      react:
        specifier: 19.3.0
        version: 19.3.0

packages:

  '@forgedevv/core@0.1.0':
    resolution: {integrity: sha512-CORE}

  '@forgedevv/shared@0.1.0':
    resolution: {integrity: sha512-SHARED}

  '@solana/web3.js@1.99.0':
    resolution: {integrity: sha512-WEB3}

  react@19.3.0:
    resolution: {integrity: sha512-REACT}
    engines: {node: '>=0.10.0'}

snapshots:

  '@forgedevv/core@0.1.0(typescript@6.0.3)':
    dependencies:
      '@forgedevv/shared': 0.1.0
      '@solana/web3.js': 1.99.0

  '@forgedevv/shared@0.1.0': {}

  '@solana/web3.js@1.99.0': {}

  react@19.3.0: {}
`;

function lockRules(path: string, base: string | Uint8Array, next: string | Uint8Array): string[] {
  return rulesOf(scan([modified(path, base, next)]));
}

describe('pnpm-lock.yaml: FORGE package entries (alias keys and npm package keys)', () => {
  const refused: Record<string, string> = {
    'integrity swap of @forgedevv/core': PNPM_LOCK.replace('sha512-CORE', 'sha512-EVIL'),
    'integrity swap of @forgedevv/shared': PNPM_LOCK.replace('sha512-SHARED', 'sha512-EVIL'),
    'resolution of @forgedevv/core swapped to a tarball': PNPM_LOCK.replace(
      '{integrity: sha512-CORE}',
      '{tarball: https://evil.example/core.tgz}',
    ),
    'importer of @forge/shared pointed at another package': PNPM_LOCK.replace(
      "version: '@forgedevv/shared@0.1.0'",
      'version: evil@1.0.0',
    ),
    'importer specifier of @forge/core changed': PNPM_LOCK.replace(
      'specifier: npm:@forgedevv/core@0.1.0',
      'specifier: npm:@forgedevv/core@0.1.1',
    ),
    'snapshot dependency of @forgedevv/core changed': PNPM_LOCK.replace(
      "'@forgedevv/shared': 0.1.0",
      "'@forgedevv/shared': 0.0.9",
    ),
    'entry of @forgedevv/core re-indented': PNPM_LOCK.replace(
      "  '@forgedevv/core@0.1.0':\n    resolution",
      "    '@forgedevv/core@0.1.0':\n      resolution",
    ),
    'entry of @forgedevv/core moved to another section, unchanged': PNPM_LOCK.replace(
      "  '@forgedevv/core@0.1.0':\n    resolution: {integrity: sha512-CORE}\n\n",
      '',
    ).replace(
      '  react@19.3.0: {}\n',
      "  react@19.3.0: {}\n\n  '@forgedevv/core@0.1.0':\n    resolution: {integrity: sha512-CORE}\n",
    ),
    'new entry with an escaped key': PNPM_LOCK.replace(
      '\nsnapshots:',
      '  "\\x40forgedevv/core@0.1.1":\n    resolution: {integrity: sha512-EVIL}\n\nsnapshots:',
    ),
    'top-level overrides added (no FORGE name)': PNPM_LOCK.replace(
      '\nimporters:',
      "\noverrides:\n  '@solana/web3.js': npm:evil@1.0.0\n\nimporters:",
    ),
    'top-level patchedDependencies added': PNPM_LOCK.replace(
      '\nimporters:',
      '\npatchedDependencies:\n  react@19.3.0:\n    hash: abc\n    path: src/content/a.txt\n\nimporters:',
    ),
    'pnpmfile checksum added': PNPM_LOCK.replace(
      '\nimporters:',
      '\npnpmfileChecksum: abc\n\nimporters:',
    ),
    'explicit multi-line key hiding the package name': PNPM_LOCK.replace(
      '\nsnapshots:',
      '  ? "@forgedevv/\\\n    core@0.1.1"\n  : resolution: {integrity: sha512-EVIL}\n\nsnapshots:',
    ),
    'YAML anchor added': PNPM_LOCK.replace(
      '\nsnapshots:',
      '  evil@1.0.0: &evil\n    resolution: {integrity: sha512-EVIL}\n\nsnapshots:',
    ),
  };
  for (const [name, next] of Object.entries(refused)) {
    it(`refuses: ${name}`, () => {
      expect(next).not.toBe(PNPM_LOCK);
      expect(lockRules('pnpm-lock.yaml', PNPM_LOCK, next)).toContain('lockfile-forge-core');
    });
  }

  it('accepts unrelated edits and the unchanged alias entries (only the lockfile lock)', () => {
    const unrelated = [
      PNPM_LOCK.replace('sha512-REACT', 'sha512-REACT2'),
      PNPM_LOCK.replace('sha512-WEB3', 'sha512-WEB3B'),
      PNPM_LOCK.replace('  react@19.3.0: {}\n', '  react@19.3.0: {}\n\n  zod@3.25.76: {}\n'),
      PNPM_LOCK.replace(/\n/g, '\r\n'),
      PNPM_LOCK,
    ];
    for (const next of unrelated) {
      const r = lockRules('pnpm-lock.yaml', PNPM_LOCK, next);
      expect(r).toContain('zone-outside-allowed');
      expect(r).not.toContain('lockfile-forge-core');
    }
  });
});

describe('other lockfiles', () => {
  const YARN = `# yarn lockfile v1

"@forge/core@npm:@forgedevv/core@0.1.0":
  version "0.1.0"
  resolved "https://registry.yarnpkg.com/@forgedevv/core/-/core-0.1.0.tgz#aaa"
  integrity sha512-CORE

"@forge/shared@npm:@forgedevv/shared@0.1.0":
  version "0.1.0"
  resolved "https://registry.yarnpkg.com/@forgedevv/shared/-/shared-0.1.0.tgz#bbb"
  integrity sha512-SHARED

react@19.3.0:
  version "19.3.0"
  integrity sha512-REACT
`;
  const NPM_LOCK = JSON.stringify(
    {
      name: 'moonpad',
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: {
            '@forge/core': 'npm:@forgedevv/core@0.1.0',
            '@forge/shared': 'npm:@forgedevv/shared@0.1.0',
          },
        },
        'node_modules/@forge/core': {
          name: '@forgedevv/core',
          version: '0.1.0',
          resolved: 'https://registry.npmjs.org/@forgedevv/core/-/core-0.1.0.tgz',
          integrity: 'sha512-CORE',
        },
        'node_modules/@forge/shared': {
          name: '@forgedevv/shared',
          version: '0.1.0',
          resolved: 'https://registry.npmjs.org/@forgedevv/shared/-/shared-0.1.0.tgz',
          integrity: 'sha512-SHARED',
        },
        'node_modules/react': { version: '19.3.0', integrity: 'sha512-REACT' },
      },
    },
    null,
    2,
  );
  const BUN_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "dependencies": {
        "@forge/core": "npm:@forgedevv/core@0.1.0",
        "@forge/shared": "npm:@forgedevv/shared@0.1.0",
      },
    },
  },
  "packages": {
    "@forge/core": ["@forgedevv/core@0.1.0", "", {}, "sha512-CORE"],
    "@forge/shared": ["@forgedevv/shared@0.1.0", "", {}, "sha512-SHARED"],
    "react": ["react@19.3.0", "", {}, "sha512-REACT"],
  }
}
`;

  it('refuses integrity and resolution swaps of core and shared in yarn.lock', () => {
    for (const next of [
      YARN.replace('sha512-CORE', 'sha512-EVIL'),
      YARN.replace('sha512-SHARED', 'sha512-EVIL'),
      YARN.replace('shared-0.1.0.tgz#bbb', 'shared-0.1.0.tgz#ccc'),
    ]) {
      expect(lockRules('yarn.lock', YARN, next)).toContain('lockfile-forge-core');
    }
    expect(lockRules('yarn.lock', YARN, YARN.replace('sha512-REACT', 'sha512-R2'))).not.toContain(
      'lockfile-forge-core',
    );
  });

  it('refuses changes to the alias entries of package-lock.json', () => {
    for (const next of [
      NPM_LOCK.replace('sha512-SHARED', 'sha512-EVIL'),
      NPM_LOCK.replace('"name": "@forgedevv/shared"', '"name": "evil"'),
      NPM_LOCK.replace(
        'https://registry.npmjs.org/@forgedevv/core/-/core-0.1.0.tgz',
        'https://evil.example/core.tgz',
      ),
    ]) {
      expect(next).not.toBe(NPM_LOCK);
      expect(lockRules('package-lock.json', NPM_LOCK, next)).toContain('lockfile-forge-core');
    }
    expect(
      lockRules('package-lock.json', NPM_LOCK, NPM_LOCK.replace('sha512-REACT', 'sha512-R2')),
    ).not.toContain('lockfile-forge-core');
  });

  it('refuses changes to the FORGE entries of bun.lock and any bun.lockb', () => {
    expect(
      lockRules('bun.lock', BUN_LOCK, BUN_LOCK.replace('sha512-SHARED', 'sha512-X')),
    ).toContain('lockfile-forge-core');
    expect(
      lockRules(
        'bun.lock',
        BUN_LOCK,
        BUN_LOCK.replace(
          '"react": ["react',
          '"overrides": { "react": "1.0.0" },\n    "react": ["react',
        ),
      ),
    ).toContain('lockfile-forge-core');
    expect(
      lockRules('bun.lock', BUN_LOCK, BUN_LOCK.replace('sha512-REACT', 'sha512-R')),
    ).not.toContain('lockfile-forge-core');
    expect(rulesOf(scan([added('bun.lockb', Uint8Array.from([1, 2, 3]))]))).toContain(
      'lockfile-forge-core',
    );
  });

  it('refuses an added lockfile that names a FORGE package, even escaped', () => {
    expect(rulesOf(scan([added('pnpm-lock.yaml', PNPM_LOCK)]))).toContain('lockfile-forge-core');
    expect(
      rulesOf(scan([added('pnpm-lock.yaml', "packages:\n  '@forgedevv\\x2fshared@0.1.0': {}\n")])),
    ).toContain('lockfile-forge-core');
    const r = rulesOf(scan([added('pnpm-lock.yaml', 'packages:\n  react@19.3.0: {}\n')]));
    expect(r).toContain('zone-outside-allowed');
    expect(r).not.toContain('lockfile-forge-core');
  });
});

describe('decodeLockEscapes', () => {
  it('decodes YAML, JSON and URL escapes of a package name', () => {
    expect(decodeLockEscapes('"\\x40forgedevv\\/core"')).toBe('"@forgedevv/core"');
    expect(decodeLockEscapes('\\u0040forgedevv\\u002Fshared')).toBe('@forgedevv/shared');
    expect(decodeLockEscapes('\\U00000040forge%2fcore')).toBe('@forge/core');
    expect(decodeLockEscapes('\\UFFFFFFFF')).toBe('\\UFFFFFFFF');
  });
});
