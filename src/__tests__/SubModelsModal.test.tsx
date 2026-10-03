import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, renderHook, act, waitFor } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args) }));
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => <div data-testid="echarts-mock" data-x-axis-name={props.option?.xAxis?.name ?? ''} data-series-count={props.option?.series?.length ?? 0} />,
}));

import SubModelsModal, { buildSubModelOption } from '../components/windows/SubModelsModal';
import { useSubModelFits, type SubModelFit, type SubModelFitsState } from '../components/windows/useSubModelFits';
import type { RelationshipPreviewResult } from '../types/commands';

const result = (n: number, r2 = 0.8, rmse2 = 0.4): RelationshipPreviewResult => ({
    request: 'r', r2_per_step: [r2], rmse2_per_step: [rmse2],
    predicted: Array.from({ length: n }, (_, i) => i), residual: Array.from({ length: n }, () => 0),
    target_raw: Array.from({ length: n }, (_, i) => i + 0.1), predictor_raw: Array.from({ length: n }, (_, i) => [i, i * 2]),
});

beforeEach(() => {
    mockInvoke.mockReset().mockImplementation((_cmd: string, args: any) => Promise.resolve(result(3, 0.5 + 0.1 * args.predictors.length)));
});
afterEach(cleanup);

describe('buildSubModelOption', () => {
    const fit: SubModelFit = { predictors: ['A', 'B'], result: result(3) };

    it('Raw (blue) vs Model (red) against the chosen predictor, X axis named after it', () => {
        const o: any = buildSubModelOption(fit, 'B', 'TARGET');
        expect(o.series.map((s: any) => s.name)).toEqual(['Raw', 'Model']);
        expect(o.series[0].data).toEqual([[0, 0.1], [2, 1.1], [4, 2.1]]); // column of B in predictor_raw
        expect(o.xAxis.name).toBe('B');
        expect(o.yAxis.name).toBe('TARGET');
    });

    it('null when the predictor is not part of the fit or the arrays are missing', () => {
        expect(buildSubModelOption(fit, 'Z', 'T')).toBeNull();
        expect(buildSubModelOption({ predictors: ['A'], result: { ...result(3), predictor_raw: undefined } }, 'A', 'T')).toBeNull();
        expect(buildSubModelOption({ predictors: ['A'], result: result(0) }, 'A', 'T')).toBeNull();
    });
});

describe('SubModelsModal', () => {
    const fits = (over: Partial<SubModelFitsState> = {}): SubModelFitsState => ({
        subModels: null, loading: false, error: null, progress: { current: 0, total: 0 }, stale: false, run: vi.fn().mockResolvedValue(undefined), ...over,
    });
    const show = (f: SubModelFitsState, over: Record<string, any> = {}) => {
        const onClose = vi.fn();
        render(<SubModelsModal fits={f} targetSensor="TARGET" predictorCount={2} stiffnessText="Medium" onClose={onClose} {...over} />);
        return onClose;
    };

    it('one card per cumulative step with R², RMSE, 2·RMSE and N, and a scatter each', () => {
        show(fits({ subModels: [{ predictors: ['A'], result: result(3, 0.61, 2) }, { predictors: ['A', 'B'], result: result(3, 0.94, 1) }] }));
        const cards = screen.getAllByTestId('sub-model-card');
        expect(cards).toHaveLength(2);
        expect(within(cards[0]).getByText('Step 1 of 2')).toBeTruthy();
        expect(cards[0].textContent).toMatch(/R²0\.6100/);
        expect(cards[0].textContent).toMatch(/RMSE1\.0000/); // 2·RMSE / 2
        expect(cards[0].textContent).toMatch(/2·RMSE2\.0000/);
        expect(cards[1].textContent).toMatch(/A \+ B/);
        expect(cards[1].textContent).toMatch(/N3/);
        expect(within(cards[1]).getByTestId('echarts-mock').getAttribute('data-x-axis-name')).toBe('A'); // every card shares the first predictor
        expect(screen.getByText(/stiffness:/).textContent).toMatch(/Medium/);
    });

    it('is a modal dialog; Escape, the backdrop and the X close it, a click inside does not', () => {
        const onClose = show(fits({ subModels: [] }));
        expect(screen.getByRole('dialog', { name: 'Sub-models' })).toBeTruthy();
        fireEvent.click(screen.getByText('Sub-models'));
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByLabelText('Close'));
        fireEvent.click(screen.getByTestId('sub-models-modal'));
        expect(onClose).toHaveBeenCalledTimes(3);
    });

    it('no target / no predictors / loading / error / nothing computed yet', () => {
        show(fits(), { targetSensor: '' });
        expect(screen.getByText('No target sensor selected.')).toBeTruthy();
        cleanup();
        show(fits(), { predictorCount: 0 });
        expect(screen.getByText('Add at least one predictor to compute sub-models.')).toBeTruthy();
        cleanup();
        show(fits({ loading: true, progress: { current: 1, total: 3 } }));
        expect(screen.getByText(/Fitting Relation model 2 of 3/)).toBeTruthy();
        cleanup();
        show(fits({ error: 'sidecar exploded' }));
        expect(screen.getByText('sidecar exploded')).toBeTruthy();
        cleanup();
        const f = fits();
        show(f);
        fireEvent.click(screen.getByText('Run now'));
        expect(f.run).toHaveBeenCalledTimes(1);
    });

    it('a stale set of fits offers Refresh', () => {
        const f = fits({ stale: true, subModels: [{ predictors: ['A'], result: result(3) }] });
        show(f);
        expect(screen.getByText(/Predictor selection changed since last fit/)).toBeTruthy();
        fireEvent.click(screen.getByText('Refresh'));
        expect(f.run).toHaveBeenCalledTimes(1);
    });

    it('never says "LinearGAM" (the algorithm name stays out of the UI)', () => {
        show(fits({ subModels: [{ predictors: ['A'], result: result(3) }] }));
        expect(document.body.textContent).not.toMatch(/linear\s*gam/i);
    });
});

