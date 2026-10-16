import { describe, it, expect, vi, afterEach } from 'vitest';
import { attachFollowY, followRange, getFollowY, withFollowY, type FollowYSpec } from '../components/charts/followYAxis';
import { buildTimeSeriesOption, niceExtent } from '../components/windows/workbench/healthCharts';
import { buildScoreOption } from '../components/windows/workbench/healthPageCharts';

/*
 * User decision 2026-10-16: on the Model fit and Health score pages a time chart's Y axis
 * follows the zoom window — the values inside it plus every reference line (±1SD / ±3SD,
 * L / H, ±2RMSE, 80 / 0), so a model line never leaves the plot. The Health score chart
 * stays 0-100.
 */

const HOUR = 3600e3;
const ts = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * HOUR).toISOString().slice(0, 19).replace('T', ' '));
const range = (a: number, b: number): [number, number, number?] => niceExtent(a - (b - a) * 0.06, b + (b - a) * 0.06);

function spec(over: Partial<FollowYSpec> = {}): FollowYSpec {
    return {
        xs: [0, 1, 2, 3, 4, 5],
        lines: [[0, 1, 100, 1, 0, null]],
        refLo: -30,
        refHi: 39,
        range,
        axis: (min, max, step) => ({ min, max, interval: step }),
        ...over,
    };
}

describe('followRange', () => {
    it('a quiet window: the reference lines set the range, not the spike outside it', () => {
        expect(followRange(spec(), 3, 5)).toEqual(range(-30, 39));
    });

    it('a window holding the spike: the spike is in range, and so are the lines', () => {
        expect(followRange(spec(), 1, 3)).toEqual(range(-30, 100));
    });

    it('no reference line: the visible values alone; nothing visible and no line: null', () => {
        const s = spec({ refLo: Infinity, refHi: -Infinity });
        expect(followRange(s, 0, 1)).toEqual(range(0, 1));
        expect(followRange(s, 5, 5)).toBeNull(); // only a gap in the window
    });

    it('a second line counts too (Target vs predicted: the predicted line)', () => {
        expect(followRange(spec({ lines: [[0, 0, 0, 0, 0, 0], [0, 0, 0, 80, 0, 0]] }), 3, 3)).toEqual(range(-30, 80));
    });
});

describe('attachFollowY', () => {
    afterEach(() => { vi.useRealTimers(); });

    function fakeChart(extent: [number, number]) {
        const handlers: Record<string, () => void> = {};
        const inst = {
            extent,
            setOption: vi.fn(),
            on: (e: string, f: () => void) => { handlers[e] = f; },
            off: vi.fn(),
            isDisposed: () => false,
            getModel: () => ({ getComponent: () => ({ axis: { scale: { getExtent: () => inst.extent } } }) }),
            zoom: (e: [number, number]) => { inst.extent = e; handlers.datazoom?.(); },
        };
        return inst;
    }

    it('patches the Y axis on every zoom, and only when the rounded range changes', () => {
        vi.useFakeTimers();
        const chart = fakeChart([0, 5]);
        const off = attachFollowY(chart, spec());
        vi.runAllTimers();
        const [a, b, step] = range(-30, 100);
        expect(chart.setOption).toHaveBeenLastCalledWith({ yAxis: { min: a, max: b, interval: step } }, { lazyUpdate: true });

        chart.zoom([3, 5]);
        vi.runAllTimers();
        const q = range(-30, 39);
        expect(chart.setOption).toHaveBeenLastCalledWith({ yAxis: { min: q[0], max: q[1], interval: q[2] } }, { lazyUpdate: true });

        // a pan inside the same quiet stretch: same range, nothing sent
        chart.setOption.mockClear();
        chart.zoom([3.5, 5]);
        vi.runAllTimers();
        expect(chart.setOption).not.toHaveBeenCalled();

        off();
        chart.zoom([0, 5]);
        vi.runAllTimers();
        expect(chart.setOption).not.toHaveBeenCalled();
    });

    it('does nothing on a chart that cannot be read', () => {
        expect(() => attachFollowY({}, spec())()).not.toThrow();
    });
});

describe('the Workbench time charts carry the spec', () => {
    it('buildTimeSeriesOption: the reference lines and bands are the spec\'s fixed part; the data is not', () => {
        const opt = buildTimeSeriesOption({
            timestamps: ts(4),
            lines: [{ name: 'Value', values: [0, 1, 100, 1], color: '#888' }],
            hLines: [{ y: 39, color: 'red' }, { y: -30, color: 'red' }],
            bands: [{ from: -5, to: 7, color: 'green' }],
        });
        const s = getFollowY(opt)!;
        expect([s.refLo, s.refHi]).toEqual([-30, 39]);
        expect(s.lines).toEqual([[0, 1, 100, 1]]);
        expect(s.xs).toHaveLength(4);
        // unzoomed, the spec gives the same range the option starts with
        const y = (opt as any).yAxis;
        expect(followRange(s, s.xs[0], s.xs[3])!.slice(0, 2)).toEqual([y.min, y.max]);
        // the spec is not an option key ECharts (or a deep comparison) sees
        expect(Object.keys(opt)).not.toContain('__followY');
    });

    it('the Health score chart keeps its fixed 0-100 axis: no spec', () => {
        const opt = buildScoreOption(ts(3), [100, 80, 0]);
        expect(getFollowY(opt)).toBeNull();
        expect((opt as any).yAxis.min).toBe(0);
        expect((opt as any).yAxis.max).toBe(100);
    });

    it('withFollowY / getFollowY: a plain object has none', () => {
        expect(getFollowY({})).toBeNull();
        expect(getFollowY(null)).toBeNull();
        const o = withFollowY({ a: 1 }, spec());
        expect(getFollowY(o)?.refHi).toBe(39);
        expect(JSON.stringify(o)).toBe('{"a":1}');
    });
});
