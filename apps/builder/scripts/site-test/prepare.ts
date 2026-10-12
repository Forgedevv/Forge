/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LaunchpadSpec } from '@forge/shared';
import { z } from 'zod';
import { allowedImageUrls } from '../../src/pipeline/build.js';
import type { GateBaseline } from '../../src/pipeline/gate.js';
import {
  initialSiteConfig,
  serializeSiteConfig,
  SITE_CONFIG_PATH,
} from '../../src/pipeline/site-config.js';
import { readWorkdirTree, type BaselineFile } from '../../src/pipeline/workdir.js';
import { builderSystemPrompt, createTaskPrompt } from '../../src/prompts/index.js';
import { base58Encode } from '../../src/scan/base58.js';
import { REPO_ROOT, TEMPLATE_DIR, ToolError, writeState, type Layout } from './layout.js';

/**
 * A brief: a partial LaunchpadSpec. `name`, `slug`, `theme` and `launchpadCoin` matter for the
 * design; everything else gets a valid dummy (the owner wallet is 32 random bytes, base58).
 */
export const BriefSchema = z.looseObject({
  name: z.string(),
  slug: z.string(),
  theme: z.record(z.string(), z.unknown()).default({}),
  launchpadCoin: z.record(z.string(), z.unknown()).default({}),
});

export function specFromBrief(raw: unknown): LaunchpadSpec {
  const brief = BriefSchema.parse(raw);
  const result = LaunchpadSpec.safeParse({
    version: 1,
    ownerWallet: base58Encode(randomBytes(32)),
    quote: 'SOL',
    tradingFeeBps: 100,
    poolCreationFeeSol: 0,
    ...brief,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: '',
      designNotes: '',
      ...brief.theme,
    },
    launchpadCoin: {
      name: brief.name.slice(0, 32),
      symbol: 'COIN',
      description: '',
      imageUrl: 'https://example.com/coin.png',
      firstBuySol: 0,
      ...brief.launchpadCoin,
    },
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new ToolError(`the brief does not make a valid LaunchpadSpec: ${fields.join(', ')}`);
  }
  return result.data;
}

interface BaselineJson {
  configText: string;
  configReference: string | null;
  files: Array<{ path: string; executable: boolean; content: string }>;
}

/** The baseline saved by `prepare`: what the scan compares the agent's work to. */
export function loadBaseline(layout: Layout): GateBaseline {
  const raw = JSON.parse(readFileSync(layout.baseline, 'utf8')) as BaselineJson;
  const map = new Map<string, BaselineFile>();
  for (const f of raw.files) {
    map.set(f.path, { content: Buffer.from(f.content, 'base64'), executable: f.executable });
  }
  return { map, configText: raw.configText, configReference: raw.configReference };
}

function packageVersion(dir: string): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string') throw new ToolError(`${dir} has no version`);
  return pkg.version;
}

export async function prepare(layout: Layout, briefPath: string): Promise<void> {
  if (existsSync(layout.out) && readdirSync(layout.out).length > 0) {
    throw new ToolError(`${layout.out} is not empty: give a new output folder`);
  }
  const brief: unknown = JSON.parse(readFileSync(briefPath, 'utf8'));
  const spec = specFromBrief(brief);
  mkdirSync(layout.prompts, { recursive: true });
  writeFileSync(layout.brief, `${JSON.stringify(brief, null, 2)}\n`);
  writeFileSync(layout.spec, `${JSON.stringify(spec, null, 2)}\n`);

  // The standalone template, exactly as the template repository is produced.
  execFileSync(
    process.execPath,
    [
      path.join(TEMPLATE_DIR, 'scripts', 'prepare-template-repo.mjs'),
      '--out',
      layout.site,
      '--pin',
      `@forge/core=${packageVersion('packages/core')}`,
      '--pin',
      `@forge/shared=${packageVersion('packages/shared')}`,
    ],
    { cwd: TEMPLATE_DIR, stdio: 'inherit' },
  );

  // forge.config.json from the spec, like build.ts on a creation; the template's sample stays
  // the reference the scan compares theme/content to.
  const configFile = path.join(layout.site, SITE_CONFIG_PATH);
  const configReference = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null;
  const configText = serializeSiteConfig(initialSiteConfig(spec));
  writeFileSync(configFile, configText);

  const tree = await readWorkdirTree(layout.site);
  const odd = tree.filter((e) => e.mode !== '100644' && e.mode !== '100755');
  if (odd.length > 0) throw new ToolError(`unexpected entries in the template: ${odd[0]!.path}`);
  const baseline: BaselineJson = {
    configText,
    configReference,
    files: tree.map((e) => ({
      path: e.path,
      executable: e.mode === '100755',
      content: e.content.toString('base64'),
    })),
  };
  writeFileSync(layout.baseline, JSON.stringify(baseline));

  writeFileSync(path.join(layout.prompts, 'system.txt'), builderSystemPrompt());
  writeFileSync(
    path.join(layout.prompts, 'task.txt'),
    createTaskPrompt(spec, {
      imageUrls: allowedImageUrls(undefined, {
        logoUrl: spec.theme.logoUrl,
        coinImageUrl: spec.launchpadCoin.imageUrl,
      }),
    }),
  );
  writeState(layout, {
    version: 1,
    linkedNodeModules: false,
    envLocal: false,
    nextDev: false,
    captures: [],
  });
  console.log(`prepared ${spec.name} (${spec.slug}): ${tree.length} files in ${layout.site}`);
  console.log(`prompts: ${layout.prompts}`);
}
