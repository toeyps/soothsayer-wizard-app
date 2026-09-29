import { useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { subscribe } from "../../utils/tauriEvents";
import { X, ChevronRight, Lock, CircleAlert, TriangleAlert, Search } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata, WorkspaceSensorFilter, CategoryChange, TimePeriod, FailureGroupStateSlice, FailureGroupStateChangedPayload } from "../../types";
import { loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { modelSensorKey, groupModelsBySensor, sensorCategory, setSensorCategory, type SensorModelGroup } from "../../utils/modelGrouping";
import { normalizeCategories, flagLegacyGate, migratePeriods } from "../../utils/workspaceMigrations";
import { findSameSensorNameConflict, suggestDistinctModelName } from "../../utils/modelNames";
import { CATEGORY_BLOCK_REASON, getBuildBlockReason, isRunningConditionConfigured, isWorkspaceRunningConditionConfigured, type RunningConditionFg } from "../../utils/runningCondition";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import { useDatasetTimeBounds } from "../../hooks/useDatasetTimeBounds";
import { conditionText } from "./periodDisplay";
import { validatePeriods } from "../../utils/timePeriods";
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, stiffnessLabel, snapStiffness } from "../reports/pmReportTypes";
import RunningConditionPanel from "./RunningConditionPanel";
import PredictiveModelBuild, { SensorPickerModal } from "./PredictiveModelBuild";

interface BuildModelData {
    workspaceId: string;
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
}

const KIND_ABBREV: Record<ModelKind, string> = {
    individual: 'I',
    relationship: 'R',
    clustering: 'C',
};

const CATEGORY_LABELS: Record<ModelCategory, string> = {
    performance: 'Performance',
    condition: 'Condition',
};

const UNCATEGORIZED = 'Uncategorized';
const DEFAULT_CLUSTER_RANGES = [
    { min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 },
];

// Mirrors Dashboard.tsx's own FG_GROUP_PALETTE/getFgGroupColor exactly
// (duplicated, not imported — sub-windows don't share a components module)
// so a group renders the same color here as it does on the Dashboard tab.
const FG_GROUP_PALETTE = ['amber', 'violet', 'green', 'blue'] as const;
const getFgGroupColor = (no: number): string =>
    no === 0 ? 'slate' : FG_GROUP_PALETTE[(no - 1) % FG_GROUP_PALETTE.length];

// Same oklch values as .fg-group-color-{name} in App.css, kept as plain JS
// here rather than relied on via CSS inheritance.
const FG_ACCENT: Record<string, string> = {
    amber: 'oklch(0.78 0.14 75)',
    violet: 'oklch(0.7 0.15 310)',
    green: 'oklch(0.72 0.15 150)',
    blue: 'oklch(0.68 0.17 245)',
    slate: 'var(--text-faint)',
};

/** Every model bucketed by its sensor key, workspace-wide (not scoped to one
 *  Failure Group) — the left list's "Component" grouping and the detail
 *  pane both need the sensor's FULL model set regardless of which FG a
 *  particular list row came from. Same identity (`modelSensorKey`) as
 *  `groupModelsBySensor`, just without the per-group filter. */
function allSensorGroups(models: FailureModel[]): SensorModelGroup[] {
    const out: SensorModelGroup[] = [];
    const byKey = new Map<string, SensorModelGroup>();
    for (const m of models) {
        const key = modelSensorKey(m);
        let g = byKey.get(key);
        if (!g) { g = { key, models: [] }; byKey.set(key, g); out.push(g); }
        g.models.push(m);
    }
    return out;
}

type LeftGroupBy = 'fg' | 'component';
type SidebarFilter = 'all' | 'attn' | 'done';

const LEGACY_BADGE = 'Legacy · all data';

/** Gate badge (approved mockup rc-gate.html): "Legacy · all data" is a neutral
 *  grey pill (the model stays Complete, nothing is wrong); every blocking
 *  reason ("Needs condition" ...) is the amber warn pill. */
function GateBadgePill({ text, title, testId }: { text: string; title?: string; testId?: string }) {
    return (
        <span data-testid={testId} title={title} className={`f4-pill ${text === LEGACY_BADGE ? 'f4-pill--grey' : 'f4-pill--warn'}`}>
            {text}
        </span>
    );
}

/** Kind identity colour used for the active tab underline. */
const KIND_COLOR: Record<ModelKind, string> = {
    individual: 'var(--accent-hi)',
    relationship: 'var(--warn)',
    clustering: 'var(--kind-clu)',
};

/** Unsaved edits to ONE model (kept per model id so switching a sensor's
 *  kind tabs never loses them). Only fields the user can edit here;
 *  `category` is deliberately absent (per-sensor, saved instantly from the
 *  detail header). */
interface ModelDraft {
    name: string;
    predictors: string[];
    y: string;
    criteria: string;
    ranges: { min: number | null; max: number | null }[];
    stiffness: number;
    numClusters: number;
    runningConditionMode: 'workspace' | 'custom';
}

const draftFromModel = (m: FailureModel): ModelDraft => ({
    name: m.name,
    predictors: m.predictorSensors ?? [],
    y: m.ySensor ?? '',
    criteria: m.criteriaSensor ?? '',
    ranges: m.clusterRanges?.length ? m.clusterRanges : DEFAULT_CLUSTER_RANGES,
    stiffness: snapStiffness(m.relStiffness ?? STIFFNESS_DEFAULT),
    numClusters: m.numClusters ?? 3,
    runningConditionMode: m.runningConditionMode ?? 'workspace',
});

// Fixed order (not alphabetical) -- I/R/C is a small, natural taxonomy, not
// an open-ended list like components, so it reads better presented in the
// same order the kind toggles/badges use everywhere else in the app.
const KIND_ORDER: ModelKind[] = ['individual', 'relationship', 'clustering'];
const DUPLICATE_NAME_BLOCK_REASON = 'Model name is already used by another model of this sensor';
const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

/**
 * The single Build Model window — a singleton (label `build-model`) opened
 * from the Failure Groups tab's "Build Model" button.
 *
 * 🆕 2026-09-29 [Build Model Workbench, Phase A]: the Overview page was
 * rebuilt as a master/detail "Workbench" (approved mockup
 * 4jDz6AVCFMgTbxrGuFB9SN, Version 13) replacing the old "Group by Failure
 * Group / Component / Model Type" accordion — layout only, every
 * behavior/handler below is unchanged from before this pass:
 *   - A left sensor list (search + filter chips + Failure-group/Component
 *     grouping — Model Type grouping is REMOVED entirely) selects a sensor;
 *     a right detail panel shows that sensor's I/R/C tabs, a collapsible
 *     "Model settings" section, a Phase-A placeholder results area, and a
 *     per-model footer (status pill, Open full view, Save, Mark complete).
 *   - The workspace-wide Running Condition Filter moved from an always-
 *     visible inline panel to a one-line summary bar + "Edit…" modal
 *     wrapping the same, unchanged `RunningConditionPanel`.
 *   - Train/lastTrainedAt/staleness and the Failure-Groups-tab status dots
 *     are explicitly NOT part of this phase (Phase B/C) — the results area
 *     is a placeholder only.
 *   - 2026-08-31: there is no "add" flow — toggling a sensor into a group
 *     (Dashboard's Sensor tab) is the sole way a model comes into existence,
 *     always as kind 'individual'. A model's kind, its auto-filled identity
 *     sensor (Target / X), FG membership and Model Type are still not
 *     editable here — see this file's git history for the long list of
 *     explicit user requests behind each of those rules; none of them
 *     changed in this pass, only where/how they render.
 *
 * All of this is local state — no window spawn for any of it.
 *
 * Owns `failureGroupState` jointly with Dashboard and PredictiveModelBuild —
 * every write here is a read-modify-write against the full workspace file
 * and broadcasts `failure-group-state-changed` afterward so those other
 * windows never see stale data.
 */
