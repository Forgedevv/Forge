import { describe, expect, it } from 'vitest';

import { checkAgentSiteConfig } from '../pipeline/site-config.js';
import { added, deleted, modified, renamed, rulesOf, scan } from './test-helpers.js';

/**
 * Regression (wave 5 review): the template's mode gate (`src/forge/ModeGate.tsx`) decides from
 * forge.config.json `mode`, read through `src/forge/config.ts`, whether a sleeping or disabled site
 * renders anything but its static page. The agent must not be able to change anything that feeds
 * that decision, nor the files that render around it.
 */

const CONFIG_PATH = 'forge.config.json';

function config(mode: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      version: 1,
      name: 'MoonPad',
      slug: 'moonpad',
      mode,
      theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
      content: { tagline: 'To the moon', about: 'A launchpad.' },
      ...extra,
    },
    null,
    2,
  );
}

describe('the site mode cannot be changed by the agent', () => {
  const cases: Array<[string, string, string]> = [
    ['disabled -> live', config('disabled'), config('live')],
    ['disabled -> sleeping', config('disabled'), config('sleeping')],
    ['sleeping -> live', config('sleeping'), config('live')],
    ['live -> sleeping', config('live'), config('sleeping')],
    [
      'mode removed (left to a default)',
      config('disabled'),
      JSON.stringify(JSON.parse(config('disabled'), (k, v) => (k === 'mode' ? undefined : v))),
    ],
    [
      'duplicate mode key (parsers disagree on which one wins)',
      config('disabled'),
      config('disabled').replace('"mode": "disabled",', '"mode": "disabled",\n  "mode": "live",'),
    ],
    [
      'mode moved to the prototype',
      config('disabled'),
      config('disabled').replace('"mode": "disabled",', '"__proto__": { "mode": "live" },'),
    ],
    [
      'mode as a nested override',
      config('disabled'),
      config('disabled', { overrides: { mode: 'live' } }),
    ],
  ];

  for (const [name, before, after] of cases) {
    it(`scan refuses: ${name}`, () => {
      const rules = rulesOf(scan([modified(CONFIG_PATH, before, after)]));
      expect(
        rules.some((r) => r === 'forge-config-locked-field' || r === 'forge-config-invalid'),
        rules.join(', '),
      ).toBe(true);
    });

    it(`pipeline check refuses: ${name}`, () => {
      // Second line of defence: the agent's file against the one the builder wrote.
      expect(checkAgentSiteConfig(before, after).length).toBeGreaterThan(0);
    });
  }

  it('refuses deleting, renaming or re-adding forge.config.json', () => {
    expect(rulesOf(scan([deleted(CONFIG_PATH, config('disabled'))]))).toContain(
      'forge-config-locked-field',
    );
    expect(
      rulesOf(scan([renamed(CONFIG_PATH, 'src/content/old.json', config('disabled'))])),
    ).toContain('forge-config-locked-field');
    expect(rulesOf(scan([added(CONFIG_PATH, config('live'))]))).toContain(
      'forge-config-locked-field',
    );
    expect(checkAgentSiteConfig(config('disabled'), null).length).toBeGreaterThan(0);
  });

  it('still lets the agent change the theme and the content', () => {
    const next = config('disabled').replace('To the moon', 'Straight to the moon');
    expect(scan([modified(CONFIG_PATH, config('disabled'), next)])).toEqual({ ok: true });
    expect(checkAgentSiteConfig(config('disabled'), next)).toEqual([]);
  });
});

describe('nothing else that feeds or wraps the mode gate is writable', () => {
  const locked: Record<string, string> = {
    // The gate, the config reader, the mode capabilities and the static pages.
    'src/forge/ModeGate.tsx': 'forge-locked-zone',
    'src/forge/config.ts': 'forge-locked-zone',
    'src/forge/mode-guard.ts': 'forge-locked-zone',
    'src/forge/modes/DisabledPage.tsx': 'forge-locked-zone',
    'src/forge/modes/SleepingPage.tsx': 'forge-locked-zone',
    'src/forge/AppProviders.tsx': 'forge-locked-zone',
    // What renders around the gate.
    'src/pages/_app.tsx': 'app-shell-locked',
    'src/pages/_document.tsx': 'app-shell-locked',
    'src/components/modes/DisabledPage.tsx': 'app-shell-locked',
    // Module resolution: an alias could point @/forge/config to a free-zone file.
    'tsconfig.json': 'zone-outside-allowed',
    'src/components/tsconfig.json': 'special-file',
    'src/pages/jsconfig.json': 'special-file',
    'package.json': 'zone-outside-allowed',
    'next.config.ts': 'next-config',
    'src/content/next.config.mjs': 'next-config',
    'src/pages/babel.config.js': 'special-file',
    'src/pages/.babelrc': 'special-file',
    // A config file next to the real one (the gate reads ../../forge.config.json only).
    'forge.config.ts': 'zone-outside-allowed',
    'src/forge.config.json': 'zone-outside-allowed',
  };

  for (const [path, rule] of Object.entries(locked)) {
    it(`refuses a change to ${path}`, () => {
      expect(rulesOf(scan([modified(path, 'export {};\n', 'export const x = 1;\n')]))).toContain(
        rule,
      );
      expect(rulesOf(scan([added(path, 'export const x = 1;\n')]))).toContain(rule);
    });
  }

  it('keeps the app shell a free zone', () => {
    expect(
      scan([
        modified(
          'src/components/AppShell.tsx',
          'export function AppShell() { return <main />; }\n',
          'export function AppShell() { return <main className="p-4" />; }\n',
        ),
      ]),
    ).toEqual({ ok: true });
  });

  it('refuses mounting a second React root outside the gate', () => {
    expect(
      rulesOf(
        scan([
          added(
            'src/components/AppShell.tsx',
            `import { createRoot } from 'react-dom/client';\nexport function AppShell() { return null; }\nif (typeof document !== 'undefined') createRoot(document.body).render(null);\n`,
          ),
        ]),
      ),
    ).toContain('forbidden-import');
  });
});
