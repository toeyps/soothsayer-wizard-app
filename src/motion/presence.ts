// Generic motion for DOM changes React makes at once. One observer per document:
//  - an element that appears reveals (m-in) unless it already animates;
//  - an element that leaves gets a copy back in its place for --dur-exit (fade, collapse for list rows,
//    an overlay crossfade for page / tab content);
//  - new text in place fades up gently (m-flash, never from below 0.6);
//  - a class / inline-style / disabled change gets no cue from here: motion.css gives every element a default colour
//    and opacity transition, so a state change eases from what was on screen and never dips (no blink).
// Opt-outs: chart internals, cursor-following tooltips, rows a scroll recycled.
// Charts never move on interaction: everything inside a chart, its hover tooltips (ECharts puts its own on <body>,
// recognisable by its z-index) and the regl scatter / pair plots are left alone.
const CHART = '.chart-wrapper *, [_echarts_instance_], .echarts-for-react, .echarts-tooltip, [style*="z-index: 9999999"], .scatter-regl-wrap, .scatter-regl-tooltip, .pair-regl-wrap';
const SKIP = CHART + ', .m-ghost, canvas, svg, script, style, option, .gutter, .pane-resize, .line-tip, .scatter-regl-tooltip-ts';
const SWAP = '.page-step, .m-swap, .widget-content, .bmw-pagebody, .bmw-detail, .app-page-transition > *';
const COLLAPSE = [
    '.fg-group-card', '.filter-row-wrap', '.highlights-chip', '.f4-fgchip', '.comp-chip', '.tq-qrow', '.up-tag-head', '.up-lane',
    '.bmw-sets-body', '.fg-srow-body', '[data-testid="file-row"]', '.hs-chk', '.hs-fix', '.bmw-srow', '.sensor-list-row',
    '.component-group-header', '.pk-row', '.pk-g', '.fg-sheet-confirm', '.rcc-line-item', '.rcc-grid', 'li', 'tr', '.fg-step-card',
    '.special-sensor-explorer-row', '.ex-nc-item', '.tq-seg-i', '.filter-row', '.rs-row', '.rcx-line',
].join(',');
const WINDOWED = '.sensor-list-row, .bmw-srow, .pk-row, .pk-g, .sensor-run-prefix, .component-group-header';
const SLIDE = '.bmw-side';

// --dur-exit is a calc(); a probe element resolves it to a plain duration.
const exitMs = (doc: Document) => {
    const p = doc.createElement('i');
    p.style.cssText = 'position:absolute;visibility:hidden;transition-duration:var(--dur-exit)';
    doc.body.appendChild(p);
    const v = parseFloat(getComputedStyle(p).transitionDuration) || 0;
    p.remove();
    return v * 1000;
};

const skip = (el: Element) => !!el.closest(SKIP);
// Ends a one-off animation at once. Never one that loops (a spinner, a pulse): finish() throws on those, and they must keep running.
const settle = (a: Animation) => {
    try { if (Number.isFinite(a.effect?.getComputedTiming().endTime as number)) a.finish(); } catch { /* motion must never raise an app error */ }
};
// No Web Animations (old engine, tests): no animations, never an error.
const anims = (t: Element | Document, opts?: GetAnimationsOptions): Animation[] => (typeof t.getAnimations === 'function' ? (t as Element).getAnimations(opts) : []);
const animating = (el: Element) => anims(el).some(a => a.playState === 'running' || a.pending);

// Takes a copy out of the flow, pinned where it is now: what replaces it lays out at its final size at once.
function pin(g: HTMLElement) {
    const parent = g.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const { offsetTop: top, offsetLeft: left, offsetWidth: w, offsetHeight: h } = g;
    Object.assign(g.style, { position: 'absolute', top: `${top}px`, left: `${left}px`, width: `${w}px`, height: `${h}px`, margin: '0', overflow: 'hidden', zIndex: '1' });
}

