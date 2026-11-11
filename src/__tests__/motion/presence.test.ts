import { describe, it, expect, vi, afterAll, beforeAll, beforeEach, afterEach } from 'vitest';
import { installPresence } from '../../motion/presence';

// jsdom has no Web Animations and resolves no CSS: stub what presence reads.
let exitDur = '0.12s';
let anims: Animation[] = [];
const realGCS = window.getComputedStyle;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

let stop: () => void = () => {};
beforeAll(() => {
    (Element.prototype as unknown as { getAnimations: unknown }).getAnimations = function () { return anims; };
    (document as unknown as { getAnimations: unknown }).getAnimations = () => [];
    stop = installPresence(document);
});
afterAll(() => stop());

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance', 'requestAnimationFrame'] });
    exitDur = '0.12s';
    anims = [];
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
        const cs = realGCS(el);
        return new Proxy(cs, { get: (t, k) => k === 'transitionDuration' ? exitDur : Reflect.get(t, k) });
    });
    document.body.innerHTML = '<div id="host"></div>';
});

afterEach(() => {
    vi.mocked(window.getComputedStyle).mockRestore();
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
});

const host = () => document.getElementById('host')!;
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstElementChild as HTMLElement; };

describe('presence', () => {
    it('an appended element reveals (m-in)', async () => {
        const n = el('<p>hello</p>');
        host().appendChild(n);
        await flush();
        expect(n.classList.contains('m-in')).toBe(true);
    });

    it('a removed element leaves a fading copy that is gone after --dur-exit', async () => {
        const n = el('<p class="note">bye</p>');
        host().appendChild(n);
        await flush();
        n.remove();
        await flush();
        const g = host().querySelector('.m-ghost');
        expect(g?.textContent).toBe('bye');
        expect(g?.getAttribute('aria-hidden')).toBe('true');
        vi.advanceTimersByTime(161);
        expect(host().querySelector('.m-ghost')).toBeNull();
    });

    it('--dur-exit = 0 (reduced motion) leaves no copy', async () => {
        exitDur = '0s';
        const n = el('<p>bye</p>');
        host().appendChild(n);
        await flush();
        n.remove();
        await flush();
        expect(host().querySelector('.m-ghost')).toBeNull();
    });

    it('new text fades up (m-flash); the same text does not', async () => {
        const n = el('<span>1</span>');
        host().appendChild(n);
        await flush();
        n.classList.remove('m-in');
        (n.firstChild as Text).data = '1';
        await flush();
        expect(n.classList.contains('m-flash')).toBe(false);
        vi.advanceTimersByTime(400); // past the per-parent throttle
        (n.firstChild as Text).data = '2';
        await flush();
        expect(n.classList.contains('m-flash')).toBe(true);
    });

    it('a class change gets no cue', async () => {
        const n = el('<span>x</span>');
        host().appendChild(n);
        await flush();
        n.classList.remove('m-in');
        n.classList.add('on');
        await flush();
        expect(n.classList.contains('m-flash')).toBe(false);
        expect(n.classList.contains('m-in')).toBe(false);
    });

    it('right after a tab click only swapped content and header actions move', async () => {
        host().innerHTML = '<div class="f4-tabs"><button role="tab">A</button></div><div class="section-header-actions"></div><div id="body"></div>';
        const body = document.getElementById('body')!;
        const old = el('<p>old</p>');
        body.appendChild(old);
        await flush();
        (host().querySelector('[role="tab"]') as HTMLElement).click();
        const plain = el('<p>plain</p>');
        const swap = el('<div class="m-swap">new</div>');
        const action = el('<button>Clear all</button>');
        body.appendChild(plain);
        body.appendChild(swap);
        host().querySelector('.section-header-actions')!.appendChild(action);
        old.remove();
        await flush();
        expect(plain.classList.contains('m-in')).toBe(false);
        expect(swap.classList.contains('m-in')).toBe(true);
        expect(action.classList.contains('m-in')).toBe(true);
        expect(body.querySelector('.m-ghost')).toBeNull();
    });

    it('settles one-off animations only: an infinite one is never finished, and a throwing finish() is swallowed', async () => {
        const finite = { effect: { getComputedTiming: () => ({ endTime: 200 }) }, finish: vi.fn(() => { throw new Error('boom'); }), playState: 'finished', pending: false } as unknown as Animation;
        const infinite = { effect: { getComputedTiming: () => ({ endTime: Infinity }) }, finish: vi.fn(), playState: 'finished', pending: false } as unknown as Animation;
        host().innerHTML = '<div class="f4-tabs"><button role="tab">A</button></div>';
        (host().querySelector('[role="tab"]') as HTMLElement).click();
        anims = [finite, infinite];
        host().appendChild(el('<p>follows the click</p>'));
        await flush();
        expect(finite.finish).toHaveBeenCalled();
        expect(infinite.finish).not.toHaveBeenCalled();
    });

    it('a direct child of <body> (the portal root) never reveals or leaves a copy; what is inside it still reveals', async () => {
        vi.advanceTimersByTime(1000); // past any tab-click quiet window an earlier test left
        const root = el('<div id="wizard-portal-root"></div>');
        document.body.appendChild(root);
        await flush();
        expect(root.classList.contains('m-in')).toBe(false);
        const pop = el('<p>picker</p>');
        root.appendChild(pop);
        await flush();
        expect(pop.classList.contains('m-in')).toBe(true);
        root.remove();
        await flush();
        expect(document.body.querySelector(':scope > .m-ghost')).toBeNull();
    });

    it('a crossfade lends its static parent position: relative only while the old copy is on screen', async () => {
        vi.advanceTimersByTime(1000);
        host().innerHTML = '<div id="p" style="position: static"><div class="m-swap">old</div></div>';
        await flush();
        const p = document.getElementById('p')!;
        p.replaceChildren(el('<div class="m-swap">new</div>'));
        await flush();
        expect(p.querySelector('.m-ghost')).not.toBeNull();
        expect(p.style.position).toBe('relative');
        vi.advanceTimersByTime(500);
        expect(p.querySelector('.m-ghost')).toBeNull();
        expect(p.style.position).toBe('static');
    });

    it('never touches chart internals or the ECharts tooltip on <body>', async () => {
        host().innerHTML = '<div class="chart-wrapper"><div id="c"></div></div><div style="z-index: 9999999" id="tip"></div>';
        await flush();
        const a = el('<p>in chart</p>');
        const b = el('<p>in tooltip</p>');
        document.getElementById('c')!.appendChild(a);
        document.getElementById('tip')!.appendChild(b);
        await flush();
        expect(a.classList.contains('m-in')).toBe(false);
        expect(b.classList.contains('m-in')).toBe(false);
        a.remove();
        b.remove();
        await flush();
        expect(document.querySelector('.m-ghost')).toBeNull();
    });

    it('never throws when the engine has no Web Animations (getAnimations missing)', async () => {
        const proto = Element.prototype as unknown as { getAnimations?: unknown };
        const saved = proto.getAnimations;
        delete proto.getAnimations;
        try {
            const n = el('<p>no engine</p>');
            host().appendChild(n);
            await flush();
            expect(n.isConnected).toBe(true); // an uncaught error in the observer would fail the run
            n.remove();
            await flush();
        } finally {
            proto.getAnimations = saved;
        }
    });
});
