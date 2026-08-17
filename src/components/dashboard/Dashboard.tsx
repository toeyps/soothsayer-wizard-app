import { useState, useMemo, useEffect, useDeferredValue, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { listen, emit, UnlistenFn } from "@tauri-apps/api/event";
import Split from 'split.js';
import { saveWorkspaceData, updateWorkspaceData, loadWorkspaceData } from '../../workspaceManager';
import {
    CsvMetadata, SensorMetadata, CsvRecord, SensorOperationConfig,
    WorkspaceState, DashboardLayoutSizes, DashboardSlot, DashboardPanel, DashboardSlotMap,
    FailureGroup, FailureSensorRow, AlarmLevel, ScatterAxisPins, TimeHighlight, HighlightLineDisplay, LineTaggedPoint,
} from '../../types';
import type { DashboardDataFilter } from '../../types/commands';
// `DashboardSlotMap` is no longer persisted in WorkspaceState (drag-and-drop
// swap was removed) but we still use the type internally to describe the
// constant slot→panel mapping below.

import { Chart, defaultSensorColor, LINE_CHART_COLORS, MAX_PAIR_PLOT_SENSORS, RANGE_PALETTE, type ChartMarkLine } from '../charts';
import { rgbaToHex } from '../charts/pairPlotColors';
import { ALARM_LEVELS, alarmLevelColor } from '../../utils/alarmLevels';
import FilterPanel, { FilterState } from './FilterPanel';
import SensorSelection from './SensorSelection';
import FailureGroupsPanel from './FailureGroupsPanel';
import HighlightsPanel from './HighlightsPanel';
import ColorPlatePicker from './ColorPlatePicker';
import { useScatterSample, ScatterSampleFilter } from '../../hooks/useScatterSample';
import { reportError } from '../../errorReporter';
import { useChartData } from '../../hooks/useChartData';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { Plus, EyeOff, BarChart3, Radio, Calendar, ArrowLeft, Check, Trash2, Pipette, LineChart as LineChartIcon, X } from 'lucide-react';

// Panel configuration
const PANELS = {
    chart: { id: 'chart', label: 'Chart', icon: BarChart3 },
    sensors: { id: 'sensors', label: 'Sensors', icon: Radio },
    data: { id: 'data', label: 'Control Chart', icon: LineChartIcon }
} as const;

// Mirrors `getGroupColor`/`GROUP_PALETTE` in FailureGroupCreation.tsx exactly
// (duplicated, not imported, since the two windows don't share a components
// module) so a group assigned from either window renders the same color.
const FG_GROUP_PALETTE = ['amber', 'violet', 'green', 'blue'] as const;
const getFgGroupColor = (no: number): string =>
    no === 0 ? 'slate' : FG_GROUP_PALETTE[(no - 1) % FG_GROUP_PALETTE.length];

type PanelId = keyof typeof PANELS;

// Default split ratios used the first time a workspace is opened (no saved
// layoutSizes yet). 66.67/33.33 mirrors the original CSS Grid `2fr 1fr`.
const DEFAULT_LAYOUT_SIZES: DashboardLayoutSizes = {
    columns: [66.67, 33.33],
    leftRows: [60, 40],
};

// Fixed panel-to-slot layout. Was previously a stateful `slotMap` that the
// user could rearrange via drag-and-drop, but the swap UI was removed so
// this is now just a constant. Mirrors the original Dashboard layout:
// chart at top-left, the data table just under it, sensors filling the
// right column. Filter lives as a tab inside the data panel, not its own slot.
const SLOT_LAYOUT: DashboardSlotMap = {
    'left-top': 'chart',
    'left-bottom': 'data',
    'right-top': 'sensors',
};

// Static list of all slots in render order — used to iterate when computing
// drag-target visibility and for building the JSX of the two columns.
const LEFT_SLOTS: DashboardSlot[] = ['left-top', 'left-bottom'];
const RIGHT_SLOTS: DashboardSlot[] = ['right-top'];

// Point budget for the line chart. The Rust `get_chart_data` command
// min/max-decimates the filtered rows down to at most this many x-positions,
// so the IPC payload, JS heap, and ECharts buffers stay bounded no matter
// how many rows the dataset holds. ~4k points ≈ 2 output points per pixel
// on a typical panel width — visually indistinguishable from raw.
const LINE_MAX_POINTS = 4000;
// Same debounce window as useChartData/useScatterSample/useTablePage's own
// backend-query debounce -- applied here to the autosave-to-disk write
// instead. Without it, every tracked state change (including e.g. each
// keystroke in a Filter value box, which has no debounce of its own)
// triggered an immediate JSON.stringify + writeTextFile to $APPDATA.
const AUTOSAVE_DEBOUNCE_MS = 250;

// Alarm-level constants/helpers live in ../../utils/alarmLevels — shared
// with SensorSelection.tsx, which is where the setpoint checkboxes actually
// render (see the 2026-08-05 handover entry for why they moved there).
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
    renameWorkspace: (newName: string) => void;
}