function ghost(doc: Document, el: HTMLElement, parent: Node, next: Node | null, kind: 'fade' | 'collapse' | 'slide' | 'swap', born: Set<Node>) {
    const ms = exitMs(doc);
    if (ms <= 0) return null;
    const g = el.cloneNode(true) as HTMLElement;
    g.classList.add('m-ghost', `m-ghost--${kind === 'swap' ? 'fade' : kind}`);
    g.setAttribute('aria-hidden', 'true');
    g.removeAttribute('id');
    g.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    let at = next && next.parentNode === parent ? next : null;
    if (kind === 'swap') {
        // Into the old slot: in front of the content that replaced it (added in this same batch), not after it.
        const before = (at ? (at as Element).previousElementSibling : (parent as Element).lastElementChild) as Element | null;
        if (before && born.has(before) && before.matches(SWAP)) at = before;
    }
    parent.insertBefore(g, at);
    if (kind === 'collapse') {
        g.style.height = `${g.offsetHeight}px`;
        g.style.overflow = 'hidden';
    } else if (kind === 'swap') {
        // The old content stays exactly where it was, over the new one, and fades: a real crossfade.
        g.style.flex = 'none'; // measured alone, not sharing the panel with what replaced it
        pin(g);
        // On the panel's own fill, so the old words fade off the new ones instead of mixing with them for a beat.
        let bg = '', p: Element | null = parent as Element;
        while (p && (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) { bg = getComputedStyle(p).backgroundColor; p = p.parentElement; }
        Object.assign(g.style, { height: '', bottom: '0', backgroundColor: bg });
    }
    void g.offsetHeight; // commit the start values, then the transition runs
    g.classList.add('m-ghost--out');
    setTimeout(() => g.remove(), ms + 40);
    return g;
}

const flashAt = new WeakMap<Element, number>();
let lastInputAt = 0;

function flash(el: Element) {
    if (!(el instanceof HTMLElement) || !el.isConnected || skip(el)) return;
    if (el.querySelectorAll('*').length > 40) return; // a change deep in a big container: the leaf flashes, never the page
    // A flash already running keeps running; one React stripped (it rewrites className) is put back.
    if (el.classList.contains('m-flash') && anims(el).some(a => a.playState === 'running')) return;
    // While the user types, a count or label flashes at most every 250 ms, so fast typing never shimmers.
    if (el.tagName === 'MARK') return; // search-hit highlights are re-created per keystroke
    const now = Date.now();
    const key = el.parentElement ?? el; // re-created siblings (counts, labels) share one throttle
    if (now - lastInputAt < 300 && (flashAt.get(key) ?? 0) > now - 250) return;
    flashAt.set(key, now);
    if (animating(el) && !el.classList.contains('m-flash')) return; // already revealing: never stack a second animation
    el.classList.remove('m-flash', 'm-in');
    void el.offsetWidth;
    el.classList.add('m-flash');
}

function enter(el: Element) {
    if (!(el instanceof HTMLElement) || skip(el)) return;
    if (el.tagName === 'MARK') return; // search-hit highlights are re-created per keystroke; they never slide in
    // Leaf labels and counts re-created on every keystroke reveal at most every 250 ms while the user types.
    if (el.children.length === 0 && Date.now() - lastInputAt < 300) {
        const key = el.parentElement ?? el, now = Date.now();
        if ((flashAt.get(key) ?? 0) > now - 250) return;
        flashAt.set(key, now);
    }
    if (animating(el)) return;
    el.classList.add('m-in');
}

function sameClassSibling(n: HTMLElement, parent: Node) {
    const c = n.classList[0];
    if (!c || !(parent instanceof Element)) return false;
    for (const s of parent.children) if (s !== n && s.classList.contains(c) && !s.classList.contains('m-ghost')) return true;
    return false;
}

export function installPresence(doc: Document = document) {
    if (typeof MutationObserver === 'undefined') return () => {};
    const scrolledAt = new WeakMap<EventTarget, number>();
    doc.addEventListener('scroll', e => { if (e.target) scrolledAt.set(e.target, Date.now()); }, true);
    doc.addEventListener('input', () => { lastInputAt = Date.now(); }, true);
    const recycled = (parent: Node) => {
        let e: Node | null = parent;
        while (e && e !== doc) { const t = scrolledAt.get(e); if (t && t > Date.now() - 200) return true; e = e.parentNode; }
        return false;
    };
    // Names (SensorLabel / KeyText) re-fit to their width: same words, cut elsewhere. That is layout, not a new value: no cue.
    const NAME = '.sl-split, .ex-key-text, [data-name-form], .sl-wrapname, .sl-wrapname--all, .sl-desc, .sl-tag';
    const nameText = new WeakMap<Element, string>();
    const remember = (el: Element) => { if (el.matches(NAME)) nameText.set(el, el.textContent ?? ''); el.querySelectorAll(NAME).forEach(n => nameText.set(n, n.textContent ?? '')); };
    const refit = (node: Node) => { const el = node instanceof Element ? node : node.parentElement; const root = el?.closest(NAME); return !!root && nameText.get(root) === root.textContent; };
    // A tab that swaps content (kind tabs, page tabs, Dashboard panel tabs): only its indicator slides and the swapped
    // content crossfades. Everything else that follows the click (settings fields, counts, footers, labels) is replaced
    // at once: no reveal, no exit copy, no flash, no colour ease, so one click reads as one movement.
    const TAB = '.f4-tabs [role="tab"], .wb3-pages .wb3-page, .dash-tabs [role="tab"], .dash-tab';
    const TABLIST = '.f4-tabs, .wb3-pages, .dash-tabs';
    // Exception (user decision): header / footer actions that come and go with the tab ("Clear all", "Add Special Sensor")
    // still fade in (--dur) and out (--dur-exit), out of the flow so nothing beside them jumps.
    // Checked through the parent: a node that just left has no parent of its own any more.
    const isAction = (n: Element, parent: Node) => n.matches('.widget-footer') || (parent instanceof Element && parent.matches('.section-header-actions, .widget-header-actions'));
    let quietUntil = 0;
    doc.addEventListener('click', e => { if ((e.target as Element | null)?.closest?.(TAB)) quietUntil = performance.now() + 150; }, true);
    const mo = new MutationObserver(records => { try { onRecords(records); } catch { /* motion must never raise an app error */ } });
    const onRecords = (records: MutationRecord[]) => {
        const added = new Set<Element>();
        const still = performance.now() < quietUntil;
        const left = new Map<Node, [HTMLElement, string][]>(); // ghosts per parent in this batch
        const born = new Set<Node>(); // added in this batch: if also removed in it, it was never painted
        for (const r of records) if (r.type === 'childList') r.addedNodes.forEach(n => born.add(n));
        // A name swapped for another form of the same name in one parent (plain <-> split): same words, no cue either way.
        const swapped = new Set<Node>();
        for (const r of records) {
            if (r.type !== 'childList') continue;
            for (const n of r.removedNodes) {
                if (!(n instanceof Element) || !n.matches(NAME)) continue;
                const t = nameText.get(n) ?? n.textContent;
                for (const m of r.target.childNodes) if (m instanceof Element && m !== n && born.has(m) && m.matches(NAME) && m.textContent === t) { swapped.add(n); swapped.add(m); }
            }
        }
        for (const r of records) {
            if (r.type === 'childList') {
                if (!r.target.isConnected) continue;
                const quiet = refit(r.target);
                r.addedNodes.forEach(n => {
                    if (quiet || swapped.has(n) || !n.isConnected) return;
                    if (n instanceof HTMLElement) { if (!still || n.matches(SWAP) || isAction(n, r.target)) added.add(n); else anims(n, { subtree: true }).forEach(settle); }
                    else if (!still && n.nodeType === 3 && r.target instanceof HTMLElement && n.textContent?.trim()) flash(r.target);
                });
                for (const n of r.removedNodes) {
                    if (!(n instanceof HTMLElement) || n.classList.contains('m-ghost') || n.isConnected) continue;
                    if (born.has(n) || quiet || swapped.has(n) || (still && !n.matches(SWAP) && !isAction(n, r.target))) continue;
                    if (n.matches(SKIP) || (r.target instanceof Element && skip(r.target))) continue;
                    if (!n.textContent?.trim() && !n.querySelector('*')) continue;
                    if (n.matches(WINDOWED) && recycled(r.target)) continue;
                    const kind = n.matches(SWAP) ? 'swap' : n.matches(SLIDE) ? 'slide' : (n.matches(COLLAPSE) || sameClassSibling(n, r.target)) ? 'collapse' : 'fade';
                    const g = ghost(doc, n, r.target, r.nextSibling, still && isAction(n, r.target) ? 'fade' : kind, born);
                    if (g && still && isAction(n, r.target)) pin(g);
                    if (g) (left.get(r.target) ?? left.set(r.target, []).get(r.target)!).push([g, kind]);
                }
            } else if (r.type === 'characterData') {
                if (!still && r.target.parentElement && r.oldValue !== r.target.textContent && !refit(r.target)) flash(r.target.parentElement);
            }
        }
        // Content swapped under a tab: whatever else left with it (a footer, a toolbar) must not hold its space either.
        for (const gs of left.values()) if (gs.some(([, k]) => k === 'swap')) for (const [g, k] of gs) if (k === 'fade') pin(g);
        for (const el of added) { if (el.isConnected && !(el.parentElement && added.has(el.parentElement))) enter(el); }
        // Swapped-in content reveals as one block: its own parts never reveal a second time inside it.
        for (const el of added) if (el.isConnected && el.matches(SWAP)) anims(el, { subtree: true }).forEach(a => { if ((a.effect as KeyframeEffect | null)?.target !== el) settle(a); });
        // After a tab click, colour eases on what merely followed it end at once (before the frame paints).
        if (still) requestAnimationFrame(() => anims(doc).forEach(a => {
            const t = (a.effect as KeyframeEffect | null)?.target as Element | null | undefined;
            if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition && t && !t.closest(TABLIST) && !t.closest('.m-ghost')) settle(a);
        }));
        // What each name says now, for the next batch.
        for (const r of records) { const t = r.target instanceof Element ? r.target : r.target.parentElement; const root = t?.isConnected ? t.closest(NAME) : null; if (root) remember(root); if (r.type === 'childList') r.addedNodes.forEach(n => { if (n instanceof Element && n.isConnected) remember(n); }); }
    };
    mo.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    return () => mo.disconnect();
}
