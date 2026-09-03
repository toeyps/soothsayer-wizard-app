import { describe, it, expect, vi, afterEach } from 'vitest';
import { debugLog } from '../utils/debugLog';

/**
 * `debugLog` replaced 17 bare `console.log` calls that were shipping in
 * production paths (2026-09-02). These tests pin the two properties the rest
 * of the app relies on: it forwards to console.log while `import.meta.env.DEV`
 * is true (dev + tests), and it is a plain pass-through — no formatting, no
 * swallowing of arguments — so a call site reads the same as the console.log
 * it replaced.
 *
 * The production half (silence when DEV is false) is not asserted here:
 * Vite statically replaces `import.meta.env.DEV` at build time, so it cannot
 * be toggled from inside a Vitest run without stubbing the module graph, and
 * a test that stubbed it would only be re-testing Vite's own substitution.
 */
describe('debugLog', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('forwards to console.log in dev/test builds', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        debugLog('hello');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('hello');
    });

    it('passes every argument through untouched', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const payload = { id: 'ws-1', rows: 42 };
        debugLog('Saving:', payload, 7);
        expect(spy).toHaveBeenCalledWith('Saving:', payload, 7);
    });

    it('is safe to call with no arguments at all', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(() => debugLog()).not.toThrow();
        expect(spy).toHaveBeenCalledWith();
    });
});
