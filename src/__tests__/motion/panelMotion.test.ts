import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { installPanelMotion } from '../../motion/panelMotion';

let slowDur = '0.24s';
const realGCS = window.getComputedStyle;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const animate = vi.fn((..._a: unknown[]) => ({ finished: new Promise<void>(() => {}), cancel: vi.fn() }));
let docAnims: { id: string; cancel: () => void }[] = [];

beforeAll(() => {
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    (document as unknown as { getAnimations: unknown }).getAnimations = () => docAnims;
    installPanelMotion(document);
});

beforeEach(() => {
    slowDur = '0.24s';
    animate.mockClear();
    docAnims = [];
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) =>
        new Proxy(realGCS(el), { get: (t, k) => k === 'transitionDuration' ? slowDur : Reflect.get(t, k) }));
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => { cb(0); return 0; });
    document.body.innerHTML = '<div class="dashboard-container"><div class="dashboard-grid-2x2">'
        + '<div class="left-column" style="display:flex;flex-direction:column"><div class="dashboard-slot" id="a"><button title="Hide panel">x</button></div><div class="dashboard-slot" id="b"></div></div>'
        + '<div class="gutter"></div></div></div>';
    document.getElementById('a')!.getBoundingClientRect = () => rect(0, 0, 400, 300);
    document.getElementById('b')!.getBoundingClientRect = () => rect(0, 300, 400, 200);
});

afterEach(() => { vi.restoreAllMocks(); });

const hideA = async () => {
    (document.querySelector('[title="Hide panel"]') as HTMLElement).click();
    document.getElementById('b')!.getBoundingClientRect = () => rect(0, 0, 400, 500); // grows into the freed space
    document.getElementById('a')!.remove();
    await flush();
};

describe('panelMotion', () => {
    it('a closed panel leaves a fixed copy on <body> that fades toward the strip', async () => {
        await hideA();
        const g = document.body.querySelector<HTMLElement>(':scope > .dashboard-slot.m-ghost');
        expect(g).not.toBeNull();
        expect(g!.style.position).toBe('fixed');
        expect(g!.getAttribute('aria-hidden')).toBe('true');
    });

    it('a panel that stays tweens its size from old to new, with no fill', async () => {
        await hideA();
        const calls = animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][];
        const call = calls.find(c => c[0][0].flex);
        expect(call).toBeDefined();
        expect(call![1].id).toBe('m-panel');
        expect(call![1].fill).toBeUndefined();
        const [from, to] = call![0].map(k => k.flex);
        expect([from, to]).toEqual(['0 0 200px', '0 0 500px']);
    });

    it('a gutter drag cancels the tweens; a throwing cancel() is swallowed', () => {
        const ok = vi.fn();
        const other = vi.fn();
        docAnims = [{ id: 'm-panel', cancel: () => { throw new Error('boom'); } }, { id: 'm-panel', cancel: ok }, { id: 'other', cancel: other }];
        expect(() => document.querySelector('.gutter')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))).not.toThrow();
        expect(ok).toHaveBeenCalled();
        expect(other).not.toHaveBeenCalled();
    });

    it('does nothing with no motion (--dur-slow = 0)', async () => {
        slowDur = '0s';
        await hideA();
        expect(document.querySelector('.m-ghost')).toBeNull();
        expect(animate).not.toHaveBeenCalled();
    });
});
