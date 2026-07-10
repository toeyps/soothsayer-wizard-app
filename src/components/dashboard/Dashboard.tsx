import { useState, useMemo, useEffect, useDeferredValue, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, UnlistenFn } from "@tauri-apps/api/event";
import Split from 'split.js';
import { saveWorkspaceData } from '../../workspaceManager';
import {
    CsvMetadata, SensorMetadata, CsvRecord, SensorOperationConfig,
    WorkspaceState, DashboardLayoutSizes, DashboardSlot, DashboardPanel, DashboardSlotMap,
} from '../../types';
import type { DashboardDataFilter } from '../../types/commands';
// `DashboardSlotMap` is no longer persisted in WorkspaceState (drag-and-drop
// swap was removed) but we still use the type internally to describe the
// constant slot→panel mapping below.

import DataTable from './DataTable';
import { Chart } from '../charts';
import FilterPanel, { FilterState } from './FilterPanel';
import SensorSelection from './SensorSelection';
import { useScatterSample, ScatterSampleFilter } from '../../hooks/useScatterSample';
import { reportError } from '../../errorReporter';
import { useChartData } from '../../hooks/useChartData';
import { useTablePage } from '../../hooks/useTablePage';

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import { Plus, EyeOff, BarChart3, Radio, Table, Download, Filter, Calendar, ArrowRight, ArrowLeft } from 'lucide-react';

// Panel configuration
const PANELS = {
    chart: { id: 'chart', label: 'Chart', icon: BarChart3 },
    filter: { id: 'filter', label: 'Filter', icon: Filter },
    sensors: { id: 'sensors', label: 'Sensors', icon: Radio },
    data: { id: 'data', label: 'Data', icon: Table }
} as const;

type PanelId = keyof typeof PANELS;

// Default split ratios used the first time a workspace is opened (no saved
// layoutSizes yet). 66.67/33.33 mirrors the original CSS Grid `2fr 1fr`.
const DEFAULT_LAYOUT_SIZES: DashboardLayoutSizes = {
    columns: [66.67, 33.33],
    leftRows: [60, 40],
    rightRows: [50, 50],
};

// Fixed panel-to-slot layout. Was previously a stateful `slotMap` that the
// user could rearrange via drag-and-drop, but the swap UI was removed so
// this is now just a constant. Mirrors the original Dashboard layout:
// chart at top-left, the data table just under it, sensors at top-right,
// filter controls at bottom-right.
const SLOT_LAYOUT: DashboardSlotMap = {
    'left-top': 'chart',
    'left-bottom': 'data',
    'right-top': 'sensors',
    'right-bottom': 'filter',
};

// Static list of all slots in render order — used to iterate when computing
// drag-target visibility and for building the JSX of the two columns.
const LEFT_SLOTS: DashboardSlot[] = ['left-top', 'left-bottom'];
const RIGHT_SLOTS: DashboardSlot[] = ['right-top', 'right-bottom'];

// Point budget for the line chart. The Rust `get_chart_data` command
// min/max-decimates the filtered rows down to at most this many x-positions,
// so the IPC payload, JS heap, and ECharts buffers stay bounded no matter
// how many rows the dataset holds. ~4k points ≈ 2 output points per pixel
// on a typical panel width — visually indistinguishable from raw.
const LINE_MAX_POINTS = 4000;
const TABLE_PAGE_SIZE = 50;
// Stable empty array for the line chart's unused row-based `data` prop
// (the chart consumes the bounded `columnar` feed instead).
const EMPTY_RECORDS: CsvRecord[] = [];

// Build the gutter element split.js inserts between panels. We use a wider
// hit-target (12px) with a thin centered line so the resize handle is easy
// to grab without dominating the layout visually.
const createGutter = (_index: number, direction: 'horizontal' | 'vertical'): HTMLElement => {
    const el = document.createElement('div');
    el.className = `gutter gutter-${direction}`;
    return el;
};

// Override split.js's default inline styling. Default sets `width`/`height`
// inline, but in a flex layout those are overridden by `flex-basis` (from our
// CSS `flex: 1` / `flex: 2 1 0`). Setting `flex-basis` inline beats the CSS
// rule and actually controls the rendered size — without this, dragging the
// gutter does nothing visually.
const flexElementStyle = (_dim: string, size: number, gutSize: number): Record<string, string> => ({
    'flex-basis': `calc(${size}% - ${gutSize}px)`,
});

const flexGutterStyle = (_dim: string, gutSize: number): Record<string, string> => ({
    'flex-basis': `${gutSize}px`,
});


interface DashboardProps {
    metadata: CsvMetadata;
    sensorMetadata: SensorMetadata[] | null;
    onBack: () => void;
    initialState: WorkspaceState | null;
}

export interface DashboardRef {
    saveWorkspace: () => Promise<void>;
    saveWorkspaceAs: () => Promise<void>;
    renameWorkspace: (newName: string) => void;
}

