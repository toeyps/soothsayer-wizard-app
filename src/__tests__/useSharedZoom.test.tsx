import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// The real `connect` only files the group name; nothing here needs a real chart.
vi.mock('echarts', () => ({ connect: vi.fn() }));
vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => null }));

import { useSharedZoom } from '../components/windows/workbench/HealthScorePage';
import { HEALTH_SYNC_GROUP, HEALTH_SYNC_GROUP_EXPANDED } from '../components/windows/workbench/healthPageCharts';

/*
 * The Health score page's two time charts show ONE zoom window (real-app request
 * 2026-10-12: the charts are the same width, so the same window puts a moment in time
 * at the same X in both — "no need to line the point up by eye"). A chart redrawn from a
 * new option starts unzoomed; the hook puts the window back.
 */

/** A stand-in for an ECharts instance: it only knows its zoom window. */
function fakeChart(opts: { inModal?: boolean } = {}) {
    const dom = document.createElement('div');
    if (opts.inModal) {
        const backdrop = document.createElement('div');
        backdrop.className = 'pm-chart-modal-backdrop';
        backdrop.appendChild(dom);
    }
    const c = {
        group: undefined as string | undefined,
        start: 0,
        end: 100,
        disposed: false,
        actions: [] as Record<string, unknown>[],
        getDom: () => dom,
        isDisposed: () => c.disposed,
        getOption: () => ({ dataZoom: [{ start: c.start, end: c.end }] }),
        dispatchAction: (p: Record<string, unknown>) => { c.actions.push(p); c.start = p.start as number; c.end = p.end as number; },
        /** The user wheels on THIS chart (ECharts updates it, then fires `datazoom`). */
        wheel: (start: number, end: number, zoom: ReturnType<typeof useSharedZoom>) => { c.start = start; c.end = end; zoom.onZoom({}, c); },
        /** The chart is redrawn from a new option (notMerge): unzoomed again. */
        redraw: () => { c.start = 0; c.end = 100; },
    };
    return c;
}

const setup = (key = 'm1') => renderHook(({ k }) => useSharedZoom(k), { initialProps: { k: key } });

describe('useSharedZoom', () => {
    it('a chart that joins is put in the cursor group; a zoom on one is pushed to the other — once, and never back', () => {
        const { result } = setup();
        const a = fakeChart();
        const b = fakeChart();
        result.current.join(a);
        result.current.join(b);
        expect([a.group, b.group]).toEqual([HEALTH_SYNC_GROUP, HEALTH_SYNC_GROUP]);
        expect([a.actions, b.actions]).toEqual([[], []]); // nothing to apply yet

        a.wheel(20, 60, result.current);
        expect(a.actions).toEqual([]);
        expect(b.actions).toEqual([{ type: 'dataZoom', dataZoomIndex: 0, start: 20, end: 60, escapeConnect: true }]);
        // The ECharts group had already forwarded it: B is where it should be, so nothing more is sent.
        b.actions.length = 0;
        a.wheel(30, 70, result.current);
        b.start = 30; b.end = 70; // (as if the group got there first on the next one)
        a.wheel(30, 70, result.current);
        expect(b.actions).toEqual([{ type: 'dataZoom', dataZoomIndex: 0, start: 30, end: 70, escapeConnect: true }]);
    });

    it('a chart redrawn from a new option (unzoomed) gets the window back; the one that kept it is left alone', () => {
        const { result } = setup();
        const a = fakeChart();
        const b = fakeChart();
        result.current.join(a);
        result.current.join(b);
        b.wheel(40, 90, result.current);
        a.actions.length = 0;
        b.actions.length = 0;

        a.redraw(); // e.g. a set point was edited: the set-point chart has a new option
        result.current.restore();
        expect(a.actions).toEqual([{ type: 'dataZoom', dataZoomIndex: 0, start: 40, end: 90, escapeConnect: true }]);
        expect(b.actions).toEqual([]);
        expect([a.start, a.end, b.start, b.end]).toEqual([40, 90, 40, 90]);
        // nothing changed: nothing is sent
        a.actions.length = 0;
        result.current.restore();
        expect([a.actions, b.actions]).toEqual([[], []]);
    });

    it('a chart that joins late (the score chart appears once the set points are valid) starts on the window', () => {
        const { result } = setup();
        const a = fakeChart();
        result.current.join(a);
        a.wheel(10, 50, result.current);
        const b = fakeChart();
        result.current.join(b);
        expect([b.start, b.end]).toEqual([10, 50]);
    });

    it('zooming back out to the whole range forgets the window: a redraw is left unzoomed', () => {
        const { result } = setup();
        const a = fakeChart();
        const b = fakeChart();
        result.current.join(a);
        result.current.join(b);
        a.wheel(20, 60, result.current);
        a.wheel(0, 100, result.current);
        expect([b.start, b.end]).toEqual([0, 100]);
        b.actions.length = 0;
        a.actions.length = 0;
        result.current.restore();
        expect([a.actions, b.actions]).toEqual([[], []]);
    });

    it('the enlarged copy of a chart stays out: it is not grouped, its zoom moves nothing, and it is not moved', () => {
        const { result } = setup();
        const a = fakeChart();
        const big = fakeChart({ inModal: true });
        result.current.join(a);
        result.current.join(big);
        expect(big.group).toBeUndefined();
        big.wheel(45, 55, result.current);
        expect(a.actions).toEqual([]);
        a.wheel(20, 60, result.current);
        expect(big.actions).toEqual([]);
        expect([big.start, big.end]).toEqual([45, 55]);
    });

    it('another model starts unzoomed; a disposed chart is dropped; a chart that cannot be read is ignored', () => {
        const { result, rerender } = setup('m1');
        const a = fakeChart();
        const b = fakeChart();
        result.current.join(a);
        result.current.join(b);
        a.wheel(20, 60, result.current);
        rerender({ k: 'm2' });
        a.redraw();
        b.redraw();
        a.actions.length = 0;
        b.actions.length = 0;
        result.current.restore();
        expect([a.actions, b.actions]).toEqual([[], []]);

        b.disposed = true;
        a.wheel(5, 15, result.current);
        expect(b.actions).toEqual([]);

        expect(() => result.current.onZoom({}, undefined)).not.toThrow();
        expect(() => result.current.join(null)).not.toThrow();
        const broken = { ...fakeChart(), getOption: () => { throw new Error('gone'); } };
        result.current.join(broken);
        expect(() => result.current.onZoom({}, broken)).not.toThrow();
    });
});

