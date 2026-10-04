import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default [
  js.configs.recommended, ...ts.configs.recommended,
  {files: ['**/*.tsx'], plugins: {'react-hooks': hooks}, rules: {
    ...hooks.configs.recommended.rules,
  }},
  {files: ['**/*.mjs'], languageOptions: {globals: {process: 'readonly', Buffer: 'readonly'}}},
  { ignores: ['**/.next/**', '**/node_modules/**', '**/next-env.d.ts', 'playwright-report/**', 'test-results/**', 'state/**'] },
];
