import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // tsconfig keeps `jsx: preserve` for Next; tests compile JSX with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['tests/**/*.test.{ts,tsx}'] },
});
