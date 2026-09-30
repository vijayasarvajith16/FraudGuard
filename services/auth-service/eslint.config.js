'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const jest = require('eslint-plugin-jest');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      strict: ['error', 'global'],
      eqeqeq: ['error', 'always'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      'prefer-const': 'error',
    },
  },
  { files: ['tests/**/*.js'], ...jest.configs['flat/recommended'] },
  prettier,
];
