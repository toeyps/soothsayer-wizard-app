import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: unknown) => mockListen(event, cb),
}));

import { subscribe } from '../utils/tauriEvents';

beforeEach(() => {
    mockListen.mockReset();
});

describe('subscribe', () => {
    it('unlistens on cleanup once the listener is registered', async () => {
        const unlisten = vi.fn();
        mockListen.mockResolvedValue(unlisten);
        const off = subscribe('evt', () => {});
        await off.ready;
        off();
        expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it('still unlistens when cleanup runs BEFORE listen() resolves (regression: `unlisten = await listen(...)` + `return () => unlisten?.()` left the handler alive forever — a stale closure that kept answering request-sensors / request-build-model-data with an old project\'s data)', async () => {
        const unlisten = vi.fn();
        let resolveListen!: (fn: () => void) => void;
        mockListen.mockReturnValue(new Promise<() => void>(res => { resolveListen = res; }));

        const off = subscribe('evt', () => {});
        off(); // effect cleaned up while the async registration is still in flight
        expect(unlisten).not.toHaveBeenCalled();

        resolveListen(unlisten);
        await off.ready;
        expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it('does not unlisten twice', async () => {
        const unlisten = vi.fn();
        mockListen.mockResolvedValue(unlisten);
        const off = subscribe('evt', () => {});
        await off.ready;
        off();
        off();
        expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it('ready resolves only once the listener is actually registered, so a request can be emitted afterwards without missing the reply', async () => {
        let resolveListen!: (fn: () => void) => void;
        mockListen.mockReturnValue(new Promise<() => void>(res => { resolveListen = res; }));
        const off = subscribe('evt', () => {});
        let ready = false;
        off.ready.then(() => { ready = true; });
        await Promise.resolve();
        expect(ready).toBe(false);
        resolveListen(() => {});
        await off.ready;
        expect(ready).toBe(true);
    });

    it('a failing listen() does not throw or reject ready', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockListen.mockRejectedValue(new Error('boom'));
        const off = subscribe('evt', () => {});
        await expect(off.ready).resolves.toBeUndefined();
        expect(() => off()).not.toThrow();
        warn.mockRestore();
    });
});
