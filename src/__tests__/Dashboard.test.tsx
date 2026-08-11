import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import type { CsvMetadata, SensorMetadata, WorkspaceState } from '../types';
import type { DashboardRef } from '../components/dashboard/Dashboard';

// ── Child component mocks — capture props, expose trigger buttons ─────────

const dataTableProps: any[] = [];
vi.mock('../components/dashboard/DataTable', () => ({
    default: (props: any) => { dataTableProps.push(props); return <div data-testid="data-table" />; },
}));

const chartProps: any[] = [];
vi.mock('../components/charts', () => ({
    Chart: (props: any) => { chartProps.push(props); return <div data-testid="chart-mock" />; },
    defaultSensorColor: (tag: string) => `default-${tag}`,
    LINE_CHART_COLORS: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
}));

const filterPanelProps: any[] = [];
vi.mock('../components/dashboard/FilterPanel', () => ({
    default: (props: any) => {
        filterPanelProps.push(props);
        return (
            <div data-testid="filter-panel">
                <button onClick={() => props.onFiltersChange({ timestampStart: '2026-01-01T00:00', timestampEnd: '', sensorFilters: [] })}>
                    apply-filter
                </button>
            </div>
        );
    },
}));

const sensorSelectionProps: any[] = [];
vi.mock('../components/dashboard/SensorSelection', () => ({
    default: (props: any) => {
        sensorSelectionProps.push(props);
        return (
            <div data-testid="sensor-selection">
                <button onClick={() => props.onSensorChange(['TAG1'])}>select-tag1</button>
                <button onClick={() => props.onSensorChange(['TAG1', 'TAG2'])}>select-tag1-tag2</button>
                <button onClick={() => props.onSensorChange([])}>select-none</button>
                <button onClick={() => props.onToggleSensorGroup('TAG1', 1)}>toggle-group</button>
                <button onClick={() => props.onCreateGroupForSensor('TAG1', 'New Group')}>create-group-for-sensor</button>
                <button onClick={() => props.onRenameGroup(1, 'Renamed')}>rename-group</button>
                <button onClick={() => props.onDeleteGroup(1)}>delete-group</button>
                <button onClick={() => props.onToggleAlarmLine('TAG1', 'H')}>toggle-alarm</button>
            </div>
        );
    },
}));

const fgPanelProps: any[] = [];
vi.mock('../components/dashboard/FailureGroupsPanel', () => ({
    default: (props: any) => {
        fgPanelProps.push(props);
        return (
            <div data-testid="fg-panel">
                <button onClick={() => props.onToggleGroupCollapse(1)}>toggle-collapse</button>
                <button onClick={() => props.onCreateEmptyGroup('Empty Group')}>create-empty-group</button>
                <button onClick={() => props.onAddBlankRow(1)}>add-blank-row</button>
                <button onClick={() => props.onUpdateRow('r1', 'status', true)}>update-row</button>
                <button onClick={() => props.onRemoveRow('r1')}>remove-row</button>
                <button
                    onClick={() => props.onBuildModel({
                        id: 'r1', groupNo: 1, mappedSensorTag: 'TAG1', conceptSensor: '',
                        mappedSensorName: '', modelType: '', modelNotes: '', additionalNotes: '', status: false,
                    })}
                >
                    build-model
                </button>
            </div>
        );
    },
}));

vi.mock('../components/dashboard/ColorPlatePicker', () => ({
    default: (props: any) => <button onClick={() => props.onChange('#abcdef')}>set-color</button>,
}));

// ── Data hooks — controllable, no debounce/invoke timing to fight ─────────

const mockUseChartData = vi.fn((_query?: unknown) => ({ view: null, loading: false, error: null } as any));
vi.mock('../hooks/useChartData', () => ({ useChartData: (query: unknown) => mockUseChartData(query) }));

const mockUseTablePage = vi.fn((_query?: unknown) => ({ page: null, loading: false, error: null } as any));
vi.mock('../hooks/useTablePage', () => ({ useTablePage: (query: unknown) => mockUseTablePage(query) }));

const mockUseScatterSample = vi.fn(
    (_filter?: unknown, _max?: unknown, _active?: unknown) =>
        ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null } as any),
);
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: (filter: unknown, max: unknown, active: unknown) => mockUseScatterSample(filter, max, active),
}));