describe('useSubModelFits', () => {
    const base = { targetSensor: 'T', predictors: ['A', 'B', 'C'], lambda: 1000, filter: { f: 1 }, reusable: null as RelationshipPreviewResult | null, resetKey: 'k1' };

    it('fits the cumulative subsets one after the other, with the model\'s own lambda and scope, and no cache_key', async () => {
        const { result: hook } = renderHook(() => useSubModelFits(base));
        expect(hook.current.subModels).toBeNull();
        await act(async () => { await hook.current.run(); });
        const calls = mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model').map(c => c[1] as any);
        expect(calls.map(c => c.predictors)).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C']]);
        expect(calls.every(c => c.target === 'T' && c.lambda === 1000 && c.filter.f === 1 && c.cache_key === undefined)).toBe(true);
        expect(hook.current.subModels!.map(s => s.predictors.length)).toEqual([1, 2, 3]);
        expect(hook.current.loading).toBe(false);
        expect(hook.current.progress).toEqual({ current: 3, total: 3 });
    });

    it('reuses an up-to-date fit of the full predictor list for the last step', async () => {
        const full = result(3, 0.99);
        const { result: hook } = renderHook(() => useSubModelFits({ ...base, reusable: full }));
        await act(async () => { await hook.current.run(); });
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        expect(hook.current.subModels![2].result).toBe(full);
    });

    it('does nothing without a target, without predictors, or when the scope is blocked', async () => {
        for (const over of [{ targetSensor: '' }, { predictors: [] as string[] }, { blocked: true }]) {
            const { result: hook, unmount } = renderHook(() => useSubModelFits({ ...base, ...over }));
            await act(async () => { await hook.current.run(); });
            expect(mockInvoke).not.toHaveBeenCalled();
            unmount();
        }
    });

    it('a failing fit becomes `error` (no throw) and leaves no half-filled result', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockInvoke.mockImplementation((_c: string, args: any) => args.predictors.length === 2 ? Promise.resolve({ ...result(3), error: 'GAM did not converge' }) : Promise.resolve(result(3)));
        const { result: hook } = renderHook(() => useSubModelFits(base));
        await act(async () => { await hook.current.run(); });
        expect(hook.current.error).toBe('GAM did not converge');
        expect(hook.current.subModels).toBeNull();
        expect(hook.current.loading).toBe(false);
        errSpy.mockRestore();
    });

    it('a change of predictors makes the cached fits `stale` (they are kept, not dropped)', async () => {
        const { result: hook, rerender } = renderHook((p: typeof base) => useSubModelFits(p), { initialProps: base });
        await act(async () => { await hook.current.run(); });
        expect(hook.current.stale).toBe(false);
        rerender({ ...base, predictors: ['A', 'B'] });
        expect(hook.current.stale).toBe(true);
        expect(hook.current.subModels).not.toBeNull();
    });

    it('a different target / stiffness / scope (resetKey) drops every cached fit', async () => {
        const { result: hook, rerender } = renderHook((p: typeof base) => useSubModelFits(p), { initialProps: base });
        await act(async () => { await hook.current.run(); });
        expect(hook.current.subModels).not.toBeNull();
        rerender({ ...base, resetKey: 'k2' });
        await waitFor(() => expect(hook.current.subModels).toBeNull());
        expect(hook.current.error).toBeNull();
    });

    it('a late-finishing older run can never overwrite a newer one', async () => {
        const gates: Array<() => void> = [];
        mockInvoke.mockImplementation((_c: string, args: any) => new Promise(res => {
            gates.push(() => res(result(3, args.predictors.length === 1 ? 0.11 : 0.22)));
        }));
        const props = { ...base, predictors: ['A'] };
        const { result: hook } = renderHook(() => useSubModelFits(props));
        let first!: Promise<void>;
        let second!: Promise<void>;
        act(() => { first = hook.current.run(); });
        act(() => { second = hook.current.run(); });
        await act(async () => { gates[1](); await second; }); // the NEWER run finishes first
        const newer = hook.current.subModels;
        expect(newer).not.toBeNull();
        await act(async () => { gates[0](); await first; }); // the older one lands late: ignored
        expect(hook.current.subModels).toBe(newer);
        expect(hook.current.loading).toBe(false);
    });
});
