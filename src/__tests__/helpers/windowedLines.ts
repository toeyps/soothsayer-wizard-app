import { vi } from 'vitest';

/** jsdom has no layout: `captureResizeObservers` stubs ResizeObserver so a test can say the browser noticed a size change (`fire`) with no commit; `setLineHeight` is the change itself, read via `getComputedStyle`. Undo with `vi.unstubAllGlobals()`. */
export interface ResizeObservers {
    fire: () => void;
    watching: (el: Element) => boolean;
    created: () => number;
    live: () => number;
}

export function captureResizeObservers(): ResizeObservers {
    const all = new Set<{ cb: () => void; els: Set<Element> }>();
    let created = 0;
    class Stub {
        private entry: { cb: () => void; els: Set<Element> };
        constructor(cb: () => void) {
            created++;
            this.entry = { cb, els: new Set() };
            all.add(this.entry);
        }
        observe(el: Element) { this.entry.els.add(el); }
        unobserve(el: Element) { this.entry.els.delete(el); }
        disconnect() { all.delete(this.entry); }
    }
    vi.stubGlobal('ResizeObserver', Stub);
    return {
        fire: () => { for (const o of [...all]) if (o.els.size) o.cb(); },
        watching: el => [...all].some(o => o.els.has(el)),
        created: () => created,
        live: () => all.size,
    };
}

export function setLineHeight(el: HTMLElement, px: number) {
    el.style.height = `${px}px`;
}
