import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // tsconfig keeps `jsx: preserve` for Next; tests compile JSX with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  // Some suites load web3 and the Meteora SDK; give them room on a loaded machine.
  test: { include: ['tests/**/*.test.{ts,tsx}'], testTimeout: 30_000 },
});
