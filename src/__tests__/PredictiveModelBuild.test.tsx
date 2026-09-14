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

const mockOpenDialog = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: (opts: unknown) => mockOpenDialog(opts),
}));

const mockUpdateWorkspaceData = vi.fn(async (id: string, patch: (s: any) => any) => patch({ id }));
const mockLoadWorkspaceData = vi.fn().mockResolvedValue(null);
vi.mock('../workspaceManager', () => ({
    updateWorkspaceData: (id: string, patch: any) => mockUpdateWorkspaceData(id, patch),
    loadWorkspaceData: (id: string) => mockLoadWorkspaceData(id),
}));

vi.mock('../hooks/usePMReport', () => ({
    usePMReport: () => ({ exportPNG: vi.fn().mockResolvedValue(undefined) }),
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

import PredictiveModelBuild from '../components/windows/PredictiveModelBuild';
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
        clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
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
        onBack: vi.fn(),
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
    return { ...utils, onBack: props.onBack };
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
    mockOpenDialog.mockReset();
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
            failureGroupState: { groups: [], models: [makeStoredModel({ predictorSensors: ['PRED1'] })] },
        });
        await renderHydrated();
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

    describe('predictor selection', () => {
        it('picking a sensor from the autocomplete adds it as a predictor chip', async () => {
            await renderHydrated();
            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED1' } });
            fireEvent.click(screen.getByText('Predictor One'));
            expect(screen.getByText('1')).toBeTruthy(); // predictor count pill
        });

        it('removing a predictor chip drops it from the selection', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ predictorSensors: ['PRED1'] })] },
            });
            await renderHydrated();
            expect(screen.getByText('Predictor One')).toBeTruthy();
            fireEvent.click(screen.getByText('Predictor One').closest('.pm-selected-chip')!.querySelector('.pm-selected-remove')!);
            expect(screen.queryByText('Predictor One')).toBeNull();
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

    describe('data filters (pmSensorFilters)', () => {
        it('is disabled with no target/predictor pool, enabled once one exists, and adds/removes a row', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ predictorSensors: ['PRED1'] })] },
            });
            await renderHydrated();
            const addBtn = screen.getByTitle('Add a sensor value filter') as HTMLButtonElement;
            expect(addBtn.disabled).toBe(false); // target + PRED1 form a non-empty pool

            fireEvent.click(addBtn);
            const removeBtn = screen.getByTitle(/Remove/) as HTMLButtonElement;
            fireEvent.click(removeBtn);
            expect(screen.queryByTitle(/Remove/)).toBeNull();
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

        it('Confirm & Save sends the Time start/end into train_individual_model', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: {
                    groups: [], models: [makeStoredModel({
                        filterTimeStart: '2026-01-01T00:00',
                        filterTimeEnd: '2026-02-01T00:00',
                    })],
                },
            });
            mockOpenDialog.mockResolvedValue('C:/save/here');
            await renderHydrated();

            fireEvent.click(screen.getByText('Save Model'));
            // Footnote must acknowledge the active time filter instead of
            // claiming "none — using the full dataset."
            expect(screen.getByText(/a time range/)).toBeTruthy();
            expect(screen.queryByText(/none — using the full dataset\./)).toBeNull();

            await act(async () => {
                fireEvent.click(screen.getByText('Confirm & Save'));
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('train_individual_model', expect.objectContaining({
                filter: expect.objectContaining({
                    timestamp_start: '2026-01-01T00:00',
                    timestamp_end: '2026-02-01T00:00',
                }),
            }));
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
    });

    describe('back navigation', () => {
        it('the Back button calls onBack instead of closing any window', async () => {
            const { onBack } = await renderHydrated();
            fireEvent.click(screen.getByTitle('Back to Build Model overview'));
            expect(onBack).toHaveBeenCalledTimes(1);
        });
    });

    describe('Save flow', () => {
        it('Confirm & Save is disabled until the plan is valid, then trains the individual model', async () => {
            mockOpenDialog.mockResolvedValue('C:/save/here');
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'compute_sensor_stats') {
                    return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
                }
                if (cmd === 'train_individual_model') {
                    return Promise.resolve({ saved_path: 'C:/save/here/individual.json' });
                }
                return Promise.resolve({});
            });
            await renderHydrated();

            fireEvent.click(screen.getByText('Save Model'));
            const confirmBtn = screen.getByText('Confirm & Save').closest('button') as HTMLButtonElement;
            expect(confirmBtn.disabled).toBe(false); // individual model alone is a valid plan

            await act(async () => {
                fireEvent.click(confirmBtn);
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
            expect(mockInvoke).toHaveBeenCalledWith('train_individual_model', expect.objectContaining({ target: 'TARGET1' }));
        });

        it('cancelling the save-folder dialog does not train anything', async () => {
            mockOpenDialog.mockResolvedValue(null);
            await renderHydrated();

            fireEvent.click(screen.getByText('Save Model'));
            await act(async () => {
                fireEvent.click(screen.getByText('Confirm & Save'));
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockInvoke).not.toHaveBeenCalledWith('train_individual_model', expect.anything());
        });

        it('disables Confirm & Save when Relationship is chosen with no predictors (blocking warning)', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });
            fireEvent.click(screen.getByText('Save Model'));
            const confirmBtn = screen.getByText('Confirm & Save').closest('button') as HTMLButtonElement;
            expect(confirmBtn.disabled).toBe(true);
        });

        it('the "Filters on training data" footnote reflects only this page\'s own filters now (2026-09-01: `dashboardSnapshot` removed as dead code — it was never written by anything, so Dashboard\'s own filters never actually carried into training; removing it changes nothing observable)', async () => {
            await renderHydrated();
            fireEvent.click(screen.getByText('Save Model'));
            expect(screen.getByText(/Filters on training data:/)).toBeTruthy();
            expect(screen.getByText(/none — using the full dataset\./)).toBeTruthy();
            expect(screen.queryByText(/Dashboard sensor filter/)).toBeNull();
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

            // Plot mode is locked now (not user-toggleable), so add a sensor
            // filter instead to produce a real config change to debounce.
            fireEvent.click(screen.getByTitle('Add a sensor value filter'));
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(mockUpdateWorkspaceData).toHaveBeenCalledWith('ws1', expect.any(Function));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models.find((m: any) => m.id === 'm1').pmSensorFilters).toHaveLength(1);
            // Broadcast so Dashboard/BuildModelWindow (separate OS windows) refresh too.
            await act(async () => { await Promise.resolve(); });
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', state.failureGroupState);
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

            fireEvent.click(screen.getByTitle('Add a sensor value filter'));
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