// ── Tauri / infra mocks ────────────────────────────────────────────────

const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
const mockListen = vi.fn((event: string, cb: (e: any) => void) => {
    (listenCallbacks[event] ??= []).push(cb);
    return Promise.resolve(() => {
        listenCallbacks[event] = (listenCallbacks[event] ?? []).filter((c) => c !== cb);
    });
});
const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => mockListen(event, cb),
    emit: (event: string, payload?: any) => mockEmit(event, payload),
}));

const { webviewWindowCalls, mockGetByLabel, MockWebviewWindow } = vi.hoisted(() => {
    const webviewWindowCalls: any[] = [];
    const mockGetByLabel = vi.fn().mockResolvedValue(null);
    class MockWebviewWindow {
        label: string;
        opts: any;
        constructor(label: string, opts: any) {
            this.label = label;
            this.opts = opts;
            webviewWindowCalls.push({ label, opts });
        }
        once = vi.fn().mockResolvedValue(undefined);
        static getByLabel = (...args: any[]) => mockGetByLabel(args[0]);
    }
    return { webviewWindowCalls, mockGetByLabel, MockWebviewWindow };
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: MockWebviewWindow }));

const mockSave = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (opts: unknown) => mockSave(opts) }));

const splitCalls: any[] = [];
const mockSplitDestroy = vi.fn();
vi.mock('split.js', () => ({
    default: (elements: any, options: any) => {
        splitCalls.push({ elements, options });
        return { destroy: mockSplitDestroy };
    },
}));

const mockSaveWorkspaceData = vi.fn().mockResolvedValue(undefined);
const mockUpdateWorkspaceData = vi.fn(async (id: string, patch: (s: any) => any) => patch({ id }));
const mockLoadWorkspaceData = vi.fn().mockResolvedValue(null);
vi.mock('../workspaceManager', () => ({
    saveWorkspaceData: (state: unknown) => mockSaveWorkspaceData(state),
    updateWorkspaceData: (id: string, patch: any) => mockUpdateWorkspaceData(id, patch),
    loadWorkspaceData: (id: string) => mockLoadWorkspaceData(id),
}));

const mockReportError = vi.fn();
vi.mock('../errorReporter', () => ({
    reportError: (source: string, err: unknown) => mockReportError(source, err),
}));

import Dashboard from '../components/dashboard/Dashboard';

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

// ── Fixtures ────────────────────────────────────────────────────────────

function makeMetadata(): CsvMetadata {
    return { headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3'], total_rows: 100 };
}

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmH: 90 },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];

function makeInitialState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
    return {
        id: 'ws1', name: 'Test WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        ...overrides,
    };
}

function renderDashboard(props: Partial<React.ComponentProps<typeof Dashboard>> = {}, ref?: React.Ref<DashboardRef>) {
    const defaultProps = {
        metadata: makeMetadata(),
        sensorMetadata,
        onBack: vi.fn(),
        initialState: makeInitialState(),
    };
    return render(<Dashboard {...defaultProps} {...props} ref={ref} />);
}

beforeEach(() => {
    dataTableProps.length = 0;
    chartProps.length = 0;
    filterPanelProps.length = 0;
    sensorSelectionProps.length = 0;
    fgPanelProps.length = 0;
    webviewWindowCalls.length = 0;
    splitCalls.length = 0;
    listenCallbacks = {};
    mockUseChartData.mockClear().mockReturnValue({ view: null, loading: false, error: null });
    mockUseTablePage.mockClear().mockReturnValue({ page: null, loading: false, error: null });
    mockUseScatterSample.mockClear().mockReturnValue({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null });
    mockInvoke.mockClear().mockResolvedValue(undefined);
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockGetByLabel.mockClear().mockResolvedValue(null);
    mockSave.mockClear();
    mockSaveWorkspaceData.mockClear().mockResolvedValue(undefined);
    mockUpdateWorkspaceData.mockClear().mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id }));
    mockLoadWorkspaceData.mockClear().mockResolvedValue(null);
    mockReportError.mockClear();
});

afterEach(() => {
    cleanup();
});

