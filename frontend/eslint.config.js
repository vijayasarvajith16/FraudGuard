import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z_]' }],
      'no-console': 'error',
      'prefer-const': 'error',
    },
  },
  reactHooks.configs.flat['recommended-latest'],
  { files: ['src/**/*.jsx'], ...reactRefresh.configs.vite },
  { files: ['vite.config.js'], languageOptions: { globals: { ...globals.node } } },
  { files: ['tests/**/*.{js,jsx}'], languageOptions: { globals: { ...globals.node } } },
  prettier,
];
