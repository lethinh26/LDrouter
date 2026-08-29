import js from '@eslint/js';
import tsplugin from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'migrations/**', 'src/web/dist/**', 'playwright-report/**', 'test-results/**', 'src/web/components/ui/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'tests/**/*.{ts,tsx}', 'tests/e2e/**/*.mjs'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: {
      '@typescript-eslint': tsplugin,
      react,
      'react-hooks': reactHooks,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...tsplugin.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // TypeScript already reports undefined variables and redeclarations at
      // compile time; the JS-core rules false-positive on TS globals (NodeJS,
      // RequestInit, React) and on interface/function declaration merging.
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
