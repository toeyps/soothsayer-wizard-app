import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockMinimize = vi.fn().mockResolvedValue(undefined);
const mockToggleMaximize = vi.fn().mockResolvedValue(undefined);
const mockGetCurrentWindow = vi.fn(() => ({ close: mockClose, minimize: mockMinimize, toggleMaximize: mockToggleMaximize }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => mockGetCurrentWindow(),
}));

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

vi.mock('../hooks/useSubWindowMenu', () => ({ useSubWindowMenu: vi.fn() }));
vi.mock('../hooks/usePMReport', () => ({
    usePMReport: () => ({ exportPNG: vi.fn().mockResolvedValue(undefined), exportPDF: vi.fn().mockResolvedValue(undefined) }),
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
import type { CsvMetadata, SensorMetadata } from '../types';

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TARGET1', description: 'Target Sensor', unit: 'bar', component: 'Pump' },
    { tag: 'PRED1', description: 'Predictor One', unit: 'C', component: 'Motor' },
    { tag: 'PRED2', description: 'Predictor Two', unit: 'C', component: 'Motor' },
];

const csvMetadata: CsvMetadata = { headers: ['timestamp', 'TARGET1', 'PRED1', 'PRED2'], total_rows: 100 };

function makePayload(overrides: Record<string, any> = {}) {
    return {
        workspaceId: 'ws1',
        targetSensor: 'TARGET1',
        predictorSensors: [] as string[],
        sensorHeaders: ['TARGET1', 'PRED1', 'PRED2'],
        sensorMetadata,
        metadata: csvMetadata,
        ...overrides,
    };
}

async function deliverPredictiveData(payload: Record<string, any> = makePayload()) {
    await act(async () => {
        for (const cb of listenCallbacks['predictive-model-data'] ?? []) {
            cb({ payload });
        }
        await Promise.resolve();
        await Promise.resolve();
    });
}

function clickApply(section: 'Relationship Model' | 'Clustering Model') {
    const btn = screen.getByText(section).closest('.pm-config-block')!.querySelector('button.pm-btn-primary') as HTMLButtonElement;
    fireEvent.click(btn);
}

async function flush(times = 3) {
    await act(async () => {
        for (let i = 0; i < times; i++) await Promise.resolve();
    });
}

beforeEach(() => {
    lineChartProps.length = 0;
    listenCallbacks = {};
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    mockMinimize.mockClear().mockResolvedValue(undefined);
    mockToggleMaximize.mockClear().mockResolvedValue(undefined);
    mockInvoke.mockReset().mockImplementation((cmd: string) => {
        if (cmd === 'compute_sensor_stats') {
            return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
        }
        return Promise.resolve({});
    });
    mockOpenDialog.mockReset();
    mockUpdateWorkspaceData.mockClear().mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id }));
    mockLoadWorkspaceData.mockClear().mockResolvedValue(null);
    mockUseChartData.mockClear().mockReturnValue({ view: null, loading: false, error: null });
});

afterEach(() => {
    cleanup();
});

