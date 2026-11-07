import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LINK_HOSTS } from './config.js';

/**
 * The launchpad template's library components check link targets passed as props (which the scan
 * cannot follow) against their own copy of the navigation hosts: it must match the scan's list.
 */
describe('library link hosts', () => {
  it('mirror the scan navigation hosts', () => {
    const source = readFileSync(
      new URL(
        '../../../launchpad-template/src/components/library/shared/safeHref.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const block = /LINK_HOSTS: readonly string\[\] = \[([\s\S]*?)\];/.exec(source)?.[1];
    expect(block, 'LINK_HOSTS array in safeHref.ts').toBeDefined();
    const hosts = [...(block ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(hosts).toEqual([...DEFAULT_LINK_HOSTS]);
  });
});
