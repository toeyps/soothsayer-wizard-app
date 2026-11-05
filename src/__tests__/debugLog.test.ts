import { describe, it, expect, vi, afterEach } from 'vitest';
import { debugLog } from '../utils/debugLog';

/** debugLog forwards arguments to console.log while DEV is true; production silence cannot be tested (Vite inlines DEV). */
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