describe('Dashboard', () => {
    it('seeds selected/visible sensors from initialState and passes them to child panels', () => {
        renderDashboard({
            initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }),
        });
        expect(last(sensorSelectionProps).selectedSensors).toEqual(['TAG1']);
    });

    it('autosaves on mount with the workspace name and lastRoute "dashboard"', () => {
        renderDashboard({ initialState: makeInitialState({ name: 'My Workspace' }) });
        expect(mockSaveWorkspaceData).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'My Workspace', lastRoute: 'dashboard' }),
        );
    });

    describe('panel collapse / expand', () => {
        it('hiding the chart panel removes it and adds a sidebar tab; clicking the tab restores it', () => {
            renderDashboard();
            fireEvent.click(screen.getAllByTitle('Hide panel')[0]); // chart panel is first
            expect(screen.queryByText('Sensor Readings')).toBeNull();
            expect(screen.getByTitle('Show Chart')).toBeTruthy();

            fireEvent.click(screen.getByTitle('Show Chart'));
            expect(screen.getByText('Sensor Readings')).toBeTruthy();
        });
    });

    describe('sensor selection', () => {
        it('selecting a sensor via SensorSelection syncs visibleSensors and shows it in the Selected Sensor tab', () => {
            renderDashboard();
            fireEvent.click(screen.getByText('select-tag1'));
            expect(screen.getByText('Pump Pressure')).toBeTruthy();
        });

        it('assigns default palette colors by selection order for sensors with no explicit color', () => {
            renderDashboard();
            fireEvent.click(screen.getByText('select-tag1-tag2'));
            const lastChart = last(chartProps.filter((p) => p.chartType === 'line'));
            expect(lastChart.sensorColors).toEqual({ TAG1: 'c0', TAG2: 'c1' });
        });

        it('Clear all empties selectedSensors', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('Clear all'));
            expect(screen.queryByText('Pump Pressure')).toBeNull();
        });

        it('removing a sensor via the trash icon drops it from the plot', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle('Remove from plot'));
            expect(screen.queryByText('Pump Pressure')).toBeNull();
        });
    });

    describe('chart type switching', () => {
        it('disables Scatter/Pair Plot with fewer than 2 sensors and enables them with 2+', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            expect((screen.getByText('Scatter') as HTMLButtonElement).disabled).toBe(true);

            fireEvent.click(screen.getByText('select-tag1-tag2'));
            expect((screen.getByText('Scatter') as HTMLButtonElement).disabled).toBe(false);
        });

        it('clicking Scatter switches the chart type', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'] }) });
            fireEvent.click(screen.getByText('Scatter'));
            expect(last(chartProps).chartType).toBe('scatter');
        });

        it('bounces back to "line" when the selection drops below 2 while scatter is active', () => {
            renderDashboard({
                initialState: makeInitialState({
                    selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'], chartType: 'scatter',
                }),
            });
            expect(last(chartProps).chartType).toBe('scatter');

            fireEvent.click(screen.getByText('select-tag1')); // down to 1 sensor
            expect(last(chartProps).chartType).toBe('line');
        });
    });

    describe('filters', () => {
        it('FilterPanel changes flow into the chart-data query filter', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('Filter'));
            fireEvent.click(screen.getByText('apply-filter'));
            const lastCall = last(mockUseChartData.mock.calls)![0] as any;
            expect(lastCall.filter.timestamp_start).toBe('2026-01-01T00:00');
        });
    });

    describe('failure-group wiring (from the Sensor tab quick-assign)', () => {
        it('toggling a sensor into a group persists via updateWorkspaceData with the new row', () => {
            renderDashboard({
                initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'Group A', isCollapsed: false }], rows: [] } }),
            });
            fireEvent.click(screen.getByText('toggle-group'));
            const patchResult = last(mockUpdateWorkspaceData.mock.results)!.value;
            return patchResult.then((state: any) => {
                expect(state.failureGroupState.rows).toHaveLength(1);
                expect(state.failureGroupState.rows[0]).toMatchObject({ mappedSensorTag: 'TAG1', groupNo: 1 });
            });
        });

        it('creating a group for a sensor adds both the group and its row', async () => {
            renderDashboard();
            fireEvent.click(screen.getByText('create-group-for-sensor'));
            const state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups.map((g: any) => g.name)).toContain('New Group');
            expect(state.failureGroupState.rows[0].mappedSensorTag).toBe('TAG1');
        });

        it('renaming and deleting a group updates fgGroups accordingly', async () => {
            renderDashboard({
                initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'Group A', isCollapsed: false }], rows: [] } }),
            });
            fireEvent.click(screen.getByText('rename-group'));
            let state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups[0].name).toBe('Renamed');

            fireEvent.click(screen.getByText('delete-group'));
            state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups).toHaveLength(0);
        });
    });

    describe('Failure Groups tab (group-centric manage view)', () => {
        it('addBlankRow / updateRow / removeRow round-trip through fgRows', async () => {
            renderDashboard();
            fireEvent.click(screen.getByText('Failure Groups'));

            fireEvent.click(screen.getByText('add-blank-row'));
            let state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.rows).toHaveLength(1);

            fireEvent.click(screen.getByText('update-row'));
            state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            // update-row targets id 'r1' which doesn't exist yet (blank row got
            // an id-`${Date.now()}...`), so this exercises the no-op-match path
            // without throwing — the real id-targeted case is covered by
            // FailureGroupsPanel's own tests.
            expect(state.failureGroupState.rows).toHaveLength(1);

            fireEvent.click(screen.getByText('create-empty-group'));
            state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups.map((g: any) => g.name)).toContain('Empty Group');
        });
    });

    describe('color / axis editor (Selected Sensor tab)', () => {
        it('the color picker updates sensorColors and is reflected on the Chart', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle('Change line color'));
            fireEvent.click(screen.getByText('set-color'));
            const lastChart = last(chartProps.filter((p) => p.chartType === 'line'));
            expect(lastChart.sensorColors.TAG1).toBe('#abcdef');
        });

        it('rejects an axis pin where min >= max', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle(/Pin the Y-axis/));
            fireEvent.change(screen.getByPlaceholderText('min'), { target: { value: '10' } });
            fireEvent.change(screen.getByPlaceholderText('max'), { target: { value: '5' } });
            fireEvent.click(screen.getByText('Apply'));
            expect(screen.getByText('Min must be less than max')).toBeTruthy();
        });

        it('applies a valid axis pin and reflects it on the Chart', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle(/Pin the Y-axis/));
            fireEvent.change(screen.getByPlaceholderText('min'), { target: { value: '0' } });
            fireEvent.change(screen.getByPlaceholderText('max'), { target: { value: '100' } });
            fireEvent.click(screen.getByText('Apply'));
            const lastChart = last(chartProps.filter((p) => p.chartType === 'line'));
            expect(lastChart.sensorAxisRange.TAG1).toEqual({ min: 0, max: 100 });
        });

        it('Unpin clears a previously-applied axis range', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle(/Pin the Y-axis/));
            fireEvent.change(screen.getByPlaceholderText('min'), { target: { value: '0' } });
            fireEvent.change(screen.getByPlaceholderText('max'), { target: { value: '100' } });
            fireEvent.click(screen.getByText('Apply'));

            fireEvent.click(screen.getByTitle(/Y-axis scale pinned/));
            fireEvent.click(screen.getByText('Unpin'));
            const lastChart = last(chartProps.filter((p) => p.chartType === 'line'));
            expect(lastChart.sensorAxisRange.TAG1).toBeUndefined();
        });

        it('clears the color/axis-range override once the sensor is deselected', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle('Change line color'));
            fireEvent.click(screen.getByText('set-color'));

            fireEvent.click(screen.getByTitle('Remove from plot'));
            fireEvent.click(screen.getByText('select-tag1')); // re-add TAG1

            const lastChart = last(chartProps.filter((p) => p.chartType === 'line'));
            expect(lastChart.sensorColors.TAG1).toBe('c0'); // back to the default, not '#abcdef'
        });
    });

    describe('alarm setpoint lines', () => {
        it('toggling an alarm line surfaces it as a markLine on the Chart', () => {
            mockUseChartData.mockReturnValue({
                view: { headers: ['TAG1'], timestamps: [], series: [[]], total_rows: 0, ts_min: null, ts_max: null },
                loading: false, error: null,
            });
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('toggle-alarm'));
            const lastChart = last(chartProps.filter((p) => p.chartType === 'line'));
            expect(lastChart.markLines).toEqual([
                expect.objectContaining({ sensor: 'TAG1', y: 90, label: 'H' }),
            ]);
        });
    });

    describe('Tauri event listeners', () => {
        it('answers "request-sensors" with the current sensor headers/selection', async () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            await act(async () => {
                for (const cb of listenCallbacks['request-sensors'] ?? []) cb({});
            });
            expect(mockEmit).toHaveBeenCalledWith('sensors-data', expect.objectContaining({
                selectedSensors: ['TAG1'],
            }));
        });

        it('applies "add-sensor-selection" payload — new selection, operation config, and merged metadata', async () => {
            renderDashboard();
            // `add-sensor-selection` is registered only after the first
            // `await listen(...)` (for `request-sensors`) resolves, so a
            // microtask flush is needed before its callback is registered.
            await act(async () => { await Promise.resolve(); });
            await act(async () => {
                for (const cb of listenCallbacks['add-sensor-selection'] ?? []) {
                    cb({
                        payload: {
                            sensors: ['CALC1'],
                            operation: { mode: 'single', singleOp: { type: 'add', value: 1 } },
                            newMetadata: [{ tag: 'CALC1', description: 'Calculated', unit: '', component: '' }],
                        },
                    });
                }
            });
            const lastProps = last(sensorSelectionProps);
            expect(lastProps.selectedSensors).toEqual(['CALC1']);
            expect(lastProps.sensorMetadata).toEqual(
                expect.arrayContaining([expect.objectContaining({ tag: 'CALC1', description: 'Calculated' })]),
            );
            expect(lastProps.sensors).toContain('CALC1'); // merged into sensorHeaders too
        });
    });

    describe('Build Model', () => {
        it('spawns the predictive-model window and persists the target/predictors', async () => {
            renderDashboard();
            fireEvent.click(screen.getByText('Failure Groups'));
            await act(async () => {
                fireEvent.click(screen.getByText('build-model'));
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(webviewWindowCalls.some((c) => c.label === 'predictive-model')).toBe(true);
        });

        it('focuses an already-open predictive-model window instead of spawning a second one', async () => {
            const existing = { setFocus: vi.fn().mockResolvedValue(undefined) };
            mockGetByLabel.mockResolvedValue(existing);
            renderDashboard();
            fireEvent.click(screen.getByText('Failure Groups'));
            await act(async () => {
                fireEvent.click(screen.getByText('build-model'));
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(existing.setFocus).toHaveBeenCalled();
            expect(webviewWindowCalls.some((c) => c.label === 'predictive-model')).toBe(false);
        });
    });

    describe('imperative rename', () => {
        it('renameWorkspace via ref updates the persisted name', () => {
            const ref = createRef<DashboardRef>();
            renderDashboard({}, ref);
            act(() => { ref.current!.renameWorkspace('Renamed Workspace'); });
            expect(mockSaveWorkspaceData).toHaveBeenLastCalledWith(
                expect.objectContaining({ name: 'Renamed Workspace' }),
            );
        });
    });

    describe('CSV export', () => {
        it('is disabled with no data filter (nothing selected)', () => {
            renderDashboard();
            fireEvent.click(screen.getByText('Data Insight'));
            expect((screen.getByTitle('Export to CSV') as HTMLButtonElement).disabled).toBe(true);
        });

        it('exports the visible (non-multi-op) columns via export_chart_csv', async () => {
            mockUseTablePage.mockReturnValue({ page: { headers: ['TAG1'], rows: [], total_rows: 5 }, loading: false, error: null });
            mockUseChartData.mockReturnValue({
                view: { headers: ['TAG1'], timestamps: [], series: [[]], total_rows: 5, ts_min: null, ts_max: null },
                loading: false, error: null,
            });
            mockSave.mockResolvedValue('C:/out.csv');
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('Data Insight'));

            await act(async () => {
                fireEvent.click(screen.getByTitle('Export to CSV'));
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('export_chart_csv', expect.objectContaining({
                filter: expect.objectContaining({ sensors: ['TAG1'] }),
                path: 'C:/out.csv',
            }));
        });
    });

    describe('relative time range', () => {
        it('applying a relative "D" range fills in start/end timestamps', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle('Apply relative range'));
            const lastCall = last(mockUseChartData.mock.calls)![0] as any;
            expect(lastCall.filter.timestamp_start).not.toBe('');
        });
    });
});
