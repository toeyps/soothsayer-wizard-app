import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import { installSlidingIndicators } from '../../motion/slideIndicator';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

const motionCss: string = readFileSync('src/motion.css', 'utf8'); // vitest cwd = repo root

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let stop: () => void = () => {};
beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    stop = installSlidingIndicators(document);
});
afterAll(() => stop());

describe('slideIndicator', () => {
    it('writes --ind-* for the selected tab, then switches the slide on one tick later', async () => {
        document.body.innerHTML = '<div class="f4-tabs"><button class="f4-tab">A</button><button class="f4-tab f4-tab--on">B</button></div>';
        const c = document.querySelector<HTMLElement>('.f4-tabs')!;
        const on = c.querySelector<HTMLElement>('.f4-tab--on')!;
        c.getBoundingClientRect = () => rect(100, 50, 300, 30);
        on.getBoundingClientRect = () => rect(160, 52, 80, 26);
        on.className = 'f4-tab f4-tab--on'; // attribute change rescans with the stubbed rects
        await flush();
        expect(c.style.getPropertyValue('--ind-x')).toBe('60px');
        expect(c.style.getPropertyValue('--ind-w')).toBe('80px');
        expect(c.style.getPropertyValue('--ind-o')).toBe('1');
        expect(c.dataset.ind).toBe('first');
        await new Promise(r => setTimeout(r, 0));
        expect(c.dataset.ind).toBe('ready');
    });

    it('hides the highlight when nothing is selected', async () => {
        document.body.innerHTML = '<div class="dash-tabs"><button class="dash-tab">A</button></div>';
        await flush();
        expect(document.querySelector<HTMLElement>('.dash-tabs')!.style.getPropertyValue('--ind-o')).toBe('0');
    });
});

describe('underline tabs (motion.css)', () => {
    it('slide sideways only, so a tab with top padding does not push the line onto the row below', () => {
        const rule = motionCss.match(/\.wb3-pages\[data-ind\]::after[^{]*\{\s*transform:\s*([^;]+);/);
        expect(rule?.[1].trim()).toBe('translateX(var(--ind-x, 0px))');
    });
});
