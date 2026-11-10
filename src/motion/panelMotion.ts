// Dashboard panel close (eye button), the mirror of the open: the closing panel fades and shrinks toward the strip on
// the left, the panels that stay grow into the freed space, the strip slides in. Sizes tween once, then split.js and the
// CSS own them again (the animations have no fill). Nothing runs while a gutter is dragged.
const ID = 'm-panel';

const slowMs = (doc: Document) => {
    const p = doc.createElement('i');
    p.style.cssText = 'position:absolute;visibility:hidden;transition-duration:var(--dur-slow)';
    doc.body.appendChild(p);
    const v = parseFloat(getComputedStyle(p).transitionDuration) || 0;
    p.remove();
    return v * 1000;
};

type Snap = { rects: Map<Element, DOMRect>; pad: number; side: boolean; at: number };

export function installPanelMotion(doc: Document = document) {
    if (typeof MutationObserver === 'undefined') return () => {};
    let snap: Snap | null = null;
    const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)', EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';

    doc.addEventListener('click', e => {
        const b = (e.target as Element | null)?.closest?.('[title="Hide panel"]');
        if (!b || !b.closest('.dashboard-container')) return;
        const grid = doc.querySelector('.dashboard-grid-2x2');
        const rects = new Map<Element, DOMRect>();
        doc.querySelectorAll('.dashboard-slot:not(.m-ghost), .left-column, .right-column').forEach(el => rects.set(el, el.getBoundingClientRect()));
        snap = { rects, pad: grid ? parseFloat(getComputedStyle(grid).paddingLeft) : 0, side: !!doc.querySelector('.collapsed-tabs-sidebar'), at: performance.now() };
    }, true);

    // A gutter drag always wins: the tween stops and split.js has the sizes at once.
    doc.addEventListener('pointerdown', e => {
        if ((e.target as Element | null)?.closest?.('.gutter') && typeof doc.getAnimations === 'function') doc.getAnimations().forEach(a => { if (a.id === ID) try { a.cancel(); } catch { /* never raise */ } });
    }, true);

    const mo = new MutationObserver(records => { try { onRecords(records); } catch { /* motion must never raise an app error */ } });
    const onRecords = (records: MutationRecord[]) => {
        if (!snap || performance.now() - snap.at > 500) return;
        let gone: HTMLElement | null = null;
        for (const r of records) for (const n of r.removedNodes) if (n instanceof HTMLElement && n.classList.contains('dashboard-slot') && !n.classList.contains('m-ghost')) gone = n;
        if (!gone) return;
        const s = snap; snap = null;
        const ms = slowMs(doc);
        if (ms <= 0) return;

        // 1. The closing panel: a copy pinned where it was (on <body>, so a column that just hid cannot hide it too).
        doc.querySelectorAll('.dashboard-slot.m-ghost').forEach(g => g.remove()); // presence's in-flow copy would hold the space
        const old = s.rects.get(gone);
        if (old) {
            const g = gone.cloneNode(true) as HTMLElement;
            g.classList.add('m-ghost');
            g.setAttribute('aria-hidden', 'true');
            g.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
            // Canvas pixels are not cloned; copy what can be copied (2D charts) so the chart fades instead of blanking.
            const from = gone.querySelectorAll('canvas'), to = g.querySelectorAll('canvas');
            to.forEach((c, i) => { try { const ctx = c.getContext('2d'); if (ctx) ctx.drawImage(from[i], 0, 0); } catch { /* WebGL or tainted: left blank */ } });
            Object.assign(g.style, { position: 'fixed', left: `${old.left}px`, top: `${old.top}px`, width: `${old.width}px`, height: `${old.height}px`, margin: '0', zIndex: '5', pointerEvents: 'none', transformOrigin: 'left center', flex: 'none' });
            doc.body.appendChild(g);
            g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-24px) scale(0.96)' }], { duration: ms * 0.75, easing: EASE_IN, fill: 'forwards' })
                .finished.finally(() => g.remove());
        }

        // 2. The panels that stay grow from their old size to the new one (one tween; no fill, so split.js keeps them).
        // Measured in the next frame, before it paints: split.js tears down in an effect that runs after this observer.
        requestAnimationFrame(() => {
            // Measure everything first: starting one tween changes the layout the next measurement would read.
            const grid = doc.querySelector<HTMLElement>('.dashboard-grid-2x2');
            const pad = grid ? parseFloat(getComputedStyle(grid).paddingLeft) : s.pad;
            const grow: [HTMLElement, number, number][] = [];
            for (const [el, was] of s.rects) {
                if (el === gone || !el.isConnected) continue;
                const now = el.getBoundingClientRect();
                if (!now.width || !now.height) continue;
                const vertical = el.classList.contains('dashboard-slot') && (el.parentElement && getComputedStyle(el.parentElement).flexDirection === 'column');
                const a = vertical ? was.height : was.width, b = vertical ? now.height : now.width;
                if (Math.abs(a - b) >= 1) grow.push([el as HTMLElement, a, b]);
            }
            if (grid && pad !== s.pad) grid.animate([{ paddingLeft: `${s.pad}px` }, { paddingLeft: `${pad}px` }], { id: ID, duration: ms, easing: EASE_OUT });
            for (const [el, a, b] of grow) el.animate([{ flex: `0 0 ${a}px` }, { flex: `0 0 ${b}px` }], { id: ID, duration: ms, easing: EASE_OUT });
        });

        // 3. The strip slides in from the left edge when it first appears (later tabs reveal on their own).
        const side = doc.querySelector<HTMLElement>('.collapsed-tabs-sidebar');
        if (side && !s.side) side.animate([{ opacity: 0, transform: 'translate(-100%, -50%)' }, { opacity: 1, transform: 'translate(0, -50%)' }], { duration: ms, easing: EASE_OUT });
    };
    mo.observe(doc.documentElement, { subtree: true, childList: true });
    return () => mo.disconnect();
}
