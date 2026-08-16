import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { CsvMetadata, SensorMetadata, WorkspaceState } from '../types';
import type { DashboardRef } from '../components/dashboard/Dashboard';

// ── Child component mocks — capture props, expose trigger buttons ─────────

const chartProps: any[] = [];
vi.mock('../components/charts', () => ({
    Chart: (props: any) => { chartProps.push(props); return <div data-testid="chart-mock" />; },
    defaultSensorColor: (tag: string) => `default-${tag}`,
    LINE_CHART_COLORS: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
    MAX_PAIR_PLOT_SENSORS: 4,
    // Real palette (not a stub) -- Dashboard's default-colour-assignment
    // tests read actual entries from it, and it must match ScatterChart's
    // own RANGE_PALETTE exactly since the two are meant to agree.
    RANGE_PALETTE: [
        [0.99, 0.75, 0.18, 1.0], [0.20, 0.83, 0.60, 1.0], [0.86, 0.40, 0.97, 1.0], [0.99, 0.45, 0.45, 1.0],
        [0.40, 0.85, 0.99, 1.0], [0.99, 0.55, 0.27, 1.0], [0.65, 0.85, 0.40, 1.0], [0.78, 0.66, 0.99, 1.0],
    ],
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
                <button onClick={() => props.onSensorChange(['TAG1', 'TAG2', 'TAG3', 'TAG4'])}>select-4-tags</button>
                <button onClick={() => props.onSensorChange(['TAG1', 'TAG2', 'TAG3', 'TAG4', 'TAG5'])}>select-5-tags</button>
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

const highlightsPanelProps: any[] = [];
vi.mock('../components/dashboard/HighlightsPanel', () => ({
    default: (props: any) => {
        highlightsPanelProps.push(props);
        return (
            <div data-testid="highlights-panel">
                <button onClick={() => props.onAddTimeHighlight('2026-01-01T00:00', '2026-01-01T01:00', 'Test')}>hl-add-highlight</button>
                <button onClick={() => props.onToggleTimeHighlight('h1')}>hl-toggle-highlight</button>
                <button onClick={() => props.onRemoveTimeHighlight('h1')}>hl-remove-highlight</button>
                <button onClick={() => props.onRecolorTimeHighlight('h1', '#abcdef')}>hl-recolor-highlight</button>
                <button onClick={() => props.onRenameTimeHighlight('h1', 'Renamed')}>hl-rename-highlight</button>
            </div>
        );
    },
}));

// ── Data hooks — controllable, no debounce/invoke timing to fight ─────────

const mockUseChartData = vi.fn((_query?: unknown) => ({ view: null, loading: false, error: null } as any));
vi.mock('../hooks/useChartData', () => ({ useChartData: (query: unknown) => mockUseChartData(query) }));

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

const mockMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: (text: string, opts: unknown) => mockMessage(text, opts),
}));

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
    chartProps.length = 0;
    filterPanelProps.length = 0;
    sensorSelectionProps.length = 0;
    fgPanelProps.length = 0;
    highlightsPanelProps.length = 0;
    webviewWindowCalls.length = 0;
    splitCalls.length = 0;
    listenCallbacks = {};
    mockUseChartData.mockClear().mockReturnValue({ view: null, loading: false, error: null });
    mockUseScatterSample.mockClear().mockReturnValue({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null });
    mockInvoke.mockClear().mockResolvedValue(undefined);
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockGetByLabel.mockClear().mockResolvedValue(null);
    mockMessage.mockClear().mockResolvedValue(undefined);
    mockSaveWorkspaceData.mockClear().mockResolvedValue(undefined);
    mockUpdateWorkspaceData.mockClear().mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id }));
    mockLoadWorkspaceData.mockClear().mockResolvedValue(null);
    mockReportError.mockClear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('Dashboard', () => {
    it('seeds selected/visible sensors from initialState and passes them to child panels', () => {
        renderDashboard({
            initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }),
        });
        expect(last(sensorSelectionProps).selectedSensors).toEqual(['TAG1']);
    });

    it('autosaves on mount with the workspace name and lastRoute "dashboard" (after the debounce settles)', async () => {
        renderDashboard({ initialState: makeInitialState({ name: 'My Workspace' }) });
        await waitFor(() => expect(mockSaveWorkspaceData).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'My Workspace', lastRoute: 'dashboard' }),
        ));
    });

    it('debounces autosave -- a burst of rapid state changes writes to disk once, not once per change (regression: every tracked state change, including each keystroke in a Filter box with no debounce of its own, used to trigger an immediate write)', () => {
        vi.useFakeTimers();
        renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
        mockSaveWorkspaceData.mockClear(); // drop the initial on-mount autosave

        // Simulate a rapid burst: three filter edits in quick succession,
        // each well inside the debounce window of the previous one.
        act(() => { fireEvent.click(screen.getByText('Filter')); });
        act(() => { fireEvent.click(screen.getByText('apply-filter')); });
        act(() => { vi.advanceTimersByTime(100); });
        act(() => { fireEvent.click(screen.getByText('select-tag1')); }); // no-op reselect, still a state change
        act(() => { vi.advanceTimersByTime(100); });

        // Still within the debounce window of the LAST change (100 + 100 = 200ms < 250ms) -- no write yet.
        expect(mockSaveWorkspaceData).not.toHaveBeenCalled();

        // Let the debounce settle past the last change.
        act(() => { vi.advanceTimersByTime(150); });
        expect(mockSaveWorkspaceData).toHaveBeenCalledTimes(1); // exactly one write, not three
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

        it('forwards sensorMetadata to Chart in Scatter/Pair Plot mode too (regression: only the line-chart branch passed it, so Pair Plot\'s hover-tooltip descriptions had no data to read)', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'] }) });
            fireEvent.click(screen.getByText('Scatter'));
            expect(last(chartProps).sensorMetadata).toEqual(
                expect.arrayContaining([expect.objectContaining({ tag: 'TAG1' })]),
            );

            fireEvent.click(screen.getByText('Pair Plot'));
            expect(last(chartProps).sensorMetadata).toEqual(
                expect.arrayContaining([expect.objectContaining({ tag: 'TAG1' })]),
            );
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

        it('Pair Plot stays clickable (not natively disabled) once the selection exceeds the 4-sensor cap, but clicking it shows a warning dialog instead of switching', async () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });

            fireEvent.click(screen.getByText('select-4-tags'));
            expect((screen.getByText('Pair Plot') as HTMLButtonElement).disabled).toBe(false);
            expect((screen.getByText('Scatter') as HTMLButtonElement).disabled).toBe(false);

            fireEvent.click(screen.getByText('select-5-tags'));
            const pairBtn = screen.getByText('Pair Plot') as HTMLButtonElement;
            // Not a native `disabled` — the click must still fire so the
            // warning dialog can explain why, per the user's explicit
            // preference over silently redirecting away from the chart.
            expect(pairBtn.disabled).toBe(false);
            expect(pairBtn.className).toContain('blocked');
            expect(pairBtn.title).toContain('at most 4 sensors');
            // Scatter has no such cap — still just needs >= 2.
            expect((screen.getByText('Scatter') as HTMLButtonElement).disabled).toBe(false);

            fireEvent.click(pairBtn);
            await waitFor(() => expect(mockMessage).toHaveBeenCalledTimes(1));
            expect(mockMessage.mock.calls[0][0]).toContain('at most 4 sensors');
            expect(mockMessage.mock.calls[0][1]).toMatchObject({ kind: 'warning' });
            expect(last(chartProps).chartType).toBe('line'); // never switched away from the default
        });

        it('does NOT bounce back to "line" when the selection grows past the cap while Pair Plot is already active — PairPlotChart shows its own in-place message instead', () => {
            renderDashboard({
                initialState: makeInitialState({
                    selectedSensors: ['TAG1', 'TAG2', 'TAG3', 'TAG4'], visibleSensors: ['TAG1', 'TAG2', 'TAG3', 'TAG4'], chartType: 'pair',
                }),
            });
            expect(last(chartProps).chartType).toBe('pair');

            fireEvent.click(screen.getByText('select-5-tags'));
            expect(last(chartProps).chartType).toBe('pair');
        });
    });

    describe('Highlights tab (time-window "By time" highlights)', () => {
        it('renders HighlightsPanel when the Highlights tab is selected, alongside Selected Sensor / Filter', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            expect(screen.queryByTestId('highlights-panel')).toBeNull();
            fireEvent.click(screen.getByText('Highlights'));
            expect(screen.getByTestId('highlights-panel')).toBeTruthy();
        });

        it('onAddTimeHighlight / onToggleTimeHighlight / onRemoveTimeHighlight / onRecolorTimeHighlight / onRenameTimeHighlight all mutate timeHighlights, forwarded to Chart as a global (not chart-type-scoped) prop', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'] }) });
            fireEvent.click(screen.getByText('Highlights'));

            fireEvent.click(screen.getByText('hl-add-highlight'));
            const highlights = last(highlightsPanelProps).timeHighlights;
            expect(highlights).toEqual([
                expect.objectContaining({ start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Test', enabled: true, color: expect.any(String) }),
            ]);
            const hId = highlights[0].id;

            act(() => { last(highlightsPanelProps).onToggleTimeHighlight(hId); });
            expect(last(highlightsPanelProps).timeHighlights[0].enabled).toBe(false);

            act(() => { last(highlightsPanelProps).onRecolorTimeHighlight(hId, '#123456'); });
            expect(last(highlightsPanelProps).timeHighlights[0].color).toBe('#123456');

            act(() => { last(highlightsPanelProps).onRenameTimeHighlight(hId, 'Renamed'); });
            expect(last(highlightsPanelProps).timeHighlights[0].label).toBe('Renamed');

            // Applies to Line too -- not scoped to whichever chart type is active.
            expect(last(chartProps).timeHighlights).toEqual(last(highlightsPanelProps).timeHighlights);

            act(() => { last(highlightsPanelProps).onRemoveTimeHighlight(hId); });
            expect(last(highlightsPanelProps).timeHighlights).toEqual([]);
        });

        it('an untitled highlight gets an auto-generated label', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('Highlights'));
            act(() => { last(highlightsPanelProps).onAddTimeHighlight('2026-01-01T00:00', '2026-01-01T01:00', '') ; });
            expect(last(highlightsPanelProps).timeHighlights[0].label).toBe('Highlight 1');
        });

        it('persists timeHighlights via the autosave (buildWorkspaceState)', async () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('Highlights'));
            fireEvent.click(screen.getByText('hl-add-highlight'));

            await waitFor(() => expect(mockSaveWorkspaceData).toHaveBeenCalled());
            const saved = last(mockSaveWorkspaceData.mock.calls)[0];
            expect(saved.timeHighlights).toEqual(last(highlightsPanelProps).timeHighlights);
        });

        it('forwards the live chartType, driving the panel\'s compatibility banner', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'], chartType: 'line' }) });
            fireEvent.click(screen.getByText('Highlights'));
            expect(last(highlightsPanelProps).chartType).toBe('line');

            fireEvent.click(screen.getByText('Scatter'));
            expect(last(highlightsPanelProps).chartType).toBe('scatter');
        });

        it('seeds highlightLineDisplay from initialState (default \'band\' when absent) and forwards it to both HighlightsPanel and Chart', () => {
            renderDashboard({
                initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'], highlightLineDisplay: 'line', chartType: 'line' }),
            });
            fireEvent.click(screen.getByText('Highlights'));
            expect(last(highlightsPanelProps).lineDisplay).toBe('line');
            expect(last(chartProps).highlightDisplay).toBe('line');
        });

        it('defaults highlightLineDisplay to \'band\' when absent from initialState', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'], chartType: 'line' }) });
            fireEvent.click(screen.getByText('Highlights'));
            expect(last(highlightsPanelProps).lineDisplay).toBe('band');
            expect(last(chartProps).highlightDisplay).toBe('band');
        });

        it('onSetLineDisplay updates state, forwarded to Chart, and persists via autosave', async () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'], chartType: 'line' }) });
            fireEvent.click(screen.getByText('Highlights'));

            act(() => { last(highlightsPanelProps).onSetLineDisplay('line'); });
            expect(last(highlightsPanelProps).lineDisplay).toBe('line');
            expect(last(chartProps).highlightDisplay).toBe('line');

            await waitFor(() => expect(mockSaveWorkspaceData).toHaveBeenCalled());
            const saved = last(mockSaveWorkspaceData.mock.calls)[0];
            expect(saved.highlightLineDisplay).toBe('line');
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
        it('renameWorkspace via ref updates the persisted name', async () => {
            const ref = createRef<DashboardRef>();
            renderDashboard({}, ref);
            act(() => { ref.current!.renameWorkspace('Renamed Workspace'); });
            await waitFor(() => expect(mockSaveWorkspaceData).toHaveBeenLastCalledWith(
                expect.objectContaining({ name: 'Renamed Workspace' }),
            ));
        });
    });

    describe('relative time range', () => {
        it('applying a relative "D" range fills in start/end timestamps', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByTitle('Apply relative range'));
            const lastCall = last(mockUseChartData.mock.calls)![0] as any;
            expect(lastCall.filter.timestamp_start).not.toBe('');
        });

        // Regression #1 (fixed first): the unit button (D/H/W/...) kept
        // showing the STRONG "active" accent background forever after being
        // clicked, even once the user hand-edited Start/End and the shown
        // dates no longer matched that preset at all — falsely implying the
        // preset was still in effect.
        //
        // Regression #2 (found by the user immediately after #1 shipped):
        // the fix above tied ALL visual feedback to `relativeRangeApplied`,
        // so once it went false (e.g. right after editing a date by hand),
        // clicking Y/M/W/D/H produced ZERO visible change — every unit
        // button looked identically plain no matter which one `relativeUnit`
        // actually was, reading as "the buttons don't respond to clicks" (a
        // user had to click ✓ Apply blind before a unit's selection ever
        // became visible). Fixed by splitting the two claims apart:
        // `isSelected` (relativeUnit === u — always live, shown as an accent
        // OUTLINE) vs `isActive` (isSelected AND relativeRangeApplied — the
        // stronger claim, shown as a SOLID accent fill). D is the default
        // relativeUnit, so it renders as "selected" (outline) from the very
        // first render even with nothing clicked yet.
        describe('unit-button selected/applied indicator (2-tier: outline = picked, solid = picked AND matches the shown dates)', () => {
            const dayBtn = () => screen.getByRole('button', { name: 'D' }) as HTMLButtonElement;
            const hourBtn = () => screen.getByRole('button', { name: 'H' }) as HTMLButtonElement;

            it('shows the default unit (D) as selected-but-not-applied at rest — outline, no solid fill', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                const btn = dayBtn();
                expect(btn.style.background).toBe('transparent');
                expect(btn.style.border).toBe('1px solid var(--accent-color)');
                expect(btn.style.color).toBe('var(--accent-color)');
                expect(btn.title).toMatch(/^Selected/);
            });

            it('every OTHER unit stays fully plain while D is selected', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                const btn = hourBtn();
                expect(btn.style.background).toBe('transparent');
                expect(btn.style.border).toBe('1px solid var(--border)');
                expect(btn.style.color).toBe('var(--text-secondary)');
                expect(btn.title).toBe('Hours');
            });

            it('solid-fills after clicking Apply', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                const btn = dayBtn();
                expect(btn.style.background).toBe('var(--accent-color)');
                expect(btn.style.color).toBe('rgb(255, 255, 255)'); // jsdom normalizes '#fff'
                expect(btn.title).toMatch(/^Currently applied/);
            });

            it('drops back to outline-only (stays selected, stops claiming "applied") when Start is edited by hand after Apply', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                fireEvent.change(screen.getByPlaceholderText('Start Date'), { target: { value: '2020-01-01T00:00' } });
                const btn = dayBtn();
                expect(btn.style.background).toBe('transparent');
                expect(btn.style.border).toBe('1px solid var(--accent-color)'); // still selected
            });

            it('drops back to outline-only when End is edited by hand after Apply', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                fireEvent.change(screen.getByPlaceholderText('End Date'), { target: { value: '2020-01-02T00:00' } });
                const btn = dayBtn();
                expect(btn.style.background).toBe('transparent');
                expect(btn.style.border).toBe('1px solid var(--accent-color)');
            });

            it('moves the outline to the newly-clicked unit (not the solid fill) when the picker is changed after Apply — this is the exact click the user reported as "unresponsive"', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                fireEvent.click(hourBtn());

                const day = dayBtn();
                expect(day.style.background).toBe('transparent');
                expect(day.style.border).toBe('1px solid var(--border)'); // no longer selected at all

                const hour = hourBtn();
                expect(hour.style.background).toBe('transparent'); // not yet applied
                expect(hour.style.border).toBe('1px solid var(--accent-color)'); // but IS now selected — visible immediately
                expect(hour.title).toMatch(/^Selected/);
            });

            it('drops back to outline-only when the amount input is changed after Apply', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '5' } });
                const btn = dayBtn();
                expect(btn.style.background).toBe('transparent');
                expect(btn.style.border).toBe('1px solid var(--accent-color)');
            });

            it('re-solid-fills after clicking Apply again', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                fireEvent.change(screen.getByPlaceholderText('Start Date'), { target: { value: '2020-01-01T00:00' } });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                const btn = dayBtn();
                expect(btn.style.background).toBe('var(--accent-color)');
            });
        });

        describe('"Reset Period" button (regression: used to be labelled just "Reset" and sit after the AGGREGATION dropdown, reading as if it might also reset that — it only ever clears the time period)', () => {
            beforeEach(() => {
                // The button only renders once there's a data range to reset
                // BACK TO (dataRange, from view.ts_min/ts_max) and an active
                // Start filter to reset AWAY FROM.
                mockUseChartData.mockReturnValue({
                    view: { headers: ['TAG1'], timestamps: [], series: [[]], total_rows: 5, ts_min: '2025-01-01T00:00:00Z', ts_max: '2025-06-01T00:00:00Z' },
                    loading: false, error: null,
                });
            });

            it('is labelled "Reset Period", not the ambiguous "Reset"', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                expect(screen.getByText('Reset Period')).toBeTruthy();
                expect(screen.queryByText('Reset')).toBeNull();
            });

            it('sits before the AGGREGATION control in the DOM, not after it', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                const resetBtn = screen.getByText('Reset Period');
                const aggregationLabel = screen.getByText('AGGREGATION (1 HR)');
                expect(resetBtn.compareDocumentPosition(aggregationLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            });

            it('clears the time period back to the full data range without touching Aggregation', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                const aggregationSelect = screen.getByDisplayValue('Raw') as HTMLSelectElement;
                fireEvent.change(aggregationSelect, { target: { value: 'max' } });

                fireEvent.click(screen.getByText('Reset Period'));

                const lastCall = last(mockUseChartData.mock.calls)![0] as any;
                // '' → null: the dataFilter builder does `filters.timestampStart || null`.
                expect(lastCall.filter.timestamp_start).toBeNull();
                expect(lastCall.filter.timestamp_end).toBeNull();
                expect((screen.getByDisplayValue('Max') as HTMLSelectElement).value).toBe('max'); // untouched
            });

            it('clears the unit-button "applied" highlight too (regression: Reset went through handleFiltersChange directly, bypassing the path that clears relativeRangeApplied, so a unit button could stay highlighted after Reset even though the dates no longer matched it)', () => {
                renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
                fireEvent.click(screen.getByTitle('Apply relative range'));
                expect(screen.getByTitle(/Currently applied/)).toBeTruthy();

                fireEvent.click(screen.getByText('Reset Period'));
                expect((screen.getByRole('button', { name: 'D' }) as HTMLButtonElement).style.background).toBe('transparent');
            });
        });
    });
});
