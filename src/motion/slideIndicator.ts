// Sliding selection highlight for tabs and switches: measures the selected item and writes --ind-* on the
// container; motion.css draws the highlight as the container's ::after. One observer per document.
type Target = { container: string; active: string; colourVar?: string };

const TARGETS: Target[] = [
    { container: '.f4-tabs', active: '.f4-tab--on', colourVar: '--kc' },
    { container: '.wb3-pages', active: '.wb3-page--on' },
    { container: '.dash-tabs', active: '.dash-tab--on' },
    { container: '.f4-seg', active: 'button.on' },
    { container: '.f4-catseg', active: 'button.on-perf, button.on-cond' },
    { container: '.chart-type-group', active: '.chart-type-btn.active' },
    { container: '.rcx-rows-mode', active: '.rcx-mode--on' },
    { container: '.tn-tabs', active: '[aria-selected="true"]' },
    { container: '.special-sensor-tabs', active: 'button.is-on' },
    { container: '.fg-sheet-seg', active: 'button.on' },
    { container: '.filter-op-seg', active: 'button.is-on' },
];
const SEL = TARGETS.map(t => t.container).join(',');

const set = (c: HTMLElement, k: string, v: string) => { if (c.style.getPropertyValue(k) !== v) c.style.setProperty(k, v); };

function paint(c: HTMLElement) {
    const t = TARGETS.find(x => c.matches(x.container));
    if (!t) return;
    const a = c.querySelector<HTMLElement>(t.active);
    if (!a) { set(c, '--ind-o', '0'); return; }
    const cr = c.getBoundingClientRect(), ar = a.getBoundingClientRect();
    set(c, '--ind-x', `${ar.left - cr.left}px`);
    set(c, '--ind-y', `${ar.top - cr.top}px`);
    set(c, '--ind-w', `${ar.width}px`);
    set(c, '--ind-h', `${ar.height}px`);
    set(c, '--ind-o', '1');
    if (t.colourVar) set(c, '--ind-c', getComputedStyle(a).getPropertyValue(t.colourVar) || '');
    if (!c.dataset.ind) {
        c.dataset.ind = 'first';
        // First paint lands without a slide; the transition switches on one frame later.
        void c.offsetWidth;
        setTimeout(() => { c.dataset.ind = 'ready'; }, 0);
    }
}

export function installSlidingIndicators(doc: Document = document) {
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return () => {}; // motion never breaks the app
    const ro = new ResizeObserver(entries => entries.forEach(e => paint(e.target as HTMLElement)));
    const seen = new WeakSet<Element>();
    const scan = () => {
        doc.querySelectorAll<HTMLElement>(SEL).forEach(c => {
            if (!seen.has(c)) { seen.add(c); ro.observe(c); }
            paint(c);
        });
    };
    const mo = new MutationObserver(scan);
    mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-current'] });
    doc.defaultView?.addEventListener('resize', scan);
    scan();
    return () => { mo.disconnect(); ro.disconnect(); doc.defaultView?.removeEventListener('resize', scan); };
}
