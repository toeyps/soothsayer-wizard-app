import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
const mockListen = vi.fn((event: string, cb: (e: any) => void) => {
    (listenCallbacks[event] ??= []).push(cb);
    return Promise.resolve(() => {});
});
const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => mockListen(event, cb),
    emit: (event: string, payload?: any) => mockEmit(event, payload),
}));

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

const mockUpdateWorkspaceData = vi.fn(async (id: string, patch: (s: any) => any) => patch({ id }));
const mockLoadWorkspaceData = vi.fn().mockResolvedValue(null);
vi.mock('../workspaceManager', () => ({
    updateWorkspaceData: (id: string, patch: any) => mockUpdateWorkspaceData(id, patch),
    loadWorkspaceData: (id: string) => mockLoadWorkspaceData(id),
}));

const mockUseChartData = vi.fn((_q?: unknown) => ({ view: null, loading: false, error: null } as any));
vi.mock('../hooks/useChartData', () => ({ useChartData: (q: unknown) => mockUseChartData(q) }));

const lineChartProps: any[] = [];
vi.mock('../components/charts/LineChart', () => ({
    default: (props: any) => { lineChartProps.push(props); return <div data-testid="line-chart-mock" />; },
}));

vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: () => <div data-testid="echarts-mock" />,
}));

import PredictiveModelBuild, { SensorAutocomplete } from '../components/windows/PredictiveModelBuild';
import type { SensorMetadata } from '../types';
import type { ComponentProps } from 'react';

type PMProps = ComponentProps<typeof PredictiveModelBuild>;

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TARGET1', description: 'Target Sensor', unit: 'bar', component: 'Pump' },
    { tag: 'PRED1', description: 'Predictor One', unit: 'C', component: 'Motor' },
    { tag: 'PRED2', description: 'Predictor Two', unit: 'C', component: 'Motor' },
];

// A FailureModel record as it'd be found in `failureGroupState.models` —
// PredictiveModelBuild hydrates entirely from this now (no more event
// payload), so most tests seed `mockLoadWorkspaceData` with one of these.
function makeStoredModel(overrides: Record<string, any> = {}) {
    return {
        id: 'm1', groupNos: [1], name: 'A', kind: 'individual', category: null, notes: '', status: false,
        targetSensor: 'TARGET1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimeStart: '', filterTimeEnd: '',
        ...overrides,
    };
}

function pmProps(overrides: Partial<PMProps> = {}): PMProps {
    return {
        workspaceId: 'ws1',
        modelId: 'm1',
        kind: 'individual',
        sensorHeaders: ['TARGET1', 'PRED1', 'PRED2'],
        sensorMetadata,
        runningConditionFilters: [],
        onBack: vi.fn(),
        onFinish: vi.fn(),
        ...overrides,
    };
}

async function flush(times = 3) {
    await act(async () => {
        for (let i = 0; i < times; i++) await Promise.resolve();
    });
}

async function renderHydrated(overrides: Partial<PMProps> = {}) {
    const props = pmProps(overrides);
    let utils!: ReturnType<typeof render>;
    await act(async () => {
        utils = render(<PredictiveModelBuild {...props} />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
    return { ...utils, onBack: props.onBack, onFinish: props.onFinish };
}

function clickApply(section: 'Relationship Model' | 'Clustering Model') {
    const btn = screen.getByText(section).closest('.pm-config-block')!.querySelector('button.pm-btn-primary') as HTMLButtonElement;
    fireEvent.click(btn);
}

beforeEach(() => {
    lineChartProps.length = 0;
    listenCallbacks = {};
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockInvoke.mockReset().mockImplementation((cmd: string) => {
        if (cmd === 'compute_sensor_stats') {
            return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
        }
        return Promise.resolve({});
    });
    mockUpdateWorkspaceData.mockClear().mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id }));
    mockLoadWorkspaceData.mockClear().mockResolvedValue({
        name: 'My Workspace',
        failureGroupState: { groups: [], models: [makeStoredModel()] },
    });
    mockUseChartData.mockClear().mockReturnValue({ view: null, loading: false, error: null });
});

afterEach(() => {
    cleanup();
});

