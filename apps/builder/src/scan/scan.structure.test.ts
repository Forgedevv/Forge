import { describe, expect, it } from 'vitest';

import {
  ELF,
  PNG,
  WOFF2,
  added,
  deleted,
  modified,
  renamed,
  rulesOf,
  scan,
} from './test-helpers.js';
import { scanDiff } from './scan.js';

const FORGE_CONFIG = JSON.stringify(
  {
    version: 1,
    name: 'MoonPad',
    slug: 'moonpad',
    mode: 'live',
    onchain: {
      cluster: 'mainnet-beta',
      launchpadConfig: 'Cfg1111111111111111111111111111111111111111',
      launchpadCoinConfig: 'Cfg2222222222222222222222222222222222222222',
      launchpadCoinMint: 'Mint333333333333333333333333333333333333333',
      ownerWallet: 'Own4444444444444444444444444444444444444444',
    },
    theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
    content: { tagline: 'To the moon', about: 'A launchpad.' },
  },
  null,
  2,
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function editConfig(edit: (c: Json) => void): string {
  const c = JSON.parse(FORGE_CONFIG) as Json;
  edit(c);
  return JSON.stringify(c, null, 2);
}

describe('locked zones', () => {
  it('blocks any change under src/forge/ (add, modify, delete, rename, case tricks)', () => {
    expect(rulesOf(scan([modified('src/forge/BuyButton.tsx', 'a', 'b')]))).toContain(
      'forge-locked-zone',
    );
    expect(rulesOf(scan([added('src/forge/Evil.tsx', 'export {}')]))).toContain(
      'forge-locked-zone',
    );
    expect(rulesOf(scan([deleted('src/forge/TradePanel.tsx', 'x')]))).toContain(
      'forge-locked-zone',
    );
    expect(
      rulesOf(scan([renamed('src/forge/BuyButton.tsx', 'src/components/BuyButton.tsx', 'x')])),
    ).toContain('forge-locked-zone');
    expect(rulesOf(scan([modified('SRC/Forge/config.ts', 'a', 'b')]))).toContain(
      'forge-locked-zone',
    );
  });

  it('allows a design change next to src/forge/', () => {
    expect(
      scan([
        modified('src/components/Header.tsx', 'export const A = 1;\n', 'export const A = 2;\n'),
      ]),
    ).toEqual({ ok: true });
  });

  it('blocks next.config.*, wherever it is', () => {
    for (const p of [
      'next.config.js',
      'next.config.mjs',
      'next.config.ts',
      'src/components/next.config.js',
    ]) {
      expect(rulesOf(scan([modified(p, 'a', 'b')]))).toContain('next-config');
    }
  });

  it('blocks API routes and files outside the allowed zones', () => {
    expect(rulesOf(scan([added('src/pages/api/steal.ts', 'export default 1')]))).toContain(
      'api-route',
    );
    for (const p of [
      'src/lib/util.ts',
      'src/middleware.ts',
      'middleware.ts',
      'vercel.json',
      '.github/workflows/x.yml',
      'scripts/postinstall.js',
      'src/styles/x.css',
      'README.md',
    ]) {
      expect(rulesOf(scan([added(p, 'x')]))).toContain('zone-outside-allowed');
    }
  });

  it('regression: locks the app shell, the document and the mode pages', () => {
    // A released change there could keep a sleeping or disabled site fully working.
    for (const p of [
      'src/pages/_app.tsx',
      'src/pages/_app.js',
      'src/pages/_App.tsx',
      'src/pages/_app/index.tsx',
      'src/pages/_document.tsx',
      'src/pages/_document.jsx',
      'src/components/modes/DisabledPage.tsx',
      'src/components/modes/SleepingPage.tsx',
      'src/components/modes/New.tsx',
      'src/components/Modes/DisabledPage.tsx',
    ]) {
      expect(rulesOf(scan([modified(p, 'a', 'b')])), p).toContain('app-shell-locked');
      expect(rulesOf(scan([added(p, 'export {}')])), p).toContain('app-shell-locked');
      expect(rulesOf(scan([deleted(p, 'x')])), p).toContain('app-shell-locked');
    }
    expect(
      rulesOf(
        scan([
          renamed('src/components/modes/DisabledPage.tsx', 'src/components/Disabled.tsx', 'x'),
        ]),
      ),
    ).toContain('app-shell-locked');
    expect(
      rulesOf(scan([renamed('src/components/Shell.tsx', 'src/pages/_app.tsx', 'x')])),
    ).toContain('app-shell-locked');
    // Neighbours stay free.
    for (const p of [
      'src/components/AppShell.tsx',
      'src/components/modesty.tsx',
      'src/pages/app.tsx',
      'src/pages/_apps.tsx',
    ]) {
      expect(rulesOf(scan([added(p, 'export const A = 1;\n')])), p).not.toContain(
        'app-shell-locked',
      );
    }
  });

  it('regression: locks the /creator-fees route of every live site', () => {
    const route = "export { default } from '@/forge/pages/CreatorFeesPage';\n";
    // The route file and anything else Next.js would serve at /creator-fees.
    for (const p of [
      'src/pages/creator-fees.tsx',
      'src/pages/creator-fees.ts',
      'src/pages/creator-fees.js',
      'src/pages/creator-fees.jsx',
      'src/pages/Creator-Fees.tsx',
      'src/pages/creator-fees/index.tsx',
      'src/pages/creator-fees/[pool].tsx',
    ]) {
      expect(
        rulesOf(scan([modified(p, route, 'export default function P() { return null; }\n')])),
        p,
      ).toContain('forge-page-locked');
      expect(
        rulesOf(scan([added(p, 'export default function P() { return null; }\n')])),
        p,
      ).toContain('forge-page-locked');
      expect(rulesOf(scan([deleted(p, route)])), p).toContain('forge-page-locked');
    }
    expect(
      rulesOf(scan([renamed('src/pages/creator-fees.tsx', 'src/pages/fees.tsx', route)])),
    ).toContain('forge-page-locked');
    expect(
      rulesOf(scan([renamed('src/pages/about.tsx', 'src/pages/creator-fees.tsx', 'x')])),
    ).toContain('forge-page-locked');
    // The locked page itself is in src/forge/.
    expect(rulesOf(scan([modified('src/forge/pages/CreatorFeesPage.tsx', 'a', 'b')]))).toContain(
      'forge-locked-zone',
    );
    // Neighbours stay free.
    for (const p of [
      'src/pages/creator.tsx',
      'src/pages/creator-feesx.tsx',
      'src/pages/fees.tsx',
    ]) {
      expect(rulesOf(scan([added(p, 'export const A = 1;\n')])), p).not.toContain(
        'forge-page-locked',
      );
    }
  });

  it('lets free-zone pages and components link to /creator-fees', () => {
    const page = [
      "import Link from 'next/link';",
      'export default function About() {',
      '  return (',
      '    <main>',
      '      <Link href="/creator-fees">Claim your creator fees</Link>',
      '      <a href="/creator-fees">Creator fees</a>',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n');
    expect(scan([added('src/pages/about.tsx', page)])).toEqual({ ok: true });
    expect(scan([added('src/components/FeesLink.tsx', page)])).toEqual({ ok: true });
  });

  it('keeps the site mode a builder-only field of forge.config.json', () => {
    for (const mode of ['live', 'sleeping']) {
      const disabled = editConfig((c) => {
        c.mode = 'disabled';
      });
      const next = editConfig((c) => {
        c.mode = mode;
      });
      expect(rulesOf(scan([modified('forge.config.json', disabled, next)]))).toContain(
        'forge-config-locked-field',
      );
    }
  });

  it('allows the free zones', () => {
    expect(
      scan([
        added(
          'src/pages/about.tsx',
          'export default function About() { return <main>About</main>; }\n',
        ),
      ]),
    ).toEqual({ ok: true });
    expect(scan([added('src/theme/tokens.css', ':root { --primary: #7c3aed; }\n')])).toEqual({
      ok: true,
    });
    expect(scan([added('src/content/faq.md', '# FAQ\n\nWhat is MoonPad?\n')])).toEqual({
      ok: true,
    });
    expect(scan([added('public/logo.png', PNG)])).toEqual({ ok: true });
    expect(scan([added('public/fonts/brand.woff2', WOFF2)])).toEqual({ ok: true });
  });

  it('blocks special and hidden files inside free zones', () => {
    for (const p of [
      'src/components/package.json',
      'src/components/tsconfig.json',
      'src/theme/.babelrc',
      'src/pages/.env',
      'src/components/.hidden/x.ts',
      'src/pages/_middleware.ts',
      'src/components/postcss.config.js',
    ]) {
      expect(rulesOf(scan([added(p, '{}')]))).toContain('special-file');
    }
  });

  it('default-denies unknown file types', () => {
    for (const p of [
      'src/content/data.yaml',
      'src/components/x.mjs',
      'src/components/run.sh',
      'src/pages/page.html',
      'src/components/Makefile',
      'src/components/x.wasm',
    ]) {
      expect(rulesOf(scan([added(p, 'x')]))).toContain('file-type-not-allowed');
    }
  });

  it('allows only images and fonts in public/', () => {
    for (const p of [
      'public/sw.js',
      'public/index.html',
      'public/robots.txt',
      'public/data.json',
      'public/style.css',
    ]) {
      expect(rulesOf(scan([added(p, 'x')]))).toContain('file-type-not-allowed');
    }
  });

  it('rejects malformed paths', () => {
    for (const p of [
      'src/components/../forge/BuyButton.tsx',
      '/etc/passwd',
      'src\\forge\\x.ts',
      'src//forge/x.ts',
      'src/components/f\u03bfrge.tsx',
      'C:/x.ts',
      '',
    ]) {
      expect(rulesOf(scan([added(p, 'x')]))).toContain('path-invalid');
    }
  });

  it('rejects the same path listed twice or differing only by case', () => {
    const r = scan([
      added('src/components/A.tsx', 'export {}'),
      added('src/components/a.tsx', 'export {}'),
    ]);
    expect(rulesOf(r)).toContain('path-invalid');
  });
});

describe('file modes and binaries', () => {
  it('blocks symlinks, submodules and executables', () => {
    expect(
      rulesOf(scan([added('src/components/link.tsx', '../forge/BuyButton.tsx', '120000')])),
    ).toContain('file-mode');
    expect(rulesOf(scan([added('src/components/sub', 'x', '160000')]))).toContain('file-mode');
    expect(rulesOf(scan([added('src/components/x.ts', 'export {}', '100755')]))).toContain(
      'file-mode',
    );
  });

  it('allows a regular file mode', () => {
    expect(scan([added('src/components/x.ts', 'export const x = 1;\n', '100644')])).toEqual({
      ok: true,
    });
  });

  it('blocks binaries disguised as images and binary content in text files', () => {
    expect(rulesOf(scan([added('public/logo.png', ELF)]))).toContain('binary-file');
    expect(rulesOf(scan([added('public/logo.png', 'not really a png')]))).toContain('binary-file');
    expect(rulesOf(scan([added('src/components/x.ts', ELF)]))).toContain('encoding-invalid');
    expect(
      rulesOf(scan([added('src/components/x.ts', Uint8Array.from([0xff, 0xfe, 0x41]))])),
    ).toContain('encoding-invalid');
  });

  it('blocks oversized files', () => {
    expect(rulesOf(scan([added('src/content/big.txt', 'a'.repeat(600 * 1024))]))).toContain(
      'file-too-large',
    );
  });

  it('allows deleting a free-zone file', () => {
    expect(scan([deleted('src/components/Old.tsx', 'export {}')])).toEqual({ ok: true });
  });
});

describe('node_modules and patches', () => {
  it('blocks node_modules, patches/ and patch files', () => {
    expect(rulesOf(scan([added('node_modules/@forge/core/index.js', 'x')]))).toContain(
      'node-modules',
    );
    expect(rulesOf(scan([added('src/components/node_modules/x/index.js', 'x')]))).toContain(
      'node-modules',
    );
    expect(rulesOf(scan([added('patches/@forge+core+1.0.0.patch', 'x')]))).toContain(
      'patch-package',
    );
    expect(rulesOf(scan([added('src/components/fix.patch', 'x')]))).toContain('patch-package');
  });
});

describe('forge.config.json (JSON-aware)', () => {
  it('allows theme and content changes', () => {
    const next = editConfig((c) => {
      c.theme.primaryColor = '#10B981';
      c.theme.fontFamily = "'Space Grotesk', sans-serif";
      c.content.tagline = 'Launch your coin in minutes';
    });
    expect(scan([modified('forge.config.json', FORGE_CONFIG, next)])).toEqual({ ok: true });
  });

  it('allows reformatting without semantic change', () => {
    expect(
      scan([modified('forge.config.json', FORGE_CONFIG, JSON.stringify(JSON.parse(FORGE_CONFIG)))]),
    ).toEqual({ ok: true });
  });

  it('blocks onchain and mode changes', () => {
    const onchain = editConfig(
      (c) => (c.onchain.ownerWallet = 'Evi1111111111111111111111111111111111111111'),
    );
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, onchain)]))).toContain(
      'forge-config-locked-field',
    );
    const mode = editConfig((c) => (c.mode = 'sleeping'));
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, mode)]))).toContain(
      'forge-config-locked-field',
    );
    const removed = editConfig((c) => delete c.onchain);
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, removed)]))).toContain(
      'forge-config-locked-field',
    );
    const extra = editConfig((c) => (c.rpc = 'https://evil.example'));
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, extra)]))).toContain(
      'forge-config-locked-field',
    );
  });

  it('blocks a duplicate onchain key (parser differential)', () => {
    const dup = FORGE_CONFIG.replace('"theme":', '"onchain": {"ownerWallet": "x"},\n  "theme":');
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, dup)]))).toContain(
      'forge-config-invalid',
    );
  });

  it('blocks invalid JSON, deletion and CSS/HTML injection in theme/content', () => {
    expect(
      rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, '{ "version": 1,')])),
    ).toContain('forge-config-invalid');
    expect(rulesOf(scan([deleted('forge.config.json', FORGE_CONFIG)]))).toContain(
      'forge-config-locked-field',
    );
    const css = editConfig(
      (c) => (c.theme.primaryColor = 'red;}</style><script>alert(1)</script>'),
    );
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, css)]))).toContain(
      'forge-config-unsafe-value',
    );
    const html = editConfig((c) => (c.content.about = '<img src=x onerror="alert(1)">'));
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, html)]))).toContain(
      'forge-config-unsafe-value',
    );
  });

  it('blocks an address added to content', () => {
    const next = editConfig(
      (c) => (c.content.about = 'Send SOL to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'),
    );
    expect(rulesOf(scan([modified('forge.config.json', FORGE_CONFIG, next)]))).toContain(
      'solana-address',
    );
  });
});

