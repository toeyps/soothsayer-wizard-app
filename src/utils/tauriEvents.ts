import { listen } from '@tauri-apps/api/event';
import type { Event, UnlistenFn } from '@tauri-apps/api/event';

/**
 * Subscribe to a Tauri event and get back a SYNCHRONOUS cleanup function.
 *
 * `listen()` is async. The common `unlisten = await listen(...)` +
 * `return () => unlisten?.()` pattern silently leaks the listener whenever
 * the effect is cleaned up before that promise resolves (StrictMode's
 * mount/unmount/mount, or a dependency change right after mount) — the
 * cleanup runs while `unlisten` is still undefined, and the handler then
 * lives on forever with a stale closure. In this multi-window app a leaked
 * handler answers requests (`request-sensors`, `request-build-model-data`)
 * with an OLD workspace's data. Here the cleanup flips `disposed`, and the
 * late-arriving unlisten function is invoked as soon as it resolves.
 */
export type Unsubscribe = (() => void) & {
    /** Resolves once the listener is actually registered — await it before
     *  emitting a request whose reply this listener must not miss. */
    ready: Promise<void>;
};

export function subscribe<T>(event: string, handler: (event: Event<T>) => void): Unsubscribe {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const ready = Promise.resolve(listen<T>(event, handler)).then(fn => {
        if (disposed) fn();
        else unlisten = fn;
    }).catch(e => console.warn(`Failed to subscribe to "${event}":`, e));
    const off = (() => {
        disposed = true;
        const fn = unlisten;
        unlisten = undefined;
        if (fn) fn();
    }) as Unsubscribe;
    off.ready = ready;
    return off;
}
