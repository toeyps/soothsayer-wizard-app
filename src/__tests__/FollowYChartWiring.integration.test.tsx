/**
 * QA 2026-10-19 — the follow-Y axis across its two halves: the Workbench chart builders
 * (`healthCharts.ts` / `healthPageCharts.ts`) hang a spec on the option, and
 * `ResponsiveECharts` must attach it to the live instance. The unit tests check each half
 * alone; these hand the REAL builders' options to the REAL wrapper (only echarts-for-react
 * is faked) and check what reaches the chart instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

let lastProps: any = null;
vi.mock('echarts-for-react', () => ({
    default: (props: any) => { lastProps = props; return <div data-testid="echarts-mock" />; },
}));
// The even-time-tick helper touches the instance too; keep it out of the counts here.
vi.mock('../components/charts/evenTimeAxis', () => ({ attachEvenTimeTicks: () => () => {}, hasTimeXAxis: () => false }));

import ResponsiveECharts from '../components/charts/ResponsiveECharts';
import { getFollowY } from '../components/charts/followYAxis';
import {
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildTimeSeriesOption,
    buildValueOverTimeOption,
} from '../components/windows/workbench/healthCharts';
import {
    asStackLower,
    asStackUpper,
    buildIndividualSetPointOption,
    buildRelationshipSetPointOption,
    buildScoreOption,
} from '../components/windows/workbench/healthPageCharts';
import type { IndividualSeries, IndividualStats, RelationshipSeries } from '../types/health';
import { makeHealthPreview } from './helpers/healthPreviewFixture';

class RO { observe() {} disconnect() {} unobserve() {} }

function fakeInstance(extent: [number, number]) {
    const handlers: Record<string, () => void> = {};
    const inst = {
        extent,
        setOption: vi.fn(),
        on: vi.fn((e: string, f: () => void) => { handlers[e] = f; }),
        off: vi.fn((e: string, f: () => void) => { if (handlers[e] === f) delete handlers[e]; }),
        isDisposed: () => false,
        resize: vi.fn(),
        getModel: () => ({ getComponent: () => ({ axis: { scale: { getExtent: () => inst.extent } } }) }),
        zoom(e: [number, number]) { inst.extent = e; handlers.datazoom?.(); },
        listening: () => 'datazoom' in handlers,
    };
    return inst;
}

const yPatches = (inst: ReturnType<typeof fakeInstance>) =>
    inst.setOption.mock.calls.filter(c => c[0]?.yAxis).map(c => [c[0].yAxis.min, c[0].yAxis.max]);

const lastPatch = (inst: ReturnType<typeof fakeInstance>) => { const p = yPatches(inst); return p[p.length - 1]; };

const HOUR = 3600e3;
const stamps = (n: number) =>
    Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * HOUR).toISOString().slice(0, 19).replace('T', ' '));

beforeEach(() => {
    lastProps = null;
    vi.stubGlobal('ResizeObserver', RO);
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function mount(option: any) {
    const view = render(<ResponsiveECharts option={option} />);
    const xs = getFollowY(option)?.xs ?? [0, 1];
    const inst = fakeInstance([xs[0], xs[xs.length - 1]]);
    act(() => { lastProps.onChartReady(inst); });
    act(() => { vi.runAllTimers(); });
    return { view, inst };
}

describe('a Workbench time chart in ResponsiveECharts', () => {
    // 100 hourly points: a spike to 100 at hour 10, otherwise 0..1; reference lines at -30 / 39.
    const values = Array.from({ length: 100 }, (_, i) => (i === 10 ? 100 : i % 2));
    const option = () => buildTimeSeriesOption({
        timestamps: stamps(100),
        lines: [{ name: 'Value', values, color: '#888' }],
        hLines: [{ y: 39, color: 'red' }, { y: -30, color: 'red' }],
    });

    it('unzoomed: the first patch is the range the option already has', () => {
        const opt = option();
        const { inst } = mount(opt);
        expect(yPatches(inst)).toEqual([[opt.yAxis.min, opt.yAxis.max]]);
    });

    it('zoomed into a quiet stretch: Y shrinks to the reference lines, never below them; back over the spike it grows again', () => {
        const opt = option();
        const xs = getFollowY(opt)!.xs;
        const { inst } = mount(opt);
        act(() => { inst.zoom([xs[50], xs[90]]); vi.runAllTimers(); });
        const [qMin, qMax] = lastPatch(inst);
        expect(qMax).toBeLessThan(opt.yAxis.max);
        expect(qMin).toBeLessThanOrEqual(-30);
        expect(qMax).toBeGreaterThanOrEqual(39);
        act(() => { inst.zoom([xs[5], xs[15]]); vi.runAllTimers(); });
        expect(lastPatch(inst)[1]).toBeGreaterThanOrEqual(100);
    });

    it('a new option re-attaches with its own spec; an option without one (the 0-100 score chart) detaches', () => {
        const { view, inst } = mount(option());
        expect(inst.listening()).toBe(true);
        view.rerender(<ResponsiveECharts option={buildScoreOption(stamps(3), [100, 80, 0])} />);
        expect(inst.off).toHaveBeenCalledWith('datazoom', expect.any(Function));
        expect(inst.listening()).toBe(false);
        inst.setOption.mockClear();
        act(() => { inst.zoom([0, 1]); vi.runAllTimers(); });
        expect(yPatches(inst)).toEqual([]);
    });

    it('unmounting detaches: a zoom afterwards patches nothing', () => {
        const { view, inst } = mount(option());
        view.unmount();
        inst.setOption.mockClear();
        act(() => { inst.zoom([0, 1]); vi.runAllTimers(); });
        expect(yPatches(inst)).toEqual([]);
    });
});

describe('every Workbench time chart reaches the wrapper with its spec (none lost in a copy)', () => {
    const ind = makeHealthPreview({ kind: 'individual' });
    const rel = makeHealthPreview({ kind: 'relationship' });
    const indSeries = ind.series as IndividualSeries;
    const indStats = ind.stats as IndividualStats;
    const relSeries = rel.series as RelationshipSeries;
    const twoRmse = (rel.stats as any).two_rmse as number;

    const cases: [string, () => any][] = [
        ['Model fit: value over time', () => buildValueOverTimeOption(indSeries, indStats, 'bar')],
        ['Model fit: target vs predicted', () => buildTargetVsPredictedOption(relSeries, 'bar')],
        ['Model fit: residual', () => buildResidualOption(relSeries, twoRmse, 'bar')],
        ['Health score: Individual set points, stacked over the score', () =>
            asStackUpper(buildIndividualSetPointOption(indSeries, indStats, { kind: 'individual', lower: -50, upper: 50 } as any, 'bar') as any)],
        ['Health score: Relation set points, stacked over the score', () =>
            asStackUpper(buildRelationshipSetPointOption(relSeries, twoRmse, { kind: 'relationship', residualAt0Upper: 40, residualAt0Lower: -40 } as any, 'bar') as any)],
        ['a stacked LOWER time chart keeps its spec too', () => asStackLower(buildValueOverTimeOption(indSeries, indStats, 'bar') as any)],
    ];

    it.each(cases)('%s', (_name, build) => {
        const opt = build();
        const spec = getFollowY(opt);
        expect(spec).not.toBeNull();
        const { inst } = mount(opt);
        expect(inst.on).toHaveBeenCalledWith('datazoom', expect.any(Function));
        expect(yPatches(inst)).toHaveLength(1);
    });

    it('the Relation set points (±40) stay inside the axis however far in the chart is zoomed', () => {
        const opt = buildRelationshipSetPointOption(relSeries, twoRmse, { kind: 'relationship', residualAt0Upper: 40, residualAt0Lower: -40 } as any, 'bar');
        const xs = getFollowY(opt)!.xs;
        const { inst } = mount(opt);
        act(() => { inst.zoom([xs[0], xs[Math.min(1, xs.length - 1)]]); vi.runAllTimers(); });
        const [lo, hi] = lastPatch(inst);
        expect(lo).toBeLessThanOrEqual(-40);
        expect(hi).toBeGreaterThanOrEqual(40);
    });

    it('the Health score chart, alone or stacked, never gets a follow-Y spec (fixed 0-100)', () => {
        expect(getFollowY(buildScoreOption(stamps(3), [100, 80, 0]))).toBeNull();
        expect(getFollowY(asStackLower(buildScoreOption(stamps(3), [100, 80, 0]) as any))).toBeNull();
    });
});
