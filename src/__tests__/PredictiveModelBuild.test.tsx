import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within, waitFor } from '@testing-library/react';

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
        clusterRanges: [], filterTimePeriods: [],
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
        runningConditionCombine: 'and',
        runningConditionTimePeriods: [],
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
            expect(screen.queryByText('Add predictors…')).toBeNull();
        });

        it('picking a sensor from the picker popup adds it as a predictor chip', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });

            fireEvent.click(screen.getByText('Add predictors…'));
            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED1' } });
            fireEvent.click(screen.getByText('PRED1')); // checkbox row label — checks it
            fireEvent.click(screen.getByText('OK'));

            expect(screen.getByText('1')).toBeTruthy(); // predictor count pill
            expect(screen.getByText('Predictor One')).toBeTruthy(); // chip, outside the popup
        });

        it('the popup groups sensors by component and starts every group collapsed until searched', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });

            fireEvent.click(screen.getByText('Add predictors…'));
            expect(screen.getByText('Motor')).toBeTruthy(); // group header visible
            expect(screen.queryByText('PRED1')).toBeNull(); // but collapsed — member hidden

            fireEvent.click(screen.getByText('Motor'));
            expect(screen.getByText('PRED1')).toBeTruthy(); // expanded — member visible
        });

        it('multiple sensors can be checked before OK is clicked, and Cancel discards a pending change', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });

            fireEvent.click(screen.getByText('Add predictors…'));
            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED' } });
            fireEvent.click(screen.getByText('PRED1'));
            fireEvent.click(screen.getByText('PRED2'));
            expect(screen.getByText('2 selected')).toBeTruthy();

            fireEvent.click(screen.getByText('Cancel'));
            expect(screen.queryByText('Predictor One')).toBeNull(); // nothing committed
            expect(screen.getByText('0')).toBeTruthy(); // predictor count pill back to 0
        });

        it('Escape also closes the popup without committing (same convention as the chart expand modal)', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });

            fireEvent.click(screen.getByText('Add predictors…'));
            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED1' } });
            fireEvent.click(screen.getByText('PRED1'));
            fireEvent.keyDown(window, { key: 'Escape' });

            expect(screen.queryByText('1 selected')).toBeNull(); // popup gone
            expect(screen.getByText('0')).toBeTruthy(); // nothing committed
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

    // 2026-09-22: X sensor and Criteria Sensor moved from a flat
    // SensorAutocomplete to the same SensorPickerModal popup as Predictor
    // sensors, but in `single` mode — per explicit user request ("ต้องเลือก
    // sensor ได้แค่ตัวเดียว ตาม concept ของ model"). Picking a row selects it
    // and closes the popup immediately, with no OK step.
    describe('X sensor / Criteria Sensor — single-select popups (2026-09-22)', () => {
        it("the trigger's icon uses its own class, not .sensor-autocomplete-icon (regression: that class is position:absolute, meant to overlay a real <input> inside .sensor-autocomplete-input-wrap -- this button has no such wrapper, so the icon escaped to whatever ancestor WAS positioned and rendered off in an unrelated spot, reported 2026-09-22)", async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering', predictorSensors: ['PRED1'] })] },
            });
            await renderHydrated({ kind: 'clustering' });

            const criteriaRow = screen.getByText('Criteria Sensor').closest('.filter-row') as HTMLElement;
            const trigger = within(criteriaRow).getByText('Pick criteria sensor...').closest('button') as HTMLButtonElement;
            expect(trigger.querySelector('.sensor-picker-trigger-icon')).toBeTruthy();
            expect(trigger.querySelector('.sensor-autocomplete-icon')).toBeNull();
        });

        it("the trigger's label carries a truncation class (regression: a long sensor description wrapped onto a second line in a narrow row -- e.g. a Custom Running Condition row sharing space with the operator select, value input and remove button -- because the label <span> had no min-width:0/ellipsis, and a flex item's default min-width is 'auto', which refuses to shrink below its text's natural width; reported 2026-09-23)", async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering', predictorSensors: ['PRED1'], criteriaSensor: 'PRED1' })] },
            });
            await renderHydrated({ kind: 'clustering' });

            const criteriaRow = screen.getByText('Criteria Sensor').closest('.filter-row') as HTMLElement;
            const trigger = within(criteriaRow).getByText(/PRED1/).closest('button') as HTMLButtonElement;
            const label = trigger.querySelector('span') as HTMLElement;
            expect(label.className).toContain('sensor-picker-trigger-label');
        });

        it('X sensor is disabled with an explanatory placeholder until at least one predictor is chosen', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering', predictorSensors: [] })] },
            });
            await renderHydrated({ kind: 'clustering' });

            const xRow = screen.getByText(/X sensor \(vs target on Y\)/).closest('.filter-row') as HTMLElement;
            const trigger = within(xRow).getByText('No predictors selected').closest('button') as HTMLButtonElement;
            expect(trigger.disabled).toBe(true);
        });

        it('picking an X sensor selects it immediately — no OK needed, unlike the multi-select Predictor popup', async () => {
            // scatterXSensor starts unset, so the page auto-fills X to the
            // first predictor (PRED1) — pick the OTHER one to prove the
            // popup actually changes the selection.
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering', predictorSensors: ['PRED1', 'PRED2'] })] },
            });
            await renderHydrated({ kind: 'clustering' });

            const xRow = screen.getByText(/X sensor \(vs target on Y\)/).closest('.filter-row') as HTMLElement;
            expect(within(xRow).getByText(/PRED1/)).toBeTruthy(); // auto-filled default

            fireEvent.click(within(xRow).getByText(/PRED1/));
            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED2' } });
            fireEvent.click(within(xRow).getByText(/^PRED2$/));

            expect(screen.queryByText('Select X sensor')).toBeNull(); // popup closed on click, no OK needed
            expect(within(xRow).getByText(/PRED2/)).toBeTruthy(); // trigger now shows the newly-picked sensor
        });

        it('Criteria Sensor offers a "None" row and every sensor, not just the model\'s chosen predictors', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'clustering', predictorSensors: ['PRED1'] })] },
            });
            await renderHydrated({ kind: 'clustering' });

            const criteriaRow = screen.getByText('Criteria Sensor').closest('.filter-row') as HTMLElement;
            fireEvent.click(within(criteriaRow).getByText('Pick criteria sensor...'));
            expect(screen.getByText('None')).toBeTruthy();

            fireEvent.change(screen.getByPlaceholderText('Search sensor tag or description...'), { target: { value: 'PRED2' } });
            fireEvent.click(within(criteriaRow).getByText(/^PRED2$/)); // exact -- the list row's bare tag span, not the trigger

            expect(within(criteriaRow).getByText(/PRED2/)).toBeTruthy(); // trigger now shows the picked sensor
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
    // 2026-09-22: renamed from "Data filter" after the user reported not
    // being able to tell whether Time start/end + Running condition scoped
    // the chart's DISPLAY or the TRAINING data — they're the same filter
    // (feeds both), so the fix is naming that explicitly rather than
    // building a second, genuinely separate date filter (see the section's
    // own JSX comment for the full reasoning).
    describe('"Training scope" section (renamed from "Data filter")', () => {
        it('shows "Training scope" as the section title, not the old "Data filter"', async () => {
            await renderHydrated();
            expect(screen.getByText('Training scope')).toBeTruthy();
            expect(screen.queryByText('Data filter')).toBeNull();
        });

        it('explains the filter feeds both the model and the chart preview', async () => {
            await renderHydrated();
            expect(screen.getByText(/Feeds the model and the chart preview/)).toBeTruthy();
        });
    });

    // Companion to the section above: the chart's own zoom tool (LineChart's
    // 🔍 button) is genuinely display-only — client-side, never re-queries —
    // so it's called out next to the legend instead of adding a second,
    // easy-to-confuse date filter for "just viewing".
    describe('chart zoom-is-view-only note (next to the Individual chart legend)', () => {
        it('renders next to the legend when the Individual chart is shown', async () => {
            await renderHydrated();
            expect(screen.getByText('Zoom = view only')).toBeTruthy();
        });

        it('its tooltip spells out that zoom never touches Training scope or the model', async () => {
            await renderHydrated();
            const note = screen.getByText('Zoom = view only').closest('[title]') as HTMLElement;
            expect(note.title).toMatch(/never changes Training scope or what the model trains on/);
        });

        it('is absent on a Relationship-kind model (no Individual chart to attach it to)', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ kind: 'relationship' })] },
            });
            await renderHydrated({ kind: 'relationship' });
            expect(screen.queryByText('Zoom = view only')).toBeNull();
        });
    });

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
            await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
        });

        it('shows the inherited combine mode next to the condition count', async () => {
            await renderHydrated({
                runningConditionFilters: [
                    { id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' },
                ],
                runningConditionCombine: 'or',
            });
            expect(screen.getByText(/OR/)).toBeTruthy();
        });
    });

    describe('running condition — Workspace/Custom override (2026-09-23)', () => {
        it('defaults to Workspace mode and carries the workspace filter/combine into the query', async () => {
            await renderHydrated({
                runningConditionFilters: [
                    { id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' },
                ],
                runningConditionCombine: 'or',
            });
            const lastQuery = last(mockUseChartData.mock.calls)[0] as any;
            expect(lastQuery.filter.value_filters).toEqual([
                { sensor: 'PRED1', operation: 'greater_than', value1: 1200, value2: null },
            ]);
            expect(lastQuery.filter.combine).toBe('or');
        });

        it('switching to Custom seeds an editable condition from the workspace filter, and Time start/end stays untouched', async () => {
            await renderHydrated({
                runningConditionFilters: [
                    { id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' },
                ],
                runningConditionCombine: 'or',
            });
            fireEvent.click(screen.getByText('Custom'));

            // Seeded row is now editable -- a "val" input exists (read-only
            // Workspace view never renders one, per the describe block above).
            expect((screen.getByPlaceholderText('val') as HTMLInputElement).value).toBe('1200');
            // Seeded combine mode carries over too.
            expect(screen.getByRole('button', { name: 'OR' })).toBeTruthy();
        });

        it('editing a Custom condition persists customRunningConditionFilters and leaves the workspace runningConditionFilters on disk untouched', async () => {
            const onDiskModel = makeStoredModel();
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [onDiskModel] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({
                    id,
                    failureGroupState: {
                        groups: [], models: [onDiskModel],
                        runningConditionFilters: [{ id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' }],
                    },
                }));
            vi.useFakeTimers();
            await renderHydrated({
                runningConditionFilters: [{ id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' }],
            });

            fireEvent.click(screen.getByText('Custom'));
            fireEvent.change(screen.getByPlaceholderText('val'), { target: { value: '999' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const saved = state.failureGroupState.models.find((m: any) => m.id === 'm1');
            expect(saved.runningConditionMode).toBe('custom');
            expect(saved.customRunningConditionFilters[0].value1).toBe('999');
            // The workspace-wide filter this model started from is untouched.
            expect(state.failureGroupState.runningConditionFilters[0].value1).toBe('1200');
            vi.useRealTimers();
        });

        it('once in Custom mode, the query filter uses the custom condition instead of the workspace one', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: {
                    groups: [], models: [makeStoredModel({
                        runningConditionMode: 'custom',
                        customRunningConditionFilters: [{ id: 'c1', sensor: 'PRED1', operation: 'less_than', value1: '50', value2: '' }],
                        customRunningConditionCombine: 'or',
                    })],
                },
            });
            await renderHydrated({
                runningConditionFilters: [{ id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' }],
                runningConditionCombine: 'and',
            });

            const lastQuery = last(mockUseChartData.mock.calls)[0] as any;
            expect(lastQuery.filter.value_filters).toEqual([
                { sensor: 'PRED1', operation: 'less_than', value1: 50, value2: null },
            ]);
            expect(lastQuery.filter.combine).toBe('or');
        });
    });

    describe('training periods actually affect training data (Feature 4-C; replaced the single Time start/end pair)', () => {
        // Time periods follow the same Workspace/Custom split as the value
        // conditions: the editable list only renders in Custom mode, and
        // `runningConditionMode: 'custom'` on the stored model is what makes
        // that model's own `filterTimePeriods` authoritative.
        const P1 = { id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
        const P2 = { id: 'p2', start: '2026-03-01T00:00', end: '2026-03-31T23:59' };
        const R1 = { start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
        const R2 = { start: '2026-03-01T00:00', end: '2026-03-31T23:59' };
        const seedCustom = (periods: unknown[], extra: Record<string, unknown> = {}) =>
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ runningConditionMode: 'custom', filterTimePeriods: periods, ...extra })] },
            });
        const chartFilter = () => (last(mockUseChartData.mock.calls)[0] as any).filter;

        it("a Custom model's periods go into the target chart query as timestamp_ranges (and never with the legacy pair)", async () => {
            seedCustom([P1, P2]);
            await renderHydrated();
            const f = chartFilter();
            expect(f.timestamp_ranges).toEqual([R1, R2]);
            expect(f.timestamp_start).toBeNull();
            expect(f.timestamp_end).toBeNull();
        });

        it('compute_sensor_stats gets the SAME ranges as the chart (no display/training mismatch)', async () => {
            seedCustom([P1, P2]);
            await renderHydrated();
            const statsCall = mockInvoke.mock.calls.find(c => c[0] === 'compute_sensor_stats')!;
            expect(statsCall[1].filter.timestamp_ranges).toEqual([R1, R2]);
            expect(statsCall[1].filter).not.toHaveProperty('timestamp_start');
            expect(statsCall[1].filter.timestamp_ranges).toEqual(chartFilter().timestamp_ranges);
        });

        it('an incomplete "between" (no max) is NOT sent to Rust (it would match every row under OR)', async () => {
            await renderHydrated({
                runningConditionCombine: 'or',
                runningConditionFilters: [
                    { id: 'a', sensor: 'PRED1', operation: 'greater_than', value1: '10', value2: '' },
                    { id: 'b', sensor: 'PRED1', operation: 'between', value1: '1', value2: '' },
                ],
            });
            const statsCall = mockInvoke.mock.calls.find(c => c[0] === 'compute_sensor_stats')!;
            expect(statsCall[1].filter.value_filters).toEqual([{ sensor: 'PRED1', operation: 'greater_than', value1: 10, value2: null }]);
            expect(chartFilter().value_filters).toEqual(statsCall[1].filter.value_filters);
        });

        it('the relationship fit invoke carries the same ranges too', async () => {
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'compute_sensor_stats') {
                    return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
                }
                if (cmd === 'preview_relationship_model') {
                    return Promise.resolve({
                        request: 'req-1', error: undefined, predicted: [1, 2, 3], residual: [0.1, -0.1, 0.05],
                        r2_per_step: [0.9], rmse2_per_step: [0.4], target_raw: [1.1, 1.9, 3.05], predictor_raw: [[1], [2], [3]],
                    });
                }
                return Promise.resolve({});
            });
            seedCustom([P1, P2], { kind: 'relationship', rcMode: 'relationship', predictorSensors: ['PRED1'], individualChecked: false });
            await renderHydrated({ kind: 'relationship' });
            await act(async () => {
                clickApply('Relationship Model');
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            const call = mockInvoke.mock.calls.find(c => c[0] === 'preview_relationship_model')!;
            expect(call[1].filter.timestamp_ranges).toEqual([R1, R2]);
        });

        it("in Workspace mode (the default) the model's own periods are ignored and the workspace list is used, shown read-only as chips", async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ filterTimePeriods: [P1] })] },
            });
            await renderHydrated({ runningConditionTimePeriods: [P2] });
            expect(chartFilter().timestamp_ranges).toEqual([R2]);
            expect(screen.getByTestId('period-chip').textContent).toBe('2026-03-01 – 2026-03-31'); // whole days -> date only
            expect(screen.queryByTestId('time-periods-editor')).toBeNull();
        });

        it('Workspace mode with no periods reads "no limit" and sends no range gate', async () => {
            await renderHydrated();
            expect(screen.getByTestId('period-chips-empty')).toBeTruthy();
            expect(chartFilter().timestamp_ranges).toEqual([]);
        });

        it("switching to Custom copies the workspace periods (fresh ids) once, and never overwrites a model's own list", async () => {
            await renderHydrated({ runningConditionTimePeriods: [P1, P2] });
            fireEvent.click(screen.getByText('Custom'));
            expect((screen.getByLabelText('Period 1 start') as HTMLInputElement).value).toBe(P1.start);
            expect((screen.getByLabelText('Period 2 end') as HTMLInputElement).value).toBe(P2.end);
            expect(chartFilter().timestamp_ranges).toEqual([R1, R2]);
            cleanup();

            seedCustom([P2], { runningConditionMode: 'workspace' });
            await renderHydrated({ runningConditionTimePeriods: [P1] });
            fireEvent.click(screen.getByText('Custom'));
            expect(screen.queryByLabelText('Period 2 start')).toBeNull();
            expect((screen.getByLabelText('Period 1 start') as HTMLInputElement).value).toBe(P2.start);
        });

        it('editing a Custom period commits on blur: persists filterTimePeriods and updates the query', async () => {
            const onDiskModel = makeStoredModel({ runningConditionMode: 'custom', filterTimePeriods: [P1] });
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [onDiskModel] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [onDiskModel] } }));
            vi.useFakeTimers();
            await renderHydrated();

            const end = screen.getByLabelText('Period 1 end');
            fireEvent.change(end, { target: { value: '2026-02-15T12:00' } });
            // Not committed while typing.
            expect(chartFilter().timestamp_ranges).toEqual([R1]);
            fireEvent.blur(end);

            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const saved = state.failureGroupState.models.find((m: any) => m.id === 'm1');
            expect(saved.filterTimePeriods).toEqual([{ ...P1, end: '2026-02-15T12:00' }]);
            expect(saved).not.toHaveProperty('filterTimeStart');
            expect(chartFilter().timestamp_ranges).toEqual([{ start: P1.start, end: '2026-02-15T12:00' }]);
            vi.useRealTimers();
        });

        it('a period whose end is before its start blocks the chart, stats and Finish (never sent as [] = whole dataset)', async () => {
            seedCustom([{ id: 'bad', start: '2026-02-01T00:00', end: '2026-01-01T00:00' }], {
                customRunningConditionNoneConfirmed: true,
            });
            const { onFinish } = await renderHydrated();
            expect(last(mockUseChartData.mock.calls)[0]).toBeNull();
            expect(mockInvoke.mock.calls.some(c => c[0] === 'compute_sensor_stats')).toBe(false);
            expect(screen.getByTestId('pm-periods-blocked')).toBeTruthy();
            expect(screen.getByTestId('period-invalid-1').textContent).toMatch(/ends before it starts/);
            const finish = screen.getByText('Finish').closest('button') as HTMLButtonElement;
            expect(finish.disabled).toBe(true);
            expect(finish.title).toMatch(/ends before it starts/);
            fireEvent.click(finish);
            expect(onFinish).not.toHaveBeenCalled();
        });

        it('overlapping periods only warn: "Merge into one" collapses them and the query still runs', async () => {
            seedCustom([P1, { id: 'p2', start: '2026-01-20T00:00', end: '2026-02-20T00:00' }]);
            await renderHydrated();
            expect(screen.getByTestId('period-overlap-2')).toBeTruthy();
            expect(chartFilter().timestamp_ranges).toHaveLength(2); // not blocked
            fireEvent.click(screen.getByTestId('period-merge-2'));
            expect(screen.queryByTestId('period-row-2')).toBeNull();
            expect(chartFilter().timestamp_ranges).toEqual([{ start: P1.start, end: '2026-02-20T00:00' }]);
        });

        it('a blank-both period means "every row" and is sent as no range gate ([]), not as a blank range', async () => {
            seedCustom([{ id: 'open', start: '', end: '' }]);
            await renderHydrated();
            expect(chartFilter().timestamp_ranges).toEqual([]);
        });

        it('an un-migrated model with the old single Time start/end reads as one period', async () => {
            const legacy: Record<string, unknown> = makeStoredModel({ runningConditionMode: 'custom', filterTimeStart: '2026-01-01T00:00', filterTimeEnd: '2026-02-01T00:00' });
            delete legacy.filterTimePeriods;
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [legacy] } });
            await renderHydrated();
            expect(chartFilter().timestamp_ranges).toEqual([{ start: '2026-01-01T00:00', end: '2026-02-01T00:00' }]);
        });
    });

    describe('back navigation', () => {
        it('the Back button calls onBack instead of closing any window', async () => {
            const { onBack } = await renderHydrated();
            fireEvent.click(screen.getByTitle('Back to Build Model overview'));
            await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
        });
    });

    describe('leaving the page flushes a pending debounced persist (2026-09-24)', () => {
        it('Back and Finish write an edit made < 250ms earlier BEFORE calling onBack/onFinish', async () => {
            const onDiskModel = makeStoredModel({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [onDiskModel] } });
            const order: string[] = [];
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => {
                order.push('write');
                return patch({ id, failureGroupState: { groups: [], models: [onDiskModel] } });
            });
            const { onFinish } = await renderHydrated();
            await act(async () => { await new Promise(r => setTimeout(r, 300)); }); // hydration's own write settles
            order.length = 0;
            (onFinish as any).mockImplementation(() => { order.push('finish'); });

            fireEvent.click(screen.getByLabelText('No condition — use all rows')); // un-confirm ...
            fireEvent.click(screen.getByLabelText('No condition — use all rows')); // ... and re-confirm: pending write, gate open
            fireEvent.click(screen.getByText('Finish'));
            await waitFor(() => expect(order).toEqual(['write', 'finish']));
        });
    });

    describe('Finish button (2026-09-17: marks the model Complete on the overview list, replacing the old Preview/Save Model flow)', () => {
        // Feature 4-B (2026-09-24): Finish is behind the running-condition gate
        // (soft gate A) -- the same getBuildBlockReason the Overview's Build Model uses.
        const cond = [{ id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' }] as const;
        const finishBtn = () => screen.getByText('Finish').closest('button') as HTMLButtonElement;

        it('clicking Finish calls onFinish once the workspace running condition is set', async () => {
            const { onFinish } = await renderHydrated({ runningConditionFilters: [...cond] });
            expect(finishBtn().disabled).toBe(false);
            fireEvent.click(screen.getByText('Finish'));
            await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
        });

        it('is disabled with the reason (button title + inline text) while the workspace condition is unset, and a click does nothing', async () => {
            const { onFinish } = await renderHydrated();
            expect(finishBtn().disabled).toBe(true);
            expect(finishBtn().title).toMatch(/Set a running condition first/);
            expect(screen.getByTestId('finish-block-reason').textContent).toMatch(/No condition — use all rows/);
            fireEvent.click(finishBtn());
            expect(onFinish).not.toHaveBeenCalled();
        });

        it('a time period alone does not unlock Finish', async () => {
            await renderHydrated({ runningConditionTimePeriods: [{ id: 'w1', start: '2026-05-01T00:00', end: '2026-06-01T00:00' }] });
            expect(finishBtn().disabled).toBe(true);
        });

        it('an incomplete workspace condition (no value) does not unlock Finish', async () => {
            await renderHydrated({ runningConditionFilters: [{ ...cond[0], value1: '' }] });
            expect(finishBtn().disabled).toBe(true);
        });

        it('a workspace "No condition — use all rows" confirmation unlocks Finish', async () => {
            await renderHydrated({ runningConditionNoneConfirmed: true });
            expect(finishBtn().disabled).toBe(false);
            expect(screen.queryByTestId('finish-block-reason')).toBeNull();
        });

        it('reports the SAME reason string the shared gate returns (one gate, one message)', async () => {
            await renderHydrated();
            expect(finishBtn().title).toBe('Set a running condition first, or choose "No condition — use all rows".');
        });

        it('a configured Custom model can Finish even though the workspace is unset', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({
                    runningConditionMode: 'custom',
                    customRunningConditionFilters: [{ id: 'c1', sensor: 'PRED1', operation: 'less_than', value1: '50', value2: '' }],
                })] },
            });
            const { onFinish } = await renderHydrated(); // workspace: nothing set
            expect(finishBtn().disabled).toBe(false);
            fireEvent.click(finishBtn());
            await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
        });

        it('a Custom model with nothing set stays blocked even if the workspace is configured (workspace None does not help Custom)', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ runningConditionMode: 'custom' })] },
            });
            await renderHydrated({ runningConditionNoneConfirmed: true });
            expect(finishBtn().disabled).toBe(true);
        });
    });

    describe('running-condition banner and Custom "No condition" (Feature 4-B)', () => {
        it('Workspace mode with the workspace unset shows a banner with "Set on Overview →" (onBack) and "Use Custom instead"', async () => {
            const { onBack } = await renderHydrated();
            const banner = screen.getByTestId('pm-rc-required-banner');
            fireEvent.click(within(banner).getByText('Set on Overview →'));
            await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));

            fireEvent.click(within(banner).getByText('Use Custom instead'));
            expect(screen.queryByTestId('pm-rc-required-banner')).toBeNull();
            expect(screen.getByLabelText('No condition — use all rows')).toBeTruthy(); // Custom's own confirm control
        });

        it('no banner once the workspace is configured (condition or confirmed None)', async () => {
            await renderHydrated({ runningConditionNoneConfirmed: true });
            expect(screen.queryByTestId('pm-rc-required-banner')).toBeNull();
            expect(screen.getByText(/No condition — using all rows/)).toBeTruthy();
        });

        it('Custom "No condition — use all rows" shows a warning, unlocks Finish and persists customRunningConditionNoneConfirmed', async () => {
            const onDiskModel = makeStoredModel({ runningConditionMode: 'custom' });
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [onDiskModel] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [onDiskModel] } }));
            vi.useFakeTimers();
            await renderHydrated();
            const finish = () => screen.getByText('Finish').closest('button') as HTMLButtonElement;
            expect(finish().disabled).toBe(true);
            expect(screen.queryByTestId('pm-custom-none-warning')).toBeNull();

            fireEvent.click(screen.getByLabelText('No condition — use all rows'));
            expect(screen.getByTestId('pm-custom-none-warning')).toBeTruthy();
            expect(finish().disabled).toBe(false);
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].customRunningConditionNoneConfirmed).toBe(true);
            vi.useRealTimers();
        });

        it('adding a Custom condition after confirming None clears the confirmation', async () => {
            mockLoadWorkspaceData.mockResolvedValue({
                name: 'WS',
                failureGroupState: { groups: [], models: [makeStoredModel({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true })] },
            });
            await renderHydrated();
            const box = screen.getByLabelText('No condition — use all rows') as HTMLInputElement;
            expect(box.checked).toBe(true);
            fireEvent.click(box); // un-confirm to reach the list
            fireEvent.click(screen.getByText('+ Add condition'));
            expect((screen.getByLabelText('No condition — use all rows') as HTMLInputElement).checked).toBe(false);
            expect(screen.getByPlaceholderText('val')).toBeTruthy();
        });

        it('a confirmed workspace None means the saved workspace conditions are NOT sent in the query filter', async () => {
            await renderHydrated({
                runningConditionNoneConfirmed: true,
                runningConditionFilters: [{ id: 'rcf1', sensor: 'PRED1', operation: 'greater_than', value1: '1200', value2: '' }],
            });
            const lastQuery = last(mockUseChartData.mock.calls)[0] as any;
            expect(lastQuery.filter.value_filters).toEqual([]);
        });
    });

    describe('persistence', () => {
        it('debounces a write into this model\'s own FailureModel record (not a global slot) after a field change', async () => {
            const onDiskModel = makeStoredModel({ runningConditionMode: 'custom', filterTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }] });
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [onDiskModel] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [onDiskModel] } }));
            vi.useFakeTimers();
            await renderHydrated();
            mockUpdateWorkspaceData.mockClear();
            mockEmit.mockClear();

            // Plot mode is locked now (not user-toggleable), and the old
            // per-model sensor-value filter is gone (2026-09-15 -- see the
            // "running condition" describe block above), so edit a training
            // period instead to produce a real config change to debounce.
            // Custom mode (set on the stored model above) so the period
            // editor actually renders (2026-09-23; periods since Feature 4-C).
            const startInput = screen.getByLabelText('Period 1 start');
            fireEvent.change(startInput, { target: { value: '2026-01-05T00:00' } });
            fireEvent.blur(startInput);
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(mockUpdateWorkspaceData).toHaveBeenCalledWith('ws1', expect.any(Function));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models.find((m: any) => m.id === 'm1').filterTimePeriods[0].start).toBe('2026-01-05T00:00');
            // Broadcast so Dashboard/BuildModelWindow (separate OS windows) refresh too.
            await act(async () => { await Promise.resolve(); });
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', { ...state.failureGroupState, workspaceId: 'ws1', origin: 'predictive-model' });
            vi.useRealTimers();
        });

        it('does not touch another model in the same group when this one changes', async () => {
            const sibling = makeStoredModel({ id: 'm2', targetSensor: 'PRED1', relModelName: 'Untouched' });
            const thisModel = makeStoredModel({ runningConditionMode: 'custom', filterTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }] });
            mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [thisModel, sibling] } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [thisModel, sibling] } }));
            vi.useFakeTimers();
            await renderHydrated();
            mockUpdateWorkspaceData.mockClear();
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups: [], models: [thisModel, sibling] } }));

            const startInput = screen.getByLabelText('Period 1 start');
            fireEvent.change(startInput, { target: { value: '2026-01-05T00:00' } });
            fireEvent.blur(startInput);
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const other = state.failureGroupState.models.find((m: any) => m.id === 'm2');
            expect(other.relModelName).toBe('Untouched');
            vi.useRealTimers();
        });
    });

    it('a per-model config autosave keeps the workspace-level failureGroupState fields it does not own, e.g. the workspace time periods (regression 2026-09-23: it rebuilt the slice from an explicit field list and dropped them)', async () => {
        const thisModel = makeStoredModel({ runningConditionMode: 'custom', filterTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }] });
        const wsPeriods = [{ id: 'w1', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }];
        mockLoadWorkspaceData.mockResolvedValue({ name: 'WS', failureGroupState: { groups: [], models: [thisModel] } });
        mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({
            id,
            failureGroupState: {
                groups: [], models: [thisModel],
                runningConditionTimePeriods: wsPeriods,
                someFutureField: 'keep-me',
            },
        }));
        vi.useFakeTimers();
        await renderHydrated();
        mockUpdateWorkspaceData.mockClear();
        mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({
            id,
            failureGroupState: {
                groups: [], models: [thisModel],
                runningConditionTimePeriods: wsPeriods,
                someFutureField: 'keep-me',
            },
        }));

        const startInput = screen.getByLabelText('Period 1 start');
        fireEvent.change(startInput, { target: { value: '2026-01-05T00:00' } });
        fireEvent.blur(startInput);
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });

        const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
        expect(state.failureGroupState.runningConditionTimePeriods).toEqual(wsPeriods);
        expect(state.failureGroupState.someFutureField).toBe('keep-me');
        vi.useRealTimers();
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