describe('PredictiveModelBuild', () => {
    it('shows a loading state until workspace data resolves', async () => {
        let resolveLoad!: (v: any) => void;
        mockLoadWorkspaceData.mockReturnValue(new Promise(res => { resolveLoad = res; }));
        render(<PredictiveModelBuild {...pmProps()} />);
        expect(screen.getByText('Loading model data...')).toBeTruthy();
        await act(async () => {
            resolveLoad({ name: 'My Workspace', failureGroupState: { groups: [], models: [makeStoredModel()] } });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.queryByText('Loading model data...')).toBeNull();
    });

    it('hydrates target sensor and workspace name from the model record', async () => {
        mockLoadWorkspaceData.mockResolvedValue({
            name: 'My Workspace',
            // Predictor sensors only matter (and only render at all) for
            // Relationship/Clustering — Individual never shows that section.
            failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship', predictorSensors: ['PRED1'] })] },
        });
        await renderHydrated({ kind: 'relationship' });
        expect(screen.getByText('My Workspace')).toBeTruthy();
        expect(screen.getAllByText('TARGET1').length).toBeGreaterThan(0);
        expect(screen.getByText('Predictor One')).toBeTruthy(); // hydrated predictor chip
    });

    it('falls back to xSensor/ySensor for a clustering-kind model with no target set yet', async () => {
        mockLoadWorkspaceData.mockResolvedValue({
            name: 'WS',
            failureGroupState: {
                groups: [],
                models: [makeStoredModel({ kind: 'clustering', targetSensor: '', xSensor: 'PRED1', ySensor: 'TARGET1' })],
            },
        });
        await renderHydrated({ kind: 'clustering' });
        // targetSensor field is empty on the stored record for clustering
        // models (they use xSensor/ySensor instead) — the page falls back
        // to ySensor as its "target" so the page isn't blank on first open.
        expect(screen.getAllByText('TARGET1').length).toBeGreaterThan(0);
    });

    it('hydrates full PM config from a previously-configured FailureModel record', async () => {
        mockLoadWorkspaceData.mockResolvedValue({
            name: 'WS',
            failureGroupState: {
                groups: [],
                models: [makeStoredModel({
                    kind: 'relationship',
                    predictorSensors: ['PRED2'],
                    scatterXSensor: 'PRED2',
                    relModelName: 'Saved Model',
                })],
            },
        });
        await renderHydrated({ kind: 'relationship' });
        expect(screen.getByText('Predictor Two')).toBeTruthy();
        expect(screen.queryByText('Predictor One')).toBeNull();
    });

    describe('plot mode is locked to the model\'s kind (chosen on the overview page)', () => {
        it('individual-kind model: Individual active, Relationship/Clustering disabled', async () => {
            await renderHydrated({ kind: 'individual' });
            const individualBtn = screen.getByText('Individual').closest('button')!;
            const relBtn = screen.getByText('Relationship').closest('button')!;
            const clusterBtn = screen.getByText('Clustering').closest('button')!;
            expect(individualBtn.className).toContain('active');
            expect(individualBtn.hasAttribute('disabled')).toBe(false);
            expect(relBtn.hasAttribute('disabled')).toBe(true);
            expect(clusterBtn.hasAttribute('disabled')).toBe(true);
        });

        it('relationship-kind model: Relationship active, Individual/Clustering disabled and not clickable', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });
            const individualBtn = screen.getByText('Individual').closest('button')!;
            const relBtn = screen.getByText('Relationship').closest('button')!;
            expect(relBtn.className).toContain('active');
            expect(individualBtn.className).not.toContain('active');
            // Disabled buttons don't fire onClick — clicking must not flip state.
            fireEvent.click(individualBtn);
            expect(individualBtn.className).not.toContain('active');
            expect(relBtn.className).toContain('active');
        });
    });

    it('fetches target-sensor stats once hydrated and feeds mean/σ markLines to the LineChart', async () => {
        mockUseChartData.mockReturnValue({
            view: { headers: ['TARGET1'], timestamps: ['t0', 't1'], series: [[1, 2]], total_rows: 2, ts_min: 't0', ts_max: 't1' },
            loading: false, error: null,
        });
        await renderHydrated();
        expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.objectContaining({ sensor: 'TARGET1' }));
        const markLines = last(lineChartProps).markLines;
        expect(markLines.map((m: any) => m.label)).toEqual(['Mean', '+1σ', '−1σ', '+3σ', '−3σ']);
    });

    // Predictor sensors only apply to Relationship (regressors) and
    // Clustering (X sensor) — the section doesn't render at all for
    // Individual, so these render with kind: 'relationship'.
    describe('predictor selection', () => {
        it('is not shown at all for an Individual-kind model', async () => {
            await renderHydrated(); // default kind: 'individual'
            expect(screen.queryByText('Predictor sensors')).toBeNull();
            expect(screen.queryByPlaceholderText('Search sensor tag or description...')).toBeNull();
        });

        it('picking a sensor from the autocomplete adds it as a predictor chip', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });
            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED1' } });
            fireEvent.click(screen.getByText('Predictor One'));
            expect(screen.getByText('1')).toBeTruthy(); // predictor count pill
        });

        it('removing a predictor chip drops it from the selection', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship', predictorSensors: ['PRED1'] })] },
            });
            await renderHydrated({ kind: 'relationship' });
            expect(screen.getByText('Predictor One')).toBeTruthy();
            fireEvent.click(screen.getByText('Predictor One').closest('.pm-selected-chip')!.querySelector('.pm-selected-remove')!);
            expect(screen.queryByText('Predictor One')).toBeNull();
        });
    });

    // `kind` is locked per model (never changes after creation — see the
    // overview page), so a model can only ever need ONE of the two config
    // blocks. Both used to render unconditionally (the inactive one just
    // dimmed via pm-config-dim), which meant e.g. a Relationship-kind model
    // permanently showed a "Clustering Model" panel it could never use.
    describe('right column (Relationship/Clustering config) — only the block matching this model\'s own kind ever renders', () => {
        it('renders neither block for an Individual-kind model', async () => {
            await renderHydrated(); // default kind: 'individual'
            expect(screen.queryByText('Relationship Model')).toBeNull();
            expect(screen.queryByText('Clustering Model')).toBeNull();
        });

        it('renders only Relationship Model for a Relationship-kind model', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });
            expect(screen.getByText('Relationship Model')).toBeTruthy();
            expect(screen.queryByText('Clustering Model')).toBeNull();
        });

        it('renders only Clustering Model for a Clustering-kind model', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering' })] },
            });
            await renderHydrated({ kind: 'clustering' });
            expect(screen.getByText('Clustering Model')).toBeTruthy();
            expect(screen.queryByText('Relationship Model')).toBeNull();
        });
    });

    describe('clustering-kind copy — the actual algorithm is GMM (nalgebra ellipse fits), not k-means', () => {
        it('the chart subtitle says GMM, never k-means', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering' })] },
            });
            await renderHydrated({ kind: 'clustering' });
            expect(screen.getByText(/GMM clustering/)).toBeTruthy();
            expect(screen.queryByText(/k-means/i)).toBeNull();
        });

        it("the predictor-sensors hint doesn't use Relationship's regression phrasing", async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering' })] },
            });
            await renderHydrated({ kind: 'clustering' });
            expect(screen.getByText(/pick one as the X sensor below/)).toBeTruthy();
            expect(screen.queryByText(/informs the target/)).toBeNull();
        });
    });

    describe('Relationship Apply', () => {
        it('blocks with no predictors selected', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });
            clickApply('Relationship Model');
            await flush();
            expect(screen.getByText('Select at least one predictor.')).toBeTruthy();
            expect(mockInvoke).not.toHaveBeenCalledWith('preview_relationship_model', expect.anything());
        });

        it('fits the model with the current predictors/stiffness', async () => {
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'compute_sensor_stats') {
                    return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
                }
                if (cmd === 'preview_relationship_model') {
                    return Promise.resolve({
                        request: 'req-1',
                        error: undefined,
                        predicted: [1, 2, 3],
                        residual: [0.1, -0.1, 0.05],
                        r2_per_step: [0.9],
                        rmse2_per_step: [0.4],
                        target_raw: [1.1, 1.9, 3.05],
                        predictor_raw: [[1], [2], [3]],
                    });
                }
                return Promise.resolve({});
            });
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship', predictorSensors: ['PRED1'] })] },
            });
            await renderHydrated({ kind: 'relationship' });

            await act(async () => {
                clickApply('Relationship Model');
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('preview_relationship_model', expect.objectContaining({
                predictors: ['PRED1'],
                target: 'TARGET1',
            }));
        });
    });

    describe('Clustering Apply', () => {
        it('requires a predictor for the X-axis', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering' })] },
            });
            await renderHydrated({ kind: 'clustering' });
            clickApply('Clustering Model');
            await flush();
            expect(screen.getByText('Select a predictor sensor for the X-axis.')).toBeTruthy();
        });

        it('computes the clustering preview once a predictor is present', async () => {
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'compute_sensor_stats') {
                    return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
                }
                if (cmd === 'compute_clustering_preview') {
                    return Promise.resolve({
                        first_sensor: 'PRED1', second_sensor: 'TARGET1',
                        criteria_sensor: null, cluster_count: 1, n_rows: 0, clusters: [],
                    });
                }
                return Promise.resolve({});
            });
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering', predictorSensors: ['PRED1'] })] },
            });
            await renderHydrated({ kind: 'clustering' });

            await act(async () => {
                clickApply('Clustering Model');
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('compute_clustering_preview', expect.objectContaining({
                first_sensor: 'PRED1',
                second_sensor: 'TARGET1',
                n_clusters: 1, // no criteria sensor picked -> falls back to 1
            }));
        });
    });

    // 2026-09-15: the editable per-model "Sensor value" filter was removed
    // entirely -- with 100 models sharing a workspace, setting the same
    // "is the machine running" condition on each one separately was the
    // actual problem. It's now a single workspace-wide
    // `runningConditionFilters`, owned and edited only on BuildModelWindow's
    // Overview page; this page just displays it read-only (see the
    // `runningConditionFilters` prop's own doc comment).
    describe('running condition (read-only, inherited from Overview)', () => {
        it('shows "not set" with no editable controls when the workspace has no filter', async () => {
            await renderHydrated({ runningConditionFilters: [] });
            expect(screen.getByText(/No running-condition filter set/)).toBeTruthy();
            expect(screen.queryByTitle('Add a sensor value filter')).toBeNull();
            expect(screen.queryByPlaceholderText('Search sensor...')).toBeNull();
        });

        it('displays each inherited condition read-only', async () => {
            await renderHydrated({
                runningConditionFilters: [
                    { id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' },
                ],
            });
            expect(screen.getByText(/Predictor One/)).toBeTruthy();
            expect(screen.getByText(/1200/)).toBeTruthy();
            // Read-only: no input to type a new value into, no select to
            // change the operator, no remove button.
            expect(screen.queryByPlaceholderText('Search sensor...')).toBeNull();
            expect(screen.queryByTitle(/Remove filter/)).toBeNull();
        });

        it('"Edit on Overview" returns to the Overview page via onBack', async () => {
            const { onBack } = await renderHydrated({ runningConditionFilters: [] });
            fireEvent.click(screen.getByText('Edit on Overview →'));
            expect(onBack).toHaveBeenCalledTimes(1);
        });
    });

    describe('Time start/end filter actually affects training data (regression — used to be a hardcoded no-op)', () => {
        it('a saved Time start/end carries into the target chart query', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: {
                    groups: [], models: [makeStoredModel({
                        filterTimeStart: '2026-01-01T00:00',
                        filterTimeEnd: '2026-02-01T00:00',
                    })],
                },
            });
            await renderHydrated();

            const lastQuery = last(mockUseChartData.mock.calls)[0] as any;
            expect(lastQuery.filter.timestamp_start).toBe('2026-01-01T00:00');
            expect(lastQuery.filter.timestamp_end).toBe('2026-02-01T00:00');
        });

        it('typing into the Time start field persists it and updates the query filter', async () => {
            const onDiskModel = makeStoredModel();
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [onDiskModel] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [onDiskModel] } }));
            vi.useFakeTimers();
            await renderHydrated();

            // datetime-local inputs aren't `role=textbox`; locate by preceding label text instead.
            const startInput = screen.getByText('Time start').closest('.filter-row')!.querySelector('input') as HTMLInputElement;
            fireEvent.change(startInput, { target: { value: '2026-03-01T00:00' } });

            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models.find((m: any) => m.id === 'm1').filterTimeStart).toBe('2026-03-01T00:00');

            const lastQuery = last(mockUseChartData.mock.calls)[0] as any;
            expect(lastQuery.filter.timestamp_start).toBe('2026-03-01T00:00');
            vi.useRealTimers();
        });

        it('clicking the Calendar icon next to Time start/end opens the native picker (regression: the browser-drawn picker-indicator icon was hard to see on this page -- the Calendar icon is a reliable, always-visible way to open it instead)', async () => {
            await renderHydrated();

            const startRow = screen.getByText('Time start').closest('.filter-row')!;
            const startInput = startRow.querySelector('input') as HTMLInputElement;
            const startIcon = startRow.querySelector('svg') as SVGElement;
            const showPickerStart = vi.fn();
            (startInput as any).showPicker = showPickerStart;
            fireEvent.click(startIcon);
            expect(showPickerStart).toHaveBeenCalledTimes(1);

            const endRow = screen.getByText('Time end').closest('.filter-row')!;
            const endInput = endRow.querySelector('input') as HTMLInputElement;
            const endIcon = endRow.querySelector('svg') as SVGElement;
            const showPickerEnd = vi.fn();
            (endInput as any).showPicker = showPickerEnd;
            fireEvent.click(endIcon);
            expect(showPickerEnd).toHaveBeenCalledTimes(1);
        });

        it('clicking the Calendar icon does not throw when showPicker() is unsupported (older WebView2/browser)', async () => {
            await renderHydrated();
            const startIcon = screen.getByText('Time start').closest('.filter-row')!.querySelector('svg') as SVGElement;
            // jsdom (and some real engines) simply don't implement showPicker --
            // the `?.()` call must no-op rather than throw.
            expect(() => fireEvent.click(startIcon)).not.toThrow();
        });

        it('the Calendar icon is explicit white and sits after the input (flush to the box\'s own right edge via marginLeft: auto) -- regression: it used to render before the input on the left, and the native picker-indicator it was meant to replace was reported unreadably dim even after trying to recolor it, so this icon needs to be unambiguously visible on its own', async () => {
            await renderHydrated();
            const startRow = screen.getByText('Time start').closest('.filter-row')!;
            const children = Array.from(startRow.querySelector('.date-input-wrapper')!.children);
            expect(children[0].tagName).toBe('INPUT');
            const icon = children[1] as HTMLElement;
            expect(icon.tagName.toLowerCase()).toBe('svg');
            expect(icon.style.color).toBe('rgb(255, 255, 255)'); // jsdom normalizes '#fff'
            expect(icon.style.marginLeft).toBe('auto');
        });
    });

    describe('back navigation', () => {
        it('the Back button calls onBack instead of closing any window', async () => {
            const { onBack } = await renderHydrated();
            fireEvent.click(screen.getByTitle('Back to Build Model overview'));
            expect(onBack).toHaveBeenCalledTimes(1);
        });
    });

    describe('Finish button (2026-09-17: marks the model Complete on the overview list, replacing the old Preview/Save Model flow)', () => {
        it('clicking Finish calls onFinish', async () => {
            const { onFinish } = await renderHydrated();
            fireEvent.click(screen.getByText('Finish'));
            expect(onFinish).toHaveBeenCalledTimes(1);
        });
    });

    describe('persistence', () => {
        it('debounces a write into this model\'s own FailureModel record (not a global slot) after a field change', async () => {
            const onDiskModel = makeStoredModel();
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [onDiskModel] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [onDiskModel] } }));
            vi.useFakeTimers();
            await renderHydrated();
            mockUpdateWorkspaceData.mockClear();
            mockEmit.mockClear();

            // Plot mode is locked now (not user-toggleable), and the old
            // per-model sensor-value filter is gone (2026-09-15 -- see the
            // "running condition" describe block above), so type into Time
            // start instead to produce a real config change to debounce.
            const startInput = screen.getByText('Time start').closest('.filter-row')!.querySelector('input') as HTMLInputElement;
            fireEvent.change(startInput, { target: { value: '2026-03-01T00:00' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(mockUpdateWorkspaceData).toHaveBeenCalledWith('ws1', expect.any(Function));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models.find((m: any) => m.id === 'm1').filterTimeStart).toBe('2026-03-01T00:00');
            // Broadcast so Dashboard/BuildModelWindow (separate OS windows) refresh too.
            await act(async () => { await Promise.resolve(); });
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', { ...state.failureGroupState, workspaceId: 'ws1', origin: 'predictive-model' });
            vi.useRealTimers();
        });

        it('does not touch another model in the same group when this one changes', async () => {
            const sibling = makeStoredModel({ id: 'm2', targetSensor: 'PRED1', relModelName: 'Untouched' });
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [makeStoredModel(), sibling] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [makeStoredModel(), sibling] } }));
            vi.useFakeTimers();
            await renderHydrated();
            mockUpdateWorkspaceData.mockClear();
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [makeStoredModel(), sibling] } }));

            const startInput = screen.getByText('Time start').closest('.filter-row')!.querySelector('input') as HTMLInputElement;
            fireEvent.change(startInput, { target: { value: '2026-03-01T00:00' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const other = state.failureGroupState.models.find((m: any) => m.id === 'm2');
            expect(other.relModelName).toBe('Untouched');
            vi.useRealTimers();
        });
    });

    it('picks up a rename via the workspace-renamed-internal event', async () => {
        await renderHydrated();
        await act(async () => {
            for (const cb of listenCallbacks['workspace-renamed-internal'] ?? []) {
                cb({ payload: { newName: 'Renamed WS' } });
            }
        });
        expect(screen.getByText('Renamed WS')).toBeTruthy();
    });
});

