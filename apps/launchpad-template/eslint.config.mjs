import globals from 'globals';
import rootConfig from '../../eslint.config.js';

// Reuses the monorepo flat config. The vendored fun-launch code base was written with looser rules,
// so a few rules are relaxed here (see README.md, "Lint").
export default [
  ...rootConfig,
  {
    ignores: ['next-env.d.ts', 'src/components/AdvancedTradingView/charting_library.d.ts'],
  },
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
