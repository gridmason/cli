import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Align the unused-vars rule with tsc's `noUnusedParameters`, which ignores
    // `_`-prefixed names — the convention for a deliberately-unused parameter
    // (e.g. a seam whose signature is fixed before its body exists).
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