describe('PredictiveModelBuild', () => {
    it('shows a loading state until predictive-model-data arrives', async () => {
        render(<PredictiveModelBuild />);
        expect(screen.getByText('Loading model data...')).toBeTruthy();
        await deliverPredictiveData();
        expect(screen.queryByText('Loading model data...')).toBeNull();
    });

    it('emits request-predictive-data on mount', async () => {
        render(<PredictiveModelBuild />);
        await flush();
        expect(mockEmit).toHaveBeenCalledWith('request-predictive-data', undefined);
    });

    it('hydrates target sensor and workspace name from the event payload (no persisted slice)', async () => {
        mockLoadWorkspaceData.mockResolvedValue({ name: 'My Workspace' });
        render(<PredictiveModelBuild />);
        await deliverPredictiveData(makePayload({ predictorSensors: ['PRED1'] }));
        expect(screen.getByText('My Workspace')).toBeTruthy();
        expect(screen.getAllByText('TARGET1').length).toBeGreaterThan(0);
        expect(screen.getByText('Predictor One')).toBeTruthy(); // hydrated predictor chip
    });

    it('a persisted predictiveModelState slice overrides the incoming payload', async () => {
        mockLoadWorkspaceData.mockResolvedValue({
            name: 'WS',
            predictiveModelState: {
                targetSensor: 'TARGET1',
                predictorSensors: ['PRED2'],
                individualChecked: false,
                rcMode: 'relationship',
                scatterXSensor: 'PRED2',
                relModelName: 'Saved Model',
                relStiffness: 100000,
                clusterModelName: '',
                numClusters: 3,
                criteriaSensor: '',
                clusterRanges: [{ min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 }],
                filterTimeStart: '',
                filterTimeEnd: '',
                pmSensorFilters: [],
            },
        });
        render(<PredictiveModelBuild />);
        await deliverPredictiveData(makePayload({ predictorSensors: ['PRED1'] })); // payload says PRED1...
        expect(screen.getByText('Predictor Two')).toBeTruthy(); // ...but the persisted slice (PRED2) wins
        expect(screen.queryByText('Predictor One')).toBeNull();
        // Individual was persisted as unchecked.
        const individualBtn = screen.getByText('Individual').closest('button')!;
        expect(individualBtn.className).not.toContain('active');
        // Relationship mode persisted as active.
        const relBtn = screen.getByText('Relationship').closest('button')!;
        expect(relBtn.className).toContain('active');
    });

    it('fetches target-sensor stats once hydrated and feeds mean/σ markLines to the LineChart', async () => {
        mockUseChartData.mockReturnValue({
            view: { headers: ['TARGET1'], timestamps: ['t0', 't1'], series: [[1, 2]], total_rows: 2, ts_min: 't0', ts_max: 't1' },
            loading: false, error: null,
        });
        render(<PredictiveModelBuild />);
        await deliverPredictiveData();
        await flush();
        expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.objectContaining({ sensor: 'TARGET1' }));
        const markLines = last(lineChartProps).markLines;
        expect(markLines.map((m: any) => m.label)).toEqual(['Mean', '+1σ', '−1σ', '+3σ', '−3σ']);
    });

    describe('predictor selection', () => {
        it('picking a sensor from the autocomplete adds it as a predictor chip', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED1' } });
            fireEvent.click(screen.getByText('Predictor One'));
            expect(screen.getByText('1')).toBeTruthy(); // predictor count pill
        });

        it('removing a predictor chip drops it from the selection', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData(makePayload({ predictorSensors: ['PRED1'] }));
            expect(screen.getByText('Predictor One')).toBeTruthy();
            fireEvent.click(screen.getByText('Predictor One').closest('.pm-selected-chip')!.querySelector('.pm-selected-remove')!);
            expect(screen.queryByText('Predictor One')).toBeNull();
        });
    });

    describe('mode toggles', () => {
        it('Individual toggles independently', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            const btn = screen.getByText('Individual').closest('button')!;
            expect(btn.className).toContain('active'); // starts checked
            fireEvent.click(btn);
            expect(btn.className).not.toContain('active');
        });

        it('Relationship and Clustering are mutually exclusive', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            fireEvent.click(screen.getByText('Relationship'));
            expect(screen.getByText('Relationship').closest('button')!.className).toContain('active');

            fireEvent.click(screen.getByText('Clustering'));
            expect(screen.getByText('Clustering').closest('button')!.className).toContain('active');
            expect(screen.getByText('Relationship').closest('button')!.className).not.toContain('active');
        });

        it('re-clicking the active mode turns it off', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            fireEvent.click(screen.getByText('Relationship'));
            fireEvent.click(screen.getByText('Relationship'));
            expect(screen.getByText('Relationship').closest('button')!.className).not.toContain('active');
        });
    });

    describe('Relationship Apply', () => {
        it('blocks with no predictors selected', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            fireEvent.click(screen.getByText('Relationship'));
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
            render(<PredictiveModelBuild />);
            await deliverPredictiveData(makePayload({ predictorSensors: ['PRED1'] }));
            fireEvent.click(screen.getByText('Relationship'));

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
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            fireEvent.click(screen.getByText('Clustering'));
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
            render(<PredictiveModelBuild />);
            await deliverPredictiveData(makePayload({ predictorSensors: ['PRED1'] }));
            fireEvent.click(screen.getByText('Clustering'));

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
            render(<PredictiveModelBuild />);
            await deliverPredictiveData(makePayload({ predictorSensors: ['PRED1'] }));
            const addBtn = screen.getByTitle('Add a sensor value filter') as HTMLButtonElement;
            expect(addBtn.disabled).toBe(false); // target + PRED1 form a non-empty pool

            fireEvent.click(addBtn);
            const removeBtn = screen.getByTitle(/Remove/) as HTMLButtonElement;
            fireEvent.click(removeBtn);
            expect(screen.queryByTitle(/Remove/)).toBeNull();
        });
    });

    describe('window controls', () => {
        it('Minimize/Maximize/Close call the corresponding Tauri window APIs', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            fireEvent.click(screen.getByTitle('Minimize'));
            expect(mockMinimize).toHaveBeenCalled();
            fireEvent.click(screen.getByTitle('Maximize'));
            expect(mockToggleMaximize).toHaveBeenCalled();

            await act(async () => {
                fireEvent.click(screen.getByText('×', { selector: '.predictive-close-btn' }));
                await Promise.resolve();
            });
            expect(mockEmit).toHaveBeenCalledWith('predictive-model-closed', undefined);
            expect(mockClose).toHaveBeenCalled();
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
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();

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
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();

            fireEvent.click(screen.getByText('Save Model'));
            await act(async () => {
                fireEvent.click(screen.getByText('Confirm & Save'));
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockInvoke).not.toHaveBeenCalledWith('train_individual_model', expect.anything());
        });

        it('disables Confirm & Save when Relationship is chosen with no predictors (blocking warning)', async () => {
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            fireEvent.click(screen.getByText('Relationship'));
            fireEvent.click(screen.getByText('Save Model'));
            const confirmBtn = screen.getByText('Confirm & Save').closest('button') as HTMLButtonElement;
            expect(confirmBtn.disabled).toBe(true);
        });
    });

    describe('persistence', () => {
        it('debounces a predictiveModelState write after a mode toggle', async () => {
            vi.useFakeTimers();
            render(<PredictiveModelBuild />);
            await deliverPredictiveData();
            mockUpdateWorkspaceData.mockClear();

            fireEvent.click(screen.getByText('Individual'));
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(mockUpdateWorkspaceData).toHaveBeenCalledWith('ws1', expect.any(Function));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.predictiveModelState.individualChecked).toBe(false);
            vi.useRealTimers();
        });
    });

    it('picks up a rename via the workspace-renamed-internal event', async () => {
        render(<PredictiveModelBuild />);
        await deliverPredictiveData();
        await act(async () => {
            for (const cb of listenCallbacks['workspace-renamed-internal'] ?? []) {
                cb({ payload: { newName: 'Renamed WS' } });
            }
        });
        expect(screen.getByText('Renamed WS')).toBeTruthy();
    });
});
