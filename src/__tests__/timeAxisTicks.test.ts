import { describe, it, expect } from 'vitest';
import { evenTimeTicks, tickPitchPx, MAX_TIME_TICKS } from '../utils/timeAxisTicks';
import { attachEvenTimeTicks, hasTimeXAxis } from '../components/charts/evenTimeAxis';
import { formatAxisTick } from '../utils/dateFormat';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const gaps = (v: number[]) => v.slice(1).map((t, i) => t - v[i]);
const DAY = 86_400_000;

describe('evenTimeTicks', () => {
    // Real-app bug: ECharts marks the 1st, 8th, 15th, 22nd of every month AND the next 1st, so
    // the labels read 7, 7, 7, 9-10 days apart ("2026/05/22 … 2026/06/01").
    it('a 3-month view: one fixed step of whole days, every tick a local midnight, across month ends', () => {
        const t = evenTimeTicks(at(2026, 4, 8, 12), at(2026, 7, 8, 12), 13);
        expect(t.key).toBe('d7');
        expect(new Set(gaps(t.values).map(g => Math.round(g / DAY)))).toEqual(new Set([7]));
        for (const v of t.values) expect(formatAxisTick(v)).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
        expect(t.values.length).toBeGreaterThanOrEqual(12);
        expect(t.values[0]).toBeGreaterThanOrEqual(at(2026, 4, 8, 12));
        expect(t.values[t.values.length - 1]).toBeLessThanOrEqual(at(2026, 7, 8, 12));
    });

    it('the step grows with the span and shrinks with the room: never more labels than fit', () => {
        const from = at(2025, 1, 1);
        for (const [days, max] of [[1, 6], [3, 10], [30, 8], [90, 12], [400, 10], [3000, 9]] as const) {
            const t = evenTimeTicks(from, from + days * DAY, max);
            expect(t.values.length).toBeLessThanOrEqual(max + 1);
            expect(t.values.length).toBeGreaterThan(1);
        }
    });

    it('below a day the ticks sit on round clock times counted from midnight', () => {
        const t = evenTimeTicks(at(2026, 3, 9, 1, 20), at(2026, 3, 9, 22, 40), 5);
        expect(t.key).toBe(`s${6 * 3_600_000}`);
        expect(t.values.map(formatAxisTick)).toEqual(['2026/03/09 06:00', '2026/03/09 12:00', '2026/03/09 18:00']);
    });

    it('long spans step by whole months on the 1st (then years)', () => {
        const t = evenTimeTicks(at(2024, 1, 10), at(2026, 1, 10), 9);
        expect(t.key).toBe('m3');
        expect(t.values.map(formatAxisTick)).toEqual(['2024/04/01', '2024/07/01', '2024/10/01', '2025/01/01', '2025/04/01', '2025/07/01', '2025/10/01', '2026/01/01']);
        expect(evenTimeTicks(at(2000, 1, 1), at(2026, 1, 1), 8).key).toBe('m60');
    });

    it('the day grid is anchored: panning keeps the same tick days (the wider range only adds ticks)', () => {
        const a = evenTimeTicks(at(2026, 4, 8), at(2026, 7, 8), 13);
        const b = evenTimeTicks(at(2026, 4, 11), at(2026, 7, 11), 13);
        const shared = a.values.filter(v => b.values.includes(v));
        expect(shared.length).toBeGreaterThanOrEqual(a.values.length - 1);
        const wide = evenTimeTicks(at(2026, 4, 8), at(2026, 7, 8), 13, at(2026, 1, 8), at(2026, 10, 8));
        expect(wide.key).toBe(a.key);
        for (const v of a.values) expect(wide.values).toContain(v);
        expect(wide.values.length).toBeGreaterThan(a.values.length * 2);
    });

    it('an empty or reversed range gives no ticks; a runaway range is capped', () => {
        expect(evenTimeTicks(5, 5, 10).values).toEqual([]);
        expect(evenTimeTicks(10, 5, 10).values).toEqual([]);
        expect(evenTimeTicks(NaN, 5, 10).values).toEqual([]);
        const huge = evenTimeTicks(at(2026, 1, 1), at(2026, 1, 1, 0, 30), 30, at(1990, 1, 1), at(2060, 1, 1));
        expect(huge.values.length).toBe(MAX_TIME_TICKS);
    });

    it('a label with a time needs more room than a date alone', () => {
        expect(tickPitchPx('s3600000')).toBeGreaterThan(tickPitchPx('d7'));
        expect(tickPitchPx('d7', 10)).toBeLessThan(tickPitchPx('d7', 12));
    });
});

