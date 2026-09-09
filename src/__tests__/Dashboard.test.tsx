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
                <button onClick={() => props.onToggleSensorGroupKind('TAG1', 1, 'individual')}>toggle-group</button>
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
                <button onClick={() => props.onCreateEmptyGroup('Empty Group')}>create-empty-group</button>
                <button onClick={() => props.onUpdateGroupDetails(1, 'Renamed', 'New Desc', 'New Rec')}>update-group-details-fg</button>
                <button onClick={() => props.onDeleteGroup(1)}>delete-group-fg</button>
                <button onClick={() => props.onDeleteModel('m1')}>delete-model-fg</button>
                <button onClick={() => props.onOpenBuildModel()}>open-build-model</button>
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
                <button onClick={() => props.onSetValueHighlightSensor('TAG1')}>hl-set-value-sensor</button>
                <button onClick={() => props.onAddValueHighlightRange(10, 20)}>hl-add-value-range</button>
                <button onClick={() => props.onToggleValueHighlightRange('r1')}>hl-toggle-value-range</button>
                <button onClick={() => props.onRemoveValueHighlightRange('r1')}>hl-remove-value-range</button>
                <button onClick={() => props.onRecolorValueHighlightRange('r1', '#abcdef')}>hl-recolor-value-range</button>
            </div>
        );
    },
}));

// ── Data hooks — controllable, no debounce/invoke timing to fight ─────────

const mockUseChartData = vi.fn((_query?: { revision?: number } | null) => ({ view: null, loading: false, error: null } as any));
vi.mock('../hooks/useChartData', () => ({ useChartData: (query: unknown) => mockUseChartData(query as any) }));

const mockUseScatterSample = vi.fn(
    (_filter?: unknown, _max?: unknown, _active?: unknown, _revision?: number) =>
        ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null } as any),
);
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: (filter: unknown, max: unknown, active: unknown, revision?: number) =>
        mockUseScatterSample(filter, max, active, revision),
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