export default function BuildModelWindow() {
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [allGroups, setAllGroups] = useState<FailureGroup[]>([]);
    const [allModels, setAllModels] = useState<FailureModel[]>([]);
    // Workspace-wide "machine running" filter (2026-09-15) — set once here,
    // every model of every kind picks it up automatically at train time (see
    // PredictiveModelBuild.tsx's `dashboardFilterPayload`).
    const [runningConditionFilters, setRunningConditionFilters] = useState<WorkspaceSensorFilter[]>([]);
    // How the conditions above combine — 'and' (default) or 'or' (2026-09-23).
    const [runningConditionCombine, setRunningConditionCombine] = useState<'and' | 'or'>('and');
    // Workspace-default training PERIODS (Feature 4-C). Empty = no time limit.
    // A model in Workspace mode uses THIS list; Custom mode uses its own
    // `filterTimePeriods`.
    const [runningConditionTimePeriods, setRunningConditionTimePeriods] = useState<TimePeriod[]>([]);
    const { bounds: datasetBounds } = useDatasetTimeBounds();
    // Drives the Workbench's "Edit…" Running Condition modal (was an inline
    // collapsible panel before Phase A; same underlying state, now shown in
    // a modal overlay instead of an always-present card).
    const [rcFilterOpen, setRcFilterOpen] = useState(false);
    // "No condition - use all rows" was explicitly confirmed for the workspace
    // (Feature 4, soft gate A). Mirrors failureGroupState.runningConditionNoneConfirmed.
    const [runningConditionNoneConfirmed, setRunningConditionNoneConfirmed] = useState(false);
    // Legacy-workspace banner: the STORED flag (failureGroupState.rcLegacyNotice,
    // written at hydration) plus a session-only "Remind me later" (never persisted).
    const [rcLegacyNotice, setRcLegacyNotice] = useState<'pending' | null>(null);
    const [legacyRemindLater, setLegacyRemindLater] = useState(false);
    /** Why the last Finish did not mark the model Complete (shown on the overview). */
    const [completeBlock, setCompleteBlock] = useState<string | null>(null);
    // Workspace id the panel was last auto-opened for, so "auto-open when the
    // running condition is unconfigured" happens once per hydration, not on
    // every broadcast.
    const rcAutoOpenedFor = useRef<string | null>(null);
    const [loading, setLoading] = useState(true);
    const hydratedRef = useRef(false);

    // ---- Workbench left list (Phase A) ----
    const [leftGroupBy, setLeftGroupBy] = useState<LeftGroupBy>('fg');
    const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    /** The sensor currently shown in the detail pane (a `modelSensorKey`), or
     *  null before anything is selected / when there are no models yet. */
    const [selectedSensorKey, setSelectedSensorKey] = useState<string | null>(null);
    /** Which model (kind tab) is active per sensor. */
    const [activeTab, setActiveTab] = useState<Record<string, string>>({});
    /** "Model settings" collapse override per model id — absent = auto
     *  (open while incomplete, else collapsed). */
    const [settingsOpenOverride, setSettingsOpenOverride] = useState<Record<string, boolean>>({});

    // ---- Predictive Model page — an in-window "next page" (not a spawned
    //      OS window) reached from the detail footer's "Open full view ↗"
    //      button. Only Dashboard + this singleton window are ever open at
    //      once. ----
    const [activePage, setActivePage] = useState<'overview' | 'model'>('overview');
    const [pmPageModelId, setPmPageModelId] = useState<string | null>(null);

    /** Unsaved edits, keyed by model id. */
    const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
    /** One-time "categories were made consistent" notice — STORED in the
     *  workspace (failureGroupState.categoryNormalisationNotice), not computed
     *  per render, so it survives whichever window writes the file first. */
    const [categoryNotice, setCategoryNotice] = useState<CategoryChange[] | null>(null);
    const [categoryWarn, setCategoryWarn] = useState<{ key: string; text: string } | null>(null);

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getComponent = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.component ?? '', [sensorMetaMap]);
    // Raw description only (not the "description (tag)" combo `sensorLabel`
    // below builds) — matches `SensorAutocomplete`'s own `getDesc` contract,
    // which appends the tag itself separately.
    const getDesc = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description ?? '', [sensorMetaMap]);
    // "description (tag)" everywhere a sensor is shown to the user (picker
    // options, predictor chips, the summary line) — the raw tag alone isn't
    // enough to recognize a sensor by; falls back to the bare tag when no
    // mapping/description exists for it.
    const sensorLabel = useCallback((tag: string) => {
        const desc = sensorMetaMap.get(normalizeSensorTag(tag))?.description;
        return desc ? `${desc} (${tag})` : tag;
    }, [sensorMetaMap]);

    // The model's own name if the user set one — a name identical to its
    // own target tag doesn't count (legacy-migrated models default to
    // that), else "description (tag)" for the target sensor, else a
    // placeholder. Clustering's Y sensor stays blank until configured,
    // falling back to X.
    const modelDisplayLabel = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        const trimmedName = model.name.trim();
        if (trimmedName && trimmedName !== targetTag) return trimmedName;
        if (!targetTag) return 'Untitled model';
        return sensorLabel(targetTag);
    }, [sensorLabel]);

    const modelComponent = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        if (!targetTag) return UNCATEGORIZED;
        return sensorMetaMap.get(normalizeSensorTag(targetTag))?.component || UNCATEGORIZED;
    }, [sensorMetaMap]);

    // Which workspace this window is currently showing, and a counter that
    // lets a slow, superseded `loadWorkspaceData` drop its result instead of
    // overwriting a newer one (2026-09-21: several `build-model-data` replies
    // could be in flight at once and whichever load finished last won).
    const workspaceIdRef = useRef<string | null>(null);
    const loadSeq = useRef(0);

    // 🆕 2026-09-29 [data-loss fix]: the most recent in-flight
    // `updateWorkspaceData` write from ANY persist path in this window
    // (running-condition edits, a model draft Save, Finish/markModelComplete,
    // the hydration-time migration write, …). Mirrors Dashboard.tsx's own
    // `pendingSaveRef` pattern. Always overwritten to the LATEST write; a
    // superseded one is simply abandoned, never left dangling. `handleClose`
    // and the `onCloseRequested` handler below await whatever this currently
    // holds before actually letting the window close.
    const pendingSaveRef = useRef<Promise<void> | null>(null);
    const trackPending = useCallback((p: Promise<void>): Promise<void> => {
        const tracked = p.finally(() => {
            if (pendingSaveRef.current === tracked) pendingSaveRef.current = null;
        });
        pendingSaveRef.current = tracked;
        return tracked;
    }, []);
    // The Predictive Model page (rendered inline below, not a separate OS
    // window) owns its own debounced persist and already flushes it on its
    // Back/Finish buttons. A native window close bypasses those buttons
    // entirely, so this window also needs a way to flush THAT page's pending
    // write before it is allowed to close.
    const pmFlushRef = useRef<(() => Promise<void>) | null>(null);
    const registerPmFlush = useCallback((flush: (() => Promise<void>) | null) => {
        pmFlushRef.current = flush;
    }, []);
    /** Awaits both this window's own pending write and the PM page's pending
     *  debounced write (if that page is open), so no path off this window can
     *  drop an edit made just before closing. */
    const flushAllPending = useCallback(async () => {
        if (pmFlushRef.current) await pmFlushRef.current();
        if (pendingSaveRef.current) await pendingSaveRef.current;
    }, []);

    // Mirrors the whole slice into local state — used by every path that
    // receives a fresh copy (hydration, broadcasts, our own writes).
    const applyFg = useCallback((fg: FailureGroupStateSlice | undefined | null) => {
        setAllGroups(fg?.groups ?? []);
        setAllModels(fg?.models ?? []);
        setRunningConditionFilters(fg?.runningConditionFilters ?? []);
        setRunningConditionCombine(fg?.runningConditionCombine ?? 'and');
        setRunningConditionTimePeriods(fg?.runningConditionTimePeriods ?? []);
        setRunningConditionNoneConfirmed(fg?.runningConditionNoneConfirmed ?? false);
        setRcLegacyNotice(fg?.rcLegacyNotice ?? null);
        setCategoryNotice(fg?.categoryNormalisationNotice ?? null);
    }, []);

    // A draft for a model that no longer exists (deleted on the Dashboard
    // meanwhile) must not linger.
    useEffect(() => {
        setDrafts(prev => {
            const ids = new Set(allModels.map(m => m.id));
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
    }, [allModels]);

    // The sensor shown in the detail pane must always be one that still has
    // at least one model — reselects the first available sensor whenever the
    // current selection disappears (another window deleted it, or this is
    // the first hydration). Runs off `allModels` directly (not off any
    // memoized bucket) so it fires exactly when the underlying data changes.
    useEffect(() => {
        const keys = allSensorGroups(allModels).map(sg => sg.key);
        setSelectedSensorKey(prev => (prev !== null && keys.includes(prev)) ? prev : (keys[0] ?? null));
    }, [allModels]);

    useEffect(() => {
        const offData = subscribe<BuildModelData>('build-model-data', async (event) => {
            const d = event.payload;
            // Re-pointed at a DIFFERENT workspace than the one on screen (the
            // main window moved on to another project while this window
            // stayed open): drop everything belonging to the old one —
            // including a PM page or half-edited form for a model that does
            // not exist in the new workspace.
            const switched = workspaceIdRef.current !== null && workspaceIdRef.current !== d.workspaceId;
            workspaceIdRef.current = d.workspaceId;
            setWorkspaceId(d.workspaceId);
            if (switched) {
                setActivePage('overview');
                setPmPageModelId(null);
                setSelectedSensorKey(null);
                setActiveTab({});
                setSettingsOpenOverride({});
                setSearchQuery('');
                setSidebarFilter('all');
                setLeftGroupBy('fg');
                setSidebarCollapsed(false);
                setDrafts({});
                setCategoryNotice(null);
                setCategoryWarn(null);
                setAllGroups([]);
                setAllModels([]);
                setRunningConditionFilters([]);
                setRunningConditionCombine('and');
                setRunningConditionTimePeriods([]);
                setRunningConditionNoneConfirmed(false);
                setRcLegacyNotice(null);
                setLegacyRemindLater(false);
                setRcFilterOpen(false);
            }
            setAllSensors(d.sensorHeaders);
            setSensorMetadata(d.sensorMetadata);
            const seq = ++loadSeq.current;
            try {
                const ws = await loadWorkspaceData(d.workspaceId);
                if (seq !== loadSeq.current || workspaceIdRef.current !== d.workspaceId) return;
                // One-time legacy cleanup (Feature 4-A): a sensor whose models
                // disagree on category is made consistent. When that changed
                // something, the result + notice are WRITTEN BACK here so the
                // notice is stored data (Dashboard's autosave can't lose it,
                // and it never re-fires once dismissed).
                // Same for the running-condition gate (Feature 4-B): a workspace
                // that already has models but nothing configured is flagged
                // `rcLegacyNotice: 'pending'` and written back, so the banner is
                // stored data rather than something recomputed per render.
                // Feature 4-C: old single time ranges become periods and the old
                // keys are dropped; written back only when that changed something.
                const periodsMigrated = ws ? migratePeriods(ws, { dropLegacyKeys: true }) : ws;
                const periodsChanged = periodsMigrated !== ws;
                const migrated = periodsMigrated ? flagLegacyGate(normalizeCategories(periodsMigrated)) : periodsMigrated;
                applyFg(migrated?.failureGroupState);
                if (migrated && rcAutoOpenedFor.current !== d.workspaceId) {
                    rcAutoOpenedFor.current = d.workspaceId;
                    const headers = d.sensorHeaders.length ? d.sensorHeaders : null;
                    if (!isWorkspaceRunningConditionConfigured(migrated.failureGroupState, headers)) setRcFilterOpen(true);
                }
                if (periodsChanged || (migrated !== ws && (migrated?.failureGroupState?.categoryNormalisationNotice?.length || migrated?.failureGroupState?.rcLegacyNotice === 'pending'))) {
                    await trackPending((async () => {
                        const written = await updateWorkspaceData(d.workspaceId, prev => flagLegacyGate(normalizeCategories(migratePeriods(prev, { dropLegacyKeys: true }))));
                        if (seq !== loadSeq.current || workspaceIdRef.current !== d.workspaceId) return;
                        if (written?.failureGroupState) {
                            applyFg(written.failureGroupState);
                            await emit('failure-group-state-changed', { ...written.failureGroupState, workspaceId: d.workspaceId, origin: 'build-model' });
                        }
                    })());
                }
            } catch (e) {
                console.warn('Failed to hydrate failure-group state:', e);
            }
            hydratedRef.current = true;
            setLoading(false);
        });

        // Any other window (Dashboard, PredictiveModelBuild) that
        // persists failureGroupState broadcasts this so our copy never
        // goes stale. Ignores another workspace's broadcast (events are
        // global) and this window's own echo.
        const offChanged = subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
            if (event.payload.workspaceId !== workspaceIdRef.current) return;
            if (event.payload.origin === 'build-model') return;
            // A load already in flight is now older than this broadcast.
            loadSeq.current++;
            applyFg(event.payload);
        });

        // Register both before asking, so the reply can't be missed.
        Promise.all([offData.ready, offChanged.ready]).then(() => emit('request-build-model-data'));

        return () => {
            offData();
            offChanged();
        };
    }, [applyFg, trackPending]);

    // Returns the write's promise (also tracked via `trackPending`, so a
    // window close can await it) rather than being fire-and-forget itself.
    const persist = useCallback((
        updater: (models: FailureModel[], groups: FailureGroup[]) => { models: FailureModel[]; groups: FailureGroup[] },
    ): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        return trackPending((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => {
                const groups = prev.failureGroupState?.groups ?? [];
                const models = prev.failureGroupState?.models ?? [];
                const result = updater(models, groups);
                // Spread-merge: this path only changes groups/models; every other slice
                // field (running condition incl. time range, future fields) must survive.
                return withFailureGroupState(prev, { groups: result.groups, models: result.models });
            });
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyFg, trackPending]);

    // The one path that actually changes the workspace-wide running
    // condition — edited entirely from the "Running Condition Filter" modal
    // (see the JSX below), never per-model. One function for all four
    // sub-fields (filters/combine/time start/time end) rather than a
    // near-duplicate persist-function per field.
    const persistRunningCondition = useCallback((patch: {
        filters?: WorkspaceSensorFilter[];
        combine?: 'and' | 'or';
        periods?: TimePeriod[];
        noneConfirmed?: boolean;
    }): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        return trackPending((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => {
                const applied = withFailureGroupState(prev, {
                    ...(patch.filters !== undefined ? { runningConditionFilters: patch.filters } : {}),
                    ...(patch.combine !== undefined ? { runningConditionCombine: patch.combine } : {}),
                    ...(patch.periods !== undefined ? { runningConditionTimePeriods: patch.periods } : {}),
                    ...(patch.noneConfirmed !== undefined ? { runningConditionNoneConfirmed: patch.noneConfirmed } : {}),
                });
                // Any edit made through this panel settles the legacy notice.
                const fg = applied.failureGroupState;
                const stillPending = fg?.rcLegacyNotice === 'pending' && !isWorkspaceRunningConditionConfigured(fg);
                return withFailureGroupState(applied, { rcLegacyNotice: stillPending ? 'pending' : null });
            });
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyFg, trackPending]);

    const addRunningConditionFilter = useCallback(() => {
        const next = [...runningConditionFilters, {
            id: `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sensor: allSensors[0] ?? '',
            operation: 'greater_than' as const,
            value1: '',
            value2: '',
        }];
        // A condition and "No condition" are mutually exclusive.
        setRunningConditionNoneConfirmed(false);
        setRunningConditionFilters(next);
        persistRunningCondition({ filters: next, noneConfirmed: false });
    }, [runningConditionFilters, allSensors, persistRunningCondition]);

    const updateRunningConditionFilter = useCallback((id: string, patch: Partial<WorkspaceSensorFilter>) => {
        const next = runningConditionFilters.map(f => f.id === id ? { ...f, ...patch } : f);
        setRunningConditionFilters(next);
        persistRunningCondition({ filters: next });
    }, [runningConditionFilters, persistRunningCondition]);

    const removeRunningConditionFilter = useCallback((id: string) => {
        const next = runningConditionFilters.filter(f => f.id !== id);
        setRunningConditionFilters(next);
        persistRunningCondition({ filters: next });
    }, [runningConditionFilters, persistRunningCondition]);

    // Periods are committed by the editor itself on blur / Enter (sorted), so
    // no debounce is needed here.
    const updateRunningConditionPeriods = useCallback((periods: TimePeriod[]) => {
        setRunningConditionTimePeriods(periods);
        persistRunningCondition({ periods });
    }, [persistRunningCondition]);

    // ---- Model editing (Feature 4-A, 2026-09-24) ----
    // Edits are kept as one DRAFT PER MODEL ID (not one global form), so
    // switching between a sensor's Individual / Relationship / Clustering
    // tabs never loses an unsaved edit. Identity fields (target sensor / X
    // sensor, kind, failure groups) are read straight from the stored model:
    // they are locked/read-only, so a draft can never carry a stale copy of
    // them. A draft also never carries `category`: category is per SENSOR
    // and saves instantly from the detail header (see `changeCategory`).
    const draftOf = (m: FailureModel): ModelDraft => drafts[m.id] ?? draftFromModel(m);
    const patchDraft = (m: FailureModel, patch: Partial<ModelDraft>) =>
        setDrafts(prev => ({ ...prev, [m.id]: { ...(prev[m.id] ?? draftFromModel(m)), ...patch } }));

    /** Category of the model's sensor across every FG (never per-model any more). */
    const categoryOf = (m: FailureModel): ModelCategory | null => sensorCategory(allModels, modelSensorKey(m));

    // ---- Running-condition gate (Feature 4-B, soft gate A). ONE source of
    //      truth: `getBuildBlockReason`. Every Build / Finish / "mark Complete"
    //      path below asks it; Save is deliberately NOT gated by it. ----
    const gateFg: RunningConditionFg = {
        models: allModels, runningConditionFilters, runningConditionCombine,
        runningConditionTimePeriods, runningConditionNoneConfirmed,
    };
    const gateHeaders = allSensors.length ? allSensors : null;
    const gateReasonOf = (m: FailureModel): string | null => getBuildBlockReason(m, gateFg, gateHeaders);
    const rcConfigured = isWorkspaceRunningConditionConfigured(gateFg, gateHeaders);
    const needsCondition = (m: FailureModel): boolean => !isRunningConditionConfigured(m, gateFg, gateHeaders);
    const legacyCompleteCount = allModels.filter(m => m.status).length;
    const blockedByCondition = allModels.filter(m => !m.status && needsCondition(m)).length;
    /** Badge text for a model the gate blocks, for ANY reason (missing condition,
     *  missing category, invalid period), else null. Hover text is the reason. */
    const gateBadge = (m: FailureModel): string | null => {
        if (gateReasonOf(m) === null) return null;
        if (needsCondition(m)) return m.status ? LEGACY_BADGE : 'Needs condition';
        return categoryOf(m) === null ? 'Needs category' : 'Fix periods';
    };

    /** Another model of the same sensor already using the name being saved.
     *  Only the model being edited is gated: an untouched draft (or one reverted
     *  to its saved name) is never blocked, so already-saved duplicates stay. */
    const nameConflictOf = (m: FailureModel): FailureModel | null => {
        const d = drafts[m.id];
        if (!d || d.name.trim() === (m.name ?? '').trim()) return null;
        return findSameSensorNameConflict(allModels, m, d.name);
    };

    /** Why Save is disabled (category / required fields), or null. */
    const modelBlockReason = (m: FailureModel): string | null => {
        // Same text as `getBuildBlockReason` (single source: one string everywhere).
        if (categoryOf(m) === null) return CATEGORY_BLOCK_REASON;
        const d = draftOf(m);
        const ok = d.name.trim() !== '' && m.groupNos.length > 0 && (
            m.kind === 'individual' ? (m.targetSensor ?? '') !== '' :
            m.kind === 'relationship' ? (m.targetSensor ?? '') !== '' && d.predictors.length >= 1 :
            (m.xSensor ?? '') !== '' && d.y !== '' && (!d.criteria || d.ranges.every(r => r.min !== null && r.max !== null))
        );
        if (!ok) return 'Fill in the required fields above first';
        return nameConflictOf(m) ? DUPLICATE_NAME_BLOCK_REASON : null;
    };

    /** Why Open full view is disabled: everything Save needs, then the gate. */
    const buildBlockReason = (m: FailureModel): string | null => modelBlockReason(m) ?? gateReasonOf(m);

    /** Short list of what's missing from THIS model's own settings (not the
     *  running condition — that's a separate concern surfaced by the gate
     *  badge/footer instead). Drives the "Model settings" section's
     *  auto-expand and its "N to fix" pill. */
    const missingItems = (m: FailureModel): string[] => {
        const d = draftOf(m);
        const items: string[] = [];
        if (categoryOf(m) === null) items.push('Pick a category');
        if (!d.name.trim()) items.push('Model name is required');
        if (m.kind === 'relationship' && d.predictors.length === 0) items.push('Add at least 1 predictor');
        if (m.kind === 'clustering') {
            if (!d.y) items.push('Pick a Y sensor');
            if (d.criteria && !d.ranges.every(r => r.min !== null && r.max !== null)) items.push('Fill in the cluster ranges');
        }
        if (nameConflictOf(m)) items.push('Fix the duplicate model name');
        return items;
    };

    /** Collapsed "Model settings" one-line summary: name · predictors/Y ·
     *  stiffness/clusters · data scope. */
    const settingsSummaryLine = (m: FailureModel, d: ModelDraft): string => {
        const parts = [d.name.trim() || 'Untitled'];
        if (m.kind === 'relationship') parts.push(d.predictors.length ? `${d.predictors.length} predictor${d.predictors.length === 1 ? '' : 's'}` : 'no predictors');
        else if (m.kind === 'clustering') parts.push(`Y: ${d.y ? sensorLabel(d.y) : '—'}`);
        if (m.kind === 'relationship') parts.push(stiffnessLabel(d.stiffness));
        else if (m.kind === 'clustering') parts.push(`${d.numClusters} clusters`);
        else parts.push('1σ + 3σ');
        parts.push(d.runningConditionMode === 'custom' ? 'Custom data' : 'Workspace data');
        return parts.join(' · ');
    };

    // Returns the `persist()` promise (rather than firing it and forgetting)
    // so `buildModel` below can await the write actually landing on disk
    // before navigating to the PM page.
    const commitModel = async (m: FailureModel) => {
        if (modelBlockReason(m) !== null) return;
        const d = draftOf(m);
        const fields: Partial<FailureModel> =
            m.kind === 'individual' ? { name: d.name.trim(), runningConditionMode: d.runningConditionMode } :
            m.kind === 'relationship' ? { name: d.name.trim(), predictorSensors: d.predictors, relStiffness: d.stiffness, runningConditionMode: d.runningConditionMode } :
            { name: d.name.trim(), ySensor: d.y, criteriaSensor: d.criteria, clusterRanges: d.criteria ? d.ranges : [], numClusters: d.numClusters, runningConditionMode: d.runningConditionMode };
        await persist((models, groups) => ({
            groups,
            models: models.map(x => x.id === m.id ? { ...x, ...fields } : x),
        }));
        setDrafts(prev => {
            if (!(m.id in prev)) return prev;
            const rest = { ...prev };
            delete rest[m.id];
            return rest;
        });
    };

    /** The detail header's category control: writes EVERY model of that
     *  sensor in EVERY failure group, and saves instantly (no Save button). */
    const changeCategory = async (key: string, cat: ModelCategory) => {
        if (sensorCategory(allModels, key) === cat) return;
        const groupNos = [...new Set(allModels.filter(m => modelSensorKey(m) === key).flatMap(m => m.groupNos))].sort((a, b) => a - b);
        await persist((models, groups) => ({ groups, models: setSensorCategory(models, key, cat) }));
        setCategoryWarn(groupNos.length > 1
            ? { key, text: `Category applies to this sensor in every failure group: ${groupNos.map(n => n === 0 ? 'Not in Group' : `FG-${n}`).join(', ')}.` }
            : null);
    };

    const dismissCategoryNotice = (): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        return trackPending((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => withFailureGroupState(prev, { categoryNormalisationNotice: null }));
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    };

    const toggleModelStatus = (modelId: string) => {
        // Toward Complete only: an unconfigured model can't be marked Complete;
        // going back to Incomplete is always allowed.
        const target = allModels.find(m => m.id === modelId);
        if (target && !target.status && gateReasonOf(target) !== null) return;
        persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: !m.status } : m),
        }));
    };

    /** Sets `status: true` unconditionally (unlike `toggleModelStatus`) —
     *  used by the PM page's "Finish" button, where clicking it again should
     *  never accidentally flip an already-complete model back to incomplete.
     *  Un-marking a model still goes through the footer's own action button
     *  (`toggleModelStatus`). The gate is evaluated against what is on DISK
     *  inside the write (the PM page flushes its own edits first), never
     *  against this window's possibly lagging copy. */
    const markModelComplete = (modelId: string): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        setCompleteBlock(null);
        return trackPending((async () => {
            const res = { reason: null as string | null };
            const next = await updateWorkspaceData(workspaceId, prev => {
                const fg = prev.failureGroupState;
                const target = fg?.models?.find(m => m.id === modelId);
                if (!target) return prev;
                res.reason = getBuildBlockReason(target, fg, gateHeaders);
                if (res.reason !== null) return prev;
                return withFailureGroupState(prev, { models: (fg?.models ?? []).map(m => m.id === modelId ? { ...m, status: true } : m) });
            });
            if (res.reason !== null) setCompleteBlock(res.reason);
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                if (res.reason === null) await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    };

    const trainModel = (modelId: string) => {
        // Guard at the source too, so a future caller can't bypass the gate.
        const target = allModels.find(m => m.id === modelId);
        if (target && gateReasonOf(target) !== null) return;
        setPmPageModelId(modelId);
        setActivePage('model');
    };

    // 🆕 2026-09-29 [data-loss fix]: awaits every in-flight write before
    // actually closing the window. See `flushAllPending` above and the
    // `onCloseRequested` effect below for the native-close equivalent.
    const handleClose = async () => {
        await flushAllPending();
        await getCurrentWindow().close();
    };

    // 🆕 2026-09-29 [data-loss fix]: a native close (the window's own X
    // button, Alt+F4, or the OS closing the app) bypasses `handleClose`
    // entirely. Only intercepts the close when this window has an in-flight
    // write of its own or the PM page is currently mounted.
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const win = getCurrentWindow();
        Promise.resolve(win.onCloseRequested(async (event) => {
            const pmPending = pmFlushRef.current;
            const pending = pendingSaveRef.current;
            if (!pmPending && !pending) return;
            event.preventDefault();
            await flushAllPending();
            await win.close();
        })).then(fn => { if (disposed) fn(); else unlisten = fn; });
        return () => { disposed = true; if (unlisten) unlisten(); };
    }, [flushAllPending]);

    // 🆕 2026-09-18 [bug fix]: must await commitModel's write landing on disk
    // before navigating to the PM page — else the PM page's own hydration
    // effect (which reads the workspace file directly) can win the race and
    // load the model record from BEFORE this commit.
    const buildModel = async (m: FailureModel) => {
        if (buildBlockReason(m) !== null) return;
        await commitModel(m);
        trainModel(m.id);
    };

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
    }

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const sensorGroupsAll = allSensorGroups(allModels);
    const fullSensorMap = new Map(sensorGroupsAll.map(sg => [sg.key, sg]));
    const totalModelsCount = allModels.length;
    const completeModelsCount = allModels.filter(m => m.status).length;

    const sensorBuildBlocked = (sg: SensorModelGroup) => sg.models.some(m => buildBlockReason(m) !== null);
    const sensorAllComplete = (sg: SensorModelGroup) => sg.models.length > 0 && sg.models.every(m => m.status);
    const matchesSidebarFilter = (sg: SensorModelGroup) =>
        sidebarFilter === 'all' || (sidebarFilter === 'attn' ? sensorBuildBlocked(sg) : sensorAllComplete(sg));
    const matchesSearch = (sg: SensorModelGroup) => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        const first = sg.models[0];
        if (!first) return false;
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        return sensorLabel(keyTag).toLowerCase().includes(q) || keyTag.toLowerCase().includes(q);
    };
    const attnCount = sensorGroupsAll.filter(sensorBuildBlocked).length;
    const doneCount = sensorGroupsAll.filter(sensorAllComplete).length;

    // One left-list row for one sensor (within one grouping bucket — the same
    // sensor can render under several Failure Group buckets when it belongs
    // to more than one; selecting any of them shows the SAME detail pane).
    const renderSensorListRow = (sg: SensorModelGroup, bucketId: string) => {
        if (sg.models.length === 0 || !matchesSearch(sg) || !matchesSidebarFilter(sg)) return null;
        const first = sg.models[0];
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        const title = keyTag ? (getDesc(keyTag) || keyTag) : modelDisplayLabel(first);
        const label = keyTag ? sensorLabel(keyTag) : title;
        const ordered = KIND_ORDER.flatMap(k => sg.models.filter(m => m.kind === k));
        const selected = sg.key === selectedSensorKey;
        return (
            <div
                key={`${bucketId}:${sg.key}`}
                data-testid={`sensor-list-row-${bucketId}-${sg.key || 'blank'}`}
                className={`bmw-srow${selected ? ' bmw-srow--sel' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => setSelectedSensorKey(sg.key)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSensorKey(sg.key); } }}
            >
                <div style={{ minWidth: 0 }}>
                    <div data-testid="sensor-row-label" className="f4-sr-title" title={label}>{title}</div>
                    <div className="f4-sr-tag">{keyTag}</div>
                </div>
                <div className="f4-kinds">
                    {ordered.map(m => (
                        <span
                            key={m.id}
                            data-testid={`sensor-kind-badge-${m.id}`}
                            className={`f4-kb model-kind-icon--${m.kind}`}
                            title={`${KIND_LABEL[m.kind]} · ${m.status ? 'Complete' : 'Incomplete'}`}
                        >
                            {KIND_ABBREV[m.kind]}
                        </span>
                    ))}
                </div>
            </div>
        );
    };

    const renderLeftList = () => {
        if (leftGroupBy === 'fg') {
            const fgSection = (no: number, name: string) => {
                const rows = groupModelsBySensor(allModels, no);
                const visible = rows.filter(sg => matchesSearch(sg) && matchesSidebarFilter(sg));
                return (
                    <div key={no}>
                        <div className="bmw-list-grp"><i style={{ background: FG_ACCENT[getFgGroupColor(no)] }} />{no === 0 ? 'Not in Group' : `FG-${no} · ${name}`}</div>
                        {rows.length === 0 ? (
                            <div className="bmw-srow-empty">No models yet</div>
                        ) : visible.length === 0 ? (
                            <div className="bmw-srow-empty">No sensors match</div>
                        ) : visible.map(sg => renderSensorListRow(sg, `fg:${no}`))}
                    </div>
                );
            };
            return (
                <>
                    {realGroups.map(g => fgSection(g.no, g.name))}
                    {fgSection(0, '')}
                </>
            );
        }
        const byComp = new Map<string, SensorModelGroup[]>();
        for (const sg of sensorGroupsAll) {
            const comp = sg.models[0] ? modelComponent(sg.models[0]) : UNCATEGORIZED;
            if (!byComp.has(comp)) byComp.set(comp, []);
            byComp.get(comp)!.push(sg);
        }
        const comps = [...byComp.entries()].sort(([a], [b]) => a.localeCompare(b));
        if (comps.length === 0) return <div className="bmw-srow-empty">No models yet</div>;
        return comps.map(([comp, rows]) => {
            const visible = rows.filter(sg => matchesSearch(sg) && matchesSidebarFilter(sg));
            return (
                <div key={comp}>
                    <div className="bmw-list-grp"><i style={{ background: 'var(--text-faint)' }} />{comp}</div>
                    {visible.length === 0
                        ? <div className="bmw-srow-empty">No sensors match</div>
                        : visible.map(sg => renderSensorListRow(sg, `component:${comp}`))}
                </div>
            );
        });
    };

    // ---- Detail pane (Phase A) ----
    const detailModels = selectedSensorKey !== null ? (fullSensorMap.get(selectedSensorKey)?.models ?? []) : [];
    const orderedDetail = KIND_ORDER.flatMap(k => detailModels.filter(m => m.kind === k));
    const activeModel = orderedDetail.find(m => m.id === activeTab[selectedSensorKey ?? '']) ?? orderedDetail[0];

    const renderModelSettingsFields = (m: FailureModel, d: ModelDraft) => (
        <>
            <div className="f4-fld" style={{ minWidth: '200px' }}>
                <label>Model name</label>
                <input
                    className="fg-inspector-input"
                    value={d.name}
                    placeholder="e.g. Bearing vibration model"
                    style={d.name.trim() ? undefined : { borderColor: 'var(--warn-line)' }}
                    onChange={e => patchDraft(m, { name: e.target.value })}
                />
                {(() => {
                    const conflict = nameConflictOf(m);
                    if (!conflict) return null;
                    const suggestion = suggestDistinctModelName(allModels, m, d.name);
                    return (
                        <div data-testid="duplicate-name-warning" className="f4-req-note" style={{ marginTop: '4px' }}>
                            Same name as this sensor's {KIND_LABEL[conflict.kind]} model — give it a different name so they can be told apart
                            <button
                                type="button"
                                data-testid="use-suggested-name"
                                style={{ marginLeft: '8px', textDecoration: 'underline', color: 'inherit', cursor: 'pointer', background: 'none', border: 'none', padding: 0, fontSize: 'inherit' }}
                                onClick={() => patchDraft(m, { name: suggestion })}
                            >
                                Use '{suggestion}'
                            </button>
                        </div>
                    );
                })()}
            </div>

            {m.kind === 'individual' && (
                <div className="f4-fld">
                    <span className="f4-lbl">Boundary</span>
                    <span className="f4-pill f4-pill--grey" style={{ height: '28px', display: 'inline-flex' }}>1σ + 3σ · automatic</span>
                    <div className="f4-hint">Everything else is automatic for an Individual model.</div>
                </div>
            )}

            {m.kind === 'relationship' && (
                <>
                    <div className="f4-fld" style={{ flex: 1, minWidth: '260px' }}>
                        <span className="f4-lbl">Predictor sensors (≥ 1)</span>
                        <SensorPickerModal
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                            selected={d.predictors}
                            excluded={[m.targetSensor ?? '']}
                            onConfirm={predictors => patchDraft(m, { predictors })}
                            noun="predictors"
                            triggerText={d.predictors.length ? `${d.predictors.length} selected. Edit predictors…` : undefined}
                            invalid={d.predictors.length === 0}
                        />
                        {d.predictors.length > 0 ? (
                            <div className="f4-pchips">
                                {d.predictors.map(p => (
                                    <span key={p} className="f4-ppill" title={sensorLabel(p)}>
                                        <span>{sensorLabel(p)}</span>
                                        <button type="button" aria-label={`Remove ${p}`} onClick={() => patchDraft(m, { predictors: d.predictors.filter(x => x !== p) })}>
                                            <X size={10} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <div className="f4-req-note">No predictors yet. A Relation model needs at least one.</div>
                        )}
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Stiffness</span>
                        <div className="f4-seg">
                            {STIFFNESS_OPTIONS.map(opt => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={d.stiffness === opt.value ? 'on' : undefined}
                                    onClick={() => patchDraft(m, { stiffness: opt.value })}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}

            {m.kind === 'clustering' && (
                <>
                    <div className="f4-fld">
                        <span className="f4-lbl">X sensor</span>
                        <div className="f4-readout" title={m.xSensor ? sensorLabel(m.xSensor) : undefined}>
                            <Lock size={12} aria-hidden="true" />
                            <span>{m.xSensor ? sensorLabel(m.xSensor) : '—'}</span>
                        </div>
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Y sensor (target)</span>
                        <SensorPickerModal
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                            single
                            value={d.y}
                            onSelect={y => patchDraft(m, { y })}
                            noun="Y sensor"
                            placeholder="None selected"
                            invalid={!d.y}
                        />
                        {!d.y && <div className="f4-req-note">Required</div>}
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Criteria sensor (optional)</span>
                        <SensorPickerModal
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                            single
                            allowNone
                            value={d.criteria}
                            onSelect={criteria => patchDraft(m, { criteria })}
                            noun="criteria sensor"
                            placeholder="None"
                        />
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Clusters</span>
                        <span className="bmw-step">
                            <button type="button" aria-label="Fewer clusters" onClick={() => patchDraft(m, { numClusters: Math.max(1, d.numClusters - 1) })}>−</button>
                            <span>{d.numClusters}</span>
                            <button type="button" aria-label="More clusters" onClick={() => patchDraft(m, { numClusters: Math.min(8, d.numClusters + 1) })}>+</button>
                        </span>
                    </div>
                    {d.criteria && (
                        <div className="f4-fld" style={{ flex: 1, minWidth: '240px' }}>
                            <span className="f4-lbl">Cluster ranges</span>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {d.ranges.map((r, i) => (
                                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0,1fr) minmax(0,1fr)', gap: '6px', alignItems: 'center' }}>
                                        <b style={{ fontSize: '0.68rem', color: 'var(--text-faint)', fontWeight: 500 }}>{i + 1}</b>
                                        <input
                                            type="number"
                                            className="fg-inspector-input"
                                            value={r.min ?? ''}
                                            placeholder="min"
                                            aria-label={`Cluster ${i + 1} min`}
                                            onChange={e => patchDraft(m, { ranges: d.ranges.map((row, idx) => idx === i ? { ...row, min: e.target.value === '' ? null : Number(e.target.value) } : row) })}
                                        />
                                        <input
                                            type="number"
                                            className="fg-inspector-input"
                                            value={r.max ?? ''}
                                            placeholder="max"
                                            aria-label={`Cluster ${i + 1} max`}
                                            onChange={e => patchDraft(m, { ranges: d.ranges.map((row, idx) => idx === i ? { ...row, max: e.target.value === '' ? null : Number(e.target.value) } : row) })}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}

            <div className="f4-fld">
                <span className="f4-lbl">Training data</span>
                <div className="f4-seg">
                    <button type="button" className={d.runningConditionMode === 'workspace' ? 'on' : undefined} onClick={() => patchDraft(m, { runningConditionMode: 'workspace' })}>Workspace</button>
                    <button type="button" className={d.runningConditionMode === 'custom' ? 'on' : undefined} onClick={() => patchDraft(m, { runningConditionMode: 'custom' })}>Custom</button>
                </div>
                <div className="f4-hint">Custom edits its own conditions on the full Build page.</div>
            </div>
        </>
    );

    const renderModelSettings = (m: FailureModel) => {
        const d = draftOf(m);
        const missing = missingItems(m);
        const isOpen = settingsOpenOverride[m.id] ?? (missing.length > 0);
        const toggle = () => setSettingsOpenOverride(prev => ({ ...prev, [m.id]: !isOpen }));
        return (
            <div className={`bmw-sets${isOpen ? ' bmw-sets--open' : ''}`}>
                <button type="button" className="bmw-sets-h" aria-expanded={isOpen} onClick={toggle}>
                    <ChevronRight size={13} className="bmw-sets-chev" aria-hidden="true" />
                    <b>Model settings</b>
                    {isOpen ? <span className="bmw-sets-sp" /> : <span className="bmw-sets-sum">{settingsSummaryLine(m, d)}</span>}
                    {missing.length > 0 && <span data-testid="settings-to-fix" className="f4-pill f4-pill--warn">{missing.length} to fix</span>}
                </button>
                {isOpen && (
                    <div data-testid="add-model-form" className="bmw-sets-body">
                        {renderModelSettingsFields(m, d)}
                    </div>
                )}
            </div>
        );
    };

    const renderResultsStage = (m: FailureModel) => (
        <div className="bmw-stage">
            <div className="bmw-stage-empty" data-testid="results-placeholder">
                {m.status ? 'Marked complete — open full view to see the chart.' : 'Not trained yet'}
            </div>
        </div>
    );

    const renderFooter = (m: FailureModel) => {
        const saveReason = modelBlockReason(m);
        const reason = buildBlockReason(m);
        const cat = categoryOf(m);
        return (
            <div className="f4-foot">
                <span className={`model-status-pill model-status-pill--${m.status ? 'complete' : 'incomplete'}`} style={{ cursor: 'default' }}>
                    {m.status ? 'Complete' : 'Incomplete'}
                </span>
                {reason ? (
                    <span data-testid="build-block-reason" className="f4-foot-reason f4-foot-reason--block">
                        <CircleAlert size={11} aria-hidden="true" />
                        {reason}
                    </span>
                ) : m.id in drafts ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Unsaved changes to the {KIND_LABEL[m.kind]} model</span>
                ) : (
                    <span data-testid="footer-status" className="f4-foot-reason">{KIND_LABEL[m.kind]}{cat ? ` · ${CATEGORY_LABELS[cat]}` : ''}</span>
                )}
                <button
                    type="button"
                    className="f4-btn f4-btn--plain f4-btn--small"
                    title={reason ?? 'Sub-models and full settings'}
                    disabled={reason !== null}
                    onClick={() => buildModel(m)}
                >
                    Open full view ↗
                </button>
                <button className="f4-btn-save" disabled={saveReason !== null} onClick={() => commitModel(m)}>
                    Save changes
                </button>
                {m.status ? (
                    <button type="button" className="f4-btn f4-btn--plain f4-btn--small" onClick={() => toggleModelStatus(m.id)}>
                        Mark incomplete
                    </button>
                ) : (
                    <button
                        type="button"
                        className="bmw-btn-ok"
                        disabled={gateReasonOf(m) !== null}
                        title={gateReasonOf(m) ?? undefined}
                        onClick={() => toggleModelStatus(m.id)}
                    >
                        ✓ Mark complete
                    </button>
                )}
            </div>
        );
    };

    const renderDetailPane = () => {
        if (!activeModel) {
            return (
                <div className="bmw-empty-detail">
                    {allModels.length === 0 ? 'No models yet — add sensors to a Failure Group from the Dashboard.' : 'Select a sensor from the list.'}
                </div>
            );
        }
        const first = orderedDetail[0];
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        const title = keyTag ? (getDesc(keyTag) || keyTag) : modelDisplayLabel(first);
        const component = keyTag ? getComponent(keyTag) : '';
        const groupNos = [...new Set(detailModels.flatMap(m => m.groupNos))].sort((a, b) => a - b);
        const category = selectedSensorKey !== null ? sensorCategory(allModels, selectedSensorKey) : null;
        return (
            <>
                <div className="bmw-dhead">
                    <button
                        type="button"
                        className="bmw-iconbtn"
                        onClick={() => setSidebarCollapsed(c => !c)}
                        title={sidebarCollapsed ? 'Show sensor list' : 'Hide sensor list'}
                        aria-label={sidebarCollapsed ? 'Show sensor list' : 'Hide sensor list'}
                    >
                        {sidebarCollapsed ? '⇥' : '⇤'}
                    </button>
                    <div style={{ minWidth: 0 }}>
                        <h3 title={keyTag ? sensorLabel(keyTag) : undefined}>{title}</h3>
                        <div className="bmw-dmeta">
                            {keyTag && <span className="f4-sr-tag">{keyTag}</span>}
                            {component && <span className="model-chip model-chip--component">{component}</span>}
                            {groupNos.map(no => {
                                const g = realGroups.find(x => x.no === no);
                                return (
                                    <span key={no} className="f4-fgchip">
                                        <i style={{ background: FG_ACCENT[getFgGroupColor(no)] }} />
                                        <span>{no === 0 ? 'Not in Group' : `FG-${no} · ${g?.name ?? ''}`}</span>
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                    <div
                        role="group"
                        aria-label="Category"
                        className={`f4-catseg${category ? '' : ' f4-catseg--unset'}`}
                        title={category ? undefined : 'Pick a category — it is set once for this sensor and applies to all of its models.'}
                    >
                        {category === null && (
                            <span className="f4-cat-flag"><CircleAlert size={11} aria-hidden="true" /> Set category</span>
                        )}
                        {(['performance', 'condition'] as ModelCategory[]).map(c => {
                            const active = category === c;
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    aria-pressed={active}
                                    className={active ? (c === 'condition' ? 'on-cond' : 'on-perf') : undefined}
                                    onClick={() => changeCategory(selectedSensorKey!, c)}
                                >
                                    {CATEGORY_LABELS[c]}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {categoryWarn?.key === selectedSensorKey && (
                    <div role="status" className="f4-req-note" style={{ padding: '4px 20px 0' }}>
                        {categoryWarn.text}
                    </div>
                )}

                <div role="tablist" className="f4-tabs">
                    {orderedDetail.map(m => {
                        const selected = m.id === activeModel.id;
                        const badge = gateBadge(m);
                        return (
                            <button
                                key={m.id}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className={`f4-tab${selected ? ' f4-tab--on' : ''}`}
                                style={{ '--kc': KIND_COLOR[m.kind] } as CSSProperties}
                                title={`${KIND_LABEL[m.kind]} · ${m.status ? 'Complete' : 'Incomplete'}`}
                                onClick={() => setActiveTab(prev => ({ ...prev, [selectedSensorKey!]: m.id }))}
                            >
                                <span className={`f4-kmini model-kind-icon--${m.kind}`} aria-hidden="true">{KIND_ABBREV[m.kind]}</span>
                                <span className="f4-tab-l">{KIND_LABEL[m.kind]}</span>
                                <span className={`f4-sdot${m.status ? ' f4-sdot--done' : ''}`} />
                                {m.id in drafts && <span className="f4-dirty" title="Unsaved changes">edited</span>}
                                {badge && <GateBadgePill text={badge} testId={`condition-badge-${m.id}`} title={gateReasonOf(m) ?? undefined} />}
                            </button>
                        );
                    })}
                    <span className="f4-tabs-spacer" />
                </div>

                <div role="tabpanel" data-testid={`model-tab-panel-${activeModel.id}`} style={{ display: 'contents' }}>
                    {renderModelSettings(activeModel)}
                    {renderResultsStage(activeModel)}
                    {renderFooter(activeModel)}
                </div>
            </>
        );
    };

    const periodStatus = validatePeriods(runningConditionTimePeriods);
    const validPeriodCount = runningConditionTimePeriods.filter((_, i) => !periodStatus[i]?.invalid).length;
    const periodsText = validPeriodCount > 0 ? `${validPeriodCount} period${validPeriodCount === 1 ? '' : 's'}` : 'Any time';
    const rcCondText = runningConditionNoneConfirmed
        ? 'No condition — every row'
        : runningConditionFilters.length === 0
        ? 'Not set'
        : runningConditionFilters.map(f => conditionText(f, sensorLabel)).join(runningConditionCombine === 'or' ? ' OR ' : ' AND ');
    const rcOneLiner = `${rcCondText} · ${periodsText}`;

    const pmPageModel = activePage === 'model' ? allModels.find(m => m.id === pmPageModelId) : undefined;

    return (
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {pmPageModel ? `Build Model — ${modelDisplayLabel(pmPageModel)}` : 'Build Model — Overview'}
                </h2>
                <button onClick={handleClose} className="scatter-regl-btn scatter-regl-btn-icon" title="Close">
                    <X size={14} />
                </button>
            </div>

            {pmPageModel && workspaceId ? (
                <PredictiveModelBuild
                    workspaceId={workspaceId}
                    modelId={pmPageModel.id}
                    kind={pmPageModel.kind}
                    sensorHeaders={allSensors}
                    sensorMetadata={sensorMetadata}
                    runningConditionFilters={runningConditionFilters}
                    runningConditionCombine={runningConditionCombine}
                    runningConditionTimePeriods={runningConditionTimePeriods}
                    runningConditionNoneConfirmed={runningConditionNoneConfirmed}
                    category={categoryOf(pmPageModel)}
                    onBack={() => setActivePage('overview')}
                    onFinish={async () => {
                        await markModelComplete(pmPageModel.id);
                        setActivePage('overview');
                    }}
                    registerFlush={registerPmFlush}
                />
            ) : (
                <div className="flex flex-col" style={{ flex: 1, minHeight: 0 }}>
                    <div className="bmw-rcbar" data-testid="rc-bar">
                        <span className="bmw-rcbar-lbl">Running condition</span>
                        <span data-testid="rc-bar-pill" className={`f4-pill ${rcConfigured ? 'f4-pill--ok' : 'f4-pill--warn'}`}>{rcConfigured ? '✓ Set' : 'Required'}</span>
                        <span className="bmw-rcbar-rule" title={rcOneLiner}>{rcOneLiner}</span>
                        <button type="button" className="f4-btn f4-btn--small" onClick={() => setRcFilterOpen(true)}>Edit…</button>
                    </div>

                    {rcLegacyNotice === 'pending' && !rcConfigured && !legacyRemindLater && (
                        <div
                            role="status"
                            data-testid="rc-legacy-banner"
                            className="f4-callout f4-callout--info"
                            style={{ margin: '12px 20px 0' }}
                        >
                            <div>
                                <b>New: running condition is now required for every model.</b>{' '}
                                {legacyCompleteCount > 0
                                    ? `${legacyCompleteCount} model${legacyCompleteCount === 1 ? '' : 's'} in this workspace ${legacyCompleteCount === 1 ? 'was' : 'were'} trained on the full dataset. They stay `
                                    : 'Models in this workspace were set up without one. They stay '}
                                <b>Complete</b> and nothing is changed. Set a condition before you build or re-train a model.
                            </div>
                            <div className="f4-acts">
                                <button type="button" className="f4-btn f4-btn--small" onClick={() => setRcFilterOpen(true)}>Set a condition</button>
                                <button
                                    type="button"
                                    className="f4-btn f4-btn--plain f4-btn--small"
                                    onClick={() => {
                                        setRunningConditionNoneConfirmed(true);
                                        persistRunningCondition({ noneConfirmed: true });
                                    }}
                                >
                                    Keep using all data
                                </button>
                                <button type="button" className="f4-btn f4-btn--plain f4-btn--small" onClick={() => setLegacyRemindLater(true)}>Remind me later</button>
                            </div>
                        </div>
                    )}

                    {!rcConfigured && blockedByCondition > 0 && (
                        <div data-testid="rc-blocked-summary" className="f4-reason" style={{ margin: '8px 20px 0' }}>
                            ⚠ {blockedByCondition} of {totalModelsCount} model{totalModelsCount === 1 ? '' : 's'} can't be built yet — they follow the workspace or have no condition of their own.
                        </div>
                    )}

                    {completeBlock && (
                        <div
                            role="alert"
                            data-testid="complete-block-reason"
                            className="f4-callout"
                            style={{ margin: '12px 20px 0', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center' }}
                        >
                            <div>The model was not marked Complete. {completeBlock}</div>
                            <button type="button" className="f4-btn f4-btn--plain f4-btn--small" onClick={() => setCompleteBlock(null)}>Dismiss</button>
                        </div>
                    )}

                    {categoryNotice && categoryNotice.length > 0 && (() => {
                        // One entry per sensor (the change list is per model). The
                        // "taken from" model is the first one, in Individual ->
                        // Relationship -> Clustering order, that was NOT changed.
                        const bySensor = new Map<string, CategoryChange[]>();
                        for (const c of categoryNotice) bySensor.set(c.sensorKey, [...(bySensor.get(c.sensorKey) ?? []), c]);
                        const changedIds = new Set(categoryNotice.map(c => c.modelId));
                        return (
                            <div role="status" data-testid="category-normalisation-notice" className="f4-notice" style={{ margin: '12px 20px 0' }}>
                                <span className="f4-notice-ico"><TriangleAlert size={16} aria-hidden="true" /></span>
                                <div style={{ minWidth: 0 }}>
                                    <div className="f4-notice-title">
                                        Category made consistent for {bySensor.size} sensor{bySensor.size === 1 ? '' : 's'}
                                    </div>
                                    All models of one sensor now share one category. These models were changed when this workspace loaded:
                                    <ul>
                                        {[...bySensor.entries()].map(([key, changes]) => {
                                            const to = changes[0].to;
                                            const source = KIND_ORDER
                                                .flatMap(k => allModels.filter(m => modelSensorKey(m) === key && m.kind === k))
                                                .find(m => !changedIds.has(m.id) && m.category != null);
                                            const any = allModels.find(m => modelSensorKey(m) === key);
                                            const tag = (any && (any.kind === 'clustering' ? any.xSensor : any.targetSensor)) || key;
                                            return (
                                                <li key={key} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    <b>{sensorLabel(tag)}</b> → {to ? CATEGORY_LABELS[to] : 'not set'}
                                                    {source ? `, taken from its ${KIND_LABEL[source.kind]} model` : ''}. Changed:{' '}
                                                    {changes.map((c, i) => (
                                                        <span key={c.modelId}>
                                                            {i > 0 && ' · '}
                                                            {KIND_LABEL[c.kind]}{' '}
                                                            {c.from ? <span className="f4-strike">{CATEGORY_LABELS[c.from]}</span> : '(not set)'} → {c.to ? CATEGORY_LABELS[c.to] : 'not set'}
                                                        </span>
                                                    ))}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                    <div style={{ marginTop: '4px' }}>If that's wrong, change it on the sensor's header.</div>
                                </div>
                                <button type="button" className="f4-notice-x" onClick={dismissCategoryNotice}>Dismiss</button>
                            </div>
                        );
                    })()}

                    <div className="bmw-wb" style={{ gridTemplateColumns: sidebarCollapsed ? '0 minmax(0,1fr)' : '300px minmax(0,1fr)' }}>
                        {!sidebarCollapsed && (
                            <aside className="bmw-side">
                                <div className="bmw-side-top">
                                    <div className="bmw-prog">
                                        <div className="bmw-prog-row">
                                            <span><b style={{ color: 'var(--text-primary)' }}>{completeModelsCount}</b> of {totalModelsCount} complete</span>
                                        </div>
                                        <div className="bmw-prog-bar">
                                            <span style={{ width: `${totalModelsCount ? (completeModelsCount / totalModelsCount * 100) : 0}%`, background: 'var(--ok)' }} />
                                        </div>
                                    </div>
                                    <div className="sensor-autocomplete-input-wrap">
                                        <Search size={12} className="sensor-autocomplete-icon" aria-hidden="true" />
                                        <input
                                            className="sensor-autocomplete-input"
                                            placeholder="Search sensor or tag…"
                                            aria-label="Search sensors"
                                            value={searchQuery}
                                            onChange={e => setSearchQuery(e.target.value)}
                                        />
                                    </div>
                                    <div className="bmw-chips">
                                        <button type="button" className={`bmw-chip${sidebarFilter === 'all' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('all')}>All <b>{sensorGroupsAll.length}</b></button>
                                        <button type="button" className={`bmw-chip${sidebarFilter === 'attn' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('attn')}>Needs setup <b>{attnCount}</b></button>
                                        <button type="button" className={`bmw-chip${sidebarFilter === 'done' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('done')}>Complete <b>{doneCount}</b></button>
                                    </div>
                                    <div className="bmw-groupby">
                                        <span>Group by</span>
                                        <div className="f4-seg">
                                            <button type="button" className={leftGroupBy === 'fg' ? 'on' : undefined} onClick={() => setLeftGroupBy('fg')}>Failure group</button>
                                            <button type="button" className={leftGroupBy === 'component' ? 'on' : undefined} onClick={() => setLeftGroupBy('component')}>Component</button>
                                        </div>
                                    </div>
                                </div>
                                <div className="bmw-list">{renderLeftList()}</div>
                            </aside>
                        )}
                        <section className="bmw-detail">{renderDetailPane()}</section>
                    </div>
                </div>
            )}

            {rcFilterOpen && (
                <div className="bmw-modal-backdrop" role="presentation" onClick={() => setRcFilterOpen(false)}>
                    <div className="bmw-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Running Condition Filter">
                        <div className="bmw-modal-head">
                            <span>Running Condition Filter</span>
                            <button type="button" className="bmw-modal-x" onClick={() => setRcFilterOpen(false)} aria-label="Close">
                                <X size={16} />
                            </button>
                        </div>
                        <RunningConditionPanel
                            open={true}
                            onToggle={() => setRcFilterOpen(false)}
                            configured={rcConfigured}
                            periods={runningConditionTimePeriods}
                            onPeriodsChange={updateRunningConditionPeriods}
                            bounds={datasetBounds}
                            filters={runningConditionFilters}
                            combine={runningConditionCombine}
                            noneConfirmed={runningConditionNoneConfirmed}
                            onNoneChange={none => {
                                setRunningConditionNoneConfirmed(none);
                                persistRunningCondition({ noneConfirmed: none });
                            }}
                            onCombineChange={mode => {
                                setRunningConditionCombine(mode);
                                persistRunningCondition({ combine: mode });
                            }}
                            onAddFilter={addRunningConditionFilter}
                            onUpdateFilter={updateRunningConditionFilter}
                            onRemoveFilter={removeRunningConditionFilter}
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