describe('attachEvenTimeTicks', () => {
    const fakeChart = (extent: [number, number], px: [number, number]) => {
        const handlers: Record<string, () => void> = {};
        let custom: number[] | undefined;
        const state = { extent };
        const inst = {
            handlers,
            state,
            on: (e: string, h: () => void) => { handlers[e] = h; },
            off: (e: string) => { delete handlers[e]; },
            isDisposed: () => false,
            setOption: (o: any) => { custom = o.xAxis.axisLabel.customValues; inst.patches.push(o); },
            patches: [] as any[],
            getModel: () => ({
                getComponent: () => ({
                    axis: {
                        type: 'time',
                        scale: { getExtent: () => state.extent },
                        getExtent: () => px,
                        model: { get: (path: string[]) => (path[1] === 'customValues' ? custom : 12) },
                    },
                }),
            }),
        };
        return inst;
    };
    const tick = () => new Promise(r => setTimeout(r, 5));

    it('patches both the ticks and the labels once, then stays quiet while the view is unchanged (hover, re-render)', async () => {
        const inst = fakeChart([at(2026, 4, 8), at(2026, 7, 8)], [0, 1300]);
        const detach = attachEvenTimeTicks(inst);
        await tick();
        expect(inst.patches).toHaveLength(1);
        const p = inst.patches[0].xAxis;
        expect(p.axisTick.customValues).toBe(p.axisLabel.customValues);
        expect(new Set(gaps(p.axisLabel.customValues).map((g: number) => Math.round(g / DAY))).size).toBe(1);
        inst.handlers.finished();
        inst.handlers.finished();
        await tick();
        expect(inst.patches).toHaveLength(1);
        detach();
        expect(inst.handlers.finished).toBeUndefined();
        expect(inst.handlers.datazoom).toBeUndefined();
    });

    it('a small pan inside the covered range changes nothing; a zoom that changes the step patches again', async () => {
        const inst = fakeChart([at(2026, 4, 8), at(2026, 7, 8)], [0, 1300]);
        attachEvenTimeTicks(inst);
        await tick();
        inst.state.extent = [at(2026, 4, 20), at(2026, 7, 20)];
        inst.handlers.datazoom();
        await tick();
        expect(inst.patches).toHaveLength(1);
        inst.state.extent = [at(2026, 5, 1), at(2026, 5, 3)];
        inst.handlers.datazoom();
        await tick();
        expect(inst.patches).toHaveLength(2);
        expect(inst.patches[1].xAxis.axisLabel.customValues.map(formatAxisTick)[0]).toMatch(/^2026\/0[45]\/\d{2}/);
    });

    it('does nothing for an instance without the API, or a non-time axis', async () => {
        expect(() => attachEvenTimeTicks(null)()).not.toThrow();
        expect(() => attachEvenTimeTicks({})()).not.toThrow();
        expect(hasTimeXAxis({ xAxis: { type: 'time' } })).toBe(true);
        expect(hasTimeXAxis({ xAxis: [{ type: 'time' }] })).toBe(true);
        expect(hasTimeXAxis({ xAxis: { type: 'value' } })).toBe(false);
        expect(hasTimeXAxis({})).toBe(false);
    });
});