// 2026-09-01: getCurrentWindow().onCloseRequested — the close-flush effect
// (docs/BACKLOG.md item 8). `mockCloseRequestedHandler` captures the
// registered handler so tests can invoke it directly, simulating the user
// requesting a close.
const mockWindowClose = vi.fn().mockResolvedValue(undefined);
let mockCloseRequestedHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null = null;
const mockOnCloseRequested = vi.fn((handler: (event: { preventDefault: () => void }) => void | Promise<void>) => {
    mockCloseRequestedHandler = handler;
    return Promise.resolve(() => { mockCloseRequestedHandler = null; });
});
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        onCloseRequested: (handler: any) => mockOnCloseRequested(handler),
        close: () => mockWindowClose(),
    }),
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
    mockWindowClose.mockClear().mockResolvedValue(undefined);
    mockOnCloseRequested.mockClear();
    mockCloseRequestedHandler = null;
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

    it('shows no standalone "N Rows" badge next to the data tabs (2026-09-01: removed per explicit user request — it always duplicated the chart\'s own "X / Y pts (downsampled)" badge, both reading the same view.total_rows)', () => {
        mockUseChartData.mockReturnValue({
            view: { headers: ['TAG1'], timestamps: Array(10).fill('t'), series: [[]], total_rows: 159264, ts_min: null, ts_max: null },
            loading: false, error: null,
        });
        renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
        expect(screen.queryByText(/Rows$/)).toBeNull();
        expect(screen.queryByText('159,264 Rows')).toBeNull();
    });

    it('skips an autosave whose payload is already on disk — a failure-group toggle costs one write, not two (2026-09-03: persistFailureGroupState writes immediately so a Build Model window opened right after reads fresh data, and the debounced autosave then rewrote the identical payload 250ms later)', async () => {
        vi.useFakeTimers();
        renderDashboard({
            initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'Group A' }], models: [] } }),
        });
        // Let the on-mount autosave land so the "already on disk" payload is primed.
        await act(async () => { vi.advanceTimersByTime(300); });
        mockSaveWorkspaceData.mockClear();

        act(() => { fireEvent.click(screen.getByText('toggle-group')); });
        // The immediate cross-window persist still happens, unchanged.
        expect(mockUpdateWorkspaceData).toHaveBeenCalled();
        // Let its .then record what the disk now holds.
        await act(async () => { await Promise.resolve(); });

        await act(async () => { vi.advanceTimersByTime(300); });
        expect(mockSaveWorkspaceData).not.toHaveBeenCalled();
    });

    it('still autosaves normally when the state actually changed after a failure-group write', async () => {
        vi.useFakeTimers();
        renderDashboard({
            initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'Group A' }], models: [] } }),
        });
        await act(async () => { vi.advanceTimersByTime(300); });
        act(() => { fireEvent.click(screen.getByText('toggle-group')); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { vi.advanceTimersByTime(300); });
        mockSaveWorkspaceData.mockClear();

        // A change the failure-group write knows nothing about must still reach disk.
        act(() => { fireEvent.click(screen.getByText('select-tag1')); });
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(mockSaveWorkspaceData).toHaveBeenCalledTimes(1);
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

    describe('close-flush (docs/BACKLOG.md item 8: a change made in the last AUTOSAVE_DEBOUNCE_MS before quitting used to be lost silently)', () => {
        it('flushes a pending autosave before letting the window close, then closes it itself', async () => {
            vi.useFakeTimers();
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); }); // let the on-mount autosave settle
            mockSaveWorkspaceData.mockClear();
            expect(mockCloseRequestedHandler).not.toBeNull();

            // Trigger an edit -- schedules a new debounced save, still pending.
            // It has to be a REAL change: since 2026-09-03 the autosave skips a
            // write whose payload is byte-identical to what is already on disk,
            // so re-selecting the already-selected TAG1 (as this test used to
            // do) would legitimately write nothing at all.
            act(() => { fireEvent.click(screen.getByText('select-none')); });

            const preventDefault = vi.fn();
            let closePromise!: Promise<void>;
            await act(async () => {
                closePromise = mockCloseRequestedHandler!({ preventDefault }) as Promise<void>;
                await Promise.resolve(); // let preventDefault's synchronous call land
            });
            expect(preventDefault).toHaveBeenCalledTimes(1); // blocks the close immediately
            expect(mockWindowClose).not.toHaveBeenCalled(); // not yet -- the save hasn't landed on disk

            await act(async () => {
                await vi.advanceTimersByTimeAsync(250); // let the debounced save actually fire
                await closePromise;
            });
            expect(mockSaveWorkspaceData).toHaveBeenCalledTimes(1); // the pending edit was actually flushed
            expect(mockWindowClose).toHaveBeenCalledTimes(1); // then, and only then, the window closes
        });

        it('does not intercept the close at all once nothing is pending -- an already-saved Dashboard closes exactly as before, no added delay', async () => {
            vi.useFakeTimers();
            renderDashboard();
            await act(async () => { await vi.advanceTimersByTimeAsync(250); }); // on-mount autosave settles -- nothing pending now
            expect(mockCloseRequestedHandler).not.toBeNull();

            const preventDefault = vi.fn();
            await act(async () => {
                await mockCloseRequestedHandler!({ preventDefault });
            });
            expect(preventDefault).not.toHaveBeenCalled();
            expect(mockWindowClose).not.toHaveBeenCalled(); // we never call close ourselves -- Tauri's own default handles an unintercepted close
        });
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

        // 2026-09-03: reported as "un-ticking a sensor in the right-hand panel
        // makes the chart flash a different colour before the line goes away".
        // Colours used to come from the sensor's index in `selectedSensors`, so
        // removing one re-packed every sensor after it onto a new slot, while
        // useChartData deliberately keeps the previous view on screen during
        // the refetch — old lines, new colours. These pin the fix.
        describe('palette colours survive changes to the selection', () => {
            const lineColors = () => last(chartProps.filter((p) => p.chartType === 'line')).sensorColors;

            it('does not re-colour the remaining sensors when one is removed', () => {
                renderDashboard();
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1', 'TAG2', 'TAG3']); });
                expect(lineColors()).toMatchObject({ TAG1: 'c0', TAG2: 'c1', TAG3: 'c2' });

                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1', 'TAG3']); });
                // Before the fix TAG3 shifted from 'c2' to 'c1' here — the flash.
                expect(lineColors()).toMatchObject({ TAG1: 'c0', TAG3: 'c2' });
            });

            it('keeps a just-removed sensor in the map, so its line does not change colour while the stale view is still on screen', () => {
                renderDashboard();
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1', 'TAG2']); });
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1']); });
                // TAG2's line is still drawn from the previous fetch until the
                // next one lands; without an entry here LineChart would fall
                // back to defaultSensorColor() and repaint it mid-flight.
                expect(lineColors().TAG2).toBe('c1');
            });

            it('gives a re-selected sensor its original colour back', () => {
                renderDashboard();
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1', 'TAG2', 'TAG3']); });
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1']); });
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1', 'TAG3']); });
                expect(lineColors().TAG3).toBe('c2'); // not 'c1', the next free slot
            });

            it('hands a brand-new sensor the lowest free slot rather than one already in use', () => {
                renderDashboard();
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1', 'TAG2']); });
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG2']); });   // frees c0
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG2', 'TAG4']); });
                expect(lineColors()).toMatchObject({ TAG2: 'c1', TAG4: 'c0' });
            });

            it('still lets an explicit colour override win over the assigned slot', () => {
                // The sensor has to start out selected: an existing effect prunes
                // explicit overrides for anything not in selectedSensors, so
                // seeding a colour for an unselected sensor would be dropped on
                // mount before this could observe it.
                renderDashboard({
                    initialState: makeInitialState({
                        selectedSensors: ['TAG1', 'TAG2'],
                        visibleSensors: ['TAG1', 'TAG2'],
                        sensorColors: { TAG2: '#abcdef' },
                    }),
                });
                expect(lineColors()).toMatchObject({ TAG1: 'c0', TAG2: '#abcdef' });
            });

            it('still prunes an explicit override when its sensor is deselected — remembering the palette SLOT must not resurrect a user-picked colour', () => {
                // Guards the interaction between the slot memory added here and
                // the older deliberate rule that a deselected sensor loses its
                // hand-picked colour (so re-adding it never silently restores
                // one). The slot is remembered; the override is not.
                renderDashboard({
                    initialState: makeInitialState({
                        selectedSensors: ['TAG1', 'TAG2'],
                        visibleSensors: ['TAG1', 'TAG2'],
                        sensorColors: { TAG2: '#abcdef' },
                    }),
                });
                expect(lineColors().TAG2).toBe('#abcdef');

                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1']); });
                act(() => { last(sensorSelectionProps).onSensorChange(['TAG1', 'TAG2']); });
                expect(lineColors().TAG2).toBe('c1'); // back to its remembered slot, not '#abcdef'
            });
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

    describe('Highlights tab ("By value" — Scatter-only, restored after removal to live here instead of a "Colour by…" control on Scatter\'s own toolbar)', () => {
        it('seeds valueHighlight from initialState (default { sensor: \'\', ranges: [] } when absent) and forwards it to HighlightsPanel', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('Highlights'));
            expect(last(highlightsPanelProps).valueHighlight).toEqual({ sensor: '', ranges: [] });
        });

        it('onSetValueHighlightSensor / onAddValueHighlightRange / onToggleValueHighlightRange / onRecolorValueHighlightRange / onRemoveValueHighlightRange all mutate valueHighlight, forwarded to Chart only on Scatter', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'], chartType: 'scatter' }) });
            fireEvent.click(screen.getByText('Highlights'));

            fireEvent.click(screen.getByText('hl-set-value-sensor'));
            expect(last(highlightsPanelProps).valueHighlight.sensor).toBe('TAG1');

            fireEvent.click(screen.getByText('hl-add-value-range'));
            const ranges = last(highlightsPanelProps).valueHighlight.ranges;
            expect(ranges).toEqual([
                expect.objectContaining({ min: 10, max: 20, enabled: true, color: expect.any(String) }),
            ]);
            const rId = ranges[0].id;

            act(() => { last(highlightsPanelProps).onToggleValueHighlightRange(rId); });
            expect(last(highlightsPanelProps).valueHighlight.ranges[0].enabled).toBe(false);

            act(() => { last(highlightsPanelProps).onRecolorValueHighlightRange(rId, '#123456'); });
            expect(last(highlightsPanelProps).valueHighlight.ranges[0].color).toBe('#123456');

            // Scatter-only -- forwarded to Chart since it's active.
            expect(last(chartProps).valueHighlight).toEqual(last(highlightsPanelProps).valueHighlight);

            act(() => { last(highlightsPanelProps).onRemoveValueHighlightRange(rId); });
            expect(last(highlightsPanelProps).valueHighlight.ranges).toEqual([]);
        });

        it('drops the sensor (and its ranges) when it\'s no longer among the selected sensors', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'], valueHighlight: { sensor: 'TAG2', ranges: [{ id: 'r1', min: 1, max: 2, color: '#fff', enabled: true }] } }) });
            fireEvent.click(screen.getByText('Highlights'));
            expect(last(highlightsPanelProps).valueHighlight).toEqual({ sensor: 'TAG2', ranges: [{ id: 'r1', min: 1, max: 2, color: '#fff', enabled: true }] });

            // Deselect TAG2 via the same mocked SensorSelection used elsewhere in this file.
            fireEvent.click(screen.getByText('select-tag1'));
            expect(last(highlightsPanelProps).valueHighlight).toEqual({ sensor: '', ranges: [] });
        });

        it('persists valueHighlight via the autosave (buildWorkspaceState)', async () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'] }) });
            fireEvent.click(screen.getByText('Highlights'));
            fireEvent.click(screen.getByText('hl-set-value-sensor'));
            fireEvent.click(screen.getByText('hl-add-value-range'));

            await waitFor(() => expect(mockSaveWorkspaceData).toHaveBeenCalled());
            const saved = last(mockSaveWorkspaceData.mock.calls)[0];
            expect(saved.valueHighlight).toEqual(last(highlightsPanelProps).valueHighlight);
        });

        it('passes valueHighlight to Chart only when Scatter is active, never Line or Pair Plot', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'], chartType: 'line' }) });
            expect(last(chartProps).valueHighlight).toBeUndefined();

            fireEvent.click(screen.getByText('Scatter'));
            expect(last(chartProps)).toHaveProperty('valueHighlight');
        });

        it('passes the currently plotted sensors (scatterChartHeaders) as valueHighlightSensors', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'] }) });
            fireEvent.click(screen.getByText('Highlights'));
            expect(last(highlightsPanelProps).valueHighlightSensors).toEqual(['TAG1', 'TAG2']);
        });
    });

    describe('lineTaggedPoints (Tag Point feature — in-memory only, per explicit user request: NOT saved to the workspace file, so it never survives closing and reopening the app; still lifted to Dashboard, not left as LineChart-local state, so it DOES survive switching chart type away and back within the same running session)', () => {
        it('always starts empty, regardless of what initialState carries (regression: this field must never round-trip through the saved workspace)', () => {
            // WorkspaceState no longer even has a lineTaggedPoints field, so
            // there's nothing to pass here — the point of this test is that
            // it's impossible to seed it from a loaded workspace at all.
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'], chartType: 'line' }) });
            expect(last(chartProps).lineTaggedPoints).toEqual([]);
        });

        it('onLineTaggedPointsChange updates state and forwards it to Chart, but does NOT include it in the autosaved workspace', async () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1'], visibleSensors: ['TAG1'], chartType: 'line' }) });
            const newTags = [{ id: 't1', timestamp: '2026-01-01T00:00', color: '#f59e0b' }];

            act(() => { last(chartProps).onLineTaggedPointsChange(newTags); });
            expect(last(chartProps).lineTaggedPoints).toEqual(newTags);

            await waitFor(() => expect(mockSaveWorkspaceData).toHaveBeenCalled());
            const saved = last(mockSaveWorkspaceData.mock.calls)[0];
            expect(saved.lineTaggedPoints).toBeUndefined();
        });

        it('is not forwarded to Scatter -- Scatter keeps its own tags local too, but for a different reason (no stable point identity across a resampled query, not the disk-persistence policy)', () => {
            renderDashboard({ initialState: makeInitialState({ selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'], chartType: 'scatter' }) });
            expect(last(chartProps).lineTaggedPoints).toBeUndefined();
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
        it('toggling a sensor into a group persists via updateWorkspaceData with a new individual-kind model', () => {
            renderDashboard({
                initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'Group A' }], models: [] } }),
            });
            fireEvent.click(screen.getByText('toggle-group'));
            const patchResult = last(mockUpdateWorkspaceData.mock.results)!.value;
            return patchResult.then((state: any) => {
                expect(state.failureGroupState.models).toHaveLength(1);
                expect(state.failureGroupState.models[0]).toMatchObject({ kind: 'individual', targetSensor: 'TAG1', groupNos: [1] });
            });
        });

        it('creating a group for a sensor adds both the group and its model, with no dead "isCollapsed" field (2026-09-01: removed — nothing in the app ever read or toggled it)', async () => {
            renderDashboard();
            fireEvent.click(screen.getByText('create-group-for-sensor'));
            const state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups.map((g: any) => g.name)).toContain('New Group');
            expect(state.failureGroupState.models[0].targetSensor).toBe('TAG1');
            const newGroup = state.failureGroupState.groups.find((g: any) => g.name === 'New Group');
            expect(newGroup).not.toHaveProperty('isCollapsed');
        });

        it('does not create a duplicate-named group for a sensor', async () => {
            renderDashboard({
                initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'New Group' }], models: [] } }),
            });
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByText('create-group-for-sensor')); // sensor mock always uses 'New Group'
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('renaming and deleting a group updates fgGroups accordingly', async () => {
            renderDashboard({
                initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'Group A' }], models: [] } }),
            });
            fireEvent.click(screen.getByText('rename-group'));
            let state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups[0].name).toBe('Renamed');

            fireEvent.click(screen.getByText('delete-group'));
            state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups).toHaveLength(0);
        });

        describe('2026-08-25 redesign — a model can belong to more than one Failure Group at once (real many-to-many, not a duplicate model per group)', () => {
            it('toggling a sensor into a SECOND group adds to its existing individual model\'s groupNos instead of creating a duplicate model', () => {
                renderDashboard({
                    initialState: makeInitialState({
                        failureGroupState: {
                            groups: [{ no: 1, name: 'Group A' }, { no: 2, name: 'Group B' }],
                            models: [{
                                id: 'm1', groupNos: [1], name: '', kind: 'individual', category: null, notes: '', status: false,
                                targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
                                individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                                relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                                clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                            }],
                        },
                    }),
                });
                // The mocked SensorSelection's toggle-group button always toggles TAG1 into group 1 as individual -- use onToggleSensorGroupKind directly via the same mock button pattern isn't available for group 2, so drive it through sensorSelectionProps instead.
                act(() => { last(sensorSelectionProps).onToggleSensorGroupKind('TAG1', 2, 'individual'); });
                return last(mockUpdateWorkspaceData.mock.results)!.value.then((state: any) => {
                    expect(state.failureGroupState.models).toHaveLength(1); // still just one record, not two
                    expect(state.failureGroupState.models[0].groupNos).toEqual(expect.arrayContaining([1, 2]));
                    expect(state.failureGroupState.models[0].groupNos).toHaveLength(2);
                });
            });

            it('toggling a sensor OUT of its last group deletes the model outright (2026-09-02: used to fall back to groupNos: [0] "Not in Group" — reported by the user as unwanted, the chip\'s X is expected to make it disappear, not reappear parked under "Not in Group")', () => {
                renderDashboard({
                    initialState: makeInitialState({
                        failureGroupState: {
                            groups: [{ no: 1, name: 'Group A' }],
                            models: [{
                                id: 'm1', groupNos: [1], name: '', kind: 'individual', category: null, notes: '', status: false,
                                targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
                                individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                                relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                                clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                            }],
                        },
                    }),
                });
                fireEvent.click(screen.getByText('toggle-group')); // toggles TAG1 out of group 1
                return last(mockUpdateWorkspaceData.mock.results)!.value.then((state: any) => {
                    expect(state.failureGroupState.models).toHaveLength(0);
                });
            });

            it('toggling a sensor OUT of "Not in Group" when it\'s the model\'s only membership deletes the model (2026-08-31 fix: used to no-op, falling back right back to [0])', () => {
                // Regression test — the old fallback logic re-added the
                // exact same [0] sentinel it had just removed, making the
                // "Remove from Not in Group" button silently do nothing.
                // There's no other group left to represent once 0 itself
                // is removed, so the placeholder model is deleted outright
                // (same as clicking "Remove model" in Build Model),
                // confirmed with the user rather than assumed.
                renderDashboard({
                    initialState: makeInitialState({
                        failureGroupState: {
                            groups: [],
                            models: [{
                                id: 'm1', groupNos: [0], name: '', kind: 'individual', category: null, notes: '', status: false,
                                targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
                                individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                                relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                                clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                            }],
                        },
                    }),
                });
                act(() => { last(sensorSelectionProps).onToggleSensorGroupKind('TAG1', 0, 'individual'); });
                return last(mockUpdateWorkspaceData.mock.results)!.value.then((state: any) => {
                    expect(state.failureGroupState.models).toHaveLength(0);
                });
            });

            it('2026-08-31: toggling a sensor into the same group with a DIFFERENT kind creates a separate model, leaving the existing kind\'s model untouched', () => {
                // The whole point of this redesign — a sensor can now
                // carry more than one model KIND at once (not just more
                // than one group), per explicit user request.
                renderDashboard({
                    initialState: makeInitialState({
                        failureGroupState: {
                            groups: [{ no: 1, name: 'Group A' }],
                            models: [{
                                id: 'm1', groupNos: [1], name: '', kind: 'individual', category: null, notes: '', status: false,
                                targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
                                individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                                relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                                clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                            }],
                        },
                    }),
                });
                act(() => { last(sensorSelectionProps).onToggleSensorGroupKind('TAG1', 1, 'relationship'); });
                return last(mockUpdateWorkspaceData.mock.results)!.value.then((state: any) => {
                    expect(state.failureGroupState.models).toHaveLength(2); // the original individual model, plus a new relationship one
                    const individual = state.failureGroupState.models.find((m: any) => m.id === 'm1');
                    const relationship = state.failureGroupState.models.find((m: any) => m.kind === 'relationship');
                    expect(individual.groupNos).toEqual([1]); // untouched
                    expect(relationship.targetSensor).toBe('TAG1');
                    expect(relationship.groupNos).toEqual([1]);
                });
            });

            it('createGroupForSensor reuses the sensor\'s existing individual model instead of creating a duplicate', async () => {
                renderDashboard({
                    initialState: makeInitialState({
                        failureGroupState: {
                            groups: [],
                            models: [{
                                id: 'm1', groupNos: [0], name: '', kind: 'individual', category: null, notes: '', status: false,
                                targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
                                individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                                relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                                clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                            }],
                        },
                    }),
                });
                fireEvent.click(screen.getByText('create-group-for-sensor')); // TAG1, 'New Group'
                const state = await last(mockUpdateWorkspaceData.mock.results)!.value;
                expect(state.failureGroupState.models).toHaveLength(1); // still one record
                const newGroupNo = state.failureGroupState.groups.find((g: any) => g.name === 'New Group').no;
                expect(state.failureGroupState.models[0].groupNos).toEqual([newGroupNo]); // 0 dropped, replaced by the real group
            });

            it('deleteGroup only strips that one membership -- a model that also belongs to another group survives untouched there', async () => {
                renderDashboard({
                    initialState: makeInitialState({
                        failureGroupState: {
                            groups: [{ no: 1, name: 'Group A' }, { no: 2, name: 'Group B' }],
                            models: [
                                {
                                    id: 'm1', groupNos: [1, 2], name: 'Shared', kind: 'individual', category: null, notes: '', status: false,
                                    targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
                                    individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                                    relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                                    clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                                },
                                {
                                    id: 'm2', groupNos: [1], name: 'OnlyInA', kind: 'individual', category: null, notes: '', status: false,
                                    targetSensor: 'TAG2', predictorSensors: [], xSensor: '', ySensor: '',
                                    individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                                    relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                                    clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                                },
                            ],
                        },
                    }),
                });
                fireEvent.click(screen.getByText('delete-group')); // deletes group 1 (mock always passes 1)
                const state = await last(mockUpdateWorkspaceData.mock.results)!.value;
                expect(state.failureGroupState.models).toHaveLength(2); // neither model deleted
                const shared = state.failureGroupState.models.find((m: any) => m.id === 'm1');
                const onlyInA = state.failureGroupState.models.find((m: any) => m.id === 'm2');
                expect(shared.groupNos).toEqual([2]); // lost group 1, still in group 2
                expect(onlyInA.groupNos).toEqual([0]); // lost its only group -> falls back to "Not in Group"
            });
        });
    });

    describe('Failure Groups tab (group-centric preview)', () => {
        it('create-empty-group round-trips through updateWorkspaceData, with no dead "isCollapsed" field', async () => {
            renderDashboard();
            fireEvent.click(screen.getByText('Failure Groups'));

            fireEvent.click(screen.getByText('create-empty-group'));
            const state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups.map((g: any) => g.name)).toContain('Empty Group');
            const newGroup = state.failureGroupState.groups.find((g: any) => g.name === 'Empty Group');
            expect(newGroup).not.toHaveProperty('isCollapsed');
        });

        it('updating group details (name/description/recommendation) and deleting from the preview panel itself also round-trip (2026-08-31: this "Edit details" editing moved here from Build Model window entirely, per explicit user request)', async () => {
            renderDashboard({
                initialState: makeInitialState({ failureGroupState: { groups: [{ no: 1, name: 'Group A' }], models: [] } }),
            });
            fireEvent.click(screen.getByText('Failure Groups'));

            fireEvent.click(screen.getByText('update-group-details-fg'));
            let state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups[0].name).toBe('Renamed');
            expect(state.failureGroupState.groups[0].description).toBe('New Desc');
            expect(state.failureGroupState.groups[0].recommendation).toBe('New Rec');

            fireEvent.click(screen.getByText('delete-group-fg'));
            state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.groups).toHaveLength(0);
        });

        it('deleting a model from the preview panel round-trips too (2026-08-31: model deletion now lives entirely on Dashboard, per explicit user request)', async () => {
            renderDashboard({
                initialState: makeInitialState({
                    failureGroupState: {
                        groups: [{ no: 1, name: 'Group A' }],
                        models: [{
                            id: 'm1', groupNos: [1], name: '', kind: 'individual', category: null, notes: '', status: false,
                            targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
                            individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                            relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                            clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                        }],
                    },
                }),
            });
            fireEvent.click(screen.getByText('Failure Groups'));

            fireEvent.click(screen.getByText('delete-model-fg'));
            const state = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(state.failureGroupState.models).toHaveLength(0);
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

        it('seeds sensorHeaders with a special sensor\'s tag from initialState.extraSensorMetadata on mount, not just on the live "add-sensor-selection" event (2026-09-01 fix — a special sensor has no row in the CSV at all, so it was completely absent from the Sensor tab\'s list on every reopen, reported by the user: "ปิดโปรแกรมเปิดใหม่แล้ว special sensor หาย")', () => {
            renderDashboard({
                initialState: makeInitialState({
                    selectedSensors: ['CALC1'],
                    visibleSensors: ['CALC1'],
                    extraSensorMetadata: [{ tag: 'CALC1', description: 'Calculated', unit: '', component: '' }],
                }),
            });
            const lastProps = last(sensorSelectionProps);
            expect(lastProps.sensors).toContain('CALC1');
            // The real CSV headers (TAG1/TAG2/TAG3 — see makeMetadata) are
            // still there too, not replaced by the extra tag.
            expect(lastProps.sensors).toEqual(expect.arrayContaining(['TAG1', 'TAG2', 'TAG3', 'CALC1']));
        });

        it('does not duplicate a special sensor\'s tag in sensorHeaders if it happens to also be a real CSV column already', () => {
            renderDashboard({
                initialState: makeInitialState({
                    extraSensorMetadata: [{ tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' }],
                }),
            });
            const lastProps = last(sensorSelectionProps);
            expect(lastProps.sensors.filter((s: string) => s === 'TAG1')).toHaveLength(1);
        });

        it('a selected sensor is always in the Sensor tab\'s list, even if it never made it into sensorHeaders itself (2026-09-01: the reported case — building a special sensor from an ALREADY-special one, live, in one session — left the new tag selected and plotted but genuinely missing from sensorHeaders through a path this couldn\'t pin down with certainty; this derives the displayed list from selectedSensors/extraSensorMetadata too instead of trusting sensorHeaders\' own imperative bookkeeping to always stay complete)', () => {
            renderDashboard({
                initialState: makeInitialState({
                    // Deliberately NOT in extraSensorMetadata either — simulates
                    // whatever gap let `selectedSensors` end up with a tag that
                    // `sensorHeaders` itself never received.
                    selectedSensors: ['GHOST1'],
                    visibleSensors: ['GHOST1'],
                }),
            });
            const lastProps = last(sensorSelectionProps);
            expect(lastProps.sensors).toContain('GHOST1');
        });

        it('captures "newRecipes" from "add-sensor-selection" and persists them via autosave (2026-09-01: the recipe, not the metadata, is what rebuilds a special sensor\'s data on the next workspace reopen — see WorkspaceState.specialSensorRecipes)', async () => {
            const seedRecipe = { kind: 'formula' as const, tag: 'EXISTING1', formula: '$TAG1 * 2' };
            renderDashboard({ initialState: makeInitialState({ specialSensorRecipes: [seedRecipe] }) });
            await act(async () => { await Promise.resolve(); });

            const newRecipe = { kind: 'operation' as const, tag: 'CALC1', sourceSensors: ['TAG1'], operationConfig: { mode: 'single' as const, singleOp: { type: 'add' as const, value: 1 } } };
            await act(async () => {
                for (const cb of listenCallbacks['add-sensor-selection'] ?? []) {
                    cb({
                        payload: {
                            sensors: ['CALC1'],
                            operation: null,
                            newMetadata: [{ tag: 'CALC1', description: 'Calculated', unit: '', component: '' }],
                            newRecipes: [newRecipe],
                        },
                    });
                }
            });

            // Appends alongside the seeded recipe, not replacing the array.
            await waitFor(() => {
                const saved = last(mockSaveWorkspaceData.mock.calls)[0];
                expect(saved.specialSensorRecipes).toEqual([seedRecipe, newRecipe]);
            });

            // A second round for the SAME tag updates that entry in place
            // rather than appending a duplicate (e.g. the user re-picks the
            // same custom name for a tweaked formula).
            const revisedRecipe = { kind: 'operation' as const, tag: 'CALC1', sourceSensors: ['TAG1', 'TAG2'], operationConfig: { mode: 'single' as const, singleOp: { type: 'multiply' as const, value: 2 } } };
            await act(async () => {
                for (const cb of listenCallbacks['add-sensor-selection'] ?? []) {
                    cb({ payload: { sensors: ['CALC1'], operation: null, newMetadata: [], newRecipes: [revisedRecipe] } });
                }
            });
            await waitFor(() => {
                const saved = last(mockSaveWorkspaceData.mock.calls)[0];
                expect(saved.specialSensorRecipes).toEqual([seedRecipe, revisedRecipe]);
            });
        });

        it('sends the recipes and the failure-group models along with "sensors-data" (the add-sensor window\'s Manage tab needs both to work out what still depends on a special sensor before offering to delete it)', async () => {
            const recipe = { kind: 'formula' as const, tag: 'CALC1', formula: '$TAG1 * 2' };
            const model = {
                id: 'm1', groupNos: [1], name: 'Boiler efficiency', kind: 'individual' as const, category: null,
                notes: '', status: false,
                targetSensor: 'CALC1', predictorSensors: [], xSensor: '', ySensor: '',
                individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
                relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
            };
            renderDashboard({
                initialState: makeInitialState({
                    specialSensorRecipes: [recipe],
                    failureGroupState: { groups: [{ no: 0, name: 'Not in Group' }], models: [model] },
                }),
            });
            await act(async () => {
                for (const cb of listenCallbacks['request-sensors'] ?? []) cb({});
            });
            expect(mockEmit).toHaveBeenCalledWith('sensors-data', expect.objectContaining({
                specialSensorRecipes: [recipe],
                models: [model],
            }));
        });

        it('"delete-special-sensors" takes the sensor out of the recipes, the metadata, the chart and the sensor list — dropping the recipe is what stops it being rebuilt on the next workspace open', async () => {
            const doomed = { kind: 'formula' as const, tag: 'CALC1', formula: '$TAG1 * 2' };
            const kept = { kind: 'formula' as const, tag: 'CALC2', formula: '$TAG2 * 3' };
            renderDashboard({
                initialState: makeInitialState({
                    selectedSensors: ['TAG1', 'CALC1'],
                    visibleSensors: ['TAG1', 'CALC1'],
                    specialSensorRecipes: [doomed, kept],
                    extraSensorMetadata: [
                        { tag: 'CALC1', description: 'Doomed', unit: '', component: '' },
                        { tag: 'CALC2', description: 'Kept', unit: '', component: '' },
                    ],
                }),
            });
            // The delete listener is the third `await listen(...)` in that
            // effect, so its callback is only registered a couple of
            // microtasks in.
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

            await act(async () => {
                for (const cb of listenCallbacks['delete-special-sensors'] ?? []) {
                    cb({ payload: { tags: ['CALC1'] } });
                }
            });

            const lastProps = last(sensorSelectionProps);
            expect(lastProps.sensors).not.toContain('CALC1');
            expect(lastProps.sensors).toContain('CALC2');
            expect(lastProps.selectedSensors).toEqual(['TAG1']);

            await waitFor(() => {
                const saved = last(mockSaveWorkspaceData.mock.calls)[0];
                expect(saved.specialSensorRecipes).toEqual([kept]);
                expect(saved.extraSensorMetadata).toEqual([{ tag: 'CALC2', description: 'Kept', unit: '', component: '' }]);
                expect(saved.selectedSensors).toEqual(['TAG1']);
            });
        });

        it('"update-special-sensor" stores the edited recipe and metadata under the same tag', async () => {
            const before = { kind: 'formula' as const, tag: 'CALC1', formula: '$TAG1 * 2' };
            const after = { kind: 'formula' as const, tag: 'CALC1', formula: '$TAG1 * 5' };
            renderDashboard({
                initialState: makeInitialState({
                    specialSensorRecipes: [before, { kind: 'formula', tag: 'CALC2', formula: '$TAG2' }],
                    extraSensorMetadata: [{ tag: 'CALC1', description: 'Doubled', unit: '', component: '' }],
                }),
            });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

            await act(async () => {
                for (const cb of listenCallbacks['update-special-sensor'] ?? []) {
                    cb({ payload: {
                        recipe: after,
                        metadata: { tag: 'CALC1', description: 'Five times', unit: 'bar', component: 'Pump' },
                        recomputed: ['CALC1'],
                    } });
                }
            });

            await waitFor(() => {
                const saved = last(mockSaveWorkspaceData.mock.calls)[0];
                // Replaced in place — the array keeps its order, because a
                // later recipe can reference an earlier one on replay.
                expect(saved.specialSensorRecipes[0]).toEqual(after);
                expect(saved.specialSensorRecipes).toHaveLength(2);
                expect(saved.extraSensorMetadata).toEqual([
                    { tag: 'CALC1', description: 'Five times', unit: 'bar', component: 'Pump' },
                ]);
            });
        });

        it('"update-special-sensor" makes the chart and scatter refetch, even though the query itself has not changed (the column was recomputed in the Rust session under the same name)', async () => {
            renderDashboard({
                initialState: makeInitialState({
                    selectedSensors: ['CALC1'],
                    visibleSensors: ['CALC1'],
                    specialSensorRecipes: [{ kind: 'formula', tag: 'CALC1', formula: '$TAG1 * 2' }],
                    extraSensorMetadata: [{ tag: 'CALC1', description: '', unit: '', component: '' }],
                }),
            });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

            const revisionBefore = last(mockUseChartData.mock.calls)[0]?.revision ?? 0;
            const scatterRevisionBefore = last(mockUseScatterSample.mock.calls)[3] ?? 0;

            await act(async () => {
                for (const cb of listenCallbacks['update-special-sensor'] ?? []) {
                    cb({ payload: { recipe: { kind: 'formula', tag: 'CALC1', formula: '$TAG1 * 5' }, recomputed: ['CALC1'] } });
                }
            });

            expect(last(mockUseChartData.mock.calls)[0]?.revision).toBe(revisionBefore + 1);
            expect(last(mockUseScatterSample.mock.calls)[3]).toBe(scatterRevisionBefore + 1);
        });

        it('"rename-special-sensor" re-keys every dashboard state slice that names the old tag', async () => {
            const renamed = { kind: 'formula' as const, tag: 'CALC1', formula: '$TAG1 * 2' };
            const dependent = { kind: 'formula' as const, tag: 'CALC2', formula: '${CALC1} + 1' };
            renderDashboard({
                initialState: makeInitialState({
                    selectedSensors: ['CALC1'],
                    visibleSensors: ['CALC1'],
                    specialSensorRecipes: [renamed, dependent],
                    extraSensorMetadata: [{ tag: 'CALC1', description: 'Doubled', unit: '', component: '' }],
                    sensorColors: { CALC1: '#ff0000' },
                    sensorAxisRange: { CALC1: { min: 0, max: 100 } },
                    alarmLinesEnabled: { CALC1: ['H'] },
                    scatterAxes: { x: 'CALC1', y: 'TAG2' },
                    scatterAxisPins: { x: { sensor: 'CALC1', min: 0, max: 10 } },
                    valueHighlight: { sensor: 'CALC1', ranges: [] },
                    failureGroupState: {
                        groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG1' }],
                        models: [{
                            id: 'm1', groupNos: [1], name: 'Model1', kind: 'individual', category: null,
                            notes: '', status: false, targetSensor: 'CALC1', predictorSensors: [], xSensor: '', ySensor: '',
                            individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000,
                            clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
                            filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                        }],
                    },
                }),
            });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

            const revisionBefore = last(mockUseChartData.mock.calls)[0]?.revision ?? 0;

            await act(async () => {
                for (const cb of listenCallbacks['rename-special-sensor'] ?? []) {
                    cb({ payload: {
                        oldTag: 'CALC1',
                        newTag: 'CALC1-renamed',
                        recipe: { kind: 'formula', tag: 'CALC1-renamed', formula: '$TAG1 * 2' },
                        metadata: { tag: 'CALC1-renamed', description: 'Doubled', unit: '', component: '' },
                        updatedRecipes: [{ kind: 'formula', tag: 'CALC2', formula: '${CALC1-renamed} + 1' }],
                    } });
                }
            });

            // Chart/scatter must refetch — the tag they were querying by no
            // longer resolves under the old name.
            expect(last(sensorSelectionProps).selectedSensors).toEqual(['CALC1-renamed']);
            expect(last(mockUseChartData.mock.calls)[0]?.revision).toBe(revisionBefore + 1);

            await waitFor(() => {
                const saved = last(mockSaveWorkspaceData.mock.calls)[0];
                // Renamed recipe re-keyed, AND its dependent's rewritten
                // formula carried through, array order preserved.
                expect(saved.specialSensorRecipes).toEqual([
                    { kind: 'formula', tag: 'CALC1-renamed', formula: '$TAG1 * 2' },
                    { kind: 'formula', tag: 'CALC2', formula: '${CALC1-renamed} + 1' },
                ]);
                expect(saved.extraSensorMetadata).toEqual([{ tag: 'CALC1-renamed', description: 'Doubled', unit: '', component: '' }]);
                expect(saved.selectedSensors).toEqual(['CALC1-renamed']);
                expect(saved.visibleSensors).toEqual(['CALC1-renamed']);
                expect(saved.sensorColors).toEqual({ 'CALC1-renamed': '#ff0000' });
                expect(saved.sensorAxisRange).toEqual({ 'CALC1-renamed': { min: 0, max: 100 } });
                expect(saved.alarmLinesEnabled).toEqual({ 'CALC1-renamed': ['H'] });
                expect(saved.scatterAxes).toEqual({ x: 'CALC1-renamed', y: 'TAG2' });
                expect(saved.scatterAxisPins).toEqual({ x: { sensor: 'CALC1-renamed', min: 0, max: 10 } });
                expect(saved.valueHighlight).toEqual({ sensor: 'CALC1-renamed', ranges: [] });
            });

            // Failure Group model — persisted separately via the same
            // read-modify-write path every other model mutation uses, so a
            // concurrently open Build Model window would see it too.
            const patched = await last(mockUpdateWorkspaceData.mock.results)!.value;
            expect(patched.failureGroupState.models[0].targetSensor).toBe('CALC1-renamed');
        });

        it('"delete-special-sensors" matches tags case-insensitively, and ignores an empty list', async () => {
            const recipe = { kind: 'formula' as const, tag: 'Calc1', formula: '$TAG1 * 2' };
            renderDashboard({ initialState: makeInitialState({ specialSensorRecipes: [recipe] }) });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

            await act(async () => {
                for (const cb of listenCallbacks['delete-special-sensors'] ?? []) cb({ payload: { tags: [] } });
            });
            expect(last(sensorSelectionProps).sensors).toContain('TAG1');

            await act(async () => {
                for (const cb of listenCallbacks['delete-special-sensors'] ?? []) cb({ payload: { tags: ['  calc1  '] } });
            });
            await waitFor(() => {
                const saved = last(mockSaveWorkspaceData.mock.calls)[0];
                expect(saved.specialSensorRecipes).toEqual([]);
            });
        });
    });

    describe('Build Model', () => {
        it('clicking "Build Model" in the Failure Groups tab spawns the singleton build-model window', async () => {
            renderDashboard();
            fireEvent.click(screen.getByText('Failure Groups'));
            await act(async () => {
                fireEvent.click(screen.getByText('open-build-model'));
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(webviewWindowCalls.some((c) => c.label === 'build-model')).toBe(true);
        });

        it('focuses an already-open build-model window instead of spawning a second one', async () => {
            const existing = { setFocus: vi.fn().mockResolvedValue(undefined) };
            mockGetByLabel.mockResolvedValue(existing);
            renderDashboard();
            fireEvent.click(screen.getByText('Failure Groups'));
            await act(async () => {
                fireEvent.click(screen.getByText('open-build-model'));
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(existing.setFocus).toHaveBeenCalled();
            expect(webviewWindowCalls.some((c) => c.label === 'build-model')).toBe(false);
        });

        it('two rapid clicks fired before the first getByLabel check resolves only spawn one window (race regression)', async () => {
            let resolveGetByLabel: (v: any) => void;
            mockGetByLabel.mockReturnValue(new Promise((resolve) => { resolveGetByLabel = resolve; }));
            renderDashboard();
            fireEvent.click(screen.getByText('Failure Groups'));

            const btn = screen.getByText('open-build-model');
            await act(async () => {
                fireEvent.click(btn);
                fireEvent.click(btn);
                resolveGetByLabel(null);
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(webviewWindowCalls.filter((c) => c.label === 'build-model')).toHaveLength(1);
        });

        it('"request-build-model-data" responds with workspaceId, sensorHeaders, sensorMetadata, and metadata', async () => {
            renderDashboard();
            mockEmit.mockClear();
            await act(async () => {
                for (const cb of listenCallbacks['request-build-model-data'] ?? []) {
                    await cb({});
                }
            });
            expect(mockEmit).toHaveBeenCalledWith('build-model-data', expect.objectContaining({
                workspaceId: expect.any(String),
            }));
        });

        it('closes the build-model window when this workspace\'s Dashboard unmounts (e.g. switching to a different project)', async () => {
            const existing = { close: vi.fn().mockResolvedValue(undefined) };
            mockGetByLabel.mockResolvedValue(existing);
            const { unmount } = renderDashboard();

            await act(async () => {
                unmount();
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(mockGetByLabel).toHaveBeenCalledWith('build-model');
            expect(existing.close).toHaveBeenCalled();
        });

        it('does nothing on unmount if no build-model window is open', async () => {
            mockGetByLabel.mockResolvedValue(null);
            const { unmount } = renderDashboard();

            // Must not throw even though getByLabel resolves to null.
            await act(async () => {
                unmount();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockGetByLabel).toHaveBeenCalledWith('build-model');
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
