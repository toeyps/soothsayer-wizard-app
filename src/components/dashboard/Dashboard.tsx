import { useState, useMemo, useEffect, useDeferredValue, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { emit, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Split from 'split.js';
import { loadWorkspaceData, saveWorkspaceFrom, updateWorkspaceData } from '../../workspaceManager';
import { withFailureGroupState, restoreDeletedModel } from '../../utils/failureGroupState';
import { modelsOnlyIn, modelSensorKey, sensorCategory } from '../../utils/modelGrouping';
import { seedHealthSetPoints } from '../../utils/healthSetPoints';
import { subscribe } from '../../utils/tauriEvents';
import {
    CsvMetadata, SensorMetadata, CsvRecord, SensorOperationConfig, SpecialSensorRecipe,
    WorkspaceState, DashboardLayoutSizes, DashboardSlot, DashboardPanel, DashboardSlotMap,
    FailureGroup, FailureModel, ModelKind, ModelCategory, AlarmLevel, ScatterAxisPins, TimeHighlight, ValueHighlight, LineTaggedPoint,
    FailureGroupStateSlice, FailureGroupStateChangedPayload, WorkspaceSensorFilter, UpdateSpecialSensorPayload,
} from '../../types';
import type { DashboardDataFilter } from '../../types/commands';
// `DashboardSlotMap` is not persisted in WorkspaceState; the type only
// describes the constant slot→panel mapping below.

import { Chart, defaultSensorColor, LINE_CHART_COLORS, MAX_PAIR_PLOT_SENSORS, RANGE_PALETTE, type ChartMarkLine } from '../charts';
import { rgbaToHex } from '../charts/pairPlotColors';
import { ALARM_LEVELS, alarmLevelColor } from '../../utils/alarmLevels';
import FilterPanel, { FilterState, FilterSensorChange } from './FilterPanel';
import SensorSelection from './SensorSelection';
import UndoToastStack from './UndoToastStack';
import Portal from '../Portal';
import BuildModelHungDialog from './BuildModelHungDialog';
import { UNDO_SECONDS } from './FailureGroupAssignSheet';
import { kindModelName } from '../../utils/modelNames';
import { defaultModelName } from './defaultModelName';
import FailureGroupsPanel from './FailureGroupsPanel';
import { NOT_IN_GROUP, appendFailureGroup, applyFailureGroupDetails, isDuplicateFailureGroupName } from './failureGroupOps';
import { getFgGroupColor } from '../../utils/failureGroupColor';
import { realFailureGroups } from '../../utils/failureGroupSummary';
import HighlightsPanel from './HighlightsPanel';
import { DateTime24Input } from '../windows/DateTime24Input';
import { stopRunningEngine } from '../windows/engineStop';
import ColourPicker from '../sensor/ColourPicker';
import { SensorLabel, SensorSetProvider } from '../sensor/SensorLabel';
import { SensorMetaContext, buildSensorLookup, sensorPlainLabel, useLayeredSensorLookup } from '../sensor/sensorInfo';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import { useScatterSample, ScatterSampleFilter } from '../../hooks/useScatterSample';
import { reportError } from '../../errorReporter';
import { useChartData } from '../../hooks/useChartData';
import { useDatasetTimeBounds } from '../../hooks/useDatasetTimeBounds';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { renameTagInArray, renameTagInRecord, renameTagInModels, renameTagInRunningConditionFilters, removeTagsFromFilters } from '../../utils/specialSensorRename';
import { mergeIntoPlot, type AddSensorSelectionPayload } from '../../utils/specialSensorPlot';
import { reorderRecipesByTags } from '../../utils/specialSensorDeps';
import { demoteModelsTrainedOnSensors } from '../../utils/specialSensorRepair';
import { applyRecipeRule, recipesDiffer } from '../../utils/incompleteRule';

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { Plus, EyeOff, BarChart3, Radio, ArrowLeft, Check, Trash2, LineChart as LineChartIcon, X, RotateCcw } from 'lucide-react';
import { debugLog } from '../../utils/debugLog';
import { formatDateTime } from '../../utils/dateFormat';

const PANELS = {
    chart: { id: 'chart', label: 'Chart', icon: BarChart3 },
    sensors: { id: 'sensors', label: 'Sensors', icon: Radio },
    data: { id: 'data', label: 'Control Chart', icon: LineChartIcon }
} as const;


/** Tags compare case-insensitively, as in the `byTag` maps below. */
const sameTag = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A model's key is targetSensor (individual/relationship) or xSensor (clustering). Pure: runs on the mirror and on disk.
const findKindIn = (models: FailureModel[], tag: string, kind: ModelKind) =>
    models.find(m => m.kind === kind && modelSensorKey(m) === normalizeSensorTag(tag));

type PanelId = keyof typeof PANELS;

// One "<Kind> model of <sensor> deleted — Undo" toast (see toggleSensorGroupKind).
interface FgUndoEntry {
    id: string;
    message: string;
    /** Filled from the mirror, then replaced by the on-disk copy when the write runs (disk is the truth). */
    captured: { model: FailureModel };
}
// A burst of removals can't pile up an unbounded wall of toasts.
const MAX_UNDO_TOASTS = 3;

// Initial split ratios when none are saved; 66.67/33.33 mirrors the CSS grid `2fr 1fr`.
const DEFAULT_LAYOUT_SIZES: DashboardLayoutSizes = {
    columns: [66.67, 33.33],
    leftRows: [60, 40],
};

const SLOT_LAYOUT: DashboardSlotMap = {
    'left-top': 'chart',
    'left-bottom': 'data',
    'right-top': 'sensors',
};

// All slots in render order — used to build the JSX of the two columns.
const LEFT_SLOTS: DashboardSlot[] = ['left-top', 'left-bottom'];
const RIGHT_SLOTS: DashboardSlot[] = ['right-top'];

// Rust min/max-decimates to this many x-positions (~2 per pixel), keeping IPC and heap bounded.
const LINE_MAX_POINTS = 4000;
/** Pair Plot draws the sample once per cell (up to 10 WebGL canvases), so its cap is far smaller than Scatter's. */
const SCATTER_MAX_POINTS = 200_000;
const PAIR_MAX_POINTS = 10_000;
// Debounces the autosave so each keystroke does not cause a JSON.stringify + disk write.
const AUTOSAVE_DEBOUNCE_MS = 250;
/** A write that hangs must not keep the window open for ever: past this it counts as failed. */
const CLOSE_SAVE_WAIT_MS = 10_000;
const CLOSE_SAVE_FAILED_NOTICE = 'Could not save your latest changes to the project file. Close the window again to leave without them.';
const AUTOSAVE_FAILED_NOTICE = 'Could not save your latest changes to the project file. It will try again with your next change.';
/** A child window that does not answer must not keep the main window open. */
const CHILD_CLOSE_WAIT_MS = 2_000;
/** Build Model says it saw a close request within this, or a second X may offer to force it. */
const BUILD_MODEL_ACK_WAIT_MS = 3_000;
/** A Build Model with nothing to ask is gone by then, so it does not blink. */
const BUILD_MODEL_RAISE_DELAY_MS = 300;
const BUILD_MODEL_ANSWER_NOTICE = 'Build Model needs an answer before the app can close.';
const BUILD_MODEL_UNREACHABLE_NOTICE = 'Could not reach the Build Model window, so nothing was closed. Close this window again to retry.';

type BuildModelHandle = NonNullable<Awaited<ReturnType<typeof WebviewWindow.getByLabel>>>;

/** A minimized window ignores setFocus, so restore it first. */
async function bringToFront(window: BuildModelHandle): Promise<void> {
    try { await window.unminimize(); } catch { /* still try to focus */ }
    try { await window.setFocus(); } catch { /* best effort */ }
}
const FG_SAVE_FAILED_NOTICE = 'Could not save your last Failure Group change. The screen is back to what the project file holds.';
const FG_SAVE_FAILED_UNREAD_NOTICE = 'Could not save your last Failure Group change, and the project file could not be read. What you see may not match the file.';
const RENAME_MODELS_FAILED_NOTICE = 'Could not update the models that use the renamed sensor. In the project file they still use its old name: reopen the project and check them.';
const REPAIR_DEMOTE_FAILED_NOTICE = 'Could not set the models that use the fixed sensor back to Incomplete. Its values changed, so train them again.';

/** Old workspace files may carry `highlightLineDisplay`; it is ignored on load and dropped by the next autosave. */
type LegacyWorkspaceFields = { highlightLineDisplay?: unknown };

function withoutLegacyWorkspaceFields(state: WorkspaceState | null | undefined): WorkspaceState {
    const { highlightLineDisplay: _droppedLineDisplay, ...rest } = (state ?? {}) as WorkspaceState & LegacyWorkspaceFields;
    return rest as WorkspaceState;
}

type RelativeRangeUnit = 'Y' | 'M' | 'W' | 'D' | 'H';

/** `end` minus `n` units: calendar-accurate for Y/M (month-end clamped), plain ms for W/D/H. */
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

// Stable empty array for the line chart's unused `data` prop (it reads `columnar`).
const EMPTY_RECORDS: CsvRecord[] = [];

// Wide 12px hit target with a thin centred line, so the handle is easy to grab.
const createGutter = (_index: number, direction: 'horizontal' | 'vertical'): HTMLElement => {
    const el = document.createElement('div');
    el.className = `gutter gutter-${direction}`;
    return el;
};

// Set `flex-basis` inline: in a flex layout it overrides split.js's width/height, so dragging would do nothing.
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


/** Name, description, machine and time zone are written only by `saveProjectDetails`; full writes carry them over from disk. */
function projectDetailsFromDisk(disk: WorkspaceState | null | undefined): Partial<WorkspaceState> {
    if (!disk) return {};
    return {
        // A file always has a name; never blank this window's out if not.
        ...(disk.name !== undefined ? { name: disk.name } : {}),
        description: disk.description,
        machine: disk.machine,
        dataUtcOffsetMin: disk.dataUtcOffsetMin,
    };
}

const Dashboard = forwardRef<DashboardRef, DashboardProps>(({ metadata, sensorMetadata: sensorMetadataProp, onBack, initialState }, ref) => {
    const [localName, setLocalName] = useState(initialState?.name || "");

    // Raw CSV columns plus persisted special sensors (they have metadata but no CSV column).
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

    // Metadata of special sensors created at runtime; merged into `sensorMetadata`.
    const [extraSensorMetadata, setExtraSensorMetadata] = useState<SensorMetadata[]>(
        initialState?.extraSensorMetadata ?? []
    );
    // Recipes are replayed after `load_csv` on the next open; `extraSensorMetadata` is cosmetic only.
    const [specialSensorRecipes, setSpecialSensorRecipes] = useState<SpecialSensorRecipe[]>(
        initialState?.specialSensorRecipes ?? []
    );
    // Bumped when a special sensor's column is recomputed so chart/scatter queries refetch; not persisted.
    const [dataRevision, setDataRevision] = useState(0);
    // Tells an open Filter panel to apply a special-sensor rename/delete to its draft; `id` bumps per event; not persisted.
    const [filterSensorChange, setFilterSensorChange] = useState<FilterSensorChange>({ id: 0 });
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

    // Derived each render so a selected or described tag is always pickable, however it got there.
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

    // In-place rename only — it never spawns a window or touches workspace IDs.
    useImperativeHandle(ref, () => ({
        renameWorkspace: (newName: string) => {
            setLocalName(newName);
        }
    }));

    const deferredSensors = useDeferredValue(selectedSensors);

    // Sync visibleSensors with selectedSensors without un-hiding hidden ones: 'new' means not in the PREVIOUS selection.
    const prevSelectedRef = useRef<string[]>(initialState?.visibleSensors ? selectedSensors : []);
    useEffect(() => {
        const before = prevSelectedRef.current;
        prevSelectedRef.current = selectedSensors;
        setVisibleSensors(prev => {
            const stillSelected = prev.filter(s => selectedSensors.includes(s));
            const newlySelected = selectedSensors.filter(s => !before.includes(s) && !stillSelected.includes(s));
            return [...stillSelected, ...newlySelected];
        });
    }, [selectedSensors]);

    const toggleSensorVisibility = useCallback((sensor: string) => {
        setVisibleSensors(prev =>
            prev.includes(sensor) ? prev.filter(s => s !== sensor) : [...prev, sensor]
        );
    }, []);

    const removeSensor = useCallback((sensor: string) => {
        setSelectedSensors(prev => prev.filter(s => s !== sensor));
    }, []);

    // Respects the Pair Plot cap (`maxSelectable`).
    const showSensorOnChart = useCallback((sensor: string) => {
        setSelectedSensors(prev => {
            if (prev.includes(sensor)) return prev;
            if (chartTypeRef.current === 'pair' && prev.length >= MAX_PAIR_PLOT_SENSORS) return prev;
            return [...prev, sensor];
        });
    }, []);

    // Bulk equivalent of removeSensor — drops every plotted sensor at once
    // (the "Clear all" action in the Selected Sensor tab header).
    const clearAllSensors = useCallback(() => {
        setSelectedSensors([]);
    }, []);

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    // Every sensor label, picker and tooltip resolves through this lookup.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata, specialSensorRecipes);
    const sensorLookupRef = useRef(sensorLookup);
    sensorLookupRef.current = sensorLookup;
    const getSensorMeta = useCallback(
        (sensor: string) => sensorMetaMap.get(normalizeSensorTag(sensor)) ?? null,
        [sensorMetaMap]
    );

    // Shared with Build Model; writes are read-modify-write via `updateWorkspaceData`.
    // One model per (tag, kind); membership = the model's `groupNos` includes the group.
    const [fgGroups, setFgGroups] = useState<FailureGroup[]>(
        initialState?.failureGroupState?.groups ?? [NOT_IN_GROUP]
    );
    const [fgModels, setFgModels] = useState<FailureModel[]>(
        initialState?.failureGroupState?.models ?? []
    );
    // Rest of `failureGroupState`, mirrored whole so the full-overwrite autosave cannot erase it. Never feeds filters.
    const [fgExtra, setFgExtra] = useState<Omit<FailureGroupStateSlice, 'groups' | 'models'>>(() => {
        const { groups: _g, models: _m, ...rest } = initialState?.failureGroupState ?? { groups: [], models: [] };
        void _g; void _m;
        return rest;
    });

    // Writes this window has in flight (autosave and failure-group): a close waits for them.
    const writesRef = useRef(new Set<Promise<void>>());
    const trackWrite = useCallback((write: Promise<unknown>) => {
        const done: Promise<void> = write.then(() => undefined, () => undefined).then(() => { writesRef.current.delete(done); });
        writesRef.current.add(done);
        return done;
    }, []);
    const fgWriteFailedRef = useRef(false);
    const [saveNotice, setSaveNotice] = useState<string | null>(null);
    const adoptFgSlice = useCallback((slice: FailureGroupStateSlice) => {
        const { groups, models, ...rest } = slice;
        setFgGroups(groups);
        setFgModels(models);
        setFgExtra(rest);
    }, []);

    // `compute` gets groups/models fresh from disk, not the mirror; other slice fields carry through `withFailureGroupState`.
    // `compute` may return `runningConditionFilters` (re-keyed on rename); a failed write reloads the mirror and tells the user.
    const persistFailureGroupStateFrom = useCallback((
        compute: (disk: { groups: FailureGroup[]; models: FailureModel[]; runningConditionFilters: WorkspaceSensorFilter[] }) => {
            groups: FailureGroup[]; models: FailureModel[]; runningConditionFilters?: WorkspaceSensorFilter[];
        },
        failure?: { notice?: string; onFailed?: () => void },
    ) => {
        if (!initialState) return;
        const write = updateWorkspaceData(initialState.id, prev => {
            const before = prev.failureGroupState;
            const result = compute({
                groups: before?.groups ?? [],
                models: before?.models ?? [],
                runningConditionFilters: before?.runningConditionFilters ?? [],
            });
            // The first model created here marks the category clean-up as handled.
            const seed = (before?.models ?? []).length === 0 && result.models.length > 0
                ? {
                    ...(before?.categoryNormalisationNotice === undefined ? { categoryNormalisationNotice: null } : {}),
                }
                : {};
            return withFailureGroupState(prev, { ...result, ...seed });
        })
            .then((next) => {
                // Adopt the whole slice from disk (incl. `fgExtra`): another window may have written first.
                if (!next) throw new Error('The project file is missing.');
                if (next.failureGroupState) {
                    adoptFgSlice(next.failureGroupState);
                    // Tell open Build Model windows; scoped to this workspace and tagged so our listener skips the echo.
                    emit('failure-group-state-changed', {
                        ...next.failureGroupState,
                        workspaceId: initialState.id,
                        origin: 'dashboard',
                    }).catch(e => console.warn('Failed to broadcast failure-group state:', e));
                }
            })
            .catch(async (e) => {
                console.error('Failed to persist failure-group assignment from Dashboard:', e);
                fgWriteFailedRef.current = true;
                failure?.onFailed?.();
                let slice: FailureGroupStateSlice | undefined;
                try {
                    slice = (await loadWorkspaceData(initialState.id))?.failureGroupState;
                } catch (readError) {
                    console.warn('Could not reload the failure groups after a failed write:', readError);
                }
                if (slice) adoptFgSlice(slice);
                setSaveNotice(failure?.notice ?? (slice ? FG_SAVE_FAILED_NOTICE : FG_SAVE_FAILED_UNREAD_NOTICE));
            });
        trackWrite(write);
    }, [initialState, adoptFgSlice, trackWrite]);

    // Every FG writer derives its result from disk via `persistFailureGroupStateFrom`, never from the mirror.

    // Keeps the mirror current with Build Model's writes; drops other workspaces' events and our own echo.
    const currentWorkspaceId = initialState?.id;
    useEffect(() => subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
        if (event.payload.workspaceId !== currentWorkspaceId) return;
        if (event.payload.origin === 'dashboard') return;
        const { groups, models, workspaceId: _w, origin: _o, ...rest } = event.payload;
        void _w; void _o;
        setFgGroups(groups);
        setFgModels(models);
        setFgExtra(rest);
    }), [currentWorkspaceId]);

    // Defaults for a new model; clustering seeds the sensor as X, Y blank. Category is inherited; name is unique among `models`.
    const makeDefaultModelForKind = useCallback((models: readonly FailureModel[], tag: string, groupNos: number[], kind: ModelKind, category: ModelCategory | null = null): FailureModel => ({
        id: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        groupNos,
        name: defaultModelName(models, getSensorMeta(tag)?.description || tag, kind),
        kind,
        category,
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
        // One cluster by default: 2+ needs a criteria sensor (Rust refuses otherwise).
        numClusters: 1,
        criteriaSensor: '',
        clusterRanges: [],
        filterTimePeriods: [],
        runningConditionMode: 'workspace',
        customRunningConditionFilters: [],
        customRunningConditionCombine: 'and',
        // Individual snapshots the master alarmL/alarmH (null if none) as prefill; other kinds start empty. Never written back.
        healthSetPoints: seedHealthSetPoints(kind, getSensorMeta(tag) ?? null),
    }), [getSensorMeta]);

    const isDuplicateGroupName = useCallback((name: string, excludeNo?: number) =>
        isDuplicateFailureGroupName(fgGroups, name, excludeNo),
    [fgGroups]);

    // Per-group toggle of a kind: reuses the sensor's model (dropping sentinel `0`) or creates one; deletes it with its last group.
    // Pure: runs on the mirror for instant UI and on disk inside the write, so a stale mirror can't revert another window.
    const applyToggle = useCallback((models: FailureModel[], tag: string, groupNo: number, kind: ModelKind): FailureModel[] => {
        const existing = findKindIn(models, tag, kind);
        const isMember = !!existing && existing.groupNos.includes(groupNo);
        if (isMember) {
            const remaining = existing!.groupNos.filter(n => n !== groupNo);
            return remaining.length > 0
                ? models.map(m => m === existing ? { ...m, groupNos: remaining } : m)
                : models.filter(m => m !== existing);
        }
        if (existing) {
            return models.map(m => m === existing
                ? { ...m, groupNos: [...new Set([...m.groupNos.filter(n => n !== 0), groupNo])] }
                : m);
        }
        return [...models, makeDefaultModelForKind(models, tag, [groupNo], kind, sensorCategory(models, normalizeSensorTag(tag)))];
    }, [makeDefaultModelForKind]);

    // Removing a model's last group deletes it at once with a 7 s Undo toast; Undo restores it via the disk-derived write.
    const [undoToasts, setUndoToasts] = useState<FgUndoEntry[]>([]);
    const undoSeq = useRef(0);
    const dismissUndo = useCallback((id: string) => {
        setUndoToasts(prev => prev.filter(t => t.id !== id));
    }, []);
    // An expired or pushed-out Undo just disappears.
    const undoToastsRef = useRef(undoToasts);
    undoToastsRef.current = undoToasts;
    const expireUndo = useCallback((id: string) => {
        dismissUndo(id);
    }, [dismissUndo]);

    const toggleSensorGroupKind = useCallback((tag: string, groupNo: number, kind: ModelKind) => {
        const existing = findKindIn(fgModels, tag, kind);
        const deletesModel = !!existing && existing.groupNos.length === 1 && existing.groupNos[0] === groupNo;
        const entry: FgUndoEntry | null = deletesModel
            ? {
                id: `undo-${++undoSeq.current}`,
                message: `${kindModelName(kind)} of ${getSensorMeta(tag)?.description || tag} deleted`,
                captured: { model: existing! },
            }
            : null;
        let announced: FgUndoEntry | null = null;
        const announce = (e: FgUndoEntry) => {
            if (announced) return;
            announced = e;
            setUndoToasts(prev => [...prev, e].slice(-MAX_UNDO_TOASTS));
        };
        if (entry) announce(entry);

        setFgModels(applyToggle(fgModels, tag, groupNo, kind));
        persistFailureGroupStateFrom(disk => {
            const models = applyToggle(disk.models, tag, groupNo, kind);
            const onDisk = findKindIn(disk.models, tag, kind);
            const removedOnDisk = !!onDisk && !models.some(m => m.id === onDisk.id);
            if (removedOnDisk) {
                // Undo restores what disk holds; if the mirror missed the deletion, announce it from here.
                const e = entry ?? {
                    id: `undo-${++undoSeq.current}`,
                    message: `${kindModelName(kind)} of ${getSensorMeta(tag)?.description || tag} deleted`,
                    captured: { model: onDisk! },
                };
                e.captured.model = onDisk!;
                announce(e);
            } else if (entry) {
                // Disk shows the model survives (another window added a group): retract the toast.
                dismissUndo(entry.id);
            }
            return { groups: disk.groups, models };
        }, {
            // Nothing was deleted: an Undo for it would be a lie.
            onFailed: () => { if (announced) dismissUndo(announced.id); },
        });
    }, [fgModels, applyToggle, persistFailureGroupStateFrom, getSensorMeta, dismissUndo]);

    const undoModelDeletion = useCallback((id: string) => {
        const entry = undoToasts.find(t => t.id === id);
        // Out of the ref at once, so an expiry firing before the re-render cannot finalize it.
        undoToastsRef.current = undoToastsRef.current.filter(t => t.id !== id);
        dismissUndo(id);
        if (!entry) return;
        const original = entry.captured.model;
        setFgModels(restoreDeletedModel(fgGroups, fgModels, original));
        persistFailureGroupStateFrom(disk => ({
            groups: disk.groups,
            models: restoreDeletedModel(disk.groups, disk.models, original),
        }));
    }, [undoToasts, dismissUndo, fgGroups, fgModels, persistFailureGroupStateFrom]);

    // Creates the empty group and puts this sensor's Individual model (reused or new) in it; other kinds are added via the toggle.
    const createGroupForSensor = useCallback((tag: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed || isDuplicateGroupName(trimmed)) return;
        // Pure over (groups, models) so it can run against the mirror (instant
        // UI) and again against disk inside the write.
        const build = (groups: FailureGroup[], models: FailureModel[]) => {
            const nextGroups = appendFailureGroup(groups, trimmed);
            const newGroupNo = nextGroups[nextGroups.length - 1].no;
            const existing = findKindIn(models, tag, 'individual');
            return {
                groups: nextGroups,
                models: existing
                    ? models.map(m => m === existing
                        ? { ...m, groupNos: [...new Set([...m.groupNos.filter(n => n !== 0), newGroupNo])] }
                        : m)
                    : [...models, makeDefaultModelForKind(models, tag, [newGroupNo], 'individual', sensorCategory(models, normalizeSensorTag(tag)))],
            };
        };
        const optimistic = build(fgGroups, fgModels);
        setFgGroups(optimistic.groups);
        setFgModels(optimistic.models);
        persistFailureGroupStateFrom(disk => build(disk.groups, disk.models));
    }, [fgGroups, fgModels, isDuplicateGroupName, makeDefaultModelForKind, persistFailureGroupStateFrom]);

    // No confirmation.
    const deleteModel = useCallback((modelId: string) => {
        setFgModels(fgModels.filter(m => m.id !== modelId));
        persistFailureGroupStateFrom(disk => ({ groups: disk.groups, models: disk.models.filter(m => m.id !== modelId) }));
    }, [fgModels, persistFailureGroupStateFrom]);

    // Group-wide, not per sensor, so these act on groups/models directly.
    const renameGroup = useCallback((groupNo: number, name: string) => {
        const trimmed = name.trim();
        if (!trimmed || isDuplicateGroupName(trimmed, groupNo)) return;
        const apply = (groups: FailureGroup[]) => groups.map(g => g.no === groupNo ? { ...g, name: trimmed } : g);
        setFgGroups(apply(fgGroups));
        // Computed against DISK inside the write: only groups change, models stay as on disk.
        persistFailureGroupStateFrom(disk => ({ groups: apply(disk.groups), models: disk.models }));
    }, [fgGroups, isDuplicateGroupName, persistFailureGroupStateFrom]);

    // Plain apply: FailureGroupsPanel checks duplicate names before calling.
    const updateGroupDetails = useCallback((groupNo: number, name: string, description: string, recommendation: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const apply = (groups: FailureGroup[]) => applyFailureGroupDetails(groups, groupNo, trimmed, description, recommendation);
        setFgGroups(apply(fgGroups));
        persistFailureGroupStateFrom(disk => ({ groups: apply(disk.groups), models: disk.models }));
    }, [fgGroups, persistFailureGroupStateFrom]);

    // Deletes models only in this group; a model also in another group just loses this one.
    const deleteGroup = useCallback((groupNo: number) => {
        if (groupNo === 0) return;
        const apply = (groups: FailureGroup[], models: FailureModel[]) => {
            const gone = new Set(modelsOnlyIn(models, groupNo).map(m => m.id));
            return {
                groups: groups.filter(g => g.no !== groupNo),
                models: models
                    .filter(m => !gone.has(m.id))
                    .map(m => (m.groupNos.includes(groupNo) ? { ...m, groupNos: m.groupNos.filter(n => n !== groupNo) } : m)),
            };
        };
        const optimistic = apply(fgGroups, fgModels);
        setFgGroups(optimistic.groups);
        setFgModels(optimistic.models);
        persistFailureGroupStateFrom(disk => apply(disk.groups, disk.models));
    }, [fgGroups, fgModels, persistFailureGroupStateFrom]);

    // Opens on the Failure Groups tab after Import step 3 or when the project has no real groups; decided once at mount.
    const [activeSensorTab, setActiveSensorTab] = useState<'sensor' | 'failure-groups'>(() =>
        initialState?.lastRoute === 'failure-group'
            || realFailureGroups(initialState?.failureGroupState?.groups).length === 0
            ? 'failure-groups' : 'sensor'
    );
    // Group the Sensor tab is filling after 'Assign sensors'; null = ordinary tab. Cleared by Done and on returning to the FG tab.
    const [assignGroupNo, setAssignGroupNo] = useState<number | null>(null);
    const startAssignSensors = useCallback((groupNo: number) => {
        setAssignGroupNo(groupNo);
        setActiveSensorTab('sensor');
    }, []);
    // After Done, focus that group's 'Assign sensors' link if still there, else the FG tab button; applied once the tab renders.
    const sensorsSectionRef = useRef<HTMLDivElement>(null);
    const fgTabButtonRef = useRef<HTMLButtonElement>(null);
    const focusAfterAssignRef = useRef<number | null>(null);
    const finishAssignSensors = useCallback(() => {
        focusAfterAssignRef.current = assignGroupNo ?? 0;
        setAssignGroupNo(null);
        setActiveSensorTab('failure-groups');
    }, [assignGroupNo]);
    useEffect(() => {
        const no = focusAfterAssignRef.current;
        if (no === null || activeSensorTab !== 'failure-groups') return;
        focusAfterAssignRef.current = null;
        const link = sensorsSectionRef.current?.querySelector<HTMLElement>(`[data-assign-group="${no}"]`);
        (link ?? fgTabButtonRef.current)?.focus();
    }, [activeSensorTab]);
    // End the run if the group was deleted, so a reused group number does not revive the bar.
    useEffect(() => {
        if (assignGroupNo !== null && !fgGroups.some(g => g.no === assignGroupNo)) setAssignGroupNo(null);
    }, [fgGroups, assignGroupNo]);

    const createEmptyGroup = useCallback((name: string) => {
        const trimmed = name.trim();
        if (!trimmed || isDuplicateGroupName(trimmed)) return;
        const add = (groups: FailureGroup[]) => appendFailureGroup(groups, trimmed);
        setFgGroups(add(fgGroups));
        persistFailureGroupStateFrom(disk => ({ groups: add(disk.groups), models: disk.models }));
    }, [fgGroups, isDuplicateGroupName, persistFailureGroupStateFrom]);

    // Per-sensor line-color override and pinned Y-axis bounds, set from the
    // "Selected Sensor" tab.
    const [sensorColors, setSensorColors] = useState<Record<string, string>>(initialState?.sensorColors ?? {});
    // min and max are independently optional; an unset side auto-fits.
    const [sensorAxisRange, setSensorAxisRange] = useState<Record<string, { min?: number; max?: number }>>(
        initialState?.sensorAxisRange ?? {}
    );

    // Lifted here because Chart.tsx unmounts ScatterChart on chart-type switch, which would reset the pair.
    const [scatterAxes, setScatterAxes] = useState<{ x: string; y: string } | null>(initialState?.scatterAxes ?? null);
    const handleScatterAxesChange = useCallback((x: string, y: string) => {
        setScatterAxes(prev => (prev?.x === x && prev?.y === y) ? prev : { x, y });
    }, []);

    // Pinned axis scale, lifted for the same reason as `scatterAxes`.
    const [scatterAxisPins, setScatterAxisPins] = useState<ScatterAxisPins>(initialState?.scatterAxisPins ?? {});
    const handleScatterAxisPinsChange = useCallback((pins: ScatterAxisPins) => {
        setScatterAxisPins(pins);
    }, []);

    // Lifted so tags survive a chart-type switch; deliberately not persisted. Scatter tags stay local to ScatterChart.
    const [lineTaggedPoints, setLineTaggedPoints] = useState<LineTaggedPoint[]>([]);
    const handleLineTaggedPointsChange = useCallback((points: LineTaggedPoint[]) => {
        setLineTaggedPoints(points);
    }, []);
    // The chart renders its tag table into `tagTableHost` (null while the tab is closed) and reports the tag count.
    const [tagTableHost, setTagTableHost] = useState<HTMLElement | null>(null);
    const [tagCount, setTagCount] = useState(0);
    const [activeDataTab, setActiveDataTab] = useState<'selected' | 'filter' | 'highlights' | 'tags'>('selected');
    const handleTagCountChange = useCallback((count: number, added: boolean) => {
        setTagCount(count);
        // Tagging a point is asking for its values: open the tab they are in.
        if (added) setActiveDataTab('tags');
    }, []);

    // Global across chart types except Pair Plot.
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

    // Scatter-only; one sensor plus ranges, because Scatter has a single colour channel.
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

    // Drop the criteria sensor and its ranges when it leaves the selection.
    useEffect(() => {
        if (valueHighlight.sensor && !selectedSensors.includes(valueHighlight.sensor)) {
            setValueHighlight({ sensor: '', ranges: [] });
        }
    }, [selectedSensors, valueHighlight.sensor]);

    // Declared here because `buildWorkspaceState` above reads it. Y/M are calendar units; W/D/H plain ms.
    const RANGE_UNITS = ['Y', 'M', 'W', 'D', 'H'] as const;
    type RangeUnit = typeof RANGE_UNITS[number];
    const [relativeAmount, setRelativeAmount] = useState(initialState?.relativeTimeRange?.amount ?? '1');
    const [relativeUnit, setRelativeUnit] = useState<RangeUnit>(initialState?.relativeTimeRange?.unit ?? 'D');
    // True only if the shown dates came from the last Apply; cleared on manual edit. Not persisted: reloaded dates may differ.
    const [relativeRangeApplied, setRelativeRangeApplied] = useState(false);

    const setSensorColor = useCallback((sensor: string, color: string) => {
        setSensorColors(prev => ({ ...prev, [sensor]: color }));
    }, []);

    // Palette slot per sensor for this window's lifetime; a slot never moves.
    const colorSlotsRef = useRef<Map<string, number>>(new Map());

    // Colours are assigned by palette slot, not tag hash, so selected sensors stay distinct.
    // A slot survives deselection: useChartData keeps the previous view on screen with its old colours.
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
        //    exhausted, wrap.
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

        // Includes deselected sensors: the in-flight previous view still draws their lines.
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


    // Pin Y-axis popover state: one sensor's min/max fields open at a time.
    const [axisEditorFor, setAxisEditorFor] = useState<string | null>(null);
    const [axisDraftMin, setAxisDraftMin] = useState('');
    const [axisDraftMax, setAxisDraftMax] = useState('');

    const [axisEditorError, setAxisEditorError] = useState<string | null>(null);
    // Viewport-relative rect of the button that opened the pin-Y-axis popover.
    const [axisEditorAnchor, setAxisEditorAnchor] = useState<PopoverAnchorRect | null>(null);

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
        setAxisEditorAnchor(null);
    }, []);

    // The pin icon toggles its own editor; there is no Cancel button.
    const toggleAxisEditor = useCallback((sensor: string) => {
        if (axisEditorFor === sensor) closeAxisEditor();
        else openAxisEditor(sensor);
    }, [axisEditorFor, closeAxisEditor, openAxisEditor]);

    // Validates before applying; either field may be blank (that side auto-fits).
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

    // Persisted per sensor tag, e.g. `{ '11FQ1603.PV': ['H'] }`.
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

    // Prune per-sensor overrides and close editors on deselect, so a re-added tag doesn't resurrect stale settings.
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

    // Drops ids no longer in PANELS so a stale saved entry can't crash the collapsed-tabs sidebar.
    const [collapsedPanels, setCollapsedPanels] = useState<Set<PanelId>>(
        new Set((initialState?.collapsedPanels ?? []).filter(
            (id): id is PanelId => id in PANELS
        ))
    );

    // split.js percentages, `[primary, secondary]` summing to ~100; updated on `onDragEnd`.
    const [layoutSizes, setLayoutSizes] = useState<DashboardLayoutSizes>(
        initialState?.layoutSizes ?? DEFAULT_LAYOUT_SIZES
    );

    // Managed by split.js; re-mounted only when a collapse changes whether the split exists.
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

    // Ref mirror so effects read fresh sizes without listing `layoutSizes` in deps (that would re-init on every drag).
    const layoutSizesRef = useRef(layoutSizes);
    useEffect(() => { layoutSizesRef.current = layoutSizes; }, [layoutSizes]);

    // Looks up the panel in each slot via SLOT_LAYOUT; drives the split.js teardown effects.
    const ltCollapsed = collapsedPanels.has(SLOT_LAYOUT['left-top']);
    const lbCollapsed = collapsedPanels.has(SLOT_LAYOUT['left-bottom']);
    const rtCollapsed = collapsedPanels.has(SLOT_LAYOUT['right-top']);
    const allLeftCollapsed = ltCollapsed && lbCollapsed;
    const allRightCollapsed = rtCollapsed;

    // Tears down when a column has no visible panels so the other takes 100% width.
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

    // Slot refs are stable across panel swaps; only collapse toggles re-init split.js.
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

    // Ref gives listeners the latest state without re-binding; recipes and models feed the Manage tab's dependency check.
    const stateRef = useRef({ allSensorTags, selectedSensors, sensorMetadata, metadata, specialSensorRecipes, fgModels, fgGroups, fgExtra });
    // Add Sensor events are global broadcasts: drop any payload whose workspaceId is not this one.
    const workspaceIdRef = useRef(initialState?.id);
    workspaceIdRef.current = initialState?.id;
    // Also match dataset `generation` (A -> Back -> A reuses the id); a payload without generation is judged by id alone.
    const forThisWorkspace = (payload: unknown) => {
        const p = payload as { workspaceId?: string; generation?: unknown } | null | undefined;
        if (p?.workspaceId !== workspaceIdRef.current) return false;
        const mine = stateRef.current.metadata.generation;
        return typeof p?.generation !== 'number' || mine === undefined || p.generation === mine;
    };
    useEffect(() => {
        stateRef.current = { allSensorTags, selectedSensors, sensorMetadata, metadata, specialSensorRecipes, fgModels, fgGroups, fgExtra };
    }, [allSensorTags, selectedSensors, sensorMetadata, metadata, specialSensorRecipes, fgModels, fgGroups, fgExtra]);

    useEffect(() => {
        let unlistenRequest: UnlistenFn | undefined;
        let unlistenAdd: UnlistenFn | undefined;
        let unlistenDelete: UnlistenFn | undefined;
        let unlistenUpdate: UnlistenFn | undefined;
        let unlistenRename: UnlistenFn | undefined;
        let unlistenDataChanged: UnlistenFn | undefined;

        const setupListeners = () => {
            debugLog("Setting up Dashboard listeners");
            unlistenRequest = subscribe('request-sensors', () => {
                debugLog("Dashboard received 'request-sensors', emitting data...");
                const { allSensorTags, selectedSensors, sensorMetadata, specialSensorRecipes, fgModels, fgExtra } = stateRef.current;
                emit('sensors-data', {
                    workspaceId: workspaceIdRef.current,
                    // Rust dataset generation; the window pins it on special-sensor commands (`expectedGeneration`).
                    generation: stateRef.current.metadata.generation,
                    sensors: allSensorTags,
                    selectedSensors: selectedSensors,
                    sensorMetadata: sensorMetadata,
                    specialSensorRecipes,
                    models: fgModels,
                    runningConditionFilters: fgExtra.runningConditionFilters ?? [],
                });
            });

            // `sensors` is a delta to ADD to the plot: merge into the CURRENT selection, the window's copy may be stale.
            unlistenAdd = subscribe<AddSensorSelectionPayload>('add-sensor-selection', async (event) => {
                if (!forThisWorkspace(event.payload)) return;
                debugLog("Dashboard received 'add-sensor-selection'", event.payload);

                let toPlot: string[] = [];
                let newOperationConfig: SensorOperationConfig | null = null;
                let newMetadata: SensorMetadata[] = [];
                let newRecipes: SpecialSensorRecipe[] = [];

                if (Array.isArray(event.payload)) {
                    toPlot = event.payload;
                    newOperationConfig = null;
                } else {
                    toPlot = event.payload.sensors ?? [];
                    newOperationConfig = event.payload.operation;
                    newMetadata = event.payload.newMetadata ?? [];
                    newRecipes = event.payload.newRecipes ?? [];
                }

                // Respect the Pair Plot cap (WebGL contexts); sensors that don't fit are reported, not dropped silently.
                const cap = chartTypeRef.current === 'pair' ? MAX_PAIR_PLOT_SENSORS : undefined;
                const { next, blocked } = mergeIntoPlot(stateRef.current.selectedSensors, toPlot, cap);
                // Eagerly, so a second event arriving before the next render
                // merges into this result instead of the pre-merge selection.
                stateRef.current = { ...stateRef.current, selectedSensors: next };
                setSelectedSensors(prev => mergeIntoPlot(prev, toPlot, cap).next);
                setOperationConfig(newOperationConfig);
                // Report what is really plotted (the cap may have kept it off) so the window's 'on chart' badge isn't a guess.
                emit('add-sensor-plot-result', { workspaceId: workspaceIdRef.current, selectedSensors: next })
                    .catch(e => console.warn('Failed to report the plotted sensors:', e));

                if (blocked.length > 0) {
                    // The new sensor's own metadata is not in the lookup until the next render.
                    const lookup = buildSensorLookup(sensorLookupRef.current, newMetadata);
                    const names = blocked.map(tag => sensorPlainLabel(lookup(tag))).join(', ');
                    const text = `Pair Plot supports at most ${MAX_PAIR_PLOT_SENSORS} sensors, so ${names} ${blocked.length === 1 ? 'was' : 'were'} added to the workspace but not plotted. Deselect a sensor first, or switch chart type.`;
                    void (async () => {
                        try {
                            await message(text, { title: 'Not plotted', kind: 'warning' });
                        } catch { /* dialog unavailable -- the sensor is still in the list */ }
                    })();
                }

                if (newMetadata.length > 0) {
                    setExtraSensorMetadata(prev => {
                        const byTag = new Map(prev.map(m => [m.tag.toLowerCase(), m]));
                        for (const m of newMetadata) byTag.set(m.tag.toLowerCase(), m);
                        return Array.from(byTag.values());
                    });
                }

                if (newRecipes.length > 0) {
                    // Replace by tag but keep array order: replay order matters (formula sensors can reference earlier ones).
                    setSpecialSensorRecipes(prev => {
                        const byTag = new Map(prev.map(r => [r.tag.toLowerCase(), r]));
                        for (const r of newRecipes) byTag.set(r.tag.toLowerCase(), r);
                        return Array.from(byTag.values());
                    });
                    // A column was recreated: refetch, so a reused name isn't served from old query results.
                    setDataRevision(n => n + 1);
                }

                // List new sensors at once, even those the plot cap kept off the chart.
                setSensorHeaders(prevHeaders => {
                    const newHeaders = [...prevHeaders];
                    let changed = false;
                    [...toPlot, ...newMetadata.map(m => m.tag)].forEach(s => {
                        const exists = newHeaders.some(h => h.toLowerCase() === s.toLowerCase());
                        if (!exists) {
                            newHeaders.push(s);
                            changed = true;
                        }
                    });
                    return changed ? newHeaders : prevHeaders;
                });
            });

            // The window already dropped the column; dropping the recipe makes it stick (recipes are replayed on open).
            // No explicit save: the setters feed `buildWorkspaceState` and the autosave.
            unlistenDelete = subscribe<{ tags: string[]; workspaceId?: string }>('delete-special-sensors', (event) => {
                if (!forThisWorkspace(event.payload)) return;
                const drop = new Set((event.payload?.tags ?? []).map(t => t.trim().toLowerCase()));
                if (drop.size === 0) return;
                debugLog('Dashboard received delete-special-sensors', event.payload);
                const kept = <T,>(list: T[], tagOf: (item: T) => string) =>
                    list.filter(item => !drop.has(tagOf(item).trim().toLowerCase()));

                setSpecialSensorRecipes(prev => kept(prev, r => r.tag));
                setExtraSensorMetadata(prev => kept(prev, m => m.tag));
                // Filter conditions (applied and draft) on a deleted column would be ignored by Rust while still shown as applied.
                const removedTags = event.payload?.tags ?? [];
                setFilters(prev => {
                    const next = removeTagsFromFilters(prev.sensorFilters, removedTags);
                    return next === prev.sensorFilters ? prev : { ...prev, sensorFilters: next };
                });
                setFilterSensorChange(prev => ({ id: prev.id + 1, removed: removedTags }));
                // Deselecting clears visibleSensors, colours, axis ranges and alarm lines through existing effects.
                setSelectedSensors(prev => kept(prev, s => s));
                setSensorHeaders(prev => kept(prev, h => h));
            });

            // Same-tag edit: Rust already recomputed the column; store recipe/metadata, bump `dataRevision` (renames use another event).
            unlistenUpdate = subscribe<Partial<UpdateSpecialSensorPayload>>('update-special-sensor', (event) => {
                if (!forThisWorkspace(event.payload)) return;
                const { recipe, metadata, recipeOrder, repaired, affectedTags } = event.payload ?? {};
                if (!recipe) return;
                debugLog('Dashboard received update-special-sensor', event.payload);
                const isTarget = (tag: string) => tag.trim().toLowerCase() === recipe.tag.trim().toLowerCase();

                // `recipeOrder` is sent only when the edit made the stored order invalid; replay runs top to bottom.
                setSpecialSensorRecipes(prev => reorderRecipesByTags(prev.map(r => (isTarget(r.tag) ? recipe : r)), recipeOrder));
                if (metadata) {
                    setExtraSensorMetadata(prev => (
                        prev.some(m => isTarget(m.tag))
                            ? prev.map(m => (isTarget(m.tag) ? metadata : m))
                            : [...prev, metadata]
                    ));
                }
                // Repair changes values and the train fingerprint ignores recipes: demote affected models in one disk-derived write.
                if (repaired === true && Array.isArray(affectedTags) && affectedTags.length > 0) {
                    persistFailureGroupStateFrom(disk => ({
                        groups: disk.groups,
                        models: demoteModelsTrainedOnSensors(
                            disk.models,
                            { runningConditionFilters: disk.runningConditionFilters },
                            affectedTags,
                        ).models,
                    }), { notice: REPAIR_DEMOTE_FAILED_NOTICE });
                }
                setDataRevision(n => n + 1);
            });

            // Rename: re-key all tag-keyed state. `updatedRecipes` = downstream recipes rewritten to the new name.
            unlistenRename = subscribe<{
                oldTag: string;
                newTag: string;
                recipe: SpecialSensorRecipe;
                metadata: SensorMetadata;
                updatedRecipes: SpecialSensorRecipe[];
                recipeOrder?: string[];
                workspaceId?: string;
            }>('rename-special-sensor', (event) => {
                if (!forThisWorkspace(event.payload)) return;
                const { oldTag, newTag, recipe, metadata, updatedRecipes, recipeOrder } = event.payload ?? {};
                if (!oldTag || !newTag || !recipe) return;
                debugLog('Dashboard received rename-special-sensor', event.payload);
                const isOld = (tag: string) => sameTag(tag, oldTag);

                setSpecialSensorRecipes(prev => reorderRecipesByTags(prev.map(r => {
                    if (isOld(r.tag)) return recipe;
                    const rewritten = (updatedRecipes ?? []).find(u => sameTag(u.tag, r.tag));
                    return rewritten ?? r;
                }), recipeOrder));
                setExtraSensorMetadata(prev => {
                    const withoutOld = prev.filter(m => !isOld(m.tag));
                    return withoutOld.some(m => sameTag(m.tag, newTag))
                        ? withoutOld.map(m => (sameTag(m.tag, newTag) ? metadata : m))
                        : [...withoutOld, metadata];
                });
                setSensorHeaders(prev => renameTagInArray(prev, oldTag, newTag));
                setSelectedSensors(prev => renameTagInArray(prev, oldTag, newTag));
                // ... and the previous selection, so a renamed HIDDEN sensor is not taken for a new one.
                prevSelectedRef.current = renameTagInArray(prevSelectedRef.current, oldTag, newTag);
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
                // Re-key Filter conditions (applied and draft): an old tag names a missing column that Rust silently ignores.
                setFilters(prev => {
                    const next = renameTagInRunningConditionFilters(prev.sensorFilters, oldTag, newTag);
                    return next === prev.sensorFilters ? prev : { ...prev, sensorFilters: next };
                });
                setFilterSensorChange(prev => ({ id: prev.id + 1, rename: { from: oldTag, to: newTag } }));

                const renamedModels = renameTagInModels(stateRef.current.fgModels, oldTag, newTag);
                setFgModels(renamedModels);
                // The Running condition names sensors too; carry it through the disk-derived write, never a hand-built slice.
                setFgExtra(prev => (prev.runningConditionFilters
                    ? { ...prev, runningConditionFilters: renameTagInRunningConditionFilters(prev.runningConditionFilters, oldTag, newTag) }
                    : prev));
                persistFailureGroupStateFrom(disk => ({
                    groups: disk.groups,
                    models: renameTagInModels(disk.models, oldTag, newTag),
                    runningConditionFilters: renameTagInRunningConditionFilters(disk.runningConditionFilters, oldTag, newTag),
                }), { notice: RENAME_MODELS_FAILED_NOTICE });

                setDataRevision(n => n + 1);
            });

            // Columns were overwritten then rolled back by a failed edit: refetch charts that fetched in between.
            unlistenDataChanged = subscribe<{ workspaceId?: string }>('special-sensor-data-changed', (event) => {
                if (!forThisWorkspace(event.payload)) return;
                setDataRevision(n => n + 1);
            });
        };

        setupListeners();

        return () => {
            if (unlistenDataChanged) unlistenDataChanged();
            if (unlistenRequest) unlistenRequest();
            if (unlistenAdd) unlistenAdd();
            if (unlistenDelete) unlistenDelete();
            if (unlistenRename) unlistenRename();
            if (unlistenUpdate) unlistenUpdate();
        };
        // Registered once; listeners read fresh values via `stateRef`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [filters, setFilters] = useState<FilterState>(initialState?.filters ?? { timestampStart: '', timestampEnd: '', sensorFilters: [] });
    const [chartType, setChartType] = useState<'line' | 'scatter' | 'pair'>(initialState?.chartType ?? 'line');
    // Lets the Add Sensor listener (registered once) apply the Pair Plot cap.
    const chartTypeRef = useRef(chartType);
    chartTypeRef.current = chartType;
    const [samplingMethod, setSamplingMethod] = useState<'raw' | 'avg' | 'max' | 'min' | 'first' | 'last'>(initialState?.samplingMethod ?? 'raw');

    // The pin popover renders only on line charts; clear `axisEditorFor` otherwise or it reopens at a stale position.
    useEffect(() => {
        if (chartType !== 'line') {
            setAxisEditorFor(null);
        }
    }, [chartType]);


    // Singleton window `build-model`; the spawn is guarded against duplicates.
    // Subscribe once and read via `stateRef`: re-subscribing races the async unlisten and leaves stale copies answering.
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

    // Covers the async gap between the existence check and window creation so two fast clicks can't make two windows.
    const pendingSpawnLabels = useRef<Set<string>>(new Set());

    const spawnBuildModel = useCallback(async () => {
        if (!initialState) return;
        const label = 'build-model';
        if (pendingSpawnLabels.current.has(label)) return;
        pendingSpawnLabels.current.add(label);
        try {
            const existing = await WebviewWindow.getByLabel(label);
            if (existing) {
                await bringToFront(existing);
                // Re-point the open window at THIS workspace; it may be left over from the previous project.
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

    // Close the workspace-scoped Build Model and Add Sensor windows on leaving: a stale one would write to the old project.
    // Best-effort: `workspace-closing` goes first, each close has its own catch; commands are pinned to `expectedGeneration` anyway.
    const closeChildWindows = useCallback(async () => {
        const closing = { workspaceId: workspaceIdRef.current, generation: stateRef.current.metadata.generation };
        try {
            Promise.resolve(emit('workspace-closing', closing)).catch(() => { /* best effort */ });
        } catch { /* best effort */ }
        for (const label of ['build-model', 'add-sensor']) {
            try {
                const w = await WebviewWindow.getByLabel(label);
                await w?.close();
            } catch { /* ignore — window may already be gone */ }
        }
    }, []);
    useEffect(() => () => { void closeChildWindows(); }, [closeChildWindows]);

    // Scatter/pair need 2+ sensors: below that, bounce to the line chart (also for restored workspaces).
    const canScatter = selectedSensors.length >= 2;
    // Too many sensors for Pair Plot does not bounce the chart: the UI blocks it; PairPlotChart's guard covers restores.
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


    // Filter, transform, aggregation and decimation run in Rust; the WebView gets only O(LINE_MAX_POINTS) arrays.
    const handleFiltersChange = useCallback((newFilters: FilterState) => {
        // The query hooks debounce backend calls themselves, so rapid
        // datetime-input edits don't queue full-dataset passes.
        setFilters(newFilters);
    }, []);

    // Wire-format value filters, shared by the chart and scatter queries below.
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
    // True dataset extent regardless of the time filter (`view.ts_min/max` shrink with it); fetched once per mount.
    const { bounds: datasetBounds } = useDatasetTimeBounds();

    // The hooks swallow failures; report them or they are invisible in a production build.
    useEffect(() => {
        if (viewError) reportError('chart-data', viewError);
    }, [viewError]);

    const loading = viewLoading;

    const isMultiOp = operationConfig?.mode === 'multi' && !!operationConfig?.multiOp;

    // Multi-op collapses to one 'Result (op)' column; otherwise the visible sensors.
    const displayHeaders = useMemo(() => {
        if (!view) return [];
        if (isMultiOp) return view.headers;
        return view.headers.filter(h => visibleSensors.includes(h));
    }, [view, isMultiOp, visibleSensors]);

    // Skipped in multi-op (no real tag to look up). Coloured by severity, not the sensor's line colour.
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

    const buildWorkspaceState = useCallback((overrides?: Partial<WorkspaceState>): WorkspaceState => ({
        ...withoutLegacyWorkspaceFields(initialState),
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
        // Use the latest fgGroups/fgModels mirror, not the mount-time `initialState`, or this full overwrite erases other writes.
        failureGroupState: { ...fgExtra, groups: fgGroups, models: fgModels },
        alarmLinesEnabled,
        scatterAxes: scatterAxes ?? undefined,
        extraSensorMetadata,
        specialSensorRecipes,
        sensorColors,
        sensorAxisRange,
        scatterAxisPins,
        timeHighlights,
        valueHighlight,
        // `lineTaggedPoints` is deliberately not persisted (see its state).
        relativeTimeRange: { amount: relativeAmount, unit: relativeUnit },
        ...overrides,
    }), [
        initialState, localName, selectedSensors, visibleSensors, operationConfig, filters, chartType,
        samplingMethod, collapsedPanels, layoutSizes, fgGroups, fgModels, fgExtra, alarmLinesEnabled, scatterAxes,
        extraSensorMetadata, specialSensorRecipes, sensorColors, sensorAxisRange, scatterAxisPins, timeHighlights,
        valueHighlight, relativeAmount, relativeUnit,
    ]);

    // Unmount flushes an armed debounce (the cleanup clears the timer): `autosaveDirtyRef` marks it, `runAutosaveRef` runs it.
    const autosaveDirtyRef = useRef(false);
    const runAutosaveRef = useRef<(() => Promise<void>) | null>(null);
    const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The last autosave did not reach the file (it stays dirty and is retried). */
    const autosaveFailedRef = useRef(false);
    /** Failed autosaves were reported: says nothing more until one succeeds. */
    const autosaveToldRef = useRef(false);
    /** A failed save at close was reported: the next close leaves regardless. */
    const closeToldRef = useRef(false);
    /** Window.close() was called: its `close-requested` pass lets the window go. */
    const leavingRef = useRef(false);
    /** A close is waiting for the saves or Build Model: a second X does not start another. */
    const closingRef = useRef(false);
    /** The X is waiting for Build Model's answer. */
    const buildModelWaitRef = useRef<{
        settle: (gone: boolean) => void;
        request: () => void;
        notResponding: () => boolean;
        destroy: () => void;
    } | null>(null);
    /** Why the X has not closed the app yet; shown over `saveNotice`. */
    const [closeWaitNotice, setCloseWaitNotice] = useState<string | null>(null);
    /** The "Build Model is not responding" question is open. */
    const [buildModelHung, setBuildModelHung] = useState(false);
    // The first autosave after opening always writes: it moves the project to
    // the top of Recents even when nothing changed.
    const autosavedOnceRef = useRef(false);

    // Debounced autosave coalesces bursts into one write.
    // Re-reads `failureGroupState` from disk first (the mirror can be stale); narrows, does not close, a cross-window race.
    useEffect(() => {
        if (!initialState) return;
        // The write itself, also run by the unmount flush; always for this Dashboard's own workspace.
        const runAutosave = async () => {
            const run: { built: WorkspaceState | null; recipesChanged: boolean } = { built: null, recipesChanged: false };
            let next: WorkspaceState | null;
            try {
                // Read and write are one queue step, so a failure-group write
                // from this window lands before the read or after the write.
                next = await saveWorkspaceFrom(initialState.id, (onDisk) => {
                    // Written only by Project details; carried over from disk.
                    const built = buildWorkspaceState({
                        failureGroupState: onDisk?.failureGroupState ?? { ...fgExtra, groups: fgGroups, models: fgModels },
                        ...projectDetailsFromDisk(onDisk),
                    });
                    // A recipe change demotes models trained on it in the SAME write; only when recipes really changed, to skip fingerprinting.
                    const recipesChanged = !!onDisk && recipesDiffer(onDisk.specialSensorRecipes, built.specialSensorRecipes);
                    const state = recipesChanged && onDisk ? applyRecipeRule(onDisk, built) : built;
                    // Skip the write when the file already holds this state.
                    if (autosavedOnceRef.current && JSON.stringify(state) === JSON.stringify(onDisk)) return null;
                    run.built = built;
                    run.recipesChanged = recipesChanged;
                    return state;
                });
            } catch (e) {
                // A failed read/write overwrote nothing; stay pending so the next change retries.
                console.warn('Autosave failed, nothing overwritten, adopted or broadcast:', e);
                autosaveDirtyRef.current = true;
                autosaveFailedRef.current = true;
                if (!autosaveToldRef.current) {
                    autosaveToldRef.current = true;
                    // A notice already up (a Failure Group write) is more specific.
                    setSaveNotice(prev => prev ?? AUTOSAVE_FAILED_NOTICE);
                }
                return;
            }
            autosaveFailedRef.current = false;
            if (autosaveToldRef.current) {
                autosaveToldRef.current = false;
                setSaveNotice(prev => (prev === AUTOSAVE_FAILED_NOTICE ? null : prev));
            }
            if (closeToldRef.current) {
                closeToldRef.current = false;
                setSaveNotice(prev => (prev === CLOSE_SAVE_FAILED_NOTICE ? null : prev));
            }
            if (!next) return;
            autosavedOnceRef.current = true;
            if (!run.recipesChanged) return;
            // Models were demoted in that write: adopt them (the mirror would
            // otherwise show them as before until the next broadcast).
            const demoted = next.failureGroupState?.models !== run.built?.failureGroupState?.models ? next.failureGroupState : undefined;
            if (demoted) {
                const { groups, models, ...rest } = demoted;
                setFgGroups(groups);
                setFgModels(models);
                setFgExtra(rest);
            }
            // Tell open Build Model windows the recipes changed (they re-read them); scoped, tagged to skip our echo.
            const fgNow = next.failureGroupState ?? run.built?.failureGroupState;
            if (fgNow) {
                const changed: FailureGroupStateChangedPayload = {
                    ...fgNow,
                    workspaceId: initialState.id,
                    origin: 'dashboard',
                    recipesChanged: true,
                };
                emit('failure-group-state-changed', changed).catch(e => console.warn('Failed to broadcast failure-group state:', e));
            }
        };
        autosaveDirtyRef.current = true;
        runAutosaveRef.current = runAutosave;
        const timer = setTimeout(() => {
            autosaveDirtyRef.current = false;
            void trackWrite(runAutosave());
        }, AUTOSAVE_DEBOUNCE_MS);
        autosaveTimerRef.current = timer;
        return () => clearTimeout(timer);
    }, [buildWorkspaceState, initialState, fgGroups, fgModels, fgExtra, trackWrite]);

    // Flush unwritten changes on unmount only (empty deps); still re-reads failureGroupState from disk first.
    useEffect(() => () => {
        if (!autosaveDirtyRef.current) return;
        autosaveDirtyRef.current = false;
        const run = runAutosaveRef.current;
        if (run) void run().catch(e => console.warn('Autosave flush on leaving the Dashboard failed:', e));
    }, []);

    // Writes everything still owed now. False when something didn't land or a write hung.
    const saveAllBeforeClose = useCallback(async (): Promise<boolean> => {
        fgWriteFailedRef.current = false;
        const drained = (async () => {
            // An edit made while waiting arms the debounce again: go round once more.
            do {
                if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
                await Promise.all([...writesRef.current]);
                if (autosaveDirtyRef.current) {
                    autosaveDirtyRef.current = false;
                    const run = runAutosaveRef.current;
                    if (run) await trackWrite(run());
                }
                await Promise.all([...writesRef.current]);
            } while (autosaveDirtyRef.current && !autosaveFailedRef.current);
            return true;
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const gaveUp = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CLOSE_SAVE_WAIT_MS); });
        const finished = await Promise.race([drained, gaveUp]);
        if (timer) clearTimeout(timer);
        return finished && !autosaveFailedRef.current && !fgWriteFailedRef.current;
    }, [trackWrite]);

    // `preventDefault()` only blocks; `close()` re-enters, so `leavingRef` lets it through. A failed save holds the window once.
    // Build Model is asked first (unknown = hold); other child windows close before this one, which never unmounts when destroyed.
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const win = getCurrentWindow();
        const closeChildrenCapped = async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const gaveUp = new Promise<void>((resolve) => { timer = setTimeout(resolve, CHILD_CLOSE_WAIT_MS); });
            await Promise.race([closeChildWindows(), gaveUp]);
            if (timer) clearTimeout(timer);
        };
        const findBuildModel = async (): Promise<BuildModelHandle | null | 'no answer'> => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const gaveUp = new Promise<'no answer'>((resolve) => { timer = setTimeout(() => resolve('no answer'), CHILD_CLOSE_WAIT_MS); });
            const found = Promise.resolve()
                .then(() => WebviewWindow.getByLabel('build-model'))
                .catch((): 'no answer' => 'no answer');
            const answer = await Promise.race([found, gaveUp]);
            if (timer) clearTimeout(timer);
            return answer;
        };
        /** True when Build Model went, false when the user kept it. */
        const askBuildModelToClose = async (buildModel: BuildModelHandle): Promise<boolean> => {
            let answered = false;
            let acked = false;
            let requestedAt: number | null = null;
            let raiseTimer: ReturnType<typeof setTimeout> | undefined;
            let settle!: (gone: boolean) => void;
            const answer = new Promise<boolean>((resolve) => {
                settle = (gone) => { answered = true; resolve(gone); };
            });
            const offKept = subscribe<{ workspaceId?: string }>('build-model-close-kept', (event) => {
                if (event.payload?.workspaceId === workspaceIdRef.current) settle(false);
            });
            const offAck = subscribe<{ workspaceId?: string }>('build-model-close-ack', (event) => {
                if (event.payload?.workspaceId !== workspaceIdRef.current) return;
                acked = true;
                setBuildModelHung(false);
            });
            let offGone: (() => void) | undefined;
            const goneReady = Promise.resolve()
                .then(() => buildModel.once('tauri://destroyed', () => settle(true)))
                .then((fn) => { if (answered) fn(); else offGone = fn; })
                .catch((e) => console.warn('Could not watch the Build Model window:', e));
            /** A call on the window failed: only a window that is really gone lets the close go on. */
            const callFailed = async () => {
                const found = await findBuildModel();
                if (found === null) { settle(true); return; }
                if (!answered) setCloseWaitNotice(BUILD_MODEL_UNREACHABLE_NOTICE);
                settle(false);
            };
            const request = () => {
                requestedAt ??= Date.now();
                void Promise.resolve()
                    .then(() => buildModel.close())
                    .then(() => {
                        if (answered) return;
                        if (raiseTimer) clearTimeout(raiseTimer);
                        raiseTimer = setTimeout(() => { if (!answered) void bringToFront(buildModel); }, BUILD_MODEL_RAISE_DELAY_MS);
                    })
                    .catch(callFailed);
            };
            const notResponding = () => !acked && requestedAt !== null && Date.now() - requestedAt >= BUILD_MODEL_ACK_WAIT_MS;
            const destroy = () => {
                setBuildModelHung(false);
                // Its run would otherwise keep the engine until the app exits.
                void stopRunningEngine();
                void Promise.resolve()
                    .then(() => buildModel.destroy())
                    .then(() => settle(true))
                    .catch(callFailed);
            };
            buildModelWaitRef.current = { settle, request, notResponding, destroy };
            setCloseWaitNotice(BUILD_MODEL_ANSWER_NOTICE);
            try {
                await Promise.all([offKept.ready, offAck.ready, goneReady]);
                if (!answered) request();
                return await answer;
            } finally {
                buildModelWaitRef.current = null;
                if (raiseTimer) clearTimeout(raiseTimer);
                setBuildModelHung(false);
                setCloseWaitNotice(prev => (prev === BUILD_MODEL_ANSWER_NOTICE ? null : prev));
                offKept();
                offAck();
                offGone?.();
            }
        };
        /** Saves what is pending; false when the failure was just reported and this window stays. */
        const saveOrTell = async (): Promise<boolean> => {
            const saved = await saveAllBeforeClose();
            if (saved || closeToldRef.current) return true;
            closeToldRef.current = true;
            setSaveNotice(CLOSE_SAVE_FAILED_NOTICE);
            return false;
        };
        Promise.resolve(win.onCloseRequested(async (event) => {
            if (leavingRef.current) return;
            if (closingRef.current) {
                event.preventDefault();
                // The answer may have been lost: ask again rather than stay held for good.
                const wait = buildModelWaitRef.current;
                if (wait) {
                    const buildModel = await findBuildModel();
                    if (buildModel === null) wait.settle(true);
                    else if (wait.notResponding()) setBuildModelHung(true);
                    else wait.request();
                }
                return;
            }
            closingRef.current = true;
            setCloseWaitNotice(null);
            try {
                const dirty = autosaveDirtyRef.current || writesRef.current.size > 0;
                if (dirty) {
                    event.preventDefault();
                    if (!(await saveOrTell())) return;
                }
                const buildModel = await findBuildModel();
                if (buildModel === 'no answer') {
                    event.preventDefault();
                    setCloseWaitNotice(BUILD_MODEL_UNREACHABLE_NOTICE);
                    return;
                }
                if (buildModel) {
                    event.preventDefault();
                    if (!(await askBuildModelToClose(buildModel))) return;
                    // This window stayed usable during the question.
                    if (!(await saveOrTell())) return;
                    await closeChildrenCapped();
                } else {
                    await closeChildrenCapped();
                    if (!dirty) return;
                }
                leavingRef.current = true;
                await win.close();
            } catch (e) {
                leavingRef.current = false;
                console.warn('Could not close the window:', e);
            } finally {
                closingRef.current = false;
            }
        })).then(fn => { if (disposed) fn(); else unlisten = fn; });
        return () => {
            disposed = true;
            if (unlisten) unlisten();
            // Leaving the Dashboard: Build Model closing now must not close this window.
            buildModelWaitRef.current?.settle(false);
        };
    }, [saveAllBeforeClose, closeChildWindows]);

    // Scatter/pair render a bounded reservoir sample from Rust, so payload, heap and GPU buffers stay constant.
    const scatterActive = chartType === 'scatter' || chartType === 'pair';
    // Pair plot redraws per cell across many WebGL contexts, so its point budget is tighter.
    const scatterMaxPoints = chartType === 'pair' ? PAIR_MAX_POINTS : SCATTER_MAX_POINTS;

    // Use `selectedSensors`, not `visibleSensors`: hiding is line-only and could starve scatter/pair below 2 sensors.
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

    // Same single-op transform as the line path; multi-op is left untransformed (the chart shows its guard).
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

    // No full-data fallback: the charts show the bounded sample (empty until the first fetch).
    const scatterReady = scatterSample.rows.length > 0;
    const scatterChartData = scatterFeed;
    // Matches scatterFilter above — falls back to the full selection, not
    // the line-chart-only visible subset.
    const scatterChartHeaders = scatterSample.headers.length > 0 ? scatterSample.headers : selectedSensors;

    // True dataset extent (not `view.ts_min/max`, which shrink with the filter), for Reset Period and defaults.
    const dataRange = useMemo(() => {
        if (datasetBounds?.min && datasetBounds?.max) {
            return { min: datasetBounds.min, max: datasetBounds.max };
        }
        return undefined;
    }, [datasetBounds]);

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
    const dataStartInput = dataRange ? formatForInput(dataRange.min) : undefined;
    const dataEndInput = dataRange ? formatForInput(dataRange.max) : undefined;

    const applyRelativeRange = useCallback(() => {
        const n = parseFloat(relativeAmount);
        if (!n || n <= 0) return;
        // Anchored to the dataset's last timestamp, not the clock (data is historical); falls back to now until bounds load.
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

    // One-shot: a fresh workspace (no saved `filters`) shows the last 6 months; any saved filters, even empty, are kept.
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
        // The ref keeps this one-shot however often the effect re-runs.
    }, [datasetBounds, initialState, filters, handleFiltersChange, formatForInput]);

    // Inner wrapper only; the render loop adds the slot wrapper so refs stay stable and split.js isn't re-initialised on swaps.
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
                        <span className="section-badge" data-testid="sampling-badge">
                            {samplingMethod === 'raw' ? 'RAW' : `${samplingMethod.toUpperCase()} (1h)`}
                        </span>
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
                        lineTaggedPoints={lineTaggedPoints}
                        onLineTaggedPointsChange={handleLineTaggedPointsChange}
                        tagTableHost={tagTableHost}
                        onTagCountChange={handleTagCountChange}
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
                        tagTableHost={tagTableHost}
                        onTagCountChange={handleTagCountChange}
                    />
                )}
            </div>
            {/* Pill-shaped controls in one row; `.timebar-datarange` states the loaded data's range. */}
            <div className="timebar">
                {/* Each side has its own calendar button. An unfinished date changes nothing (clearing would show the full range over the typing); blank clears it. */}
                <div className="timebar-range">
                    <div className="timebar-date">
                        <DateTime24Input
                            ariaLabel="Start date"
                            calClassName="timebar-cal"
                            calLabel="Pick start date"
                            value={displayTimestampStart}
                            min={dataStartInput}
                            max={dataEndInput}
                            onChange={(value) => {
                                if (!value) return;
                                handleFiltersChange({ ...filters, timestampStart: value });
                                setRelativeRangeApplied(false);
                            }}
                            onClear={() => {
                                handleFiltersChange({ ...filters, timestampStart: '' });
                                setRelativeRangeApplied(false);
                            }}
                        />
                    </div>
                    <span className="timebar-range-sep">→</span>
                    <div className="timebar-date">
                        <DateTime24Input
                            ariaLabel="End date"
                            calClassName="timebar-cal"
                            calLabel="Pick end date"
                            value={displayTimestampEnd}
                            min={dataStartInput}
                            max={dataEndInput}
                            onChange={(value) => {
                                if (!value) return;
                                handleFiltersChange({ ...filters, timestampEnd: value });
                                setRelativeRangeApplied(false);
                            }}
                            onClear={() => {
                                handleFiltersChange({ ...filters, timestampEnd: '' });
                                setRelativeRangeApplied(false);
                            }}
                        />
                    </div>
                </div>

                <span className="timebar-hint">Last</span>
                <div className="timebar-num">
                    <input
                        type="number"
                        min="0"
                        // Y/M are calendar units: whole numbers only; W/D/H may be fractional.
                        step={relativeUnit === 'Y' || relativeUnit === 'M' ? '1' : 'any'}
                        value={relativeAmount}
                        onChange={(e) => { setRelativeAmount(e.target.value); setRelativeRangeApplied(false); }}
                        aria-label="Amount"
                    />
                    <button type="button" onClick={applyRelativeRange} title="Apply relative range">
                        <Check size={13} />
                    </button>
                </div>

                <div className="timebar-unit-seg">
                    {RANGE_UNITS.map(u => {
                        // isSelected = unit picked in the widget, updates on every click.
                        // isActive = also relativeRangeApplied, i.e. the dates on screen are this unit's last Apply result.
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
                                className={`timebar-unit-btn${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                            >
                                {u}
                            </button>
                        );
                    })}
                </div>

                <div className="timebar-vsep" />
                <span className="timebar-hint">Aggregation</span>
                <select
                    className="timebar-select"
                    value={samplingMethod}
                    onChange={(e) => setSamplingMethod(e.target.value as 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last')}
                >
                    <option value="raw">Raw</option>
                    <option value="avg">Avg</option>
                    <option value="max">Max</option>
                    <option value="min">Min</option>
                    <option value="first">First</option>
                    <option value="last">Last</option>
                </select>

                {/* Clears only timestampStart/End to the full range, not Aggregation. */}
                {dataRange && filters.timestampStart && (
                    <button
                        className="timebar-reset"
                        title="Reset the time period back to the full data range — does not change Aggregation"
                        onClick={() => {
                            handleFiltersChange({
                                ...filters,
                                timestampStart: '',
                                timestampEnd: ''
                            });
                            // The dates changed, so the relative-range unit must stop showing as active.
                            setRelativeRangeApplied(false);
                        }}
                    >
                        <RotateCcw size={12} />
                        Reset period
                    </button>
                )}

                <span className="timebar-spacer" />

                {/* Always shown once bounds load: the chart does not default to the whole range. */}
                {dataRange && (
                    <span
                        className="timebar-datarange"
                        title="First and last timestamp across the whole loaded dataset"
                    >
                        Data {formatDateTime(new Date(dataRange.min))} → {formatDateTime(new Date(dataRange.max))}
                    </span>
                )}
            </div>
        </div>
    );


    const renderDataContent = () => (
        <div className="widget-section data-widget">
            <div className="section-header collapsible-header">
                <div className="section-header-left" style={{ gap: '4px' }}>
                    {(['selected', 'filter', 'highlights', 'tags'] as const).map(tab => (
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
                                    : tab === 'tags'
                                        ? `Tagged points${tagCount > 0 ? ` (${tagCount})` : ''}`
                                    : `Selected Sensor${selectedSensors.length > 0 ? ` (${selectedSensors.length})` : ''}`}
                        </button>
                    ))}
                </div>
                <div className="section-header-actions">
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
                            sensorChange={filterSensorChange}
                            onShowSensor={showSensorOnChart}
                            showSensorBlockedReason={chartType === 'pair' && selectedSensors.length >= MAX_PAIR_PLOT_SENSORS
                                ? `Pair Plot shows at most ${MAX_PAIR_PLOT_SENSORS} sensors`
                                : undefined}
                        />
                    </div>
                ) : activeDataTab === 'tags' ? (
                    <div className="tag-panel">
                        {tagCount === 0 && (
                            <div className="tag-panel-empty" data-testid="tag-panel-empty">
                                {chartType === 'pair'
                                    ? 'Pair Plot has no tagged points — switch to Line or Scatter to tag a point.'
                                    : 'No tagged points yet — turn on the Tag tool at the top right of the chart, then click the chart. The values of every tagged point are compared here.'}
                            </div>
                        )}
                        {/* The chart renders its table of values into this element. */}
                        <div ref={setTagTableHost} className="tag-panel-host" data-testid="tag-panel-host" />
                    </div>
                ) : activeDataTab === 'highlights' ? (
                    <HighlightsPanel
                        timeHighlights={timeHighlights}
                        onAddTimeHighlight={handleAddTimeHighlight}
                        onToggleTimeHighlight={handleToggleTimeHighlight}
                        onRemoveTimeHighlight={handleRemoveTimeHighlight}
                        onRecolorTimeHighlight={handleRecolorTimeHighlight}
                        onRenameTimeHighlight={handleRenameTimeHighlight}
                        valueHighlight={valueHighlight}
                        valueHighlightSensors={scatterChartHeaders}
                        onSetValueHighlightSensor={handleSetValueHighlightSensor}
                        onAddValueHighlightRange={handleAddValueHighlightRange}
                        onToggleValueHighlightRange={handleToggleValueHighlightRange}
                        onRemoveValueHighlightRange={handleRemoveValueHighlightRange}
                        onRecolorValueHighlightRange={handleRecolorValueHighlightRange}
                        chartType={chartType}
                        dataStart={dataStartInput}
                        dataEnd={dataEndInput}
                    />
                ) : (
                    <div className="custom-scrollbar" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
                        {selectedSensors.length === 0 && (
                            <div style={{ padding: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', opacity: 0.6 }}>
                                No sensors plotted yet — pick some from the Sensor panel.
                            </div>
                        )}
                        {/* Visibility/colour/Y-pin reach only LineChart, so Scatter/Pair hide them. Pair Plot's lasso-cluster ignores the Highlights tab (see ChartTypes.ts `timeHighlights`). */}
                        {chartType !== 'line' && selectedSensors.length > 0 && (
                            <div style={{
                                margin: '8px 10px', padding: '8px 10px',
                                background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)',
                                borderRadius: '6px', fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.5,
                            }}>
                                {chartType === 'scatter'
                                    ? 'Scatter Plot: pick the X/Y sensor pair from the dropdowns above the chart. Colour points by value or highlight them by time from the Highlights tab.'
                                    : 'Pair Plot: lasso-select points in any cell to brush a colored cluster — pick a cluster colour or remove a cluster from the chips above the matrix.'}
                            </div>
                        )}
                        {/* One set (rules 2 + 3): the rows read differently; a name that fits changes nothing. */}
                        <SensorSetProvider tags={selectedSensors}>{selectedSensors.map((sensor) => {
                            const visible = visibleSensors.includes(sensor);
                            const isPinned = !!sensorAxisRange[sensor];
                            const isLine = chartType === 'line';
                            // Must match LineChart's own tag-keyed default so the swatch agrees with the on-chart colour; Line only.
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
                                        {/* The swatch is the colour button; the series colour lives only on the swatch and tooltip/tag-box values. */}
                                        {isLine && (
                                            <ColourPicker
                                                color={currentColor}
                                                onChange={(hex) => setSensorColor(sensor, hex)}
                                                onOpen={closeAxisEditor}
                                                used={selectedSensors.filter(t => t !== sensor).map(t => resolvedSensorColors[t] ?? defaultSensorColor(t))}
                                                label={sensorLookup(sensor).description || sensor}
                                                title="Line colour"
                                            />
                                        )}
                                        <SensorLabel tag={sensor} />
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                                            {isLine && (
                                                <>
                                                    <button
                                                        onClick={(e) => {
                                                            const opening = axisEditorFor !== sensor;
                                                            toggleAxisEditor(sensor);
                                                            setAxisEditorAnchor(opening ? e.currentTarget.getBoundingClientRect() : null);
                                                            // (An open ColourPicker closes itself on this mousedown.)
                                                        }}
                                                        title={isPinned ? 'Y-axis scale pinned to a fixed range — click to edit, click again to close' : 'Pin the Y-axis to a fixed min/max range'}
                                                        className="row-action-btn"
                                                        style={isPinned ? { background: 'var(--accent-muted)', color: 'var(--accent-hi)' } : undefined}
                                                    >
                                                        <LineChartIcon size={14} />
                                                    </button>
                                                </>
                                            )}
                                            <button
                                                onClick={() => removeSensor(sensor)}
                                                title="Remove from plot"
                                                className="row-action-btn"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>
                                    {isLine && axisEditorFor === sensor && (
                                        <AnchoredPopover
                                            anchorRect={axisEditorAnchor}
                                            onRequestClose={closeAxisEditor}
                                            // Wide enough for label, two fields and Apply (plus Unpin) on one line.
                                            width={isPinned ? 310 : 270}
                                            style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
                                        >
                                            <div className="fg-menu-heading">Pin Y-axis</div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem' }}>
                                                <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>Y-axis:</span>
                                                <input
                                                    type="number"
                                                    placeholder="min"
                                                    value={axisDraftMin}
                                                    onChange={(e) => setAxisDraftMin(e.target.value)}
                                                    style={{
                                                        flex: 1, minWidth: 0, padding: '2px 4px',
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
                                                        flex: 1, minWidth: 0, padding: '2px 4px',
                                                        background: 'var(--input-bg)', border: '1px solid var(--border)',
                                                        borderRadius: '4px', color: 'var(--text-primary)',
                                                        fontSize: '0.75rem', outline: 'none',
                                                    }}
                                                />
                                                <button className="text-btn" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={applyAxisEditor}>Apply</button>
                                                {isPinned && (
                                                    <button
                                                        className="text-btn"
                                                        style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
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
                                        </AnchoredPopover>
                                    )}
                                </div>
                            );
                        })}</SensorSetProvider>
                    </div>
                )}
            </div>
        </div>
    );

    const renderSensorsContent = () => (
        <div className="widget-section" ref={sensorsSectionRef}>
            <div className="section-header collapsible-header">
                <div className="section-header-left" style={{ gap: '4px' }}>
                    {(['sensor', 'failure-groups'] as const).map(tab => (
                        <button
                            key={tab}
                            ref={tab === 'failure-groups' ? fgTabButtonRef : undefined}
                            onClick={() => {
                                setActiveSensorTab(tab);
                                // Leaving for the FG tab ends an "Assign sensors" run.
                                if (tab === 'failure-groups') setAssignGroupNo(null);
                            }}
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
                        assignGroupNo={assignGroupNo}
                        onAssignDone={finishAssignSensors}
                    />
                ) : (
                    <FailureGroupsPanel
                        fgGroups={fgGroups}
                        fgModels={fgModels}
                        sensorMetadata={sensorMetadata}
                        runningConditionFg={fgExtra}
                        datasetHeaders={allSensorTags.length ? allSensorTags : null}
                        specialSensorRecipes={specialSensorRecipes}
                        getGroupColor={getFgGroupColor}
                        onUpdateGroupDetails={updateGroupDetails}
                        onDeleteGroup={deleteGroup}
                        onCreateEmptyGroup={createEmptyGroup}
                        onDeleteModel={deleteModel}
                        onOpenBuildModel={spawnBuildModel}
                        onAssignSensors={startAssignSensors}
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
                                // Already open (a second create with the same label errors): focus it and send this workspace's data.
                                await bringToFront(existing);
                                const cur = stateRef.current;
                                emit('sensors-data', {
                                    workspaceId: workspaceIdRef.current,
                                    generation: cur.metadata.generation,
                                    sensors: cur.allSensorTags,
                                    selectedSensors: cur.selectedSensors,
                                    sensorMetadata: cur.sensorMetadata,
                                    specialSensorRecipes: cur.specialSensorRecipes,
                                    models: cur.fgModels,
                                    runningConditionFilters: cur.fgExtra.runningConditionFilters ?? [],
                                });
                                return;
                            }
                            const webview = new WebviewWindow('add-sensor', {
                                url: '/?window=add-sensor',
                                title: 'Add Special Sensor',
                                width: 1000,
                                height: 800,
                                // The body grid's right track has no floor of its own: minWidth = 320px left track + 150px floor.
                                minWidth: 470,
                                minHeight: 400,
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

    // Null when collapsed so the sibling slot takes the whole column.
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
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="dashboard-container">
            <UndoToastStack
                toasts={undoToasts}
                onUndo={undoModelDeletion}
                onExpire={expireUndo}
                durationMs={UNDO_SECONDS * 1000}
            />
            {closeWaitNotice ? (
                <Portal>
                    <div className="dash-save-notice" role="alert" data-testid="close-wait-notice">
                        <span>{closeWaitNotice}</span>
                        <button type="button" className="fg-undo-toast-btn" onClick={() => setCloseWaitNotice(null)}>Dismiss</button>
                    </div>
                </Portal>
            ) : saveNotice && (
                <Portal>
                    <div className="dash-save-notice" role="alert" data-testid="save-failed-notice">
                        <span>{saveNotice}</span>
                        <button type="button" className="fg-undo-toast-btn" onClick={() => setSaveNotice(null)}>Dismiss</button>
                    </div>
                </Portal>
            )}
            {buildModelHung && (
                <Portal>
                    <BuildModelHungDialog
                        onCloseIt={() => buildModelWaitRef.current?.destroy()}
                        onCancel={() => buildModelWaitRef.current?.settle(false)}
                    />
                </Portal>
            )}
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
                {/* Slot wrappers give split.js stable refs for vertical resize. */}
                <div className="left-column" ref={leftColumnRef}>
                    {LEFT_SLOTS.map(slot => renderSlot(slot))}
                </div>

                <div className="right-column" ref={rightColumnRef}>
                    {/* Right column's one slot (RT) per SLOT_LAYOUT lives in this wrapper. */}
                    <div className="right-column-splits">
                        {RIGHT_SLOTS.map(slot => renderSlot(slot))}
                    </div>
                </div>
            </div>
        </div>
        </SensorMetaContext.Provider>
    );
});

export default Dashboard;