describe('SensorAutocomplete', () => {
    // 2026-09-18: optional component-grouping, added for BuildModelWindow's
    // predictor picker (per explicit user request: "แสดงผลเป็น by component
    // ได้ไหม ... สามารถ search ได้ด้วย"). Tested directly against the real
    // implementation here -- BuildModelWindow.test.tsx mocks this component
    // out entirely, so it can only assert that the `getComponent` prop is
    // wired through, not what it renders.
    const sensors = ['TAG1', 'TAG2', 'TAG3'];
    const descriptions: Record<string, string> = { TAG1: 'Pump Pressure', TAG2: 'Pump Temp' }; // TAG3: no description
    const components: Record<string, string> = { TAG1: 'Pump', TAG2: 'Pump' }; // TAG3: no component
    const getDesc = (tag: string) => descriptions[tag] ?? '';
    const getComponent = (tag: string) => components[tag] ?? '';

    afterEach(cleanup);

    it('stays a flat list when getComponent is omitted (default/backward-compatible behavior for every other caller)', () => {
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} value="" onSelect={() => {}} placeholder="Search…" />
        );
        // A non-empty query both opens the dropdown and is needed to trigger
        // React's onChange at all here -- firing `change` with the same
        // value the input already holds (`''`) is a silent no-op.
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'TAG' } });
        expect(document.querySelectorAll('.sensor-autocomplete-group-header').length).toBe(0);
        expect(screen.getByText('TAG1')).toBeTruthy();
    });

    it('groups options under a component header, alphabetically, with an "Uncategorized" fallback for sensors with no component', () => {
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} getComponent={getComponent} value="" onSelect={() => {}} placeholder="Search…" />
        );
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'TAG' } });
        const headers = Array.from(document.querySelectorAll('.sensor-autocomplete-group-header')).map(el => el.textContent);
        expect(headers).toEqual(['Pump', 'Uncategorized']);
    });

    it('search still narrows the grouped list, not just the flat one', () => {
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} getComponent={getComponent} value="" onSelect={() => {}} placeholder="Search…" />
        );
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Pump Temp' } });
        expect(screen.getByText('TAG2')).toBeTruthy(); // matched by its description "Pump Temp"
        expect(screen.getByText('Pump Temp')).toBeTruthy();
        expect(screen.queryByText('TAG3')).toBeNull();
        // Only the matching sensor's own component group renders.
        const headers = Array.from(document.querySelectorAll('.sensor-autocomplete-group-header')).map(el => el.textContent);
        expect(headers).toEqual(['Pump']);
    });

    it('clicking a grouped item still selects it and closes the dropdown', () => {
        const onSelect = vi.fn();
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} getComponent={getComponent} value="" onSelect={onSelect} placeholder="Search…" clearOnSelect />
        );
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'TAG3' } });
        fireEvent.click(screen.getByText('TAG3')); // Uncategorized group, bare tag (no description)
        expect(onSelect).toHaveBeenCalledWith('TAG3');
        expect(screen.queryByText('Uncategorized')).toBeNull(); // dropdown closed
    });
});
