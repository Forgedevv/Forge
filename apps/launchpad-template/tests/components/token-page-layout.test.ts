import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Token page on phones and tablets (375, 390 and 768px wide): one column, nothing wider than the
 * screen. Wide tables scroll inside their own frame, long addresses are truncated with a copy
 * button, and the trade panel shrinks with its column.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const css = read('src/theme/theme.css');

describe('token page layout on small screens', () => {
  it('stacks stats, chart, trade panel and tables in one shrinkable column below 1000px', () => {
    const narrow = /@media \(max-width: 1000px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/\.launchpad-token-grid \{ grid-template-columns: minmax\(0, 1fr\);/);
    expect(narrow).toContain("'stats' 'chart' 'trade' 'tables'");
    expect(css).toMatch(/\.launchpad-token-trade \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.launchpad-token-chart \{[^}]*min-width: 0/);
  });

  it('scrolls the transaction and holder tables inside their own frame, on both axes', () => {
    for (const file of [
      'src/components/TokenTable/TxnsTab/TxTable.tsx',
      'src/components/TokenTable/HoldersTab/HoldersTable/index.tsx',
    ]) {
      expect(read(file), file).toContain('ref={parentRef} className="min-h-0 flex-1 overflow-auto"');
    }
    expect(read('src/pages/token/[tokenId].tsx')).toContain(
      'className="launchpad-token-tables flex flex-col overflow-hidden"',
    );
  });

  it('truncates the coin address in the header and keeps it copyable', () => {
    const header = read('src/components/TokenHeader/TokenHeader.tsx');
    expect(header).toContain('<Copyable');
    expect(header).toContain('<TruncatedAddress');
    expect(header).toContain('truncate font-medium');
  });
});
