import { listen } from '@tauri-apps/api/event';
import type { Event, UnlistenFn } from '@tauri-apps/api/event';

/** Subscribe to a Tauri event with a synchronous cleanup. `await listen(...)` leaks the handler if cleanup runs before it resolves; here cleanup sets `disposed` and the late `unlisten` is called as soon as it resolves. */
export type Unsubscribe = (() => void) & {
    /** Resolves once the listener is registered; await it before emitting a request whose reply it must not miss. */
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