const PKG = JSON.stringify(
  {
    name: 'moonpad',
    dependencies: { '@forge/core': '1.2.3', next: '15.0.0', react: '19.0.0' },
    devDependencies: { typescript: '5.6.0' },
  },
  null,
  2,
);

describe('package.json and lockfiles', () => {
  it('blocks @forge/core version change, removal, alias and override', () => {
    const variants = [
      PKG.replace('"1.2.3"', '"1.2.4"'),
      PKG.replace('"@forge/core": "1.2.3",', ''),
      PKG.replace('"@forge/core": "1.2.3"', '"@forge/core": "npm:@evil/core@1.0.0"'),
      JSON.stringify({
        ...JSON.parse(PKG),
        pnpm: { overrides: { '@forge/core': 'link:../evil' } },
      }),
      JSON.stringify({ ...JSON.parse(PKG), devDependencies: { '@forge/core': '9.9.9' } }),
    ];
    for (const next of variants)
      expect(rulesOf(scan([modified('package.json', PKG, next)]))).toContain(
        'forge-core-dependency',
      );
    expect(rulesOf(scan([deleted('package.json', PKG)]))).toContain('forge-core-dependency');
  });

  it('still locks package.json, but does not report @forge/core for unrelated edits', () => {
    const next = PKG.replace('"19.0.0"', '"19.0.1"');
    const r = rulesOf(scan([modified('package.json', PKG, next)]));
    expect(r).toContain('zone-outside-allowed');
    expect(r).not.toContain('forge-core-dependency');
  });

  it('blocks patch-package in package.json', () => {
    const next = JSON.stringify({ ...JSON.parse(PKG), scripts: { postinstall: 'patch-package' } });
    expect(rulesOf(scan([modified('package.json', PKG, next)]))).toContain('patch-package');
  });

  it('blocks lockfile changes touching @forge/core', () => {
    const lock =
      "packages:\n\n  '@forge/core@1.2.3':\n    resolution: {integrity: sha512-AAA}\n\n  react@19.0.0:\n    resolution: {integrity: sha512-BBB}\n";
    const touched = lock.replace('sha512-AAA', 'sha512-EVIL');
    expect(rulesOf(scan([modified('pnpm-lock.yaml', lock, touched)]))).toContain(
      'lockfile-forge-core',
    );
    const untouched = lock.replace('sha512-BBB', 'sha512-CCC');
    const r = rulesOf(scan([modified('pnpm-lock.yaml', lock, untouched)]));
    expect(r).toContain('zone-outside-allowed');
    expect(r).not.toContain('lockfile-forge-core');
    const npmLock = JSON.stringify({
      packages: { 'node_modules/@forge/core': { version: '1.2.3', integrity: 'sha512-A' } },
    });
    const npmTouched = npmLock.replace('sha512-A', 'sha512-B');
    expect(rulesOf(scan([modified('package-lock.json', npmLock, npmTouched)]))).toContain(
      'lockfile-forge-core',
    );
  });
});

describe('fail closed', () => {
  it('rejects malformed input instead of passing', () => {
    expect(rulesOf(scanDiff({ files: 'nope' } as never))).toContain('path-invalid');
    expect(
      rulesOf(scanDiff([{ path: 'src/components/x.ts', status: 'weird' } as never])),
    ).toContain('path-invalid');
    expect(
      rulesOf(
        scanDiff([
          { path: 'src/components/x.ts', status: 'added', oldContent: null, newContent: null },
        ]),
      ),
    ).toContain('encoding-invalid');
  });

  it('passes an empty diff', () => {
    expect(scanDiff([])).toEqual({ ok: true });
  });
});
