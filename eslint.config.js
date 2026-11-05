import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Flat ESLint config (ESLint 9).
 *
 * Added 2026-09-03. Before this the repo had ELEVEN
 * `// eslint-disable-next-line react-hooks/exhaustive-deps` comments and no
 * ESLint installed at all — suppressions for a linter that never ran, so the
 * one rule that actually catches stale-closure bugs (the class of bug this
 * project has hit repeatedly) was never enforced.
 *
 * Deliberately narrow: `tsc` already owns type errors and unused symbols
 * (`strict`, `noUnusedLocals`, `noUnusedParameters` in tsconfig.json), so this
 * config only adds what the compiler cannot see. `eslint-plugin-react-hooks`
 * v7 ships React Compiler rules in its `recommended` preset; those are not
 * enabled here — this codebase was never written against them and turning
 * them on would bury the two rules that matter under hundreds of findings.
 * Revisit if the project ever adopts the React Compiler.
 */
export default tseslint.config(
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'src-tauri/target/**',
            'src-tauri/python/**',
        ],
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.es2022 },
        },
        plugins: { 'react-hooks': reactHooks },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',

            // Deferred to tsc, which already enforces them.
            '@typescript-eslint/no-unused-vars': 'off',

            // Advisory only: flags defensive initialisers that every branch overwrites; removing them is churn.
            'no-useless-assignment': 'warn',

            // Known debt, surfaced as warnings so CI still passes.
            // Tightening the `any`s is its own task.
            '@typescript-eslint/no-explicit-any': 'warn',
            // Dev logging goes through `debugLog()` (silent in production); console.warn/error stay.
            'no-console': ['warn', { allow: ['warn', 'error'] }],
        },
    },
    {
        // Tests run under Vitest globals and use `any` for fixtures and loose mock payloads.
        files: ['src/__tests__/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.node } },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            'no-console': 'off',
        },
    },
);
