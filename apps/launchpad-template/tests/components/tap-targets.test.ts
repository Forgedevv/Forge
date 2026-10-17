import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config.js';

/**
 * Small controls stay compact on desktop and grow to a 40px tap target (at least) on touch screens
 * and phones, through the `touch:` variant of tailwind.config.js.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('tap targets on touch screens', () => {
  it('defines the touch variant for coarse pointers and phone widths', () => {
    const variants: Array<[string, string]> = [];
    const plugins = (tailwindConfig as { plugins: unknown[] }).plugins;
    for (const plugin of plugins) {
      const handler = (plugin as { handler?: (api: unknown) => void }).handler;
      handler?.({
        addVariant: (name: string, value: string) => variants.push([name, value]),
        addUtilities: () => {},
        addComponents: () => {},
        matchUtilities: () => {},
        theme: () => ({}),
      });
    }
    expect(variants).toContainEqual(['touch', '@media (pointer: coarse), (max-width: 639px)']);
  });

  it('gives the trade presets, Max, slippage presets and custom slippage input 40px on touch', () => {
    const form = read('src/forge/trade/TradeForm.tsx');
    const chip = /const chipClass =\s*'([^']+)'/.exec(form)?.[1] ?? '';
    expect(chip).toContain('touch:min-h-[2.5rem]');
    // Presets, Max and slippage presets all use the chip class.
    expect(form.match(/\$\{chipClass\}/g)?.length).toBe(3);
    expect(form).toMatch(/id="forge-trade-slippage"[\s\S]*?touch:min-h-\[2\.5rem\] touch:text-base/);
  });

  it('gives the header buttons, the theme toggle and the market tabs 40px on touch', () => {
    const button = read('src/components/ui/button.tsx');
    expect(button).toMatch(/default: '[^']*touch:h-10/);
    expect(button).toMatch(/icon: '[^']*touch:h-10 touch:w-10/);
    expect(read('src/components/ThemeToggle.tsx')).toContain('touch:h-10 touch:w-10');
    expect(read('src/components/Explore/MobileExploreTabs.tsx')).toMatch(/h-10 [^"]*touch:h-11/);
  });
});
