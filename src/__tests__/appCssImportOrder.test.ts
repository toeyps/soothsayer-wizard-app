import { describe, it, expect } from 'vitest';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

// `?raw` on a .css file returns '' under vitest, so read the file directly (cwd = repo root).
const css: string = readFileSync('src/App.css', 'utf8');

// CSS ignores an @import after any other rule, so every @import must come first (a @source before it dropped the fonts).
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
