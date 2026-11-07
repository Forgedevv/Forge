import { LIBRARY } from '@/components/library/registry';
import { FAMILY_LABELS, LIBRARY_FAMILIES } from '@/components/library/types';
import {
  SECTIONS,
  SECTION_SLOTS,
  SLOT_DEFAULTS,
  SLOT_LABELS,
} from '@/components/sections/registry';

/**
 * Text catalogue of the visual library for the builder agent (`src/components/sections/CATALOGUE.md`)
 * and the compact list of section variants the builder rotates through
 * (`src/components/sections/catalogue.json`). Both are generated from the registries: the test
 * `catalogue.test.ts` fails when they drift, and `UPDATE_CATALOGUE=1` rewrites them.
 */

const WEIGHT_TEXT = {
  light: 'light (CSS or SVG)',
  medium: 'medium (JS or 2D canvas)',
  heavy: 'heavy (WebGL or 3D, loaded after the page)',
} as const;

export function renderCatalogueMarkdown(): string {
  const out: string[] = [
    '# Visual library catalogue',
    '',
    '<!-- Generated from src/components/sections/registry.ts and src/components/library/registry.ts. -->',
    '',
    'Ready-made sections and effects for the home page and footer. Every section reads its copy from',
    '`src/content/index.ts` by default and takes the same copy as props; every effect follows the',
    'theme colours (`--color-primary`, `--color-accent`, `--color-bg`, `--color-text`), works on phones',
    'and stops moving under "reduce motion". Heavy effects load after the page, only on screens',
    'that can run them, and show a static look elsewhere.',
    '',
    '## Section variants',
    '',
    'Pick one variant per slot, or keep the template section and restyle it. Use a variant by',
    'importing it in place of the template section it replaces; give it copy props only where the',
    'brief needs other words than `content`.',
    '',
  ];
  for (const slot of SECTION_SLOTS) {
    out.push(`### ${SLOT_LABELS[slot]}`, '', `Replaces \`${SLOT_DEFAULTS[slot]}\`.`, '');
    for (const entry of SECTIONS.filter((e) => e.slot === slot)) {
      out.push(
        `- \`${entry.id}\` **${entry.name}**: ${entry.description}`,
        `  \`import { ${entry.exportName} } from '${entry.importPath}';\``,
        `  Moods: ${entry.moods.join(', ')}. Weight: ${entry.weight}.${
          entry.options ? ` Options: ${entry.options}.` : ''
        }`,
      );
    }
    out.push('');
  }
  out.push(
    '## Effects',
    '',
    'The building blocks of the sections, to compose sections of your own. Read the props in the',
    'file before using one: each prop is documented there.',
    '',
  );
  for (const family of LIBRARY_FAMILIES) {
    out.push(`### ${FAMILY_LABELS[family]}`, '');
    for (const entry of LIBRARY.filter((e) => e.family === family)) {
      out.push(
        `- \`${entry.id}\` **${entry.name}**: ${entry.description}`,
        `  \`import { ${entry.exportName} } from '${entry.importPath}';\``,
        `  Moods: ${entry.moods.join(', ')}. Weight: ${WEIGHT_TEXT[entry.weight]}.`,
      );
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export function renderCatalogueJson(): string {
  const sections = SECTIONS.map((entry) => ({
    id: entry.id,
    slot: entry.slot,
    moods: entry.moods,
    weight: entry.weight,
  }));
  return `${JSON.stringify({ slots: SECTION_SLOTS, sections }, null, 2)}\n`;
}