const Dashboard = forwardRef<DashboardRef, DashboardProps>(({ metadata, sensorMetadata: sensorMetadataProp, onBack, initialState }, ref) => {
    const [localName, setLocalName] = useState(initialState?.name || "");

    const [sensorHeaders, setSensorHeaders] = useState<string[]>(() =>
        metadata.headers.filter(h => {
            const lower = h.trim().toLowerCase();
            return lower !== 'timestamp' && lower !== 'time';
        })
    );

    // Metadata for sensors created at runtime via "Add Special Sensor" --
    // the mapping-CSV-derived `sensorMetadataProp` never changes after
    // initial load, so calculated sensors' component assignments live here
    // instead, seeded from the persisted workspace and merged below into the
    // `sensorMetadata` every child actually reads.
    const [extraSensorMetadata, setExtraSensorMetadata] = useState<SensorMetadata[]>(
        initialState?.extraSensorMetadata ?? []
    );
    const sensorMetadata = useMemo(() => {
        if (extraSensorMetadata.length === 0) return sensorMetadataProp;
        const known = new Set((sensorMetadataProp ?? []).map(m => m.tag.toLowerCase()));
        const extras = extraSensorMetadata.filter(m => !known.has(m.tag.toLowerCase()));
        if (extras.length === 0) return sensorMetadataProp;
        return [...(sensorMetadataProp ?? []), ...extras];
    }, [sensorMetadataProp, extraSensorMetadata]);

    const [selectedSensors, setSelectedSensors] = useState<string[]>(initialState?.selectedSensors || []);
    const [visibleSensors, setVisibleSensors] = useState<string[]>(initialState?.visibleSensors || []);
    const [operationConfig, setOperationConfig] = useState<SensorOperationConfig | null>(initialState?.operationConfig || null);

    // "Save As" (duplicate workspace under a new name) was removed entirely
    // per user request — button, File menu items, and this window's own
    // request-save-as-data/save-as-submit handshake are all gone. Only
    // plain in-place rename remains (below), which never spawned a window
    // or touched workspace IDs.
    useImperativeHandle(ref, () => ({
        renameWorkspace: (newName: string) => {
            setLocalName(newName);
        }
    }));

    const deferredSensors = useDeferredValue(selectedSensors);

    // Keep visibleSensors in lockstep with selectedSensors WITHOUT clobbering
    // hide/show state: newly-selected sensors default to visible, sensors
    // that get deselected drop out, but a sensor the user hid via the
    // "Selected Sensor" tab (see toggleSensorVisibility) stays hidden across
    // unrelated selection changes instead of being forced visible again.
    useEffect(() => {
        setVisibleSensors(prev => {
            const stillSelected = prev.filter(s => selectedSensors.includes(s));
            const newlySelected = selectedSensors.filter(s => !prev.includes(s));
            return [...stillSelected, ...newlySelected];
        });
    }, [selectedSensors]);

    // Toggle a plotted sensor's visibility on the chart without deselecting
    // it (i.e. without removing it from selectedSensors / the sensor list's
    // checkboxes).
    const toggleSensorVisibility = useCallback((sensor: string) => {
        setVisibleSensors(prev =>
            prev.includes(sensor) ? prev.filter(s => s !== sensor) : [...prev, sensor]
        );
    }, []);

    // Fully removes a sensor from the plot — same effect as unchecking it in
    // the Sensor panel. visibleSensors drops it too via the sync effect above.
    const removeSensor = useCallback((sensor: string) => {
        setSelectedSensors(prev => prev.filter(s => s !== sensor));
    }, []);

    // Bulk equivalent of removeSensor — drops every plotted sensor at once
    // (the "Clear all" action in the Selected Sensor tab header).
    const clearAllSensors = useCallback(() => {
        setSelectedSensors([]);
    }, []);

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getSensorMeta = useCallback(
        (sensor: string) => sensorMetaMap.get(normalizeSensorTag(sensor)) ?? null,
        [sensorMetaMap]
    );

    // ── Failure group assignment (Sensor tab quick-assign + Failure Groups
    //    tab manage view) ────────────────────────────────────────────────
    // Owns WorkspaceState.failureGroupState in full — the standalone
    // FailureGroupCreation.tsx window that used to own this slice has been
    // deleted; everything failure-group-related lives here now, split
    // across two views in the same Sensor panel: SensorSelection.tsx's
    // per-sensor quick-assign (FolderPlus icon) and FailureGroupsPanel.tsx's
    // group-centric manage tab. Persisted via `updateWorkspaceData`
    // (read-modify-write) rather than Dashboard's own full-overwrite
    // autosave so a burst of quick edits can't race each other.
    //
    // A sensor can belong to multiple groups at once, so membership is
    // "does a row exist for (tag, groupNo)" rather than one row per tag.
    // toggleSensorGroup below adds/removes the specific row for a
    // (tag, groupNo) pair without touching the sensor's rows in any other
    // group; FailureGroupsPanel's addBlankRowToGroup/updateFgRow (further
    // down) cover the group-first editing path.
    const [fgGroups, setFgGroups] = useState<FailureGroup[]>(
        initialState?.failureGroupState?.groups ?? [{ no: 0, name: 'Not in Group', isCollapsed: false }]
    );
    const [fgRows, setFgRows] = useState<FailureSensorRow[]>(
        initialState?.failureGroupState?.rows ?? []
    );

    const persistFailureGroupState = useCallback((groups: FailureGroup[], rows: FailureSensorRow[]) => {
        if (!initialState) return;
        updateWorkspaceData(initialState.id, prev => ({
            ...prev,
            failureGroupState: { groups, rows },
        })).catch(e => console.error('Failed to persist failure-group assignment from Dashboard:', e));
    }, [initialState]);

    const toggleSensorGroup = useCallback((tag: string, groupNo: number) => {
        const isMember = fgRows.some(r => r.mappedSensorTag.toLowerCase() === tag.toLowerCase() && r.groupNo === groupNo);
        const nextRows = isMember
            ? fgRows.filter(r => !(r.mappedSensorTag.toLowerCase() === tag.toLowerCase() && r.groupNo === groupNo))
            : [...fgRows, {
                id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                groupNo,
                conceptSensor: '',
                mappedSensorTag: tag,
                mappedSensorName: getSensorMeta(tag)?.description ?? tag,
                modelType: '',
                modelNotes: '',
                additionalNotes: '',
                status: false,
            }];
        setFgRows(nextRows);
        persistFailureGroupState(fgGroups, nextRows);
    }, [fgRows, fgGroups, getSensorMeta, persistFailureGroupState]);

    const createGroupForSensor = useCallback((tag: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const maxNo = Math.max(...fgGroups.map(g => g.no), 0);
        const newGroups = [...fgGroups, { no: maxNo + 1, name: trimmed, isCollapsed: false }];
        const newRows = [...fgRows, {
            id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            groupNo: maxNo + 1,
            conceptSensor: '',
            mappedSensorTag: tag,
            mappedSensorName: getSensorMeta(tag)?.description ?? tag,
            modelType: '',
            modelNotes: '',
            additionalNotes: '',
            status: false,
        }];
        setFgGroups(newGroups);
        setFgRows(newRows);
        persistFailureGroupState(newGroups, newRows);
    }, [fgGroups, fgRows, getSensorMeta, persistFailureGroupState]);

    // Renaming/deleting a group is global (not tied to one sensor's row), so
    // these operate on fgGroups/fgRows directly rather than through
    // toggleSensorGroup. Deleting removes every row across every sensor that
    // belonged to that group — mirrors FailureGroupCreation.tsx's own
    // `removeGroup`, which also has no confirmation step.
    const renameGroup = useCallback((groupNo: number, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const newGroups = fgGroups.map(g => g.no === groupNo ? { ...g, name: trimmed } : g);
        setFgGroups(newGroups);
        persistFailureGroupState(newGroups, fgRows);
    }, [fgGroups, fgRows, persistFailureGroupState]);

    const deleteGroup = useCallback((groupNo: number) => {
        if (groupNo === 0) return;
        const newGroups = fgGroups.filter(g => g.no !== groupNo);
        const newRows = fgRows.filter(r => r.groupNo !== groupNo);
        setFgGroups(newGroups);
        setFgRows(newRows);
        persistFailureGroupState(newGroups, newRows);
    }, [fgGroups, fgRows, persistFailureGroupState]);

    // ── Failure Groups tab (group-centric manage view) ──────────────────
    // Everything below supports FailureGroupsPanel.tsx, the Dashboard-native
    // replacement for the standalone FailureGroupCreation.tsx window (deleted
    // — see PROJECT_HANDOVER.md). Reuses fgGroups/fgRows/
    // persistFailureGroupState above; toggleSensorGroup/createGroupForSensor
    // (also above) remain the entry points used by SensorSelection.tsx's
    // per-sensor quick-assign, unchanged.
    const [activeSensorTab, setActiveSensorTab] = useState<'sensor' | 'failure-groups'>(
        initialState?.lastRoute === 'failure-group' ? 'failure-groups' : 'sensor'
    );

    const toggleGroupCollapse = useCallback((groupNo: number) => {
        setFgGroups(prev => prev.map(g => g.no === groupNo ? { ...g, isCollapsed: !g.isCollapsed } : g));
        // Collapse state is cosmetic (not worth a disk write on its own), but
        // persisting keeps it consistent with everything else in this slice —
        // cheap given updateWorkspaceData's read-modify-write already runs on
        // every other mutation here.
        persistFailureGroupState(
            fgGroups.map(g => g.no === groupNo ? { ...g, isCollapsed: !g.isCollapsed } : g),
            fgRows,
        );
    }, [fgGroups, fgRows, persistFailureGroupState]);

    const createEmptyGroup = useCallback((name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const maxNo = Math.max(...fgGroups.map(g => g.no), 0);
        const newGroups = [...fgGroups, { no: maxNo + 1, name: trimmed, isCollapsed: false }];
        setFgGroups(newGroups);
        persistFailureGroupState(newGroups, fgRows);
    }, [fgGroups, fgRows, persistFailureGroupState]);

    // Creates a row with no sensor tag yet — the panel immediately expands
    // it into a tag picker. Id is computed and returned synchronously (not
    // read back from state) so the caller can expand it in the same tick.
    const addBlankRowToGroup = useCallback((groupNo: number): string => {
        const id = `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const newRows = [...fgRows, {
            id, groupNo, conceptSensor: '', mappedSensorTag: '', mappedSensorName: '',
            modelType: '', modelNotes: '', additionalNotes: '', status: false,
        }];
        setFgRows(newRows);
        persistFailureGroupState(fgGroups, newRows);
        return id;
    }, [fgGroups, fgRows, persistFailureGroupState]);

    const updateFgRow = useCallback((
        rowId: string,
        field: 'mappedSensorTag' | 'conceptSensor' | 'modelType' | 'modelNotes' | 'status',
        value: string | boolean,
    ) => {
        const newRows = fgRows.map(r => {
            if (r.id !== rowId) return r;
            const updated = { ...r, [field]: value };
            if (field === 'mappedSensorTag') updated.mappedSensorName = getSensorMeta(value as string)?.description ?? (value as string);
            return updated;
        });
        setFgRows(newRows);
        persistFailureGroupState(fgGroups, newRows);
    }, [fgGroups, fgRows, getSensorMeta, persistFailureGroupState]);

    const removeFgRowById = useCallback((rowId: string) => {
        const newRows = fgRows.filter(r => r.id !== rowId);
        setFgRows(newRows);
        persistFailureGroupState(fgGroups, newRows);
    }, [fgGroups, fgRows, persistFailureGroupState]);

    // Per-sensor line-color override and pinned Y-axis bounds, set from the
    // "Selected Sensor" tab.
    const [sensorColors, setSensorColors] = useState<Record<string, string>>(initialState?.sensorColors ?? {});
    // min/max are independently optional — pinning just one side (e.g. a
    // floor with no ceiling) is valid; the unset side keeps auto-fitting.
    const [sensorAxisRange, setSensorAxisRange] = useState<Record<string, { min?: number; max?: number }>>(
        initialState?.sensorAxisRange ?? {}
    );

    // Scatter chart's X/Y sensor pair — owned here (not local to
    // ScatterChart) because Chart.tsx unmounts ScatterChart entirely
    // whenever chartType leaves 'scatter'; without lifting this up, the
    // pair reset to the first two sensors every time the user switched
    // chart type and back.
    const [scatterAxes, setScatterAxes] = useState<{ x: string; y: string } | null>(initialState?.scatterAxes ?? null);
    const handleScatterAxesChange = useCallback((x: string, y: string) => {
        setScatterAxes(prev => (prev?.x === x && prev?.y === y) ? prev : { x, y });
    }, []);

    // Scatter chart's pinned axis SCALE (ruler-icon editor) — a different
    // thing from `scatterAxes` above (which just tracks which sensor is on
    // which axis). Same "lift out of ScatterChart" reasoning: it unmounts
    // on every chart-type switch, so anything left as local state there is
    // lost the moment the user looks away and back.
    const [scatterAxisPins, setScatterAxisPins] = useState<ScatterAxisPins>(initialState?.scatterAxisPins ?? {});
    const handleScatterAxisPinsChange = useCallback((pins: ScatterAxisPins) => {
        setScatterAxisPins(pins);
    }, []);

    // Line chart's tagged points ("Tag Point" feature) — same "lift out of
    // the chart component" reasoning as scatterAxisPins above: LineChart
    // unmounts on every chart-type switch, so its own local state would be
    // lost the moment the user looked away and back. Scatter's own tagged
    // points are deliberately NOT lifted here — see LineTaggedPoint's
    // docstring in types.ts for why (no stable point identity across a
    // resampled query).
    const [lineTaggedPoints, setLineTaggedPoints] = useState<LineTaggedPoint[]>(initialState?.lineTaggedPoints ?? []);
    const handleLineTaggedPointsChange = useCallback((points: LineTaggedPoint[]) => {
        setLineTaggedPoints(points);
    }, []);

    // Time-window highlights ("Highlights" tab) — global across every chart
    // type except Pair Plot. See TimeHighlight in types.ts for why.
    const [timeHighlights, setTimeHighlights] = useState<TimeHighlight[]>(
        initialState?.timeHighlights ?? [],
    );

    const handleAddTimeHighlight = useCallback((start: string, end: string, label: string) => {
        setTimeHighlights(prev => [...prev, {
            id: `${Date.now()}-${prev.length}`,
            start, end,
            label: label || `Highlight ${prev.length + 1}`,
            color: rgbaToHex(RANGE_PALETTE[prev.length % RANGE_PALETTE.length]),
            enabled: true,
        }]);
    }, []);

    const handleToggleTimeHighlight = useCallback((id: string) => {
        setTimeHighlights(prev => prev.map(h => h.id === id ? { ...h, enabled: !h.enabled } : h));
    }, []);

    const handleRemoveTimeHighlight = useCallback((id: string) => {
        setTimeHighlights(prev => prev.filter(h => h.id !== id));
    }, []);

    const handleRecolorTimeHighlight = useCallback((id: string, color: string) => {
        setTimeHighlights(prev => prev.map(h => h.id === id ? { ...h, color } : h));
    }, []);

    const handleRenameTimeHighlight = useCallback((id: string, label: string) => {
        setTimeHighlights(prev => prev.map(h => h.id === id ? { ...h, label } : h));
    }, []);

    // How highlights render on the Line chart — see HighlightLineDisplay.
    // Global (not per-highlight) and Line-only; Scatter/Pair Plot ignore it.
    const [highlightLineDisplay, setHighlightLineDisplay] = useState<HighlightLineDisplay>(
        initialState?.highlightLineDisplay ?? 'band',
    );

    // Quick relative time range (e.g. "last 2 D") — an alternative to
    // manually picking absolute start/end dates. Y/M use calendar-accurate
    // arithmetic (setFullYear/setMonth) since those units aren't a fixed
    // duration; W/D/H are plain millisecond math. Declared here (rather than
    // next to `applyRelativeRange` below, where it conceptually belongs)
    // because `buildWorkspaceState` — defined earlier in this file — reads
    // it, and TypeScript's block scoping doesn't allow forward references.
    const RANGE_UNITS = ['Y', 'M', 'W', 'D', 'H'] as const;
    type RangeUnit = typeof RANGE_UNITS[number];
    const [relativeAmount, setRelativeAmount] = useState(initialState?.relativeTimeRange?.amount ?? '1');
    const [relativeUnit, setRelativeUnit] = useState<RangeUnit>(initialState?.relativeTimeRange?.unit ?? 'D');
    // Whether the currently-shown Start/End dates were actually produced by
    // the last "Apply relative range" click — NOT just whether a unit is
    // selected in the picker. Without this, the unit buttons (and the
    // amount field) kept showing the last-applied preset as "active" even
    // after the user hand-edited Start/End directly, falsely implying the
    // dates on screen still equal that preset. Cleared on manual edit,
    // set on Apply. Deliberately not persisted — on workspace reload we
    // don't actually know whether the saved dates still match the saved
    // amount/unit, so defaulting to "not active" is the honest state.
    const [relativeRangeApplied, setRelativeRangeApplied] = useState(false);

    const setSensorColor = useCallback((sensor: string, color: string) => {
        setSensorColors(prev => ({ ...prev, [sensor]: color }));
    }, []);

    // Fills in a default for every selected sensor that doesn't have an
    // explicit override, keyed by position in `selectedSensors` (stable —
    // only appended/filtered, never reordered by hide/show) rather than
    // hashing the tag. Hashing let unrelated sensors collide onto the same
    // palette slot, or land on adjacent blue/indigo/violet entries that
    // read as "basically the same color" on a thin line trace — the report
    // that prompted this. Index-based assignment guarantees every
    // simultaneously-selected sensor (up to the 6-color palette) gets a
    // visually distinct color instead of leaving it to chance.
    const resolvedSensorColors = useMemo(() => {
        const map: Record<string, string> = {};
        selectedSensors.forEach((sensor, i) => {
            map[sensor] = sensorColors[sensor] ?? LINE_CHART_COLORS[i % LINE_CHART_COLORS.length];
        });
        return map;
    }, [selectedSensors, sensorColors]);

    const setSensorFixedRange = useCallback((sensor: string, min: number | undefined, max: number | undefined) => {
        setSensorAxisRange(prev => ({ ...prev, [sensor]: { min, max } }));
    }, []);

    const clearSensorFixedRange = useCallback((sensor: string) => {
        setSensorAxisRange(prev => {
            if (!(sensor in prev)) return prev;
            const next = { ...prev };
            delete next[sensor];
            return next;
        });
    }, []);

    // Themed color plate (see ColorPlatePicker) — replaces the browser/OS-
    // native <input type="color"> dialog, unreachable by CSS. Same
    // one-open-at-a-time toggle pattern as the axis editor below.
    const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
    const toggleColorPicker = useCallback((sensor: string) => {
        setColorPickerFor(prev => (prev === sensor ? null : sensor));
    }, []);

    // Inline "pin Y-axis scale" editor — one sensor's min/max fields open at
    // a time, directly under its row in the Selected Sensor tab.
    const [axisEditorFor, setAxisEditorFor] = useState<string | null>(null);
    const [axisDraftMin, setAxisDraftMin] = useState('');
    const [axisDraftMax, setAxisDraftMax] = useState('');

    const [axisEditorError, setAxisEditorError] = useState<string | null>(null);

    const openAxisEditor = useCallback((sensor: string) => {
        const existing = sensorAxisRange[sensor];
        setAxisDraftMin(existing?.min !== undefined ? String(existing.min) : '');
        setAxisDraftMax(existing?.max !== undefined ? String(existing.max) : '');
        setAxisEditorError(null);
        setAxisEditorFor(sensor);
    }, [sensorAxisRange]);

    const closeAxisEditor = useCallback(() => {
        setAxisEditorFor(null);
        setAxisEditorError(null);
    }, []);

    // The pin icon is the only way in — clicking it again while its own
    // editor is already open closes it, instead of a separate Cancel button.
    const toggleAxisEditor = useCallback((sensor: string) => {
        if (axisEditorFor === sensor) closeAxisEditor();
        else openAxisEditor(sensor);
    }, [axisEditorFor, closeAxisEditor, openAxisEditor]);

    // Validates before applying instead of silently closing on bad input —
    // a mistyped min/max used to just no-op with no sign anything was
    // rejected, leaving the user unsure whether their edit "took". Either
    // field may be left blank — pinning only a min (or only a max) is valid,
    // the blank side keeps auto-fitting to the data.
    const applyAxisEditor = useCallback(() => {
        if (!axisEditorFor) return;
        const minText = axisDraftMin.trim();
        const maxText = axisDraftMax.trim();
        const min = minText === '' ? undefined : parseFloat(minText);
        const max = maxText === '' ? undefined : parseFloat(maxText);
        if ((min !== undefined && isNaN(min)) || (max !== undefined && isNaN(max))) {
            setAxisEditorError('Enter a valid number');
            return;
        }
        if (min === undefined && max === undefined) {
            setAxisEditorError('Enter at least a min or a max');
            return;
        }
        if (min !== undefined && max !== undefined && min >= max) {
            setAxisEditorError('Min must be less than max');
            return;
        }
        setSensorFixedRange(axisEditorFor, min, max);
        closeAxisEditor();
    }, [axisEditorFor, axisDraftMin, axisDraftMax, setSensorFixedRange, closeAxisEditor]);

    // Which alarm setpoint lines are toggled on, per sensor tag — e.g.
    // `{ '11FQ1603.PV': ['H'] }`. Unlike sensorColors/sensorAxisRange above,
    // this DOES persist to WorkspaceState (see buildWorkspaceState below):
    // re-checking the same alarms every time a workspace reopens would be
    // exactly the kind of re-selection tedium the FG assignment feature
    // exists to avoid elsewhere in this file.
    const [alarmLinesEnabled, setAlarmLinesEnabled] = useState<Record<string, AlarmLevel[]>>(
        initialState?.alarmLinesEnabled ?? {}
    );

    const toggleAlarmLine = useCallback((tag: string, level: AlarmLevel) => {
        setAlarmLinesEnabled(prev => {
            const current = prev[tag] ?? [];
            const isOn = current.includes(level);
            const nextLevels = isOn ? current.filter(l => l !== level) : [...current, level];
            const next = { ...prev };
            if (nextLevels.length === 0) delete next[tag];
            else next[tag] = nextLevels;
            return next;
        });
    }, []);

    // Prune per-sensor color/axis-range/alarm-line overrides (and close the
    // inline axis/alarm editors) once a sensor is deselected — via the trash
    // button, unchecking it in the Sensor panel, or "Clear selection".
    // Without this, re-adding the same tag later silently resurrects a stale
    // color/pinned range/checked alarms with no indication anything carried
    // over from the earlier session.
    useEffect(() => {
        const selectedSet = new Set(selectedSensors);
        setSensorColors(prev => {
            const stale = Object.keys(prev).filter(s => !selectedSet.has(s));
            if (stale.length === 0) return prev;
            const next = { ...prev };
            for (const s of stale) delete next[s];
            return next;
        });
        setSensorAxisRange(prev => {
            const stale = Object.keys(prev).filter(s => !selectedSet.has(s));
            if (stale.length === 0) return prev;
            const next = { ...prev };
            for (const s of stale) delete next[s];
            return next;
        });
        setAlarmLinesEnabled(prev => {
            const stale = Object.keys(prev).filter(s => !selectedSet.has(s));
            if (stale.length === 0) return prev;
            const next = { ...prev };
            for (const s of stale) delete next[s];
            return next;
        });
        setAxisEditorFor(prev => (prev && !selectedSet.has(prev) ? null : prev));
    }, [selectedSensors]);

    // Collapsed panels state. Filters out ids that no longer exist in PANELS
    // (e.g. a workspace saved before Filter moved from its own panel into a
    // data-panel tab) so a stale entry can't crash the collapsed-tabs sidebar.
    const [collapsedPanels, setCollapsedPanels] = useState<Set<PanelId>>(
        new Set((initialState?.collapsedPanels ?? []).filter(
            (id): id is PanelId => id in PANELS
        ))
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
    const slotRefs: Record<DashboardSlot, React.RefObject<HTMLDivElement | null>> = {
        'left-top': slotLTRef,
        'left-bottom': slotLBRef,
        'right-top': slotRTRef,
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
    const allLeftCollapsed = ltCollapsed && lbCollapsed;
    // Right column is a single slot (Sensors) now that Filter moved into a
    // data-panel tab, so "all collapsed" just mirrors that one slot.
    const allRightCollapsed = rtCollapsed;

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

    // Right column is a single slot (Sensors) — no split.js instance needed
    // there anymore; it fills 100% of the column via CSS flex, same as any
    // lone surviving panel elsewhere in this layout.

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
            unlistenAdd = await listen<{ sensors: string[], operation: SensorOperationConfig | null, newMetadata?: SensorMetadata[] }>('add-sensor-selection', async (event) => {
                console.log("Dashboard received 'add-sensor-selection'", event.payload);

                let newSelectedSensors: string[] = [];
                let newOperationConfig: SensorOperationConfig | null = null;
                let newMetadata: SensorMetadata[] = [];

                if (Array.isArray(event.payload)) {
                    newSelectedSensors = event.payload;
                    newOperationConfig = null;
                } else {
                    newSelectedSensors = event.payload.sensors;
                    newOperationConfig = event.payload.operation;
                    newMetadata = event.payload.newMetadata ?? [];
                }

                // Update selection
                setSelectedSensors(newSelectedSensors);
                setOperationConfig(newOperationConfig);

                if (newMetadata.length > 0) {
                    setExtraSensorMetadata(prev => {
                        const byTag = new Map(prev.map(m => [m.tag.toLowerCase(), m]));
                        for (const m of newMetadata) byTag.set(m.tag.toLowerCase(), m);
                        return Array.from(byTag.values());
                    });
                }

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

    // ── Build Model — spawns the Predictive Model window directly ───────
    // Previously FailureGroupCreation.tsx's job (its `spawnPMHelper` +
    // `request-predictive-data` responder); reproduced here verbatim since
    // that window no longer exists. PM itself has no idea who spawned it —
    // it just broadcasts `request-predictive-data` on mount and consumes
    // whatever answers on `predictive-model-data` (see PredictiveModelBuild.tsx).
    const pendingModelDataRef = useRef<{ targetSensor: string; predictorSensors: string[] } | null>(null);
    const autoResumedPmRef = useRef(false);

    const buildDashboardSnapshot = useCallback(() => ({
        selectedSensors, visibleSensors, operationConfig, filters, samplingMethod,
    }), [selectedSensors, visibleSensors, operationConfig, filters, samplingMethod]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        (async () => {
            unlisten = await listen('request-predictive-data', async () => {
                if (!pendingModelDataRef.current || !initialState) return;
                await emit('predictive-model-data', {
                    workspaceId: initialState.id,
                    targetSensor: pendingModelDataRef.current.targetSensor,
                    predictorSensors: pendingModelDataRef.current.predictorSensors,
                    sensorHeaders,
                    sensorMetadata,
                    metadata,
                    dashboardSnapshot: buildDashboardSnapshot(),
                });
            });
        })();
        return () => { if (unlisten) unlisten(); };
    }, [initialState, sensorHeaders, sensorMetadata, metadata, buildDashboardSnapshot]);

    const spawnPredictiveModel = useCallback(async (target: string, predictors: string[]) => {
        if (!initialState) return;
        pendingModelDataRef.current = { targetSensor: target, predictorSensors: predictors };

        await updateWorkspaceData(initialState.id, prev => ({
            ...prev,
            lastRoute: 'predictive-model',
            predictiveModelState: {
                ...(prev.predictiveModelState ?? {
                    individualChecked: true,
                    rcMode: null,
                    scatterXSensor: '',
                    relModelName: '',
                    // Default λ corresponds to the "Standard" stiffness preset
                    // in PredictiveModelBuild — kept in sync with the
                    // STIFFNESS_OPTIONS set there (copied from
                    // FailureGroupCreation.tsx's own default, now deleted).
                    relStiffness: 100_000,
                    clusterModelName: '',
                    numClusters: 3,
                    criteriaSensor: '',
                    clusterRanges: [
                        { min: 0, max: 33 },
                        { min: 33, max: 66 },
                        { min: 66, max: 100 },
                    ],
                    filterTimeStart: '',
                    filterTimeEnd: '',
                    pmSensorFilters: [],
                }),
                targetSensor: target,
                predictorSensors: predictors,
            },
        }));

        try {
            // Idempotency: focus instead of respawning if PM is already open.
            const existingPM = await WebviewWindow.getByLabel('predictive-model');
            if (existingPM) {
                try { await existingPM.setFocus(); } catch { /* ignore */ }
                return;
            }
            const screenW = window.screen.width;
            const screenH = window.screen.height;
            const isMac = /mac/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent);
            const webview = new WebviewWindow('predictive-model', {
                url: '/?window=predictive-model',
                title: `Predictive Model — ${target}`,
                width: Math.round(screenW * 0.75),
                height: Math.round(screenH * 0.85),
                center: true,
                maximized: true,
                decorations: isMac,
            });
            webview.once('tauri://error', (e) => console.error('Failed to open predictive model window:', e));
            // Reset lastRoute so reopening this workspace from Recent lands
            // back on Dashboard's Failure Groups tab, not stuck pointing at
            // PM. Dual listeners (destroyed + the explicit close event)
            // mirror the robustness FailureGroupCreation.tsx used to
            // provide — PM emits both regardless of who spawned it.
            webview.once('tauri://destroyed', () => {
                updateWorkspaceData(initialState.id, prev => ({ ...prev, lastRoute: 'failure-group' })).catch(() => { /* ignore */ });
            });
            const unlistenClose = await listen('predictive-model-closed', () => {
                updateWorkspaceData(initialState.id, prev => ({ ...prev, lastRoute: 'failure-group' })).catch(() => { /* ignore */ });
                unlistenClose();
            });
        } catch (err) {
            console.error('Error opening predictive model window:', err);
        }
    }, [initialState]);

    const handleBuildModel = useCallback(async (row: FailureSensorRow) => {
        if (!row.mappedSensorTag || !initialState) return;
        // Preserve previously chosen predictors when reopening Build Model on
        // the same target — only reset when the target changes.
        const prevState = (await loadWorkspaceData(initialState.id))?.predictiveModelState;
        const sameTarget = prevState?.targetSensor === row.mappedSensorTag;
        const carriedPredictors = sameTarget ? (prevState?.predictorSensors ?? []) : [];
        await spawnPredictiveModel(row.mappedSensorTag, carriedPredictors);
    }, [initialState, spawnPredictiveModel]);

    // Recent-workspace resume: if this workspace's lastRoute is
    // 'predictive-model' (set the last time Build Model was clicked),
    // auto-reopen PM once on mount instead of leaving the user stranded on
    // Dashboard with no visible link to the model they were configuring.
    // DataUploadPage.tsx used to hand this off to FailureGroupCreation.tsx's
    // own cascade; now Dashboard does it directly since FG no longer exists.
    useEffect(() => {
        if (autoResumedPmRef.current) return;
        if (initialState?.lastRoute !== 'predictive-model') return;
        const target = initialState.predictiveModelState?.targetSensor;
        if (!target) return;
        autoResumedPmRef.current = true;
        spawnPredictiveModel(target, initialState.predictiveModelState?.predictorSensors ?? []);
        // Intentionally run once on mount only — initialState is a stable
        // prop for this window's lifetime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Scatter / pair plots are meaningless with fewer than two sensors, so
    // below that the two buttons are disabled — and if the selection drops
    // under two WHILE such a chart is active (unticking down to one), we
    // bounce back to the line chart instead of showing an empty canvas.
    // Also covers workspace restores that persisted a scatter view whose
    // sensor selection no longer qualifies.
    const canScatter = selectedSensors.length >= 2;
    // See MAX_PAIR_PLOT_SENSORS (ChartTypes.ts) for why Pair Plot specifically
    // needs its own, tighter cap than plain Scatter — WebGL context exhaustion.
    // Unlike the < 2 case below, exceeding this cap does NOT auto-bounce the
    // chart type: the selection UI blocks picking a 5th sensor while Pair
    // Plot is already active (see `maxSelectable` on SensorSelection), and
    // the Pair Plot tab itself blocks entry with an explanatory dialog
    // instead of switching charts out from under the user (handlePairPlotClick
    // below). PairPlotChart's own render guard is the last line of defense
    // for the one path that can still exceed it — a workspace restore that
    // persisted chartType:'pair' alongside a larger selection.
    useEffect(() => {
        if (!canScatter && chartType !== 'line') {
            setChartType('line');
        }
    }, [canScatter, chartType]);

    const handlePairPlotClick = useCallback(async () => {
        if (selectedSensors.length > MAX_PAIR_PLOT_SENSORS) {
            const text = `Pair Plot supports at most ${MAX_PAIR_PLOT_SENSORS} sensors — ${selectedSensors.length} are currently selected. Deselect some sensors first.`;
            try {
                await message(text, { title: 'Too many sensors', kind: 'warning' });
            } catch {
                alert(text);
            }
            return;
        }
        setChartType('pair');
    }, [selectedSensors.length]);


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

    const loading = viewLoading;

    const isMultiOp = operationConfig?.mode === 'multi' && !!operationConfig?.multiOp;

    // Headers actually shown (chart + table). In multi-op mode the backend
    // collapses everything into one "Result (op)" column; otherwise show
    // the visible subset of the resolved sensors.
    const displayHeaders = useMemo(() => {
        if (!view) return [];
        if (isMultiOp) return view.headers;
        return view.headers.filter(h => visibleSensors.includes(h));
    }, [view, isMultiOp, visibleSensors]);

    // Alarm setpoint lines for the currently-visible sensors. Skipped
    // entirely in multi-op mode — `displayHeaders` there is a single
    // synthesized "Result (op)" column, not a real sensor tag, so there's no
    // metadata to look an alarm value up against. Colored by SEVERITY
    // (`alarmLevelColor`: amber for L/H, red for LL/HH), not by the sensor's
    // own line color — an earlier version matched the sensor's color instead,
    // but that made a setpoint line blend into its own sensor's trace and
    // become hard to spot at a glance, which defeats the point of it being
    // a warning line at all.
    const markLines = useMemo<ChartMarkLine[]>(() => {
        if (isMultiOp) return [];
        const lines: ChartMarkLine[] = [];
        for (const sensor of displayHeaders) {
            const enabled = alarmLinesEnabled[sensor];
            if (!enabled || enabled.length === 0) continue;
            const meta = getSensorMeta(sensor);
            if (!meta) continue;
            for (const { level, metaKey } of ALARM_LEVELS) {
                if (!enabled.includes(level)) continue;
                const y = meta[metaKey];
                if (y === undefined) continue;
                lines.push({ sensor, y, label: level, lineStyle: 'dashed', color: alarmLevelColor(level) });
            }
        }
        return lines;
    }, [isMultiOp, displayHeaders, alarmLinesEnabled, getSensorMeta]);

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

    // Rows in the filtered (post-aggregation) population — the header badge
    // count and the export-disabled check both read this. Sourced from the
    // chart-data query itself (already running for the Line/Scatter view),
    // not a separate fetch — `get_chart_data`'s response was already
    // carrying this exact figure.
    const tableTotalRows = view?.total_rows ?? 0;

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
        // Carry the LATEST fgGroups/fgRows (kept current by toggleSensorGroup/
        // createGroupForSensor), not the stale failureGroupState captured in
        // `initialState` at mount — otherwise this full-overwrite autosave
        // would silently erase what was just written via their own
        // read-modify-write persistence.
        failureGroupState: { groups: fgGroups, rows: fgRows },
        alarmLinesEnabled,
        scatterAxes: scatterAxes ?? undefined,
        extraSensorMetadata,
        sensorColors,
        sensorAxisRange,
        scatterAxisPins,
        timeHighlights,
        highlightLineDisplay,
        lineTaggedPoints,
        relativeTimeRange: { amount: relativeAmount, unit: relativeUnit },
        ...overrides,
    }), [
        initialState, localName, selectedSensors, visibleSensors, operationConfig, filters, chartType,
        samplingMethod, collapsedPanels, layoutSizes, fgGroups, fgRows, alarmLinesEnabled, scatterAxes,
        extraSensorMetadata, sensorColors, sensorAxisRange, scatterAxisPins, timeHighlights, highlightLineDisplay,
        lineTaggedPoints, relativeAmount, relativeUnit,
    ]);

    // Auto-save state changes — debounced (see AUTOSAVE_DEBOUNCE_MS) so a
    // burst of rapid edits (typing, dragging a slider, resizing panels)
    // coalesces into ONE disk write instead of one per intermediate state.
    // Every relevant state change gives buildWorkspaceState a new identity,
    // which reruns this effect: the OLD timer is cleared (cleanup below)
    // and a new one queued, so only the LAST edit in a rapid burst ever
    // actually reaches disk — same "clear + requeue" shape as the
    // useChartData/useScatterSample/useTablePage debounce this mirrors.
    useEffect(() => {
        if (!initialState) return;
        const timer = setTimeout(() => {
            saveWorkspaceData(buildWorkspaceState());
        }, AUTOSAVE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
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

    // Deliberately `selectedSensors`, not `visibleSensors`: the "hide from
    // chart" toggle in the Selected Sensor tab is a line-chart-only display
    // tweak. Scatter/Pair Plot have no per-sensor visibility concept of
    // their own, so they should always see the full selection — otherwise
    // hiding one line silently drops that sensor from the scatter/pair
    // sample too, and (worse) the Pair Plot tab can stay enabled on
    // selectedSensors.length >= 2 while the actual fetch below 2 sensors,
    // landing the user on a "Select at least 2 sensors" dead end.
    const scatterFilter = useMemo<ScatterSampleFilter | null>(() => {
        if (!scatterActive || selectedSensors.length === 0) return null;
        return {
            sensors: selectedSensors,
            timestamp_start: filters.timestampStart || null,
            timestamp_end: filters.timestampEnd || null,
            value_filters: wireValueFilters,
        };
    }, [scatterActive, selectedSensors, filters.timestampStart, filters.timestampEnd, wireValueFilters]);

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
    // Matches scatterFilter above — falls back to the full selection, not
    // the line-chart-only visible subset.
    const scatterChartHeaders = scatterSample.headers.length > 0 ? scatterSample.headers : selectedSensors;

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

    const applyRelativeRange = useCallback(() => {
        const n = parseFloat(relativeAmount);
        if (!n || n <= 0) return;
        const end = new Date();
        const start = new Date(end);
        switch (relativeUnit) {
            case 'Y': {
                // Y/M aren't a fixed duration, so fractional amounts (e.g.
                // "0.5") can't be applied precisely — truncate to whole
                // units rather than Math.round(), which would silently
                // double a "0.5" input by rounding it up to a full unit.
                const day = start.getDate();
                start.setFullYear(start.getFullYear() - Math.trunc(n));
                // setFullYear can overflow into the next month on leap-day
                // edges (e.g. Feb 29 in a non-leap target year rolls to
                // Mar 1) — clamp back to the last valid day of the
                // intended month instead of silently drifting forward.
                if (start.getDate() !== day) start.setDate(0);
                break;
            }
            case 'M': {
                const day = start.getDate();
                start.setMonth(start.getMonth() - Math.trunc(n));
                // Same overflow guard for month-end dates (e.g. Mar 31 minus
                // 1 month naively lands on Mar 3, not Feb 28/29).
                if (start.getDate() !== day) start.setDate(0);
                break;
            }
            case 'W': start.setTime(start.getTime() - n * 7 * 24 * 60 * 60 * 1000); break;
            case 'D': start.setTime(start.getTime() - n * 24 * 60 * 60 * 1000); break;
            case 'H': start.setTime(start.getTime() - n * 60 * 60 * 1000); break;
        }
        handleFiltersChange({
            ...filters,
            timestampStart: formatForInput(start.toISOString()),
            timestampEnd: formatForInput(end.toISOString()),
        });
        setRelativeRangeApplied(true);
    }, [relativeAmount, relativeUnit, filters, handleFiltersChange, formatForInput]);

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
                            className={`chart-type-btn ${chartType === 'pair' ? 'active' : ''} ${selectedSensors.length > MAX_PAIR_PLOT_SENSORS ? 'blocked' : ''}`}
                            onClick={handlePairPlotClick}
                            disabled={selectedSensors.length < 2}
                            title={
                                selectedSensors.length < 2
                                    ? 'Select at least 2 sensors'
                                    : selectedSensors.length > MAX_PAIR_PLOT_SENSORS
                                        ? `Pair Plot supports at most ${MAX_PAIR_PLOT_SENSORS} sensors`
                                        : undefined
                            }
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
                        markLines={markLines}
                        sensorColors={resolvedSensorColors}
                        sensorAxisRange={sensorAxisRange}
                        sensorMetadata={sensorMetadata}
                        timeHighlights={timeHighlights}
                        highlightDisplay={highlightLineDisplay}
                        lineTaggedPoints={lineTaggedPoints}
                        onLineTaggedPointsChange={handleLineTaggedPointsChange}
                    />
                ) : (
                    // Scatter / pair plot render the bounded Rust sample so
                    // huge datasets can't blank the WebGL canvas.
                    <Chart
                        data={scatterChartData}
                        sensors={scatterChartHeaders}
                        headers={scatterChartHeaders}
                        chartType={chartType}
                        scatterX={scatterAxes?.x}
                        scatterY={scatterAxes?.y}
                        onScatterAxesChange={handleScatterAxesChange}
                        scatterAxisPins={scatterAxisPins}
                        onScatterAxisPinsChange={handleScatterAxisPinsChange}
                        sensorMetadata={sensorMetadata}
                        timeHighlights={timeHighlights}
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
                                    onChange={(e) => {
                                        handleFiltersChange({ ...filters, timestampStart: e.target.value });
                                        setRelativeRangeApplied(false);
                                    }}
                                    placeholder="Start Date"
                                />
                            </div>
                            <span className="separator">-</span>
                            <div className="date-input-wrapper">
                                <Calendar size={14} />
                                <input
                                    type="datetime-local"
                                    value={displayTimestampEnd}
                                    onChange={(e) => {
                                        handleFiltersChange({ ...filters, timestampEnd: e.target.value });
                                        setRelativeRangeApplied(false);
                                    }}
                                    placeholder="End Date"
                                />
                            </div>
                            <span className="separator">·</span>
                            {RANGE_UNITS.map(u => {
                                // Two DIFFERENT things, deliberately shown differently:
                                //   isSelected — this unit is what's currently picked
                                //     in the widget. Must update on every click, on its
                                //     own, with zero dependency on Apply having ever run
                                //     — otherwise clicking Y/M/W/D/H gives no visible
                                //     feedback at all while relativeRangeApplied is
                                //     false (e.g. right after a manual calendar edit),
                                //     which reads as "the buttons don't respond" even
                                //     though relativeUnit IS changing underneath.
                                //   isActive — the STRONGER claim that relativeRangeApplied
                                //     is ALSO true, i.e. the dates on screen really are
                                //     this unit's last-Applied result (see that state's
                                //     own docstring for why it can go false again).
                                const isSelected = relativeUnit === u;
                                const isActive = relativeRangeApplied && isSelected;
                                const unitLabel = { Y: 'Years', M: 'Months', W: 'Weeks', D: 'Days', H: 'Hours' }[u];
                                return (
                                    <button
                                        key={u}
                                        type="button"
                                        onClick={() => { setRelativeUnit(u); setRelativeRangeApplied(false); }}
                                        title={
                                            isActive
                                                ? `Currently applied — last ${relativeAmount || '?'} ${unitLabel}`
                                                : isSelected
                                                    ? `Selected — click ✓ Apply to use "last ${relativeAmount || '?'} ${unitLabel}"`
                                                    : unitLabel
                                        }
                                        style={{
                                            width: '22px', height: '22px', padding: 0,
                                            background: isActive ? 'var(--accent-color)' : 'transparent',
                                            border: isSelected ? '1px solid var(--accent-color)' : '1px solid var(--border)',
                                            borderRadius: '4px',
                                            color: isActive ? '#fff' : (isSelected ? 'var(--accent-color)' : 'var(--text-secondary)'),
                                            fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
                                        }}
                                    >
                                        {u}
                                    </button>
                                );
                            })}
                            <input
                                type="number"
                                min="0"
                                // Y/M are calendar units, not a fixed duration — the spinner
                                // (and applyRelativeRange's truncation) only make sense on
                                // whole units for those two; W/D/H stay fractional-friendly.
                                step={relativeUnit === 'Y' || relativeUnit === 'M' ? '1' : 'any'}
                                value={relativeAmount}
                                onChange={(e) => { setRelativeAmount(e.target.value); setRelativeRangeApplied(false); }}
                                style={{
                                    width: '68px', padding: '2px 4px',
                                    background: 'var(--input-bg)', border: '1px solid var(--border)',
                                    borderRadius: '4px', color: 'var(--text-primary)',
                                    fontSize: '0.75rem', outline: 'none',
                                    // Native spin-button arrows otherwise render in the
                                    // browser's light-mode chrome (white), clashing with
                                    // the app's dark theme — this makes Chromium/WebView2
                                    // draw all native form-control chrome for this input
                                    // (just the spinner here) in its dark variant.
                                    colorScheme: 'dark',
                                }}
                            />
                            <button
                                type="button"
                                onClick={applyRelativeRange}
                                title="Apply relative range"
                                style={{
                                    width: '22px', height: '22px', padding: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'var(--accent-color)', border: 'none',
                                    borderRadius: '4px', color: '#fff', cursor: 'pointer',
                                }}
                            >
                                <Check size={13} />
                            </button>
                        </div>
                    </div>
                    {/* Sits right after TIME RANGE (not after AGGREGATION,
                        which it never touches) — only clears
                        timestampStart/End back to the full data range.
                        Label says "Period" explicitly so it doesn't read as
                        also resetting the aggregation dropdown next to it. */}
                    {dataRange && filters.timestampStart && (
                        <button
                            className="reset-range-btn"
                            title="Reset the time period back to the full data range — does not change Aggregation"
                            onClick={() => {
                                handleFiltersChange({
                                    ...filters,
                                    timestampStart: '',
                                    timestampEnd: ''
                                });
                                // Same reasoning as the manual Start/End edit
                                // handlers above: the dates just changed out
                                // from under whatever relative-range preset
                                // was last applied, so its unit button must
                                // stop claiming to still be "active".
                                setRelativeRangeApplied(false);
                            }}
                        >
                            Reset Period
                        </button>
                    )}
                    <div className="time-range-tab-group">
                        <label>AGGREGATION (1 HR)</label>
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
                </div>
            </div>
        </div>
    );

    // Which tab the panel shows — Filter, Highlights, or the "Selected
    // Sensor" list (per-sensor show/hide + remove controls; replaces the old
    // in-chart ECharts legend). The "Data Insight" tab (raw/aggregated table
    // + its `useTablePage` backend query) was removed 2026-08-16 — unused in
    // practice; see docs/PROJECT_HANDOVER.md for how to bring it back.
    const [activeDataTab, setActiveDataTab] = useState<'selected' | 'filter' | 'highlights'>('selected');

    const renderDataContent = () => (
        <div className="widget-section data-widget">
            <div className="section-header collapsible-header">
                <div className="section-header-left" style={{ gap: '4px' }}>
                    {(['selected', 'filter', 'highlights'] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveDataTab(tab)}
                            style={{
                                background: 'none', border: 'none',
                                borderBottom: activeDataTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
                                color: activeDataTab === tab ? '#3b82f6' : 'var(--text-secondary)',
                                fontSize: '0.85rem', fontWeight: 600,
                                padding: '4px 6px', marginBottom: '-1px', cursor: 'pointer',
                            }}
                        >
                            {tab === 'filter'
                                ? 'Filter'
                                : tab === 'highlights'
                                    ? 'Highlights'
                                    : `Selected Sensor${selectedSensors.length > 0 ? ` (${selectedSensors.length})` : ''}`}
                        </button>
                    ))}
                </div>
                <div className="section-header-actions">
                    {/* Always visible regardless of which tab is active — previously
                        this lived in the (now-removed) single-tab header and updated
                        live as a filter sanity-check; keeping it tab-independent means
                        a filter edit is still visible without leaving "Selected Sensor". */}
                    <span className="section-badge">{tableTotalRows.toLocaleString()} Rows</span>
                    {activeDataTab === 'selected' && selectedSensors.length > 0 && (
                        <button
                            className="export-btn-header"
                            onClick={clearAllSensors}
                            title="Remove every sensor from the plot"
                        >
                            <X size={14} />
                            Clear all
                        </button>
                    )}
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
                {activeDataTab === 'filter' ? (
                    <div className="filter-content">
                        <FilterPanel
                            selectedSensors={selectedSensors}
                            filters={filters}
                            onFiltersChange={handleFiltersChange}
                            sensorMetadata={sensorMetadata}
                        />
                    </div>
                ) : activeDataTab === 'highlights' ? (
                    <HighlightsPanel
                        timeHighlights={timeHighlights}
                        onAddTimeHighlight={handleAddTimeHighlight}
                        onToggleTimeHighlight={handleToggleTimeHighlight}
                        onRemoveTimeHighlight={handleRemoveTimeHighlight}
                        onRecolorTimeHighlight={handleRecolorTimeHighlight}
                        onRenameTimeHighlight={handleRenameTimeHighlight}
                        lineDisplay={highlightLineDisplay}
                        onSetLineDisplay={setHighlightLineDisplay}
                        chartType={chartType}
                    />
                ) : (
                    <div className="custom-scrollbar" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
                        {selectedSensors.length === 0 && (
                            <div style={{ padding: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', opacity: 0.6 }}>
                                No sensors plotted yet — pick some from the Sensor panel.
                            </div>
                        )}
                        {/* Line's per-sensor visibility/color/Y-axis-pin only ever reach
                            LineChart (Chart.tsx forwards sensorColors/sensorAxisRange to
                            'line' only, and scatterChartHeaders always uses the FULL
                            selectedSensors regardless of visibleSensors) — showing those
                            controls for Scatter/Pair Plot let the user "edit" something
                            with zero effect. Scatter's X/Y picker stays inside the chart
                            canvas itself; its value/time colouring lives in the Highlights
                            tab. Pair Plot's lasso-cluster is its own self-contained
                            mechanism and deliberately does NOT read the Highlights tab at
                            all (see ChartTypes.ts's timeHighlights docstring) — mixing two
                            differently-scoped highlighting systems on the same matrix read
                            as more confusing than useful. */}
                        {chartType !== 'line' && selectedSensors.length > 0 && (
                            <div style={{
                                margin: '8px 10px', padding: '8px 10px',
                                background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)',
                                borderRadius: '6px', fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.5,
                            }}>
                                {chartType === 'scatter'
                                    ? 'Scatter Plot: pick the X/Y sensor pair from the dropdowns above the chart. Colour points by value or highlight them by time from the Highlights tab.'
                                    : 'Pair Plot: lasso-select points in any cell to brush a colored cluster — recolor or delete clusters from the panel under the chart.'}
                            </div>
                        )}
                        {selectedSensors.map((sensor) => {
                            const meta = getSensorMeta(sensor);
                            const visible = visibleSensors.includes(sensor);
                            const isPinned = !!sensorAxisRange[sensor];
                            const isLine = chartType === 'line';
                            // Tag-keyed, not index-keyed — must match LineChart's own
                            // default exactly so the swatch always agrees with the
                            // sensor's actual on-chart color, even after another
                            // sensor is hidden/shown and shifts positional indices.
                            // Only meaningful for Line — Scatter/Pair Plot have no
                            // per-sensor color concept, so they always show neutral text.
                            const currentColor = isLine ? (resolvedSensorColors[sensor] ?? defaultSensorColor(sensor)) : 'var(--text-primary)';
                            return (
                                <div key={sensor} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <div
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '10px',
                                            padding: '8px 10px',
                                            opacity: isLine && !visible ? 0.5 : 1,
                                        }}
                                    >
                                        {isLine && (
                                            <input
                                                type="checkbox"
                                                checked={visible}
                                                onChange={() => toggleSensorVisibility(sensor)}
                                                title={visible ? 'Hide from chart' : 'Show on chart'}
                                            />
                                        )}
                                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontWeight: 500, fontSize: '0.8rem', color: currentColor }}>
                                                {meta ? meta.description : sensor}
                                            </span>
                                            {meta && (
                                                <span style={{ fontSize: '0.7rem', color: currentColor, opacity: 0.75 }}>
                                                    {meta.tag} • {meta.unit}
                                                </span>
                                            )}
                                        </div>
                                        {/* Action cluster — kept together (not scattered) so the row reads as
                                            one group of controls on the right, same as the reference layout. */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                                            {isLine && (
                                                <>
                                                    <button
                                                        onClick={() => toggleColorPicker(sensor)}
                                                        title="Change line color"
                                                        style={{
                                                            background: colorPickerFor === sensor ? `${currentColor}33` : 'none',
                                                            border: 'none', borderRadius: '4px',
                                                            color: currentColor,
                                                            cursor: 'pointer', padding: '4px', display: 'flex',
                                                        }}
                                                    >
                                                        <Pipette size={14} />
                                                    </button>
                                                    <button
                                                        onClick={() => toggleAxisEditor(sensor)}
                                                        title={isPinned ? 'Y-axis scale pinned to a fixed range — click to edit, click again to close' : 'Pin the Y-axis to a fixed min/max range'}
                                                        style={{
                                                            background: isPinned ? `${currentColor}33` : 'none',
                                                            border: 'none', borderRadius: '4px',
                                                            color: currentColor,
                                                            cursor: 'pointer', padding: '4px', display: 'flex',
                                                        }}
                                                    >
                                                        <LineChartIcon size={14} />
                                                    </button>
                                                </>
                                            )}
                                            <button
                                                onClick={() => removeSensor(sensor)}
                                                title="Remove from plot"
                                                style={{
                                                    background: 'none', border: 'none', color: currentColor,
                                                    cursor: 'pointer', padding: '4px', display: 'flex',
                                                }}
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>
                                    {isLine && colorPickerFor === sensor && (
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 10px 8px' }}>
                                            <div style={{
                                                padding: '10px',
                                                background: 'var(--input-bg)', border: '1px solid var(--border)',
                                                borderRadius: '6px', width: '160px',
                                            }}>
                                                <ColorPlatePicker
                                                    color={currentColor}
                                                    onChange={(hex) => setSensorColor(sensor, hex)}
                                                />
                                            </div>
                                        </div>
                                    )}
                                    {isLine && axisEditorFor === sensor && (
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 10px 8px' }}>
                                            <div style={{
                                                padding: '8px 10px',
                                                background: 'var(--input-bg)', border: '1px solid var(--border)',
                                                borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '4px',
                                            }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem' }}>
                                                    <span style={{ color: 'var(--text-secondary)' }}>Y-axis:</span>
                                                    <input
                                                        type="number"
                                                        placeholder="min"
                                                        value={axisDraftMin}
                                                        onChange={(e) => setAxisDraftMin(e.target.value)}
                                                        style={{
                                                            width: '64px', padding: '2px 4px',
                                                            background: 'var(--input-bg)', border: '1px solid var(--border)',
                                                            borderRadius: '4px', color: 'var(--text-primary)',
                                                            fontSize: '0.75rem', outline: 'none', colorScheme: 'dark',
                                                        }}
                                                    />
                                                    <span style={{ color: 'var(--text-secondary)' }}>–</span>
                                                    <input
                                                        type="number"
                                                        placeholder="max"
                                                        value={axisDraftMax}
                                                        onChange={(e) => setAxisDraftMax(e.target.value)}
                                                        style={{
                                                            width: '64px', padding: '2px 4px',
                                                            background: 'var(--input-bg)', border: '1px solid var(--border)',
                                                            borderRadius: '4px', color: 'var(--text-primary)',
                                                            fontSize: '0.75rem', outline: 'none', colorScheme: 'dark',
                                                        }}
                                                    />
                                                    <button className="text-btn" onClick={applyAxisEditor}>Apply</button>
                                                    {isPinned && (
                                                        <button
                                                            className="text-btn"
                                                            onClick={() => { clearSensorFixedRange(sensor); closeAxisEditor(); }}
                                                        >
                                                            Unpin
                                                        </button>
                                                    )}
                                                </div>
                                                {axisEditorError && (
                                                    <span style={{ fontSize: '0.7rem', color: 'var(--danger, #ef4444)' }}>
                                                        {axisEditorError}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );

    const renderSensorsContent = () => (
        <div className="widget-section">
            <div className="section-header collapsible-header">
                <div className="section-header-left" style={{ gap: '4px' }}>
                    {(['sensor', 'failure-groups'] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveSensorTab(tab)}
                            style={{
                                background: 'none', border: 'none',
                                borderBottom: activeSensorTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
                                color: activeSensorTab === tab ? '#3b82f6' : 'var(--text-secondary)',
                                fontSize: '0.85rem', fontWeight: 600,
                                padding: '4px 6px', marginBottom: '-1px', cursor: 'pointer',
                            }}
                        >
                            {tab === 'sensor' ? `Sensor (${sensorHeaders.length})` : 'Failure Groups'}
                        </button>
                    ))}
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
                {activeSensorTab === 'sensor' ? (
                    <SensorSelection
                        sensors={sensorHeaders}
                        selectedSensors={selectedSensors}
                        onSensorChange={setSelectedSensors}
                        maxSelectable={chartType === 'pair' ? MAX_PAIR_PLOT_SENSORS : undefined}
                        sensorMetadata={sensorMetadata}
                        fgGroups={fgGroups}
                        fgRows={fgRows}
                        getGroupColor={getFgGroupColor}
                        onToggleSensorGroup={toggleSensorGroup}
                        onCreateGroupForSensor={createGroupForSensor}
                        onRenameGroup={renameGroup}
                        onDeleteGroup={deleteGroup}
                        alarmLinesEnabled={alarmLinesEnabled}
                        onToggleAlarmLine={toggleAlarmLine}
                    />
                ) : (
                    <FailureGroupsPanel
                        allSensors={sensorHeaders}
                        sensorMetadata={sensorMetadata}
                        fgGroups={fgGroups}
                        fgRows={fgRows}
                        getGroupColor={getFgGroupColor}
                        onToggleGroupCollapse={toggleGroupCollapse}
                        onRenameGroup={renameGroup}
                        onDeleteGroup={deleteGroup}
                        onCreateEmptyGroup={createEmptyGroup}
                        onAddBlankRow={addBlankRowToGroup}
                        onUpdateRow={updateFgRow}
                        onRemoveRow={removeFgRowById}
                        onBuildModel={handleBuildModel}
                    />
                )}
            </div>
            {activeSensorTab === 'sensor' && (
                <div className="widget-footer">
                    <button
                        className="add-sensor-btn"
                        onClick={async () => {
                            const webview = new WebviewWindow('add-sensor', {
                                url: '/?window=add-sensor',
                                title: 'Add Special Sensor',
                                width: 1000,
                                height: 800,
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
            )}
        </div>
    );

    const renderPanel = (panel: DashboardPanel) => {
        switch (panel) {
            case 'chart': return renderChartContent();
            case 'data': return renderDataContent();
            case 'sensors': return renderSensorsContent();
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



            <div className={`dashboard-grid-2x2 ${allLeftCollapsed ? 'left-fully-collapsed' : ''} ${allRightCollapsed ? 'right-fully-collapsed' : ''} ${collapsedPanels.size > 0 ? 'has-collapsed-sidebar' : ''}`}>
                {/* Left column — slots LT (chart) and LB (data table) per
                    SLOT_LAYOUT. Slot wrappers exist so split.js has stable
                    refs to manage vertical resize. */}
                <div className="left-column" ref={leftColumnRef}>
                    {LEFT_SLOTS.map(slot => renderSlot(slot))}
                </div>

                <div className="right-column" ref={rightColumnRef}>
                    {/* Right column's one slot (RT) per SLOT_LAYOUT lives in this
                        wrapper. The "Create Failure Group" / "Failure Groups"
                        jump-button that used to live below this (spawning the
                        standalone FailureGroupCreation.tsx window, later just
                        switching tabs) was removed entirely — the Failure
                        Groups tab above is directly clickable, so a redundant
                        jump-button added nothing. */}
                    <div className="right-column-splits">
                        {RIGHT_SLOTS.map(slot => renderSlot(slot))}
                    </div>
                    {/* end .right-column-splits */}
                </div>
            </div>
        </div>
    );
});

export default Dashboard;
