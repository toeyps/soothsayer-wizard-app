import { describe, it, expect } from 'vitest';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

// `?raw` on a .css file returns '' under vitest, so read the file directly (cwd = repo root).
const css: string = readFileSync('src/App.css', 'utf8');

// CSS ignores any @import that comes after another rule, and Vite prints
// "@import must precede all other statements". A Tailwind `@source` placed
// before the Google Fonts @import silently dropped the Inter / JetBrains Mono
// fonts (2026-10-04). Every @import must come before any @source / rule.
describe('App.css statement order', () => {
  it('keeps every @import before the first @source or style rule', () => {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const lastImport = noComments.lastIndexOf('@import');
    const firstOther = noComments.search(/@source|[^@\s;}{][^{;]*\{/);
    expect(lastImport).toBeGreaterThan(-1);
    expect(firstOther).toBeGreaterThan(lastImport);
  });

  it('still loads the Google Fonts stylesheet', () => {
    expect(css).toContain('fonts.googleapis.com');
  });
});
