import { describe, it, expect } from 'vitest';
import cfg from '../../vite.config.ts?raw';

// A change to any file Vite watches but the app does not import makes Vite
// full-reload the webview, which drops the open workspace back to the Import
// page during `tauri dev` (verified 2026-10-04: `touch CLAUDE.md` alone did it).
// Docs/tests/scripts/Rust edits must stay unwatched. Read as text because the
// config lives in the node tsconfig project, not the app's.
const watchBlock = cfg.slice(cfg.indexOf('watch:'));

describe('vite dev-server watch ignore list', () => {
  it('ignores non-app files so editing them never reloads the page', () => {
    for (const g of ['**/src-tauri/**', '**/docs/**', '**/scripts/**', '**/.claude/**', '**/src/__tests__/**', '**/*.md', '**/*.py']) {
      expect(watchBlock, g).toContain(`"${g}"`);
    }
  });

  it('does not ignore app source, so real edits still hot-reload', () => {
    expect(watchBlock).not.toMatch(/"\*\*\/src\/(\*\*|components|hooks|utils|types)/);
  });
});