// The stacked card's Expand overlay holds BOTH charts: that enlarged pair is linked to itself —
// its own cursor group, its own zoom window — and never to the pair under the backdrop.
describe('useSharedZoom — the enlarged pair (scope "expanded")', () => {
    const setupExpanded = (key = 'm1') => renderHook(({ k }) => useSharedZoom(k, 'expanded'), { initialProps: { k: key } });

    it('the two enlarged charts join their own group; a zoom on one is pushed to the other', () => {
        const { result } = setupExpanded();
        const a = fakeChart({ inModal: true });
        const b = fakeChart({ inModal: true });
        result.current.join(a);
        result.current.join(b);
        expect(a.group).toBe(HEALTH_SYNC_GROUP_EXPANDED);
        expect(b.group).toBe(HEALTH_SYNC_GROUP_EXPANDED);
        expect(HEALTH_SYNC_GROUP_EXPANDED).not.toBe(HEALTH_SYNC_GROUP);
        a.wheel(30, 70, result.current);
        expect(b.actions).toEqual([{ type: 'dataZoom', dataZoomIndex: 0, start: 30, end: 70, escapeConnect: true }]);
        expect(a.actions).toEqual([]);
        // a redraw of one (a set point edited while the overlay is open) gets the window back
        b.redraw();
        result.current.restore();
        expect([b.start, b.end]).toEqual([30, 70]);
    });

    it('a chart ON THE PAGE stays out of it: not grouped, not moved, its zoom moves nothing', () => {
        const { result } = setupExpanded();
        const big = fakeChart({ inModal: true });
        const onPage = fakeChart();
        result.current.join(big);
        result.current.join(onPage);
        expect(onPage.group).toBeUndefined();
        big.wheel(10, 40, result.current);
        expect(onPage.actions).toEqual([]);
        onPage.wheel(50, 60, result.current);
        expect(big.actions).toEqual([]);
        expect([big.start, big.end]).toEqual([10, 40]);
    });

    it('the page pair and the enlarged pair keep separate windows (two hooks, as the page uses them)', () => {
        const page = setup();
        const expanded = setupExpanded();
        const p1 = fakeChart();
        const p2 = fakeChart();
        const x1 = fakeChart({ inModal: true });
        const x2 = fakeChart({ inModal: true });
        for (const c of [p1, p2, x1, x2]) { page.result.current.join(c); expanded.result.current.join(c); }
        expect([p1.group, p2.group, x1.group, x2.group]).toEqual([HEALTH_SYNC_GROUP, HEALTH_SYNC_GROUP, HEALTH_SYNC_GROUP_EXPANDED, HEALTH_SYNC_GROUP_EXPANDED]);
        // every chart reports its zoom to BOTH hooks' handlers only through the one it was given; here: each to its own
        p1.wheel(20, 60, page.result.current);
        expect([p2.start, p2.end]).toEqual([20, 60]);
        expect([[x1.start, x1.end], [x2.start, x2.end]]).toEqual([[0, 100], [0, 100]]);
        x2.wheel(40, 90, expanded.result.current);
        expect([x1.start, x1.end]).toEqual([40, 90]);
        expect([[p1.start, p1.end], [p2.start, p2.end]]).toEqual([[20, 60], [20, 60]]);
        // a zoom event that reaches the WRONG hook is ignored (the chart never joined it)
        p1.wheel(5, 6, expanded.result.current);
        expect([x1.start, x1.end]).toEqual([40, 90]);
    });

    it('another model starts the enlarged pair unzoomed too', () => {
        const { result, rerender } = setupExpanded('m1');
        const a = fakeChart({ inModal: true });
        const b = fakeChart({ inModal: true });
        result.current.join(a);
        result.current.join(b);
        a.wheel(30, 70, result.current);
        rerender({ k: 'm2' });
        b.redraw();
        b.actions.length = 0;
        result.current.restore();
        expect(b.actions).toEqual([]);
    });
});
