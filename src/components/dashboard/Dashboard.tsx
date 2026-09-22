import { useState, useMemo, useEffect, useDeferredValue, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { emit, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Split from 'split.js';
import { saveWorkspaceData, updateWorkspaceData, loadWorkspaceData } from '../../workspaceManager';
import { subscribe } from '../../utils/tauriEvents';
import {
    CsvMetadata, SensorMetadata, CsvRecord, SensorOperationConfig, SpecialSensorRecipe,
    WorkspaceState, DashboardLayoutSizes, DashboardSlot, DashboardPanel, DashboardSlotMap,
    FailureGroup, FailureModel, ModelKind, AlarmLevel, ScatterAxisPins, TimeHighlight, HighlightLineDisplay, ValueHighlight, LineTaggedPoint,
    WorkspaceSensorFilter,
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
import { useDatasetTimeBounds } from '../../hooks/useDatasetTimeBounds';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { renameTagInArray, renameTagInRecord, renameTagInModels } from '../../utils/specialSensorRename';

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { Plus, EyeOff, BarChart3, Radio, Calendar, ArrowLeft, Check, Trash2, Pipette, LineChart as LineChartIcon, X } from 'lucide-react';
import { debugLog } from '../../utils/debugLog';
import { formatDateTime } from '../../utils/dateFormat';

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

/** Tag comparison is case-insensitive everywhere else this file matches a
 *  sensor tag (see the `byTag` maps in the `add-sensor-selection` listener
 *  below) — used here too for the special-sensor rename cascade. */
const sameTag = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
// Same debounce window as useChartData/useScatterSample's own
// backend-query debounce -- applied here to the autosave-to-disk write
// instead. Without it, every tracked state change (including e.g. each
// keystroke in a Filter value box, which has no debounce of its own)
// triggered an immediate JSON.stringify + writeTextFile to $APPDATA.
const AUTOSAVE_DEBOUNCE_MS = 250;

type RelativeRangeUnit = 'Y' | 'M' | 'W' | 'D' | 'H';

/**
 * `end` minus `n` of `unit` — calendar-accurate for Y/M (not a fixed
 * duration, so `setFullYear`/`setMonth`, with a clamp for month-end
 * overflow like Mar 31 minus 1 month landing on Mar 3 instead of Feb 28/29)
 * and plain millisecond math for W/D/H. Shared by the relative-range Apply
 * button and the one-time "last 6 months" default so both agree on what
 * "N months back" means.
 */
const subtractRelativeAmount = (end: Date, unit: RelativeRangeUnit, n: number): Date => {
    const start = new Date(end);
    switch (unit) {
        case 'Y': {
            const day = start.getDate();
            start.setFullYear(start.getFullYear() - Math.trunc(n));
            if (start.getDate() !== day) start.setDate(0);
            break;
        }
        case 'M': {
            const day = start.getDate();
            start.setMonth(start.getMonth() - Math.trunc(n));
            if (start.getDate() !== day) start.setDate(0);
            break;
        }
        case 'W': start.setTime(start.getTime() - n * 7 * 24 * 60 * 60 * 1000); break;
        case 'D': start.setTime(start.getTime() - n * 24 * 60 * 60 * 1000); break;
        case 'H': start.setTime(start.getTime() - n * 60 * 60 * 1000); break;
    }
    return start;
};

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

    // 2026-09-01 fix: seeded from `metadata.headers` (the raw CSV columns)
    // ALONE used to mean a special/calculated sensor — which has no row in
    // the CSV at all, only an `extraSensorMetadata` entry — was completely
    // absent from this list on every workspace reopen, even though
    // `selectedSensors`/`extraSensorMetadata` themselves restored fine.
    // `SensorSelection`'s "all sensors" list read this state directly, so
    // the sensor was reported as gone entirely — no name, not in the list
    // at all — not merely "present but empty" (see `specialSensorRecipes`'s
    // own doc comment for that separate, deeper bug this fix now lets
    // actually surface). The live "Add Special Sensor" flow already appends
    // a new tag into `sensorHeaders` via the `add-sensor-selection`
    // listener below — this just does the same thing once, on mount, for
    // whatever was already persisted.
    //
    // 2026-09-01 (later): `SensorSelection` itself now actually reads the
    // derived `allSensorTags` below, not this state directly — see that
    // memo's own comment for a second, related gap this mount-seeding fix
    // didn't cover.
    const [sensorHeaders, setSensorHeaders] = useState<string[]>(() => {
        const csvHeaders = metadata.headers.filter(h => {
            const lower = h.trim().toLowerCase();
            return lower !== 'timestamp' && lower !== 'time';
        });
        const known = new Set(csvHeaders.map(h => h.toLowerCase()));
        const extraTags = (initialState?.extraSensorMetadata ?? [])
            .map(m => m.tag)
            .filter(tag => !known.has(tag.toLowerCase()));
        return extraTags.length > 0 ? [...csvHeaders, ...extraTags] : csvHeaders;
    });

    // Metadata for sensors created at runtime via "Add Special Sensor" --
    // the mapping-CSV-derived `sensorMetadataProp` never changes after
    // initial load, so calculated sensors' component assignments live here
    // instead, seeded from the persisted workspace and merged below into the
    // `sensorMetadata` every child actually reads.
    const [extraSensorMetadata, setExtraSensorMetadata] = useState<SensorMetadata[]>(
        initialState?.extraSensorMetadata ?? []
    );
    // What actually rebuilds a special sensor's data on the NEXT workspace
    // open (DataUploadPage.tsx replays these, in order, right after
    // `load_csv`) -- `extraSensorMetadata` above is cosmetic only. See
    // `WorkspaceState.specialSensorRecipes`'s own doc comment for why this
    // exists at all.
    const [specialSensorRecipes, setSpecialSensorRecipes] = useState<SpecialSensorRecipe[]>(
        initialState?.specialSensorRecipes ?? []
    );
    // Bumped when a special sensor's column is recomputed in the Rust session
    // after its recipe was edited. The chart and scatter queries are unchanged
    // by that — same sensors, same filters — so they would happily keep
    // showing values from the old recipe; this is what tells them to refetch.
    // Deliberately NOT part of `buildWorkspaceState`: it describes this
    // session's in-memory data, not anything worth persisting.
    const [dataRevision, setDataRevision] = useState(0);
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

    // 2026-09-01 fix: `sensorHeaders` above is meant to be kept in sync with
    // `selectedSensors`/`extraSensorMetadata` via an imperative "push if
    // missing" step inside the `add-sensor-selection` listener below — but
    // a special sensor built by extending an ALREADY-special sensor (one
    // whose own tag never came from the CSV) went missing from the Sensor
    // tab's list entirely despite being correctly selected and plotted,
    // reported by the user, and the exact mechanism wasn't pinned down with
    // certainty from code alone. Rather than chase that specific gap,
    // `allSensorTags` derives the full list fresh every render instead of
    // relying on that imperative sync staying correct — a tag that's
    // SELECTED or has metadata can now never be excluded from the list it
    // must be pickable/searchable from, regardless of how it got there.
    // This is what `SensorSelection` actually reads now (see the JSX
    // below); `sensorHeaders` itself is unchanged (`request-sensors`,
    // `add-sensor-selection`'s own bookkeeping, and persistence still all
    // use it as before).
    const allSensorTags = useMemo(() => {
        const known = new Set(sensorHeaders.map(h => h.toLowerCase()));
        const extras: string[] = [];
        for (const tag of selectedSensors) {
            if (!known.has(tag.toLowerCase())) { known.add(tag.toLowerCase()); extras.push(tag); }
        }
        for (const m of extraSensorMetadata) {
            if (!known.has(m.tag.toLowerCase())) { known.add(m.tag.toLowerCase()); extras.push(m.tag); }
        }
        return extras.length > 0 ? [...sensorHeaders, ...extras] : sensorHeaders;
    }, [sensorHeaders, selectedSensors, extraSensorMetadata]);

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
    //    tab preview) ─────────────────────────────────────────────────────
    // Owns WorkspaceState.failureGroupState in full. Sensor-level "which
    // group(s) is this sensor in" (SensorSelection.tsx's per-sensor
    // quick-assign, FolderPlus icon) creates/removes individual-kind
    // FailureModels here; everything else — description, recommendation,
    // per-model kind/category/sensors, PM build config — is owned and edited
    // exclusively by the separate Build Model window (BuildModelWindow.tsx,
    // one OS window per group). FailureGroupsPanel.tsx here is preview-only
    // (see its own doc comment) so this file never duplicates state that
    // window already owns. Persisted via `updateWorkspaceData`
    // (read-modify-write) rather than Dashboard's own full-overwrite
    // autosave so this window and any open Build Model window(s) editing
    // *different* groups can't clobber each other.
    //
    // A sensor can belong to multiple groups at once (2026-08-25: a real
    // many-to-many relationship — see FailureModel.groupNos in types.ts),
    // so membership is "does tag's individual model's groupNos include
    // groupNo" — one individual model per tag, not one per (tag, groupNo).
    const [fgGroups, setFgGroups] = useState<FailureGroup[]>(
        initialState?.failureGroupState?.groups ?? [{ no: 0, name: 'Not in Group' }]
    );
    const [fgModels, setFgModels] = useState<FailureModel[]>(
        initialState?.failureGroupState?.models ?? []
    );
    // Workspace-wide "machine running" filter (2026-09-15) — owned/edited
    // entirely on BuildModelWindow's Overview page, but Dashboard's own
    // full-overwrite autosave (`buildWorkspaceState` below) rebuilds
    // `failureGroupState` from local state on every tick, same as
    // fgGroups/fgModels — without tracking this too, the very next Dashboard
    // autosave after BuildModelWindow sets it would silently erase it.
    const [runningConditionFilters, setRunningConditionFilters] = useState<WorkspaceSensorFilter[]>(
        initialState?.failureGroupState?.runningConditionFilters ?? []
    );

    // Serialized WorkspaceState that is already known to be on disk. The
    // debounced autosave below compares against this and skips a write whose
    // payload would be byte-identical — see its own comment for why that
    // matters. Every path that actually persists updates this.
    const lastSavedPayloadRef = useRef<string | null>(null);
    // Latest `buildWorkspaceState`, reachable from callbacks declared above
    // it. It is defined much further down, so naming it directly here (or in
    // a dependency array) would be a temporal-dead-zone error at render time.
    const buildWorkspaceStateRef = useRef<((overrides?: Partial<WorkspaceState>) => WorkspaceState) | null>(null);

    const persistFailureGroupState = useCallback((groups: FailureGroup[], models: FailureModel[]) => {
        if (!initialState) return;
        updateWorkspaceData(initialState.id, prev => ({
            ...prev,
            failureGroupState: {
                groups,
                models,
                // Dashboard never edits this itself — preserve whatever is
                // actually on disk right now rather than the (possibly
                // stale-by-a-tick) local copy, since `prev` here is a fresh
                // read, not the closure's `runningConditionFilters`.
                runningConditionFilters: prev.failureGroupState?.runningConditionFilters ?? [],
            },
        }))
            .then((next) => {
                // Tell any open Build Model window (a separate OS window that
                // otherwise only sees Dashboard's edits when it is next
                // opened) — scoped to this workspace, and tagged so this
                // window's own listener below skips its own echo.
                if (next?.failureGroupState) {
                    emit('failure-group-state-changed', {
                        ...next.failureGroupState,
                        workspaceId: initialState.id,
                        origin: 'dashboard',
                    }).catch(e => console.warn('Failed to broadcast failure-group state:', e));
                }
                // 2026-09-03: this write already made the new failure-group
                // state durable, so record what the disk now holds. Without
                // it the debounced autosave rewrote the very same content
                // ~250ms later, making every single toggle cost one disk read
                // plus two full-state writes.
                const build = buildWorkspaceStateRef.current;
                if (build) {
                    lastSavedPayloadRef.current = JSON.stringify(build({ failureGroupState: { groups, models, runningConditionFilters } }));
                }
            })
            .catch(e => console.error('Failed to persist failure-group assignment from Dashboard:', e));
    }, [initialState, runningConditionFilters]);

    // BuildModelWindow and PredictiveModelBuild persist failureGroupState
    // independently (their own updateWorkspaceData read-modify-write calls)
    // since they're separate OS windows. Without this listener, this
    // window's own fgGroups/fgModels would go stale the moment either of
    // them writes — and Dashboard's full-overwrite autosave below (which
    // saves `{groups: fgGroups, models: fgModels}` alongside everything
    // else it owns) would then clobber their fresher on-disk data on its
    // next tick. Both windows broadcast this event after every persist so
    // this copy never drifts. Also carries `runningConditionFilters` now,
    // for the same reason.
    //
    // 2026-09-21: events are global broadcasts across every window, so with
    // more than one project the payload can belong to a DIFFERENT workspace
    // (a stale window from the previous project). Only apply the one that
    // names THIS workspace — and skip this window's own echo.
    const currentWorkspaceId = initialState?.id;
    useEffect(() => subscribe<{ groups: FailureGroup[]; models: FailureModel[]; runningConditionFilters?: WorkspaceSensorFilter[]; workspaceId?: string; origin?: string }>('failure-group-state-changed', (event) => {
        if (event.payload.workspaceId !== currentWorkspaceId) return;
        if (event.payload.origin === 'dashboard') return;
        setFgGroups(event.payload.groups);
        setFgModels(event.payload.models);
        setRunningConditionFilters(event.payload.runningConditionFilters ?? []);
    }), [currentWorkspaceId]);

    // Default PM build config for a freshly created model of a given kind —
    // mirrors spawnPredictiveModel's own seed defaults below so a model
    // behaves identically whether it was created here or from Build Model.
    //
    // 2026-08-31 redesign: model creation/deletion now lives entirely on
    // Dashboard (Sensor tab's per-kind toggle + Failure Groups tab's own
    // delete button) — Build Model no longer creates or removes models at
    // all, only edits/trains existing ones, per explicit user request. A
    // sensor can now carry more than one model KIND at once (e.g. both an
    // Individual and a Relationship model), not just more than one GROUP —
    // so this is parameterized by kind instead of being individual-only.
    // Clustering has no single "target sensor" (it needs X and Y); adding
    // it from a single-sensor toggle seeds that sensor as X and leaves Y
    // blank for later — confirmed via AskUserQuestion over not offering
    // Clustering in this flow at all.
    const makeDefaultModelForKind = useCallback((tag: string, groupNos: number[], kind: ModelKind): FailureModel => ({
        id: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        groupNos,
        name: getSensorMeta(tag)?.description || tag,
        kind,
        category: null,
        notes: '',
        status: false,
        targetSensor: kind === 'clustering' ? '' : tag,
        predictorSensors: [],
        xSensor: kind === 'clustering' ? tag : '',
        ySensor: '',
        individualChecked: true,
        rcMode: null,
        scatterXSensor: '',
        relModelName: '',
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
    }), [getSensorMeta]);

    const isDuplicateGroupName = useCallback((name: string, excludeNo?: number) =>
        fgGroups.some(g => g.no !== 0 && g.no !== excludeNo && g.name.trim().toLowerCase() === name.trim().toLowerCase()),
    [fgGroups]);

    // A model "of kind K for sensor S" is identified by targetSensor (for
    // individual/relationship) or xSensor (for clustering, which seeded
    // this sensor as X on creation — see makeDefaultModelForKind above).
    const findModelForKind = useCallback((tag: string, kind: ModelKind) =>
        fgModels.find(m => m.kind === kind && (
            kind === 'clustering' ? (m.xSensor ?? '').toLowerCase() === tag.toLowerCase() : (m.targetSensor ?? '').toLowerCase() === tag.toLowerCase()
        )),
    [fgModels]);

    // A sensor's per-kind, per-group toggle (SensorSelection's FolderPlus
    // menu and its chips) — 2026-08-25 redesign: a sensor can legitimately
    // sit in several Failure Groups at once, expressed as several entries
    // in one model's `groupNos`, not one duplicate model per group.
    // 2026-08-31 redesign: a sensor can ALSO carry more than one model
    // KIND at once now (e.g. both Individual and Relationship) — this is
    // the one control that both creates AND removes a specific (sensor,
    // group, kind) membership, toggling instantly with no separate
    // confirm step, consistent with the rest of the app's "no
    // confirmations, click does the thing" policy this session settled on.
    // Toggling ON reuses this sensor's existing model of that kind if one
    // exists (adding `groupNo`, dropping the `0` "Not in Group" sentinel
    // now that it has a real group) or creates a fresh one. Toggling OFF
    // removes just this one (group, kind) membership — deleting the model
    // outright once it has no group left to represent (whether the group
    // just removed was a real one or `0` itself).
    //
    // 2026-09-02: removing a sensor's LAST real group used to fall back to
    // `groupNos: [0]` ("Not in Group") instead of deleting — the model
    // itself (and whatever config it already had) wasn't lost, just
    // unlinked from a failure mode. Reported by the user as unwanted: the
    // chip's X is expected to make the membership disappear entirely, not
    // reappear parked under "Not in Group" — so this now deletes the model
    // the same way removing it from `0` already did (2026-08-31 fix, same
    // reasoning: no group left to represent it), rather than special-casing
    // groupNo 0 vs. a real group.
    const toggleSensorGroupKind = useCallback((tag: string, groupNo: number, kind: ModelKind) => {
        const existing = findModelForKind(tag, kind);
        const isMember = !!existing && existing.groupNos.includes(groupNo);
        let nextModels: FailureModel[];
        if (isMember) {
            const remaining = existing!.groupNos.filter(n => n !== groupNo);
            nextModels = remaining.length > 0
                ? fgModels.map(m => m === existing ? { ...m, groupNos: remaining } : m)
                : fgModels.filter(m => m !== existing);
        } else if (existing) {
            nextModels = fgModels.map(m => m === existing
                ? { ...m, groupNos: [...new Set([...m.groupNos.filter(n => n !== 0), groupNo])] }
                : m);
        } else {
            nextModels = [...fgModels, makeDefaultModelForKind(tag, [groupNo], kind)];
        }
        setFgModels(nextModels);
        persistFailureGroupState(fgGroups, nextModels);
    }, [fgModels, fgGroups, findModelForKind, makeDefaultModelForKind, persistFailureGroupState]);

    // "Create a brand new group for this sensor" — creates the empty group
    // and, for convenience, reuses-or-creates this sensor's Individual
    // model into it (the common case); additional kinds are then added the
    // same way as any other group, via toggleSensorGroupKind on the new
    // group's own row once it appears in the menu.
    const createGroupForSensor = useCallback((tag: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed || isDuplicateGroupName(trimmed)) return;
        const maxNo = Math.max(...fgGroups.map(g => g.no), 0);
        const newGroupNo = maxNo + 1;
        const newGroups = [...fgGroups, { no: newGroupNo, name: trimmed }];
        const existing = findModelForKind(tag, 'individual');
        const newModels = existing
            ? fgModels.map(m => m === existing
                ? { ...m, groupNos: [...new Set([...m.groupNos.filter(n => n !== 0), newGroupNo])] }
                : m)
            : [...fgModels, makeDefaultModelForKind(tag, [newGroupNo], 'individual')];
        setFgGroups(newGroups);
        setFgModels(newModels);
        persistFailureGroupState(newGroups, newModels);
    }, [fgGroups, fgModels, findModelForKind, isDuplicateGroupName, makeDefaultModelForKind, persistFailureGroupState]);

    // 2026-08-31: model deletion now lives on Dashboard (Failure Groups
    // tab's own per-model delete button) — Build Model no longer has a
    // "Remove model" control at all, per explicit user request. No
    // confirmation dialog, matching this session's "click does the thing"
    // policy for every other destructive action in the app.
    const deleteModel = useCallback((modelId: string) => {
        const newModels = fgModels.filter(m => m.id !== modelId);
        setFgModels(newModels);
        persistFailureGroupState(fgGroups, newModels);
    }, [fgGroups, fgModels, persistFailureGroupState]);

    // Renaming/deleting a group is global (not tied to one sensor's model),
    // so these operate on fgGroups/fgModels directly rather than through
    // toggleSensorGroupKind.
    const renameGroup = useCallback((groupNo: number, name: string) => {
        const trimmed = name.trim();
        if (!trimmed || isDuplicateGroupName(trimmed, groupNo)) return;
        const newGroups = fgGroups.map(g => g.no === groupNo ? { ...g, name: trimmed } : g);
        setFgGroups(newGroups);
        persistFailureGroupState(newGroups, fgModels);
    }, [fgGroups, fgModels, isDuplicateGroupName, persistFailureGroupState]);

    // Name + Description + Recommendation together, for the Failure Groups
    // tab's own "Edit details" panel — 2026-08-31: moved here from Build
    // Model window entirely, per explicit user request ("ส่วนของ edit
    // detail ต้องอยู่ที่ dashboard ด้วย"), so it's no longer duplicated
    // between the two. FailureGroupsPanel.tsx does its own duplicate-name
    // check locally before calling this (same pattern Build Model used),
    // so this is a plain apply, not a validating gate.
    const updateGroupDetails = useCallback((groupNo: number, name: string, description: string, recommendation: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const newGroups = fgGroups.map(g => g.no === groupNo ? { ...g, name: trimmed, description, recommendation } : g);
        setFgGroups(newGroups);
        persistFailureGroupState(newGroups, fgModels);
    }, [fgGroups, fgModels, persistFailureGroupState]);

    // Deleting a group only strips THAT group from every model's
    // `groupNos` (falling back to `[0]`, "Not in Group", if it was a
    // model's last one) — it no longer deletes models outright the way it
    // did before `groupNos[]` existed. A model that also belongs to
    // another group keeps living there untouched; that's the whole point
    // of the many-to-many redesign. No confirmation step here — the UI
    // callers (FailureGroupsPanel, BuildModelWindow) confirm first.
    const deleteGroup = useCallback((groupNo: number) => {
        if (groupNo === 0) return;
        const newGroups = fgGroups.filter(g => g.no !== groupNo);
        const newModels = fgModels.map(m => {
            if (!m.groupNos.includes(groupNo)) return m;
            const remaining = m.groupNos.filter(n => n !== groupNo);
            return { ...m, groupNos: remaining.length > 0 ? remaining : [0] };
        });
        setFgGroups(newGroups);
        setFgModels(newModels);
        persistFailureGroupState(newGroups, newModels);
    }, [fgGroups, fgModels, persistFailureGroupState]);

    // ── Failure Groups tab (group-centric preview) ───────────────────────
    // Supports FailureGroupsPanel.tsx. Reuses fgGroups/fgModels/
    // persistFailureGroupState above; toggleSensorGroupKind/
    // createGroupForSensor (also above) remain the entry points used by
    // SensorSelection.tsx's per-sensor quick-assign, unchanged.
    const [activeSensorTab, setActiveSensorTab] = useState<'sensor' | 'failure-groups'>(
        initialState?.lastRoute === 'failure-group' ? 'failure-groups' : 'sensor'
    );

    const createEmptyGroup = useCallback((name: string) => {
        const trimmed = name.trim();
        if (!trimmed || isDuplicateGroupName(trimmed)) return;
        const maxNo = Math.max(...fgGroups.map(g => g.no), 0);
        const newGroups = [...fgGroups, { no: maxNo + 1, name: trimmed }];
        setFgGroups(newGroups);
        persistFailureGroupState(newGroups, fgModels);
    }, [fgGroups, fgModels, isDuplicateGroupName, persistFailureGroupState]);

    // "Quick add" a model straight from the Failure Groups tab's card,
    // right after creating the group it belongs to, without opening Build
    // Model first — added per explicit user request. Only the bare
    // minimum needed to exist (name, kind, its kind-appropriate sensor(s),
    // and which group(s) it belongs to — checkboxes in the modal, per
    // explicit user request that one model be assignable to several
    // groups at once); everything else (category, predictors, cluster
    // ranges, …) is still only editable from Build Model afterward — the
    // model shows "Incomplete" until then, same as any model created
    // there directly.
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

    // Line chart's tagged points ("Tag Point" feature) — lifted out of the
    // chart component for the same reason as scatterAxisPins above:
    // LineChart unmounts on every chart-type switch, so its own local state
    // would be lost the moment the user looked away and back. Deliberately
    // NOT seeded from `initialState`/included in `buildWorkspaceState` below
    // — per explicit user request, tags should NOT survive closing and
    // reopening the app, only an in-session chart-type switch. Scatter's own
    // tagged points are lifted even less far — kept as local ScatterChart
    // state, not here — see LineTaggedPoint's docstring in types.ts for why
    // (no stable point identity across a resampled query).
    const [lineTaggedPoints, setLineTaggedPoints] = useState<LineTaggedPoint[]>([]);
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

    // "By value" highlighting ("Highlights" tab) — Scatter-only. Lives
    // alongside timeHighlights in the same tab (per explicit user request —
    // it used to be a "Colour by…" dropdown on Scatter's own toolbar
    // before being replaced by time-window highlighting; the user asked
    // for it back, deliberately relocated into the Highlights tab this
    // time instead of restoring the old toolbar control). See
    // ValueHighlight in types.ts for why this is one sensor + its ranges
    // rather than a flat list like timeHighlights — Scatter only has one
    // colour channel, so ranges from more than one sensor active at once
    // would be ambiguous.
    const [valueHighlight, setValueHighlight] = useState<ValueHighlight>(
        initialState?.valueHighlight ?? { sensor: '', ranges: [] },
    );

    const handleSetValueHighlightSensor = useCallback((sensor: string) => {
        setValueHighlight(prev => ({ ...prev, sensor }));
    }, []);

    const handleAddValueHighlightRange = useCallback((min: number, max: number) => {
        setValueHighlight(prev => ({
            ...prev,
            ranges: [...prev.ranges, {
                id: `${Date.now()}-${prev.ranges.length}`,
                min, max,
                color: rgbaToHex(RANGE_PALETTE[prev.ranges.length % RANGE_PALETTE.length]),
                enabled: true,
            }],
        }));
    }, []);

    const handleToggleValueHighlightRange = useCallback((id: string) => {
        setValueHighlight(prev => ({ ...prev, ranges: prev.ranges.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r) }));
    }, []);

    const handleRemoveValueHighlightRange = useCallback((id: string) => {
        setValueHighlight(prev => ({ ...prev, ranges: prev.ranges.filter(r => r.id !== id) }));
    }, []);

    const handleRecolorValueHighlightRange = useCallback((id: string, color: string) => {
        setValueHighlight(prev => ({ ...prev, ranges: prev.ranges.map(r => r.id === id ? { ...r, color } : r) }));
    }, []);

    // Drop the criteria sensor (turn "by value" coloring off) if it's no
    // longer among the selected sensors — same reasoning as scatterAxes/
    // scatterAxisPins elsewhere in this file. Its ranges go with it — they're
    // meaningless for a different sensor.
    useEffect(() => {
        if (valueHighlight.sensor && !selectedSensors.includes(valueHighlight.sensor)) {
            setValueHighlight({ sensor: '', ranges: [] });
        }
    }, [selectedSensors, valueHighlight.sensor]);

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

    // Palette slot each sensor has been handed, remembered for the lifetime
    // of this window. Once a sensor owns a slot it keeps it — see
    // `resolvedSensorColors` below for why that matters.
    const colorSlotsRef = useRef<Map<string, number>>(new Map());

    // Fills in a default for every selected sensor that doesn't have an
    // explicit override. Assignment is by palette SLOT, not by hashing the
    // tag: hashing let unrelated sensors collide onto the same slot, or land
    // on adjacent blue/indigo/violet entries that read as "basically the same
    // color" on a thin line trace — the report that prompted the original
    // change. Slots guarantee every simultaneously-selected sensor (up to the
    // palette size) gets a visually distinct color.
    //
    // 2026-09-03: slots are now REMEMBERED instead of recomputed as
    // `selectedSensors[i]`, which made a sensor's color depend on the
    // composition of the list rather than on the sensor. Un-ticking one
    // sensor in the right-hand panel re-packed every sensor after it onto a
    // new slot, and `useChartData` deliberately keeps the previous view on
    // screen while the next query is in flight ("so the chart never flashes
    // blank") — so for ~250ms the OLD lines were redrawn in NEW colors. The
    // sensor being removed was worse still: it dropped out of this map
    // immediately, so LineChart fell back to `defaultSensorColor()`, a
    // different (hash-based) color, and its line visibly changed color just
    // before vanishing. That is the flicker the user reported.
    //
    // Two rules fix it: an assigned slot never moves, and a sensor keeps its
    // entry here after being deselected, so a line still on screen from the
    // previous fetch keeps the color it was drawn with.
    const resolvedSensorColors = useMemo(() => {
        const slots = colorSlotsRef.current;
        const assigned = new Map<string, number>();
        const taken = new Set<number>();

        // 1) Honour slots already handed out (selection order breaks ties if
        //    two sensors somehow remember the same one).
        for (const sensor of selectedSensors) {
            const slot = slots.get(sensor);
            if (slot !== undefined && !taken.has(slot)) {
                assigned.set(sensor, slot);
                taken.add(slot);
            }
        }
        // 2) Everything new takes the lowest free slot. Once the palette is
        //    exhausted, wrap — same as the old behaviour past that point.
        let overflow = 0;
        for (const sensor of selectedSensors) {
            if (assigned.has(sensor)) continue;
            let slot = 0;
            while (slot < LINE_CHART_COLORS.length && taken.has(slot)) slot++;
            if (slot === LINE_CHART_COLORS.length) {
                slot = overflow % LINE_CHART_COLORS.length;
                overflow++;
            } else {
                taken.add(slot);
            }
            assigned.set(sensor, slot);
        }
        for (const [sensor, slot] of assigned) slots.set(sensor, slot);

        // Every sensor that has ever held a slot, not just the currently
        // selected ones — a line from the in-flight previous view is still
        // being drawn and must not lose its color mid-flight.
        const map: Record<string, string> = {};
        for (const [sensor, slot] of slots) {
            map[sensor] = sensorColors[sensor] ?? LINE_CHART_COLORS[slot];
        }
        // An explicit user-picked color always wins.
        for (const [sensor, color] of Object.entries(sensorColors)) {
            map[sensor] = color;
        }
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
    // Lets the TIME RANGE row's Calendar icons open the native
    // datetime-local picker directly on click, instead of relying on the
    // browser-drawn `::-webkit-calendar-picker-indicator` pseudo-element
    // (styled in App.css, but how visible that ends up is entirely up to
    // WebView2's own rendering of it — reported hard to see on the
    // Build Model page's matching inputs, 2026-09-16, same
    // `.date-input-wrapper` pattern reused here).
    const timeRangeStartRef = useRef<HTMLInputElement>(null);
    const timeRangeEndRef = useRef<HTMLInputElement>(null);
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
    //
    // 2026-09-01: tracks `allSensorTags` (not `sensorHeaders` directly) so
    // AddSensorWindow's own "pick a source sensor" list has the same
    // guaranteed-complete picture Dashboard's own Sensor tab does — a
    // special sensor missing from here would mean it can't even be picked
    // as an input for building another one on top of it.
    //
    // 2026-09-07: also carries `specialSensorRecipes` and `fgModels` — the
    // add-sensor window's "Manage" tab needs both to work out what still
    // depends on a special sensor before offering to delete it (see
    // `buildSpecialSensorUsage`). They travel on the same
    // request-sensors/sensors-data handshake rather than a second one.
    const stateRef = useRef({ allSensorTags, selectedSensors, sensorMetadata, metadata, specialSensorRecipes, fgModels, fgGroups });
    // 2026-09-21: every event from the Add Sensor window is a GLOBAL
    // broadcast, so with a second project loaded a leftover window from the
    // previous one could push ITS sensors/metadata/recipes into this
    // workspace. Each payload now names its workspace and is dropped here
    // unless it matches.
    const workspaceIdRef = useRef(initialState?.id);
    workspaceIdRef.current = initialState?.id;
    const forThisWorkspace = (payload: unknown) =>
        (payload as { workspaceId?: string } | null | undefined)?.workspaceId === workspaceIdRef.current;
    useEffect(() => {
        stateRef.current = { allSensorTags, selectedSensors, sensorMetadata, metadata, specialSensorRecipes, fgModels, fgGroups };
    }, [allSensorTags, selectedSensors, sensorMetadata, metadata, specialSensorRecipes, fgModels, fgGroups]);

    useEffect(() => {
        let unlistenRequest: UnlistenFn | undefined;
        let unlistenAdd: UnlistenFn | undefined;
        let unlistenDelete: UnlistenFn | undefined;
        let unlistenUpdate: UnlistenFn | undefined;
        let unlistenRename: UnlistenFn | undefined;

        const setupListeners = () => {
            debugLog("Setting up Dashboard listeners");
            // Listen for request from child window
            unlistenRequest = subscribe('request-sensors', () => {
                debugLog("Dashboard received 'request-sensors', emitting data...");
                const { allSensorTags, selectedSensors, sensorMetadata, specialSensorRecipes, fgModels } = stateRef.current;
                emit('sensors-data', {
                    workspaceId: workspaceIdRef.current,
                    sensors: allSensorTags,
                    selectedSensors: selectedSensors,
                    sensorMetadata: sensorMetadata,
                    specialSensorRecipes,
                    models: fgModels,
                });
            });

            // Listen for new selections from child window
            unlistenAdd = subscribe<{ sensors: string[], operation: SensorOperationConfig | null, newMetadata?: SensorMetadata[], newRecipes?: SpecialSensorRecipe[], workspaceId?: string }>('add-sensor-selection', async (event) => {
                if (!forThisWorkspace(event.payload)) return;
                debugLog("Dashboard received 'add-sensor-selection'", event.payload);

                let newSelectedSensors: string[] = [];
                let newOperationConfig: SensorOperationConfig | null = null;
                let newMetadata: SensorMetadata[] = [];
                let newRecipes: SpecialSensorRecipe[] = [];

                if (Array.isArray(event.payload)) {
                    newSelectedSensors = event.payload;
                    newOperationConfig = null;
                } else {
                    newSelectedSensors = event.payload.sensors;
                    newOperationConfig = event.payload.operation;
                    newMetadata = event.payload.newMetadata ?? [];
                    newRecipes = event.payload.newRecipes ?? [];
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

                if (newRecipes.length > 0) {
                    // Append-or-replace by tag, but otherwise preserve
                    // existing array order -- replay order matters (a
                    // later formula sensor can reference an earlier one).
                    setSpecialSensorRecipes(prev => {
                        const byTag = new Map(prev.map(r => [r.tag.toLowerCase(), r]));
                        for (const r of newRecipes) byTag.set(r.tag.toLowerCase(), r);
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

            // Sensors deleted from the add-sensor window's "Manage" tab.
            //
            // The window has already checked that nothing depends on them
            // (`buildSpecialSensorUsage`) and has already run its own undo
            // window, so this side just applies the removal — dropping the
            // recipe is what actually makes it stick, since the recipes are
            // what DataUploadPage replays to rebuild these columns on the
            // next workspace open.
            //
            // The column itself stays in the Rust session's in-memory data
            // until then: there is no command to drop one, and adding one is
            // not worth it for state that is discarded at app close anyway.
            // Removing the tag from all three lists below is what takes it
            // out of every list, picker and chart in the meantime.
            //
            // No explicit save call — every setter here feeds
            // `buildWorkspaceState`, so the debounced autosave writes it.
            unlistenDelete = subscribe<{ tags: string[]; workspaceId?: string }>('delete-special-sensors', (event) => {
                if (!forThisWorkspace(event.payload)) return;
                const drop = new Set((event.payload?.tags ?? []).map(t => t.trim().toLowerCase()));
                if (drop.size === 0) return;
                debugLog('Dashboard received delete-special-sensors', event.payload);
                const kept = <T,>(list: T[], tagOf: (item: T) => string) =>
                    list.filter(item => !drop.has(tagOf(item).trim().toLowerCase()));

                setSpecialSensorRecipes(prev => kept(prev, r => r.tag));
                setExtraSensorMetadata(prev => kept(prev, m => m.tag));
                // visibleSensors, sensorColors, sensorAxisRange and
                // alarmLinesEnabled all follow selectedSensors through
                // existing effects, so deselecting is enough to clear them.
                setSelectedSensors(prev => kept(prev, s => s));
                setSensorHeaders(prev => kept(prev, h => h));
            });

            // A special sensor's recipe was edited in the "Manage" tab. The
            // window has already recomputed its column — and every column
            // built on top of it — in the Rust session, so this side only
            // records the new recipe and metadata (autosave persists them)
            // and bumps `dataRevision` so the charts refetch the new values.
            //
            // The tag is unchanged here — a rename fires `rename-special-
            // sensor` instead (below), which is where every tag-keyed piece
            // of this file's own state gets re-keyed. This listener only
            // ever sees an edit that keeps the same tag.
            unlistenUpdate = subscribe<{ recipe: SpecialSensorRecipe; metadata: SensorMetadata; workspaceId?: string }>('update-special-sensor', (event) => {
                if (!forThisWorkspace(event.payload)) return;
                const { recipe, metadata } = event.payload ?? {};
                if (!recipe) return;
                debugLog('Dashboard received update-special-sensor', event.payload);
                const isTarget = (tag: string) => tag.trim().toLowerCase() === recipe.tag.trim().toLowerCase();

                setSpecialSensorRecipes(prev => prev.map(r => (isTarget(r.tag) ? recipe : r)));
                if (metadata) {
                    setExtraSensorMetadata(prev => (
                        prev.some(m => isTarget(m.tag))
                            ? prev.map(m => (isTarget(m.tag) ? metadata : m))
                            : [...prev, metadata]
                    ));
                }
                setDataRevision(n => n + 1);
            });

            // A special sensor was RENAMED (in addition to whatever else the
            // edit changed) in the "Manage" tab. Everything `update-special-
            // sensor` already does for the recipe/metadata pair itself, PLUS
            // re-keying every OTHER piece of this file's own state that names
            // a sensor by tag — selection, per-sensor chart cosmetics, and
            // every Failure Group model field. `updatedRecipes` carries any
            // downstream recipe whose formula/sourceSensors were rewritten to
            // point at the new name (their OWN tags are unchanged, so they're
            // matched into `specialSensorRecipes` by tag, same as `recipe`
            // itself is matched by `oldTag`).
            unlistenRename = subscribe<{
                oldTag: string;
                newTag: string;
                recipe: SpecialSensorRecipe;
                metadata: SensorMetadata;
                updatedRecipes: SpecialSensorRecipe[];
                workspaceId?: string;
            }>('rename-special-sensor', (event) => {
                if (!forThisWorkspace(event.payload)) return;
                const { oldTag, newTag, recipe, metadata, updatedRecipes } = event.payload ?? {};
                if (!oldTag || !newTag || !recipe) return;
                debugLog('Dashboard received rename-special-sensor', event.payload);
                const isOld = (tag: string) => sameTag(tag, oldTag);

                setSpecialSensorRecipes(prev => prev.map(r => {
                    if (isOld(r.tag)) return recipe;
                    const rewritten = (updatedRecipes ?? []).find(u => sameTag(u.tag, r.tag));
                    return rewritten ?? r;
                }));
                setExtraSensorMetadata(prev => {
                    const withoutOld = prev.filter(m => !isOld(m.tag));
                    return withoutOld.some(m => sameTag(m.tag, newTag))
                        ? withoutOld.map(m => (sameTag(m.tag, newTag) ? metadata : m))
                        : [...withoutOld, metadata];
                });
                setSensorHeaders(prev => renameTagInArray(prev, oldTag, newTag));
                setSelectedSensors(prev => renameTagInArray(prev, oldTag, newTag));
                setVisibleSensors(prev => renameTagInArray(prev, oldTag, newTag));
                setSensorColors(prev => renameTagInRecord(prev, oldTag, newTag));
                setSensorAxisRange(prev => renameTagInRecord(prev, oldTag, newTag));
                setAlarmLinesEnabled(prev => renameTagInRecord(prev, oldTag, newTag));
                setScatterAxes(prev => (prev ? { x: isOld(prev.x) ? newTag : prev.x, y: isOld(prev.y) ? newTag : prev.y } : prev));
                setScatterAxisPins(prev => ({
                    x: prev.x && isOld(prev.x.sensor) ? { ...prev.x, sensor: newTag } : prev.x,
                    y: prev.y && isOld(prev.y.sensor) ? { ...prev.y, sensor: newTag } : prev.y,
                }));
                setValueHighlight(prev => (isOld(prev.sensor) ? { ...prev, sensor: newTag } : prev));

                const renamedModels = renameTagInModels(stateRef.current.fgModels, oldTag, newTag);
                setFgModels(renamedModels);
                persistFailureGroupState(stateRef.current.fgGroups, renamedModels);

                setDataRevision(n => n + 1);
            });
        };

        setupListeners();

        return () => {
            if (unlistenRequest) unlistenRequest();
            if (unlistenAdd) unlistenAdd();
            if (unlistenDelete) unlistenDelete();
            if (unlistenRename) unlistenRename();
            if (unlistenUpdate) unlistenUpdate();
        };
        // `persistFailureGroupState` is a `useCallback` keyed only on
        // `initialState`, which never changes after this component mounts --
        // capturing it once here (rather than re-subscribing every Tauri
        // listener whenever its identity is recomputed) is the same
        // register-once-use-`stateRef`-for-freshness pattern the rest of this
        // effect already relies on.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [filters, setFilters] = useState<FilterState>(initialState?.filters ?? { timestampStart: '', timestampEnd: '', sensorFilters: [] });
    const [chartType, setChartType] = useState<'line' | 'scatter' | 'pair'>(initialState?.chartType ?? 'line');
    const [samplingMethod, setSamplingMethod] = useState<'raw' | 'avg' | 'max' | 'min' | 'first' | 'last'>(initialState?.samplingMethod ?? 'raw');


    // ── Build Model — singleton window (label `build-model`) reached from
    //    the Failure Groups tab's "Build Model" button. Was two OS windows
    //    (an Overview browser + one per-group window per groupNo, spawned
    //    on demand) until the user asked to cut the total window count down
    //    to just Dashboard + this one — the window itself now handles
    //    overview/detail navigation internally as in-window pages, so there
    //    is only ever this one label to spawn or focus. This also means the
    //    duplicate-window race that used to exist between the "check if a
    //    per-group window already exists" and "create it" steps can't
    //    happen anymore for group-switching (it's local state now); it's
    //    still guarded here for the singleton spawn itself.
    //
    // 2026-09-21: reads the freshest values through `stateRef` and subscribes
    // ONCE instead of re-subscribing on every change of the four values it
    // used to close over. Each re-subscription raced its own async
    // unlisten, leaving stale copies alive that answered the Build Model
    // window's request with an older workspace id / older sensor metadata
    // (e.g. before the special sensors' component and description had been
    // merged in) — the window applied whichever reply arrived last.
    const emitBuildModelData = useCallback(async () => {
        const wsId = workspaceIdRef.current;
        if (!wsId) return;
        const { allSensorTags: sensors, sensorMetadata: meta, metadata: csvMeta } = stateRef.current;
        await emit('build-model-data', {
            workspaceId: wsId,
            sensorHeaders: sensors,
            sensorMetadata: meta,
            metadata: csvMeta,
        });
    }, []);
    useEffect(() => subscribe('request-build-model-data', () => { emitBuildModelData(); }), [emitBuildModelData]);

    // Guards the gap between the `getByLabel` existence check and the
    // `new WebviewWindow(...)` call below (both async IPC round-trips) so
    // two rapid clicks on the "Build Model" button can't both see "no
    // existing window" and both construct one.
    const pendingSpawnLabels = useRef<Set<string>>(new Set());

    const spawnBuildModel = useCallback(async () => {
        if (!initialState) return;
        const label = 'build-model';
        if (pendingSpawnLabels.current.has(label)) return;
        pendingSpawnLabels.current.add(label);
        try {
            const existing = await WebviewWindow.getByLabel(label);
            if (existing) {
                try { await existing.setFocus(); } catch { /* ignore */ }
                // The open window fetched its data once, on its own mount —
                // re-point it at THIS workspace instead of trusting that it
                // still is (it may be a leftover from the previous project).
                try { await emitBuildModelData(); } catch { /* ignore */ }
                return;
            }
            const screenW = window.screen.width;
            const screenH = window.screen.height;
            const isMac = /mac/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent);
            const webview = new WebviewWindow(label, {
                url: '/?window=build-model',
                title: 'Build Model',
                width: Math.round(screenW * 0.75),
                height: Math.round(screenH * 0.85),
                center: true,
                maximized: true,
                decorations: isMac,
            });
            webview.once('tauri://error', (e) => console.error('Failed to open build model window:', e));
        } catch (err) {
            console.error('Error opening build model window:', err);
        } finally {
            pendingSpawnLabels.current.delete(label);
        }
    }, [initialState, emitBuildModelData]);

    // Close the (singleton, workspace-scoped) Build Model window when
    // leaving this workspace. It only ever fetches its data once, on its
    // own mount (see BuildModelWindow.tsx's `request-build-model-data`
    // round-trip) — it has no way to notice `main` switching to a
    // different workspace underneath it. Without this, staying open across
    // a switch means the next "Build Model" click here (now scoped to a
    // different workspace) just focuses the stale window via
    // `WebviewWindow.getByLabel('build-model')` above instead of opening
    // one for the new workspace — the user edits what looks like the right
    // project but is actually still writing to the old one.
    //
    // 2026-09-21: the Add Special Sensor window is workspace-scoped in
    // exactly the same way and was never closed here. It keeps the previous
    // project's sensor list, metadata (component/description) and recipes,
    // and — because its events are global broadcasts and it computes columns
    // in the ONE shared Rust session — kept feeding that project's special
    // sensors into whichever project was open next.
    useEffect(() => {
        return () => {
            for (const label of ['build-model', 'add-sensor']) {
                WebviewWindow.getByLabel(label)
                    .then(w => w?.close())
                    .catch(() => { /* ignore — window may already be gone */ });
            }
        };
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
                revision: dataRevision,
            }
            : null
    );
    // True dataset extent, independent of the current time filter — the one
    // source of truth for "what does this dataset span" (see the hook's own
    // docstring for why `view.ts_min`/`ts_max` can't serve this once any
    // time filter is applied). Fetched once per Dashboard mount.
    const { bounds: datasetBounds } = useDatasetTimeBounds();

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
        // Carry the LATEST fgGroups/fgModels (kept current by
        // toggleSensorGroupKind/createGroupForSensor, and by the
        // 'failure-group-state-changed' listener above whenever
        // BuildModelWindow or PredictiveModelBuild persist independently),
        // not the stale failureGroupState captured in `initialState` at
        // mount — otherwise this full-overwrite autosave would silently
        // erase what was just written via read-modify-write elsewhere.
        failureGroupState: { groups: fgGroups, models: fgModels, runningConditionFilters },
        alarmLinesEnabled,
        scatterAxes: scatterAxes ?? undefined,
        extraSensorMetadata,
        specialSensorRecipes,
        sensorColors,
        sensorAxisRange,
        scatterAxisPins,
        timeHighlights,
        highlightLineDisplay,
        valueHighlight,
        // lineTaggedPoints deliberately excluded — see the state's own
        // comment above for why (not meant to survive app close/reopen).
        relativeTimeRange: { amount: relativeAmount, unit: relativeUnit },
        ...overrides,
    }), [
        initialState, localName, selectedSensors, visibleSensors, operationConfig, filters, chartType,
        samplingMethod, collapsedPanels, layoutSizes, fgGroups, fgModels, runningConditionFilters, alarmLinesEnabled, scatterAxes,
        extraSensorMetadata, specialSensorRecipes, sensorColors, sensorAxisRange, scatterAxisPins, timeHighlights, highlightLineDisplay,
        valueHighlight, relativeAmount, relativeUnit,
    ]);

    // Keeps `buildWorkspaceStateRef` pointing at the current builder so the
    // callbacks declared above it (persistFailureGroupState) can reach it.
    // Runs after every render, so it is always current by the time any click
    // handler fires.
    useEffect(() => { buildWorkspaceStateRef.current = buildWorkspaceState; });

    // 2026-09-01: what the close-flush effect below awaits before actually
    // letting the window close — see its own comment for why this exists.
    // Always overwritten to the LATEST scheduled save on every effect rerun
    // (a superseded save's promise is simply abandoned, never left
    // dangling — nothing else ever holds a reference to it), so this always
    // points at "the save that still needs to land on disk", never a stale
    // one from an edit that's already been superseded by a newer one.
    const pendingSaveRef = useRef<Promise<void> | null>(null);

    // Auto-save state changes — debounced (see AUTOSAVE_DEBOUNCE_MS) so a
    // burst of rapid edits (typing, dragging a slider, resizing panels)
    // coalesces into ONE disk write instead of one per intermediate state.
    // Every relevant state change gives buildWorkspaceState a new identity,
    // which reruns this effect: the OLD timer is cleared (cleanup below)
    // and a new one queued, so only the LAST edit in a rapid burst ever
    // actually reaches disk — same "clear + requeue" shape as the
    // useChartData/useScatterSample debounce this mirrors.
    //
    // 🆕 2026-09-18 [CRITICAL FIX]: this write used to bake in this window's
    // OWN `fgGroups`/`fgModels`/`runningConditionFilters` mirror (via
    // `buildWorkspaceState()`'s default). That mirror is kept "current" only
    // by the `failure-group-state-changed` broadcast above — best-effort
    // cross-window IPC, not a guaranteed-ordered channel. If a Build Model /
    // Predictive Model window (a SEPARATE OS process — see CLAUDE.md's
    // "Windows & capabilities") wrote fresher failure-group state and its
    // broadcast hadn't landed here yet, then ANY Dashboard-only interaction
    // at all — panning a chart, toggling a sensor, nothing to do with
    // failure groups — re-armed this 250ms debounce and silently overwrote
    // that fresher data with this window's stale copy the moment it fired.
    // No rapid clicking or "Build Model" needed — this is exactly the "I
    // didn't touch anything, just closed and reopened the app" data-loss
    // report: the clobber happened quietly during the PRIOR session, and
    // reopening just revealed the already-corrupted file. Root-caused via
    // the "close/reopen with FG already gone" repro (rules out the
    // workspaceManager.ts same-window queue fix from earlier the same day —
    // that only serializes writes WITHIN one window, and this loss needed no
    // rapid same-window actions at all to reproduce).
    //
    // Fix: re-read `failureGroupState` fresh from disk right before writing,
    // instead of trusting this window's local mirror — same defensive
    // pattern `persistFailureGroupState` above already uses for
    // `runningConditionFilters`. This narrows the race to a genuine
    // near-simultaneous cross-window write (a few ms IPC round trip)
    // instead of "any stale mirror, arbitrarily late," but a fully
    // race-proof fix needs a Rust-side atomic read-modify-write across
    // processes — out of scope here, flagged separately.
    useEffect(() => {
        if (!initialState) return;
        let timer: ReturnType<typeof setTimeout>;
        pendingSaveRef.current = new Promise<void>((resolve) => {
            timer = setTimeout(async () => {
                let freshFailureGroupState = { groups: fgGroups, models: fgModels, runningConditionFilters };
                try {
                    const onDisk = await loadWorkspaceData(initialState.id);
                    if (onDisk?.failureGroupState) {
                        freshFailureGroupState = {
                            groups: onDisk.failureGroupState.groups,
                            models: onDisk.failureGroupState.models,
                            runningConditionFilters: onDisk.failureGroupState.runningConditionFilters ?? [],
                        };
                    }
                } catch (e) {
                    // Disk read failed — fall back to this window's own
                    // mirror rather than blocking the autosave entirely.
                    console.warn('Autosave: failed to re-read failureGroupState from disk, using local copy:', e);
                }
                const next = buildWorkspaceState({ failureGroupState: freshFailureGroupState });
                const payload = JSON.stringify(next);
                // 2026-09-03: skip the write when the state is byte-identical
                // to what is already on disk. Primarily this removes the
                // second of the two writes every failure-group toggle used to
                // cause — persistFailureGroupState writes immediately (so a
                // Build Model window opened right after reads fresh data),
                // then this autosave rewrote the exact same content 250ms
                // later — but it also covers any other path that reschedules
                // an autosave without actually changing anything.
                if (payload !== lastSavedPayloadRef.current) {
                    await saveWorkspaceData(next);
                    lastSavedPayloadRef.current = payload;
                }
                pendingSaveRef.current = null;
                resolve();
            }, AUTOSAVE_DEBOUNCE_MS);
        });
        return () => clearTimeout(timer);
    }, [buildWorkspaceState, initialState, fgGroups, fgModels, runningConditionFilters]);

    // 2026-09-01: flush a pending autosave before the window is actually
    // allowed to close, instead of letting a change made in the last
    // AUTOSAVE_DEBOUNCE_MS before quitting get silently lost — per
    // `docs/BACKLOG.md` item 8. `preventDefault()` on its own only BLOCKS
    // the close; it's still on us to call `.close()` ourselves once the
    // flush is done, or the window would become impossible to close at all
    // (a worse regression than the data loss this fixes). Only intercepts
    // the close when there's actually something pending — an already-saved
    // Dashboard closes exactly as before, no added delay.
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const win = getCurrentWindow();
        Promise.resolve(win.onCloseRequested(async (event) => {
            const pending = pendingSaveRef.current;
            if (!pending) return;
            event.preventDefault();
            await pending;
            await win.close();
        })).then(fn => { if (disposed) fn(); else unlisten = fn; });
        return () => { disposed = true; if (unlisten) unlisten(); };
    }, []);

    // ── Scatter / Pair-plot data path (bounded sample) ───────────────────
    // A 2 GB CSV is millions of rows; pushing every point to WebGL exhausts
    // GPU memory and blanks the canvas, and holding them all as JS objects
    // can OOM the renderer. So the scatter & pair-plot charts render a bounded
    // reservoir sample fetched from Rust — the payload, heap, and GPU buffers
    // stay constant regardless of dataset size. (The line chart uses
    // the equally-bounded `get_chart_data` path above.)
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
        dataRevision,
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

    // Data range for auto-filling the time inputs — the TRUE dataset extent
    // (see useDatasetTimeBounds), not `view.ts_min`/`ts_max`: those reflect
    // only the currently-filtered population, so once any time filter is
    // applied they'd shrink to the filtered window instead of staying the
    // full range "Reset Period" and this fallback need.
    const dataRange = useMemo(() => {
        if (datasetBounds?.min && datasetBounds?.max) {
            return { min: datasetBounds.min, max: datasetBounds.max };
        }
        return undefined;
    }, [datasetBounds]);

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
        // Anchored to the dataset's OWN last timestamp, not the machine's
        // clock — this data is historical and its end can sit anywhere
        // relative to today, so "today minus 6 months" routinely landed
        // outside the dataset entirely and silently produced 0 points.
        // Falls back to now only in the brief window before the dataset's
        // bounds have loaded.
        const end = datasetBounds?.max ? new Date(datasetBounds.max) : new Date();
        if (isNaN(end.getTime())) return;
        const start = subtractRelativeAmount(end, relativeUnit, n);
        handleFiltersChange({
            ...filters,
            timestampStart: formatForInput(start.toISOString()),
            timestampEnd: formatForInput(end.toISOString()),
        });
        setRelativeRangeApplied(true);
    }, [relativeAmount, relativeUnit, filters, handleFiltersChange, formatForInput, datasetBounds]);

    // First-open default: a genuinely fresh workspace (`initialState.filters`
    // was never saved — see `WorkspaceState.filters`'s docstring) starts
    // showing the dataset's last 6 months instead of everything, once its
    // real end timestamp is known. Fires at most once, ever, per workspace
    // — a workspace reopened with ANY previously-saved filters (including an
    // explicitly empty one from "Reset Period", which is meant to keep
    // showing everything) is left exactly as it was.
    const appliedInitialDefaultRangeRef = useRef(false);
    useEffect(() => {
        if (appliedInitialDefaultRangeRef.current) return;
        if (initialState?.filters) return;
        if (!datasetBounds?.max) return;
        appliedInitialDefaultRangeRef.current = true;
        const end = new Date(datasetBounds.max);
        if (isNaN(end.getTime())) return;
        const start = subtractRelativeAmount(end, 'M', 6);
        setRelativeAmount('6');
        setRelativeUnit('M');
        setRelativeRangeApplied(true);
        handleFiltersChange({
            ...filters,
            timestampStart: formatForInput(start.toISOString()),
            timestampEnd: formatForInput(end.toISOString()),
        });
        // `appliedInitialDefaultRangeRef` makes this a true one-shot no
        // matter how many times the effect re-runs — `initialState` never
        // changes post-mount, so in practice only `datasetBounds` arriving
        // triggers the run that actually does anything.
    }, [datasetBounds, initialState, filters, handleFiltersChange, formatForInput]);

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
                        valueHighlight={valueHighlight}
                    />
                )}
            </div>
            <div className="chart-bottom-tab">
                <div className="chart-tab-content">
                    <div className="time-range-tab-group">
                        <label>TIME RANGE</label>
                        <div className="time-range-inputs">
                            <div className="date-input-wrapper">
                                <input
                                    ref={timeRangeStartRef}
                                    type="datetime-local"
                                    value={displayTimestampStart}
                                    onChange={(e) => {
                                        handleFiltersChange({ ...filters, timestampStart: e.target.value });
                                        setRelativeRangeApplied(false);
                                    }}
                                    placeholder="Start Date"
                                />
                                {/* Flush against the box's own right edge
                                    and white — explicit color, not just
                                    `currentColor` inherited from the
                                    wrapper's dimmer text color, so it reads
                                    clearly against the dark input
                                    background instead of blending in. */}
                                <Calendar
                                    size={14}
                                    style={{ cursor: 'pointer', color: '#fff', marginLeft: 'auto' }}
                                    onClick={() => timeRangeStartRef.current?.showPicker?.()}
                                />
                            </div>
                            <span className="separator">-</span>
                            <div className="date-input-wrapper">
                                <input
                                    ref={timeRangeEndRef}
                                    type="datetime-local"
                                    value={displayTimestampEnd}
                                    onChange={(e) => {
                                        handleFiltersChange({ ...filters, timestampEnd: e.target.value });
                                        setRelativeRangeApplied(false);
                                    }}
                                    placeholder="End Date"
                                />
                                <Calendar
                                    size={14}
                                    style={{ cursor: 'pointer', color: '#fff', marginLeft: 'auto' }}
                                    onClick={() => timeRangeEndRef.current?.showPicker?.()}
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
                    {/* Always visible once the dataset's real bounds are
                        known (not gated on a filter being applied, unlike
                        Reset Period below) — tells the user up front what
                        time period the loaded data actually covers, since
                        the chart no longer defaults to showing all of it. */}
                    {dataRange && (
                        <span
                            className="data-range-hint"
                            title="First and last timestamp across the whole loaded dataset"
                        >
                            Data: {formatDateTime(new Date(dataRange.min))} – {formatDateTime(new Date(dataRange.max))}
                        </span>
                    )}
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
    // in-chart ECharts legend). The "Data Insight" tab (raw/aggregated table)
    // was removed 2026-08-16 — unused in practice; its leftover hook/component
    // and the `get_table_page` Rust command were deleted 2026-09-20.
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
                    {/* 2026-09-01: the "N Rows" sanity-check badge that used to sit
                        here was removed per explicit user request — it always showed
                        the exact same figure as the chart's own "X / Y pts
                        (downsampled)" badge above (both read `view.total_rows`), so
                        it was pure redundancy, not a second, independent number. */}
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
                        valueHighlight={valueHighlight}
                        valueHighlightSensors={scatterChartHeaders}
                        onSetValueHighlightSensor={handleSetValueHighlightSensor}
                        onAddValueHighlightRange={handleAddValueHighlightRange}
                        onToggleValueHighlightRange={handleToggleValueHighlightRange}
                        onRemoveValueHighlightRange={handleRemoveValueHighlightRange}
                        onRecolorValueHighlightRange={handleRecolorValueHighlightRange}
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
                                                            fontSize: '0.75rem', outline: 'none',
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
                                                            fontSize: '0.75rem', outline: 'none',
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
                            {tab === 'sensor' ? `Sensor (${allSensorTags.length})` : 'Failure Groups'}
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
                        sensors={allSensorTags}
                        selectedSensors={selectedSensors}
                        onSensorChange={setSelectedSensors}
                        maxSelectable={chartType === 'pair' ? MAX_PAIR_PLOT_SENSORS : undefined}
                        sensorMetadata={sensorMetadata}
                        fgGroups={fgGroups}
                        fgModels={fgModels}
                        getGroupColor={getFgGroupColor}
                        onToggleSensorGroupKind={toggleSensorGroupKind}
                        onCreateGroupForSensor={createGroupForSensor}
                        onRenameGroup={renameGroup}
                        onDeleteGroup={deleteGroup}
                        alarmLinesEnabled={alarmLinesEnabled}
                        onToggleAlarmLine={toggleAlarmLine}
                    />
                ) : (
                    <FailureGroupsPanel
                        fgGroups={fgGroups}
                        fgModels={fgModels}
                        sensorMetadata={sensorMetadata}
                        getGroupColor={getFgGroupColor}
                        onUpdateGroupDetails={updateGroupDetails}
                        onDeleteGroup={deleteGroup}
                        onCreateEmptyGroup={createEmptyGroup}
                        onDeleteModel={deleteModel}
                        onOpenBuildModel={spawnBuildModel}
                    />
                )}
            </div>
            {activeSensorTab === 'sensor' && (
                <div className="widget-footer">
                    <button
                        className="add-sensor-btn"
                        onClick={async () => {
                            const existing = await WebviewWindow.getByLabel('add-sensor');
                            if (existing) {
                                // Already open — creating another with the
                                // same label just errors. Focus it and hand
                                // it this workspace's data afresh.
                                try { await existing.setFocus(); } catch { /* ignore */ }
                                const cur = stateRef.current;
                                emit('sensors-data', {
                                    workspaceId: workspaceIdRef.current,
                                    sensors: cur.allSensorTags,
                                    selectedSensors: cur.selectedSensors,
                                    sensorMetadata: cur.sensorMetadata,
                                    specialSensorRecipes: cur.specialSensorRecipes,
                                    models: cur.fgModels,
                                });
                                return;
                            }
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
