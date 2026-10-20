// @vitest-environment node
/**
 * QA 2026-10-19 — the Import page's "Supported:" list (`SensorDataPanel.tsx`
 * SUPPORTED_TIMESTAMPS, shown when 2+ files are picked) promises the user that these
 * shapes are read. The promise is kept by the Rust test
 * `the_timestamp_shapes_the_import_page_lists_are_the_ones_parsed` in
 * `src-tauri/src/csv_processor.rs` — but only while every listed example is IN that test.
 * This reads the real Rust source so an example added to the page without a Rust check
 * (or a Rust test trimmed later) fails here instead of silently shipping an untested claim.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import { SUPPORTED_TIMESTAMPS } from '../components/upload/SensorDataPanel';

const RUST: string = readFileSync('src-tauri/src/csv_processor.rs', 'utf8');

/** The body of the Rust test that checks the page's list. */
const body = (() => {
    const start = RUST.indexOf('fn the_timestamp_shapes_the_import_page_lists_are_the_ones_parsed');
    if (start < 0) throw new Error('the Rust test is gone — the page list is no longer checked');
    const next = RUST.indexOf('#[test]', start);
    return RUST.slice(start, next < 0 ? undefined : next);
})();

describe('Import page timestamp examples <-> the Rust parser test', () => {
    it('every example the page lists is one the Rust test reads', () => {
        const missing = SUPPORTED_TIMESTAMPS.filter(s => !body.includes(`"${s}"`));
        expect(missing).toEqual([]);
    });

    it('none of the page examples is in the Rust test\'s "not read" list', () => {
        const end = body.indexOf('is listed as not read');
        expect(end).toBeGreaterThan(0);
        const notRead = body.slice(body.lastIndexOf('for s in [', end), end);
        expect(SUPPORTED_TIMESTAMPS.filter(s => notRead.includes(`"${s}"`))).toEqual([]);
    });
});