const Dashboard = forwardRef<DashboardRef, DashboardProps>(({ metadata, sensorMetadata, onBack, initialState }, ref) => {
    const [localName, setLocalName] = useState(initialState?.name || "");

    const [sensorHeaders, setSensorHeaders] = useState<string[]>(() =>
        metadata.headers.filter(h => {
            const lower = h.trim().toLowerCase();
            return lower !== 'timestamp' && lower !== 'time';
        })
    );

    const [selectedSensors, setSelectedSensors] = useState<string[]>(initialState?.selectedSensors || []);
    const [visibleSensors, setVisibleSensors] = useState<string[]>(initialState?.visibleSensors || []);
    const [operationConfig, setOperationConfig] = useState<SensorOperationConfig | null>(initialState?.operationConfig || null);

    // Ref to access buildWorkspaceState from imperative handle and early effects
    const buildStateRef = useRef<(overrides?: Partial<WorkspaceState>) => WorkspaceState>(() => initialState!);

    useImperativeHandle(ref, () => ({
        saveWorkspace: async () => {
            if (initialState) {
                await saveWorkspaceData(buildStateRef.current());
                alert(`Workspace "${localName}" Saved Successfully!`);
            }
        },
        saveWorkspaceAs: async () => {
            // Open new window instead of prompt
            const webview = new WebviewWindow('save-as', {
                url: '/?window=save-as',
                title: 'Save Workspace As',
                width: 450,
                height: 350,
                center: true,
                alwaysOnTop: true,
                decorations: false,
                resizable: false,
                skipTaskbar: true
            });

            await webview.once('tauri://error', (e) => {
                console.error('Failed to create Save As window:', e);
            });
        },
        renameWorkspace: (newName: string) => {
            setLocalName(newName);
        }
    }));

    // Listen for Save As window requests and submissions
    useEffect(() => {
        let unlistenReq: (() => void) | undefined;
        let unlistenSubmit: (() => void) | undefined;

        const setupSaveAsListeners = async () => {
            unlistenReq = await listen('request-save-as-data', async () => {
                await emit('request-save-as-data-response', { currentName: localName });
            });

            unlistenSubmit = await listen<{ newName: string }>('save-as-submit', async (event) => {
                if (initialState) {
                    const newId = `ws_${Date.now()}`;
                    const newState = buildStateRef.current({ id: newId, name: event.payload.newName });
                    await saveWorkspaceData(newState);
                    setLocalName(event.payload.newName);
                    await emit('workspace-renamed-internal', { newName: event.payload.newName });
                    alert(`New workspace "${event.payload.newName}" created!`);
                }
            });
        };

        setupSaveAsListeners();
        return () => {
            if (unlistenReq) unlistenReq();
            if (unlistenSubmit) unlistenSubmit();
        };
    }, [localName, initialState]);

    const deferredSensors = useDeferredValue(selectedSensors);

    // Sync visibleSensors with selectedSensors when selectedSensors changes
    useEffect(() => {
        setVisibleSensors(selectedSensors);
    }, [selectedSensors]);

    // Collapsed panels state
    const [collapsedPanels, setCollapsedPanels] = useState<Set<PanelId>>(
        new Set((initialState?.collapsedPanels ?? []) as PanelId[])
    );

    // Resizable layout sizes (split.js percentages). Initialized from the
    // persisted workspace value or DEFAULT_LAYOUT_SIZES on first open. Each
    // tuple is `[primary, secondary]` summing to ~100. Updated by split.js's
    // `onDragEnd` and picked up by the existing autosave effect via
    // `buildWorkspaceState`.
    const [layoutSizes, setLayoutSizes] = useState<DashboardLayoutSizes>(
        initialState?.layoutSizes ?? DEFAULT_LAYOUT_SIZES
    );

    // Refs that split.js will manage. Attached to the slot wrappers below.
    // Split.js stays mounted across renders and only re-mounts when a panel
    // collapse/expand changes whether the split should exist at all.
    const leftColumnRef = useRef<HTMLDivElement>(null);
    const rightColumnRef = useRef<HTMLDivElement>(null);
    const slotLTRef = useRef<HTMLDivElement>(null);
    const slotLBRef = useRef<HTMLDivElement>(null);
    const slotRTRef = useRef<HTMLDivElement>(null);
    const slotRBRef = useRef<HTMLDivElement>(null);
    const slotRefs: Record<DashboardSlot, React.RefObject<HTMLDivElement | null>> = {
        'left-top': slotLTRef,
        'left-bottom': slotLBRef,
        'right-top': slotRTRef,
        'right-bottom': slotRBRef,
    };

    // Read-only ref mirror of `layoutSizes` so the useEffects can pull the
    // freshest sizes when they re-initialize (e.g. after a panel un-collapses)
    // without listing layoutSizes itself in the deps and causing a re-init on
    // every drag.
    const layoutSizesRef = useRef(layoutSizes);
    useEffect(() => { layoutSizesRef.current = layoutSizes; }, [layoutSizes]);

    // Slot-aware collapse flags. Each one looks up which panel is in the
    // slot via SLOT_LAYOUT, then checks if that panel is collapsed. Drives
    // the split.js effects below (tear down when a slot's panel hides).
    const ltCollapsed = collapsedPanels.has(SLOT_LAYOUT['left-top']);
    const lbCollapsed = collapsedPanels.has(SLOT_LAYOUT['left-bottom']);
    const rtCollapsed = collapsedPanels.has(SLOT_LAYOUT['right-top']);
    const rbCollapsed = collapsedPanels.has(SLOT_LAYOUT['right-bottom']);
    const allLeftCollapsed = ltCollapsed && lbCollapsed;
    const allRightCollapsed = rtCollapsed && rbCollapsed;

    // ── split.js: horizontal split between left and right columns ──
    // Tears down when an entire column has no visible panels so the surviving
    // column can take 100% width (CSS class on the grid hides the empty side).
    useEffect(() => {
        if (allLeftCollapsed || allRightCollapsed) return;
        const left = leftColumnRef.current;
        const right = rightColumnRef.current;
        if (!left || !right) return;
        const inst = Split([left, right], {
            sizes: layoutSizesRef.current.columns,
            minSize: [400, 280],
            gutterSize: 12,
            direction: 'horizontal',
            gutter: createGutter,
            elementStyle: flexElementStyle,
            gutterStyle: flexGutterStyle,
            onDragEnd: (sizes) => {
                setLayoutSizes(prev => ({ ...prev, columns: [sizes[0], sizes[1]] as [number, number] }));
            },
        });
        return () => { try { inst.destroy(); } catch { /* split.js may already be torn down */ } };
    }, [allLeftCollapsed, allRightCollapsed]);

    // ── split.js: vertical split inside left column (LT ↔ LB) ──
    // Refs point to slot wrappers which stay STABLE across panel swaps, so
    // swapping panels does NOT re-init split.js — only collapse toggles do.
    useEffect(() => {
        if (ltCollapsed || lbCollapsed) return;
        const lt = slotLTRef.current;
        const lb = slotLBRef.current;
        if (!lt || !lb) return;
        const inst = Split([lt, lb], {
            sizes: layoutSizesRef.current.leftRows,
            minSize: [200, 120],
            gutterSize: 12,
            direction: 'vertical',
            gutter: createGutter,
            elementStyle: flexElementStyle,
            gutterStyle: flexGutterStyle,
            onDragEnd: (sizes) => {
                setLayoutSizes(prev => ({ ...prev, leftRows: [sizes[0], sizes[1]] as [number, number] }));
            },
        });
        return () => { try { inst.destroy(); } catch { /* ignore */ } };
    }, [ltCollapsed, lbCollapsed]);

    // ── split.js: vertical split inside right column (RT ↔ RB) ──
    // Save & Continue lives OUTSIDE the .right-column-splits wrapper so it
    // isn't resized along with the panels.
    useEffect(() => {
        if (rtCollapsed || rbCollapsed) return;
        const rt = slotRTRef.current;
        const rb = slotRBRef.current;
        if (!rt || !rb) return;
        const inst = Split([rt, rb], {
            sizes: layoutSizesRef.current.rightRows,
            minSize: [120, 120],
            gutterSize: 12,
            direction: 'vertical',
            gutter: createGutter,
            elementStyle: flexElementStyle,
            gutterStyle: flexGutterStyle,
            onDragEnd: (sizes) => {
                setLayoutSizes(prev => ({ ...prev, rightRows: [sizes[0], sizes[1]] as [number, number] }));
            },
        });
        return () => { try { inst.destroy(); } catch { /* ignore */ } };
    }, [rtCollapsed, rbCollapsed]);

    const togglePanel = (panelId: PanelId) => {
        setCollapsedPanels(prev => {
            const newSet = new Set(prev);
            if (newSet.has(panelId)) {
                newSet.delete(panelId);
            } else {
                newSet.add(panelId);
            }
            return newSet;
        });
    };

    const expandPanel = (panelId: PanelId) => {
        setCollapsedPanels(prev => {
            const newSet = new Set(prev);
            newSet.delete(panelId);
            return newSet;
        });
    };

    // Event handling for Add Sensor Window communication
    // Use ref to keep track of latest state without re-binding listeners
    const stateRef = useRef({ sensorHeaders, selectedSensors, sensorMetadata, metadata });
    useEffect(() => {
        stateRef.current = { sensorHeaders, selectedSensors, sensorMetadata, metadata };
    }, [sensorHeaders, selectedSensors, sensorMetadata, metadata]);

    useEffect(() => {
        let unlistenRequest: UnlistenFn | undefined;
        let unlistenAdd: UnlistenFn | undefined;

        const setupListeners = async () => {
            console.log("Setting up Dashboard listeners");
            // Listen for request from child window
            unlistenRequest = await listen('request-sensors', () => {
                console.log("Dashboard received 'request-sensors', emitting data...");
                const { sensorHeaders, selectedSensors, sensorMetadata } = stateRef.current;
                emit('sensors-data', {
                    sensors: sensorHeaders,
                    selectedSensors: selectedSensors,
                    sensorMetadata: sensorMetadata
                });
            });

            // Listen for new selections from child window
            unlistenAdd = await listen<{ sensors: string[], operation: SensorOperationConfig | null }>('add-sensor-selection', async (event) => {
                console.log("Dashboard received 'add-sensor-selection'", event.payload);

                let newSelectedSensors: string[] = [];
                let newOperationConfig: SensorOperationConfig | null = null;

                if (Array.isArray(event.payload)) {
                    newSelectedSensors = event.payload;
                    newOperationConfig = null;
                } else {
                    newSelectedSensors = event.payload.sensors;
                    newOperationConfig = event.payload.operation;
                }

                // Update selection
                setSelectedSensors(newSelectedSensors);
                setOperationConfig(newOperationConfig);

                // Manually update sensor headers to include any new sensors from the selection
                // This ensures immediate UI update without waiting for backend fetch
                setSensorHeaders(prevHeaders => {
                    const newHeaders = [...prevHeaders];
                    let changed = false;
                    newSelectedSensors.forEach(s => {
                        // Check case-insensitive existence
                        const exists = newHeaders.some(h => h.toLowerCase() === s.toLowerCase());
                        if (!exists) {
                            newHeaders.push(s);
                            changed = true;
                        }
                    });
                    return changed ? newHeaders : prevHeaders;
                });
            });
            // NOTE: the Save & Continue button registers its own one-shot listener that
            // includes workspaceId + dashboardSnapshot and then closes the dashboard. We do
            // not register a duplicate listener here to avoid double-emitting stale data.
        };

        setupListeners();

        return () => {
            if (unlistenRequest) unlistenRequest();
            if (unlistenAdd) unlistenAdd();
        };
    }, []);

    const [filters, setFilters] = useState<FilterState>(initialState?.filters ?? { timestampStart: '', timestampEnd: '', sensorFilters: [] });
    const [chartType, setChartType] = useState<'line' | 'scatter' | 'pair'>(initialState?.chartType ?? 'line');
    const [samplingMethod, setSamplingMethod] = useState<'raw' | 'avg' | 'max' | 'min' | 'first' | 'last'>(initialState?.samplingMethod ?? 'raw');

    // Scatter / pair plots are meaningless with fewer than two sensors, so
    // below that the two buttons are disabled — and if the selection drops
    // under two WHILE such a chart is active (unticking down to one), we
    // bounce back to the line chart instead of showing an empty canvas.
    // Also covers workspace restores that persisted a scatter view whose
    // sensor selection no longer qualifies.
    const canScatter = selectedSensors.length >= 2;
    useEffect(() => {
        if (!canScatter && chartType !== 'line') {
            setChartType('line');
        }
    }, [canScatter, chartType]);


    // ── Bounded data-view queries ────────────────────────────────────
    // The full pipeline (dashboard filter → operation transform → hourly
    // aggregation → min/max decimation) runs in Rust. The WebView only
    // ever receives O(LINE_MAX_POINTS) chart arrays and one table page —
    // selecting millions of rows no longer copies the dataset into the JS
    // heap or blocks the main thread. (Previously `get_data` streamed
    // every row over IPC and every transform re-ran in useMemos here.)
    const handleFiltersChange = useCallback((newFilters: FilterState) => {
        // The query hooks debounce backend calls themselves, so rapid
        // datetime-input edits don't queue full-dataset passes.
        setFilters(newFilters);
    }, []);

    // Wire-format value filters, shared by the chart/table/export/scatter
    // queries below.
    const wireValueFilters = useMemo(() =>
        filters.sensorFilters
            .filter(sf => sf.value1 !== '')
            .map(sf => ({
                sensor: sf.sensor,
                operation: sf.operation,
                value1: sf.value1 !== '' ? parseFloat(sf.value1) : null,
                value2: sf.value2 !== '' ? parseFloat(sf.value2) : null,
            })),
        [filters.sensorFilters]);

    // All SELECTED sensors are fetched (bounded, so cheap); the visibility
    // eye-toggles pick columns client-side without refetching.
    const dataFilter = useMemo<DashboardDataFilter | null>(() => {
        if (deferredSensors.length === 0) return null;
        return {
            sensors: deferredSensors,
            timestamp_start: filters.timestampStart || null,
            timestamp_end: filters.timestampEnd || null,
            value_filters: wireValueFilters,
        };
    }, [deferredSensors, filters.timestampStart, filters.timestampEnd, wireValueFilters]);

    const { view, loading: viewLoading, error: viewError } = useChartData(
        dataFilter
            ? {
                filter: dataFilter,
                sampling: samplingMethod,
                operation: operationConfig,
                maxPoints: LINE_MAX_POINTS,
            }
            : null
    );
    // Both data hooks swallow backend failures into state; in a production
    // build there's no console, so route them to the global reporter
    // (toast + persistent log file) or they die invisible.
    useEffect(() => {
        if (viewError) reportError('chart-data', viewError);
    }, [viewError]);

    // Table pages through the same (post-op / post-aggregation) row set in
    // the backend; only the visible 50 rows ever reach the WebView.
    const [tablePageIndex, setTablePageIndex] = useState(0);
    const tableQueryKey = useMemo(
        () => (dataFilter ? JSON.stringify({ dataFilter, samplingMethod, operationConfig }) : ''),
        [dataFilter, samplingMethod, operationConfig]
    );
    useEffect(() => {
        setTablePageIndex(0);
    }, [tableQueryKey]);

    const { page: tablePage, loading: tableLoading } = useTablePage(
        dataFilter
            ? {
                filter: dataFilter,
                sampling: samplingMethod,
                operation: operationConfig,
                page: tablePageIndex,
                pageSize: TABLE_PAGE_SIZE,
            }
            : null
    );

    const loading = viewLoading || tableLoading;

    const isMultiOp = operationConfig?.mode === 'multi' && !!operationConfig?.multiOp;

    // Headers actually shown (chart + table). In multi-op mode the backend
    // collapses everything into one "Result (op)" column; otherwise show
    // the visible subset of the resolved sensors.
    const displayHeaders = useMemo(() => {
        if (!view) return [];
        if (isMultiOp) return view.headers;
        return view.headers.filter(h => visibleSensors.includes(h));
    }, [view, isMultiOp, visibleSensors]);

    // Columnar line-chart feed projected to the visible sensors — array
    // picks over ≤LINE_MAX_POINTS values, no per-row objects.
    const lineColumnar = useMemo(() => {
        if (!view) return { timestamps: [] as string[], series: [] as (number | null)[][] };
        if (isMultiOp) return { timestamps: view.timestamps, series: view.series };
        const picks = displayHeaders.map(h => view.headers.indexOf(h));
        return {
            timestamps: view.timestamps,
            series: picks.map(i => (i >= 0 ? view.series[i] : [])),
        };
    }, [view, isMultiOp, displayHeaders]);

    // Current table page projected to the visible sensors (50 rows max).
    const tableRows = useMemo<CsvRecord[]>(() => {
        if (!tablePage) return [];
        if (isMultiOp) return tablePage.rows;
        const picks = displayHeaders.map(h => tablePage.headers.indexOf(h));
        return tablePage.rows.map(r => ({
            timestamp: r.timestamp,
            values: picks.map(i => (i >= 0 ? r.values[i] : null)),
        }));
    }, [tablePage, isMultiOp, displayHeaders]);

    const tableTotalRows = tablePage?.total_rows ?? 0;

    // Build workspace state helper for saving
    const buildWorkspaceState = useCallback((overrides?: Partial<WorkspaceState>): WorkspaceState => ({
        ...initialState!,
        name: localName,
        lastRoute: 'dashboard',
        selectedSensors,
        visibleSensors,
        operationConfig,
        filters,
        chartType,
        samplingMethod,
        collapsedPanels: Array.from(collapsedPanels),
        layoutSizes,
        ...overrides,
    }), [initialState, localName, selectedSensors, visibleSensors, operationConfig, filters, chartType, samplingMethod, collapsedPanels, layoutSizes]);

    // Keep ref in sync for imperative handle usage
    buildStateRef.current = buildWorkspaceState;

    // Auto-save state changes
    useEffect(() => {
        if (initialState) {
            saveWorkspaceData(buildWorkspaceState());
        }
    }, [buildWorkspaceState, initialState]);

    // ── Scatter / Pair-plot data path (bounded sample) ───────────────────
    // A 2 GB CSV is millions of rows; pushing every point to WebGL exhausts
    // GPU memory and blanks the canvas, and holding them all as JS objects
    // can OOM the renderer. So the scatter & pair-plot charts render a bounded
    // reservoir sample fetched from Rust — the payload, heap, and GPU buffers
    // stay constant regardless of dataset size. (The line chart / table use
    // the equally-bounded `get_chart_data` / `get_table_page` path above.)
    const scatterActive = chartType === 'scatter' || chartType === 'pair';
    // Pair plot redraws the sample once PER cell across many WebGL contexts,
    // so it gets a tighter point budget than the single-canvas scatter.
    const scatterMaxPoints = chartType === 'pair' ? 50_000 : 200_000;

    const scatterFilter = useMemo<ScatterSampleFilter | null>(() => {
        if (!scatterActive || visibleSensors.length === 0) return null;
        return {
            sensors: visibleSensors,
            timestamp_start: filters.timestampStart || null,
            timestamp_end: filters.timestampEnd || null,
            value_filters: wireValueFilters,
        };
    }, [scatterActive, visibleSensors, filters.timestampStart, filters.timestampEnd, wireValueFilters]);

    const scatterSample = useScatterSample(
        scatterFilter,
        scatterMaxPoints,
        scatterActive,
    );
    useEffect(() => {
        if (scatterSample.error) reportError('scatter-sample', scatterSample.error);
    }, [scatterSample.error]);

    // Keep the sample consistent with the line/table path by applying the same
    // single-op transform. (Multi-op collapses to one column → scatter needs
    // ≥2, so it's left untransformed and the chart shows its own guard.)
    const scatterFeed = useMemo<CsvRecord[]>(() => {
        const rows = scatterSample.rows;
        if (operationConfig?.mode === 'single' && operationConfig.singleOp) {
            const { type, value } = operationConfig.singleOp;
            return rows.map(r => ({
                ...r,
                values: r.values.map(v => {
                    if (v === null) return null;
                    switch (type) {
                        case 'add': return v + value;
                        case 'subtract': return v - value;
                        case 'multiply': return v * value;
                        case 'divide': return value !== 0 ? v / value : v;
                        case 'power': return Math.pow(v, value);
                        default: return v;
                    }
                }),
            }));
        }
        return rows;
    }, [scatterSample.rows, operationConfig]);

    // The dashboard no longer holds the full dataset, so there is no
    // full-data fallback: the scatter / pair charts render the bounded
    // sample (empty while the first fetch is in flight — the Loading badge
    // covers that window).
    const scatterReady = scatterSample.rows.length > 0;
    const scatterChartData = scatterFeed;
    const scatterChartHeaders = scatterSample.headers.length > 0 ? scatterSample.headers : visibleSensors;


    // Data range for auto-filling the time inputs — first/last timestamp of
    // the filtered population, computed backend-side.
    const dataRange = useMemo(() => {
        if (view?.ts_min && view?.ts_max) {
            return { min: view.ts_min, max: view.ts_max };
        }
        return undefined;
    }, [view]);

    // Format timestamp for datetime-local input
    const formatForInput = useCallback((dateStr: string) => {
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '';
            const offset = date.getTimezoneOffset() * 60000;
            return (new Date(date.getTime() - offset)).toISOString().slice(0, 16);
        } catch {
            return '';
        }
    }, []);

    // Display values: show data range when filter is empty
    const displayTimestampStart = filters.timestampStart || (dataRange ? formatForInput(dataRange.min) : '');
    const displayTimestampEnd = filters.timestampEnd || (dataRange ? formatForInput(dataRange.max) : '');

    // Drag-and-drop swap was removed in favor of a fixed layout (see
    // SLOT_LAYOUT at the top of this file). Resize via split.js remains.

    // ── Panel content renderers ──
    // Each returns the inner panel wrapper (.chart-section-large or
    // .widget-section) WITHOUT the outer .dashboard-slot — the slot wrapper
    // is added by the render loop in the JSX. This way the slot ref stays
    // stable across swaps and only the inner content changes, so split.js
    // doesn't have to tear down and re-init on every panel swap.
    const renderChartContent = () => (
        <div className="chart-section-large">
            <div className="section-header collapsible-header">
                <div className="section-header-left">
<button
                        onClick={onBack}
                        className="collapse-btn"
                        title="Back to Import"
                        style={{ marginRight: '0.5rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                    >
                        <ArrowLeft size={18} />
                    </button>
                    <h3>Sensor Readings</h3>
                    {chartType === 'line' && (
                        <span className="section-badge">{samplingMethod.toUpperCase()} (1h)</span>
                    )}
                    <span className="section-badge">
                        {chartType === 'line'
                            ? (view && view.timestamps.length < view.total_rows
                                ? `${view.timestamps.length.toLocaleString()} / ${view.total_rows.toLocaleString()} pts (downsampled)`
                                : `${(view?.total_rows ?? 0).toLocaleString()} Points`)
                            : scatterReady
                                ? (scatterSample.total > scatterSample.sampled
                                    ? `${scatterSample.sampled.toLocaleString()} / ${scatterSample.total.toLocaleString()} pts (sampled)`
                                    : `${scatterSample.sampled.toLocaleString()} Points`)
                                : `${scatterChartData.length.toLocaleString()} Points`}
                    </span>
                    {(loading || (scatterActive && scatterSample.loading)) && (
                        <span className="section-badge section-badge-loading">Loading...</span>
                    )}
                </div>
                <div className="section-header-actions">
                    <div className="chart-type-group">
                        <button className={`chart-type-btn ${chartType === 'line' ? 'active' : ''}`} onClick={() => setChartType('line')}>Line</button>
                        <button
                            className={`chart-type-btn ${chartType === 'scatter' ? 'active' : ''}`}
                            onClick={() => setChartType('scatter')}
                            disabled={!canScatter}
                            title={canScatter ? undefined : 'Select at least 2 sensors'}
                        >Scatter</button>
                        <button
                            className={`chart-type-btn ${chartType === 'pair' ? 'active' : ''}`}
                            onClick={() => setChartType('pair')}
                            disabled={!canScatter}
                            title={canScatter ? undefined : 'Select at least 2 sensors'}
                        >Pair Plot</button>
                    </div>
                    <button className="collapse-btn" onClick={() => togglePanel('chart')} title="Hide panel">
                        <EyeOff size={14} />
                    </button>
                </div>
            </div>
            <div className="chart-wrapper" style={{ opacity: (loading || (scatterActive && scatterSample.loading)) ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                {chartType === 'line' ? (
                    // Bounded columnar feed from Rust — the chart never sees
                    // (or allocates) more than LINE_MAX_POINTS positions.
                    <Chart
                        data={EMPTY_RECORDS}
                        columnar={lineColumnar}
                        sensors={displayHeaders}
                        headers={displayHeaders}
                        chartType="line"
                    />
                ) : (
                    // Scatter / pair plot render the bounded Rust sample so
                    // huge datasets can't blank the WebGL canvas.
                    <Chart
                        data={scatterChartData}
                        sensors={scatterChartHeaders}
                        headers={scatterChartHeaders}
                        chartType={chartType}
                    />
                )}
            </div>
            <div className="chart-bottom-tab">
                <div className="chart-tab-content">
                    <div className="time-range-tab-group">
                        <label>TIME RANGE</label>
                        <div className="time-range-inputs">
                            <div className="date-input-wrapper">
                                <Calendar size={14} />
                                <input
                                    type="datetime-local"
                                    value={displayTimestampStart}
                                    onChange={(e) => handleFiltersChange({ ...filters, timestampStart: e.target.value })}
                                    placeholder="Start Date"
                                />
                            </div>
                            <span className="separator">-</span>
                            <div className="date-input-wrapper">
                                <Calendar size={14} />
                                <input
                                    type="datetime-local"
                                    value={displayTimestampEnd}
                                    onChange={(e) => handleFiltersChange({ ...filters, timestampEnd: e.target.value })}
                                    placeholder="End Date"
                                />
                            </div>
                        </div>
                    </div>
                    <div className="time-range-tab-group">
                        <label>SAMPLING (1 HR)</label>
                        <div className="date-input-wrapper">
                            <select
                                value={samplingMethod}
                                onChange={(e) => setSamplingMethod(e.target.value as 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last')}
                                style={{
                                    background: 'var(--input-bg)',
                                    border: 'none',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.8rem',
                                    outline: 'none',
                                    cursor: 'pointer',
                                    padding: 0
                                }}
                            >
                                <option value="raw" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Raw</option>
                                <option value="avg" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Avg</option>
                                <option value="max" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Max</option>
                                <option value="min" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Min</option>
                                <option value="first" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>First</option>
                                <option value="last" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Last</option>
                            </select>
                        </div>
                    </div>
                    {dataRange && filters.timestampStart && (
                        <button
                            className="reset-range-btn"
                            onClick={() => {
                                handleFiltersChange({
                                    ...filters,
                                    timestampStart: '',
                                    timestampEnd: ''
                                });
                            }}
                        >
                            Reset
                        </button>
                    )}
                </div>
            </div>
        </div>
    );

    const exportDisabled = !dataFilter || tableTotalRows === 0 || displayHeaders.length === 0;

    const renderDataContent = () => (
        <div className="widget-section data-widget">
            <div className="section-header collapsible-header">
                <div className="section-header-left">
<h3>Data Insight</h3>
                    <span className="section-badge">{tableTotalRows.toLocaleString()} Rows</span>
                </div>
                <div className="section-header-actions">
                    <button
                        className="export-btn-header"
                        onClick={async () => {
                            if (exportDisabled || !dataFilter) return;
                            try {
                                const filePath = await save({
                                    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
                                    defaultPath: `sensor_data_${new Date().toISOString().slice(0, 10)}.csv`,
                                });
                                if (!filePath) return;
                                // Rust streams the full post-op/post-aggregation
                                // row set straight to disk — the rows never
                                // enter the WebView (the old exporter built the
                                // whole CSV as one JS string and froze/OOMed on
                                // multi-million-row datasets).
                                await invoke<number>('export_chart_csv', {
                                    filter: {
                                        ...dataFilter,
                                        // Export what the table shows: visible
                                        // columns (multi-op uses all selected
                                        // sensors to compute its Result column).
                                        sensors: isMultiOp ? dataFilter.sensors : displayHeaders,
                                    },
                                    sampling: samplingMethod,
                                    operation: operationConfig,
                                    path: filePath,
                                });
                            } catch (err) {
                                console.error('Export failed:', err);
                            }
                        }}
                        title="Export to CSV"
                        disabled={exportDisabled}
                    >
                        <Download size={14} />
                        Export dataset
                    </button>
                    <button
                        className="collapse-btn"
                        onClick={() => togglePanel('data')}
                        title="Hide panel"
                    >
                        <EyeOff size={14} />
                    </button>
                </div>
            </div>
            <div className="widget-content">
                <DataTable
                    headers={displayHeaders}
                    rows={tableRows}
                    totalRows={tableTotalRows}
                    page={tablePageIndex}
                    pageSize={TABLE_PAGE_SIZE}
                    onPageChange={setTablePageIndex}
                />
            </div>
        </div>
    );

    const renderSensorsContent = () => (
        <div className="widget-section">
            <div className="section-header collapsible-header">
                <div className="section-header-left">
<h3>Recent Sensor Data</h3>
                    <span className="section-badge">{sensorHeaders.length} Sensors</span>
                </div>
                <button
                    className="collapse-btn"
                    onClick={() => togglePanel('sensors')}
                    title="Hide panel"
                >
                    <EyeOff size={14} />
                </button>
            </div>
            <div className="widget-content">
                <SensorSelection
                    sensors={sensorHeaders}
                    selectedSensors={selectedSensors}
                    onSensorChange={setSelectedSensors}
                    sensorMetadata={sensorMetadata}
                />
            </div>
            <div className="widget-footer">
                <button
                    className="add-sensor-btn"
                    onClick={async () => {
                        const webview = new WebviewWindow('add-sensor', {
                            url: '/?window=add-sensor',
                            title: 'Add Special Sensor',
                            width: 800,
                            height: 700,
                            center: true,
                            alwaysOnTop: false,
                            decorations: false
                        });
                        await webview.once('tauri://created', function () { });
                        await webview.once('tauri://error', function (e) { console.error(e); });
                    }}
                >
                    <Plus size={16} />
                    Add Special Sensor
                </button>
            </div>
        </div>
    );

    const renderFilterContent = () => (
        <div className="widget-section filter-widget">
            <div className="section-header collapsible-header">
                <div className="section-header-left">
<h3>Filter & Controls</h3>
                </div>
                <button
                    className="collapse-btn"
                    onClick={() => togglePanel('filter')}
                    title="Hide panel"
                >
                    <EyeOff size={14} />
                </button>
            </div>
            <div className="widget-content filter-content">
                <FilterPanel
                    selectedSensors={selectedSensors}
                    filters={filters}
                    onFiltersChange={handleFiltersChange}
                />
            </div>
        </div>
    );

    const renderPanel = (panel: DashboardPanel) => {
        switch (panel) {
            case 'chart': return renderChartContent();
            case 'data': return renderDataContent();
            case 'sensors': return renderSensorsContent();
            case 'filter': return renderFilterContent();
        }
    };

    // Renders a single slot wrapper IF its current panel isn't collapsed.
    // Returns null when collapsed so the surviving sibling slot (with its
    // .dashboard-slot flex:1) takes the full column.
    const renderSlot = (slot: DashboardSlot) => {
        if (collapsedPanels.has(SLOT_LAYOUT[slot])) return null;
        return (
            <div
                key={slot}
                ref={slotRefs[slot]}
                className="dashboard-slot"
            >
                {renderPanel(SLOT_LAYOUT[slot])}
            </div>
        );
    };

    return (
        <div className="dashboard-container">
            {/* Collapsed Tabs Sidebar */}
            {collapsedPanels.size > 0 && (
                <div className="collapsed-tabs-sidebar">
                    {Array.from(collapsedPanels).map(panelId => {
                        const panel = PANELS[panelId];
                        const IconComponent = panel.icon;
                        return (
                            <button
                                key={panelId}
                                className="collapsed-tab"
                                onClick={() => expandPanel(panelId)}
                                title={`Show ${panel.label}`}
                            >
                                <IconComponent size={18} />
                                <span className="collapsed-tab-label">{panel.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}



            <div className={`dashboard-grid-2x2 ${allLeftCollapsed ? 'left-fully-collapsed' : ''} ${allRightCollapsed ? 'right-fully-collapsed' : ''}`}>
                {/* Left column — slots LT (chart) and LB (data table) per
                    SLOT_LAYOUT. Slot wrappers exist so split.js has stable
                    refs to manage vertical resize. */}
                <div className="left-column" ref={leftColumnRef}>
                    {LEFT_SLOTS.map(slot => renderSlot(slot))}
                </div>

                <div className="right-column" ref={rightColumnRef}>
                    {/* Right column's two slots (RT/RB) per SLOT_LAYOUT live in this
                        wrapper. Save & Continue lives OUTSIDE so resizing the
                        panels never pushes it off-screen. */}
                    <div className="right-column-splits">
                        {RIGHT_SLOTS.map(slot => renderSlot(slot))}
                    </div>
                    {/* end .right-column-splits */}

                    {/* Save & Continue Section */}
                    <div className="save-continue-section">
                        <button
                            className="save-continue-btn"
                            onClick={async () => {
                                try {
                                    if (!initialState) return;
                                    // Persist the dashboard snapshot + flip lastRoute BEFORE spawning the window,
                                    // so FG can hydrate from disk and the next Recent Workspace click
                                    // lands the user back in FG (or onward to PM via cascade).
                                    const snapshot = {
                                        selectedSensors,
                                        visibleSensors,
                                        operationConfig,
                                        filters,
                                        samplingMethod,
                                    };
                                    await saveWorkspaceData(buildWorkspaceState({
                                        lastRoute: 'failure-group',
                                        dashboardSnapshot: snapshot,
                                    }));

                                    // Idempotency: if FG already exists (e.g. user double-clicked Save & Continue),
                                    // just focus it and exit — don't spawn a duplicate.
                                    const existingFG = await WebviewWindow.getByLabel('failure-group');
                                    if (existingFG) {
                                        try { await existingFG.setFocus(); } catch { /* ignore */ }
                                        try { await getCurrentWindow().destroy(); } catch { /* ignore */ }
                                        return;
                                    }
                                    const screenW = window.screen.width;
                                    const screenH = window.screen.height;
                                    const isMac = /mac/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent);
                                    // ──────────────────────────────────────────────
                                    // Register the `request-failure-group-data`
                                    // listener BEFORE spawning the FG webview —
                                    // otherwise we race the FG window's mount
                                    // emit and the request can land before we're
                                    // listening. When that happened, the handshake
                                    // never completed and `getCurrentWindow().destroy()`
                                    // never ran — so the dashboard window
                                    // appeared to "not close" after Save & Continue.
                                    // ──────────────────────────────────────────────
                                    const unlisten = await listen('request-failure-group-data', async () => {
                                        await emit('failure-group-data', {
                                            workspaceId: initialState.id,
                                            sensorHeaders,
                                            sensorMetadata,
                                            metadata,
                                            dashboardSnapshot: snapshot,
                                            // Save & Continue always lands in FG.
                                            // Explicit so FG won't accidentally cascade
                                            // to PM (the cascade only fires when
                                            // `targetRoute === 'predictive-model'`).
                                            targetRoute: 'failure-group',
                                        });
                                        unlisten();
                                        try { await getCurrentWindow().destroy(); } catch { /* ignore */ }
                                    });
                                    const webview = new WebviewWindow('failure-group', {
                                        url: '/?window=failure-group',
                                        title: 'Predictive Mode - Failure Group Creation',
                                        width: Math.round(screenW * 0.8),
                                        height: Math.round(screenH * 0.8),
                                        center: true,
                                        decorations: isMac,
                                    });
                                    // Hide the dashboard window as soon as FG is created (~few hundred ms)
                                    // rather than waiting for the full handshake (~1 s). Without this,
                                    // the user briefly sees Dashboard sitting under a loading FG.
                                    // The destroy in the handshake listener above still runs — hide()
                                    // is just a visual quick-cut.
                                    webview.once('tauri://created', async () => {
                                        try { await getCurrentWindow().hide(); } catch { /* ignore */ }
                                    });
                                    webview.once('tauri://error', (e) => {
                                        console.error('Failed to create failure group window:', e);
                                    });
                                } catch (err) {
                                    console.error('Error opening failure group window:', err);
                                }
                            }}
                        >
                            Save & Continue
                            <ArrowRight size={16} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
});

export default Dashboard;
