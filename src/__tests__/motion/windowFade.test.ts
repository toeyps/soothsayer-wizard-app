import { describe, it, expect, vi, afterEach } from 'vitest';
import { exitMs, fadeOutWindow, undoFadeOutWindow } from '../../motion/windowFade';

const realGCS = window.getComputedStyle;
const stubDur = (d: string) => vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) =>
    new Proxy(realGCS(el), { get: (t, k) => k === 'transitionDuration' ? d : Reflect.get(t, k) }));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); undoFadeOutWindow(); });

describe('windowFade', () => {
    it('with no motion (0 ms) resolves at once and adds no class', async () => {
        stubDur('0s');
        expect(exitMs()).toBe(0);
        await fadeOutWindow();
        expect(document.documentElement.classList.contains('m-leaving')).toBe(false);
    });

    it('fades for --dur-exit, then resolves; undo shows the content again', async () => {
        vi.useFakeTimers();
        stubDur('0.12s');
        let done = false;
        const p = fadeOutWindow().then(() => { done = true; });
        expect(document.documentElement.classList.contains('m-leaving')).toBe(true);
        await vi.advanceTimersByTimeAsync(119);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(done).toBe(true);
        undoFadeOutWindow();
        expect(document.documentElement.classList.contains('m-leaving')).toBe(false);
    });
});
