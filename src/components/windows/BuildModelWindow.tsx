import { useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { subscribe } from "../../utils/tauriEvents";
import { X, Plus, ChevronDown, ChevronRight, Gauge } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata, WorkspaceSensorFilter, CategoryChange, TimePeriod, FailureGroupStateSlice, FailureGroupStateChangedPayload } from "../../types";
import { loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { modelSensorKey, groupModelsBySensor, sensorCategory, setSensorCategory, type SensorModelGroup } from "../../utils/modelGrouping";
import { normalizeCategories, flagLegacyGate, migratePeriods } from "../../utils/workspaceMigrations";
import { getBuildBlockReason, isRunningConditionConfigured, isWorkspaceRunningConditionConfigured, type RunningConditionFg } from "../../utils/runningCondition";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import { useDatasetTimeBounds } from "../../hooks/useDatasetTimeBounds";
import { periodChipLabel } from "../../utils/timePeriods";
import TimePeriodsEditor from "./TimePeriodsEditor";
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
// here rather than relied on via CSS inheritance — a Component-view row's
// accordion isn't nested inside a `.fg-group-color-*` element at all. Ties
// an open row/form back to its own group's color (a thin left accent bar)
// plus a small text breadcrumb inside the form itself, so it's always
// obvious which model's detail is on screen — per explicit user request,
// a second time, now that the layout/scroll bugs that made an earlier
// version of this feel cluttered are actually fixed.
const FG_ACCENT: Record<string, string> = {
    amber: 'oklch(0.78 0.14 75)',
    violet: 'oklch(0.7 0.15 310)',
    green: 'oklch(0.72 0.15 150)',
    blue: 'oklch(0.68 0.17 245)',
    slate: 'var(--text-faint)',
};

// `label` renders a tag as "description (tag)" when metadata has a
// description, else the bare tag — see this component's own `sensorLabel`.
function sensorSummary(model: FailureModel, label: (tag: string) => string): string {
    if (model.kind === 'individual') return `Target: ${model.targetSensor ? label(model.targetSensor) : '—'}`;
    if (model.kind === 'relationship') {
        const predictors = (model.predictorSensors ?? []).map(label).join(', ') || '—';
        return `Target: ${model.targetSensor ? label(model.targetSensor) : '—'} · Predictors: ${predictors}`;
    }
    const criteria = model.criteriaSensor ? ` · Criteria: ${label(model.criteriaSensor)}` : '';
    return `X: ${model.xSensor ? label(model.xSensor) : '—'} · Y (target): ${model.ySensor ? label(model.ySensor) : '—'}${criteria}`;
}

type GroupBy = 'fg' | 'component' | 'kind';

const CONDITION_BADGE_STYLE: CSSProperties = {
    color: 'var(--warn, #d9a441)', background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.45)',
};

/** Unsaved edits to ONE model (kept per model id so switching a sensor row's
 *  tabs never loses them). Only fields the user can edit here; `category` is
 *  deliberately absent (per-sensor, saved instantly from the sensor header). */
interface ModelDraft {
    name: string;
    predictors: string[];
    y: string;
    criteria: string;
    ranges: { min: number | null; max: number | null }[];
}

const draftFromModel = (m: FailureModel): ModelDraft => ({
    name: m.name,
    predictors: m.predictorSensors ?? [],
    y: m.ySensor ?? '',
    criteria: m.criteriaSensor ?? '',
    ranges: m.clusterRanges?.length ? m.clusterRanges : DEFAULT_CLUSTER_RANGES,
});

// Fixed order (not alphabetical) -- I/R/C is a small, natural taxonomy, not
// an open-ended list like components, so it reads better presented in the
// same order the kind toggles/badges use everywhere else in the app.
const KIND_ORDER: ModelKind[] = ['individual', 'relationship', 'clustering'];
const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

/**
 * The single Build Model window — a singleton (label `build-model`) opened
 * from the Failure Groups tab's "Build Model" button. One page only —
 * every model from every Failure Group, groupable by FG or by Component —
 * with everything editable inline, no navigation to a second page at all
 * (an earlier version of this redesign used a separate "model detail"
 * page; the user asked for that to become an inline accordion instead):
 *
 *   - Clicking a model row (FG or Component view) expands that model's
 *     edit form directly beneath the row, accordion-style — clicking it
 *     again (or a different row) closes/switches it. This replaces an
 *     earlier version that navigated to a dedicated model page; the user
 *     asked for it to work like the old per-group window's inline row
 *     editing instead: "it should become a tab appearing below that
 *     model, not go to a new page".
 *   - 2026-08-31: there is no "add" flow anymore — toggling a sensor into
 *     a group (Sensor tab) is the sole way a model comes into existence
 *     now, always as kind 'individual'; this window only ever edits an
 *     existing model's detail afterward, per explicit user request
 *     ("เอาปุ่ม add model ออกเหมือนกัน ของหน้านี้").
 *   - 2026-08-31: a Failure Group's own Name/Description/Recommendation
 *     are no longer editable here at all — that "Edit details" panel
 *     moved to Dashboard's Failure Groups tab entirely (not duplicated),
 *     per explicit user request ("ส่วนของ edit detail ต้องอยู่ที่
 *     dashboard ด้วย"). This window's group cards are read-only headers
 *     now — name, FG badge, model count — nothing else to edit about the
 *     group itself.
 *   - 2026-09-01: a model's own "Failure groups" list in the edit form is
 *     now read-only too (a plain chip list, no checkboxes) — membership is
 *     changed exclusively via the Sensor tab's per-kind toggle, per
 *     explicit user request ("ไม่ควรแก้ FG ได้ในหน้านี้ ดูได้อย่างเดียว
 *     ไปแก้ที่หน้า dashboard ที่ทำไว้แล้ว").
 *   - 2026-09-01: each kind's auto-filled "identity" sensor — Individual/
 *     Relationship's Target, Clustering's X — is locked (read-only) once
 *     set, so it can't be changed by mistake after the model already
 *     exists; Relationship's predictors and Clustering's Y sensor stay
 *     freely editable, per explicit user request ("sensor ที่เป็น auto
 *     fill ... ต้องล็อคไว้ห้าม user เปลี่ยน ... ส่วน predictor ของ relation
 *     กับ y sensor ของ clustering สามารถเปลี่ยนได้").
 *   - 2026-09-01 (later): the "Model kind" picker itself is gone too — a
 *     model's kind is decided once, on the Sensor tab (which I/R/C toggle
 *     created it), and can no longer be switched afterward here, per
 *     explicit user request ("ลบการเปลี่ยน model kind ออก เพราะว่าเราเลือก
 *     model kind ที่หน้า dashboard แล้ว"). `formKind` still exists as
 *     state (seeded from the model being edited) purely to pick which
 *     kind-specific fields render below — it's fixed for the life of the
 *     form.
 *
 * All of this is local state — no window spawn for any of it — which is
 * also what makes the earlier "two Build Model windows for the same
 * group" race structurally impossible now.
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
    // Workspace-wide "machine running" filter (2026-09-15) — the whole point
    // of this panel living on the Overview page rather than per-model: set
    // once here, every model of every kind picks it up automatically at
    // train time (see PredictiveModelBuild.tsx's `dashboardFilterPayload`).
    // Replaced the old per-model `pmSensorFilters` — with 100 models in one
    // workspace, setting the same "is the machine running" condition 100
    // times separately was the actual problem being solved.
    const [runningConditionFilters, setRunningConditionFilters] = useState<WorkspaceSensorFilter[]>([]);
    // How the conditions above combine — 'and' (default, matches every
    // workspace's behavior before this existed) or 'or'. Same panel, same
    // persist path as runningConditionFilters (2026-09-23).
    const [runningConditionCombine, setRunningConditionCombine] = useState<'and' | 'or'>('and');
    // Workspace-default training PERIODS (Feature 4-C; replaced the single
    // start/end pair). Empty = no time limit. A model in Workspace mode uses
    // THIS list; Custom mode uses its own `filterTimePeriods`.
    const [runningConditionTimePeriods, setRunningConditionTimePeriods] = useState<TimePeriod[]>([]);
    const { bounds: datasetBounds } = useDatasetTimeBounds();
    const [rcFilterOpen, setRcFilterOpen] = useState(false);
    // "No condition - use all rows" was explicitly confirmed for the workspace
    // (Feature 4, soft gate A). Mirrors failureGroupState.runningConditionNoneConfirmed.
    const [runningConditionNoneConfirmed, setRunningConditionNoneConfirmed] = useState(false);
    // Legacy-workspace banner: the STORED flag (failureGroupState.rcLegacyNotice,
    // written at hydration) plus a session-only "Remind me later" (never persisted).
    const [rcLegacyNotice, setRcLegacyNotice] = useState<'pending' | null>(null);
    const [legacyRemindLater, setLegacyRemindLater] = useState(false);
    // Workspace id the panel was last auto-opened for, so "auto-open when the
    // running condition is unconfigured" happens once per hydration, not on
    // every broadcast.
    const rcAutoOpenedFor = useRef<string | null>(null);
    const [loading, setLoading] = useState(true);
    const hydratedRef = useRef(false);

    const [groupBy, setGroupBy] = useState<GroupBy>('fg');

    // ---- Predictive Model page — an in-window "next page" (not a spawned
    //      OS window) reached from the model edit form's "Build Model"
    //      button (see `renderModelFormFooter`). Only
    //      Dashboard + this singleton window are ever open at once; PM used
    //      to be its own window/label ('predictive-model') until the user
    //      asked for it to become a page inside this one instead, same
    //      consolidation this window itself already went through (see this
    //      component's own doc comment above). ----
    const [activePage, setActivePage] = useState<'overview' | 'model'>('overview');
    const [pmPageModelId, setPmPageModelId] = useState<string | null>(null);


    // ---- Model edit accordion: one row open at a time. FG view rows are one
    //      per SENSOR (id `fg:{groupNo}:{sensorKey}`); Component / Model Type
    //      view rows are one per MODEL (id `m:{modelId}`). ----
    const [openRow, setOpenRow] = useState<string | null>(null);
    /** Which model tab is showing inside each sensor row (row id -> model id). */
    const [activeTab, setActiveTab] = useState<Record<string, string>>({});
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
    // options, predictor chips, the summary line) — the raw tag alone
    // (e.g. "11TE1210.PV") isn't enough to recognize a sensor by; falls
    // back to the bare tag when no mapping/description exists for it.
    const sensorLabel = useCallback((tag: string) => {
        const desc = sensorMetaMap.get(normalizeSensorTag(tag))?.description;
        return desc ? `${desc} (${tag})` : tag;
    }, [sensorMetaMap]);

    // The model's own name if the user set one — a name identical to its
    // own target tag doesn't count, since legacy-migrated models default to
    // that instead of being truly unset (see workspaceManager.ts's
    // migration shim) — else "description (tag)" for the target sensor,
    // else a placeholder.
    // Clustering's Y sensor stays blank until configured (see this file's
    // own doc comment on "auto-fill sensor" locking below) — falling back
    // to X keeps a fresh Clustering model's label/component the same as
    // Individual/Relationship's instead of reading "Untitled"/Uncategorized
    // until someone happens to fill in Y, which the user flagged as an
    // inconsistency between the Dashboard's own FG tab and here (both
    // derive from the same target-tag shape).
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
                setOpenRow(null);
                setActiveTab({});
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
                    const written = await updateWorkspaceData(d.workspaceId, prev => flagLegacyGate(normalizeCategories(migratePeriods(prev, { dropLegacyKeys: true }))));
                    if (seq !== loadSeq.current || workspaceIdRef.current !== d.workspaceId) return;
                    if (written?.failureGroupState) {
                        applyFg(written.failureGroupState);
                        await emit('failure-group-state-changed', { ...written.failureGroupState, workspaceId: d.workspaceId, origin: 'build-model' });
                    }
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
    }, [applyFg]);

    const persist = useCallback(async (
        updater: (models: FailureModel[], groups: FailureGroup[]) => { models: FailureModel[]; groups: FailureGroup[] },
    ) => {
        if (!workspaceId) return;
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
    }, [workspaceId, applyFg]);

    // The one path that actually changes the workspace-wide running
    // condition — edited entirely from this window's own "Running Condition
    // Filter" panel (see the JSX below), never per-model. One function for
    // all four sub-fields (filters/combine/time start/time end) rather than
    // a near-duplicate persist-function per field — each earlier one had to
    // remember to explicitly preserve every OTHER sibling field on write,
    // which is exactly the kind of easy-to-miss duplication that caused a
    // real bug once already (see `persist` above's own comment). A field
    // left out of `patch` falls through to whatever's already on disk.
    const persistRunningCondition = useCallback(async (patch: {
        filters?: WorkspaceSensorFilter[];
        combine?: 'and' | 'or';
        periods?: TimePeriod[];
        noneConfirmed?: boolean;
    }) => {
        if (!workspaceId) return;
        const next = await updateWorkspaceData(workspaceId, prev => {
            const applied = withFailureGroupState(prev, {
                // Only the fields this call was given; everything else stays as it is.
                ...(patch.filters !== undefined ? { runningConditionFilters: patch.filters } : {}),
                ...(patch.combine !== undefined ? { runningConditionCombine: patch.combine } : {}),
                ...(patch.periods !== undefined ? { runningConditionTimePeriods: patch.periods } : {}),
                ...(patch.noneConfirmed !== undefined ? { runningConditionNoneConfirmed: patch.noneConfirmed } : {}),
            });
            // Any edit made through this panel settles the legacy notice: it stays
            // 'pending' only while the workspace is still unconfigured, and is
            // otherwise marked handled (null) so it can never re-fire later.
            const fg = applied.failureGroupState;
            const stillPending = fg?.rcLegacyNotice === 'pending' && !isWorkspaceRunningConditionConfigured(fg);
            return withFailureGroupState(applied, { rcLegacyNotice: stillPending ? 'pending' : null });
        });
        if (next?.failureGroupState) {
            applyFg(next.failureGroupState);
            await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
        }
    }, [workspaceId, applyFg]);

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
    // switching between a sensor's Individual / Relationship / Clustering tabs
    // never loses an unsaved edit. Identity fields (target sensor / X sensor,
    // kind, failure groups) are read straight from the stored model: they are
    // locked/read-only, so a draft can never carry a stale copy of them. A
    // draft also never carries `category`: category is per SENSOR and saves
    // instantly from the sensor header (see `changeCategory`), so a leftover
    // draft can't overwrite a newer sensor-level change.
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

    /** Why Save is disabled (category / required fields), or null. */
    const modelBlockReason = (m: FailureModel): string | null => {
        if (categoryOf(m) === null) return 'Pick a category on the sensor header';
        const d = draftOf(m);
        const ok = d.name.trim() !== '' && m.groupNos.length > 0 && (
            m.kind === 'individual' ? (m.targetSensor ?? '') !== '' :
            m.kind === 'relationship' ? (m.targetSensor ?? '') !== '' && d.predictors.length >= 1 :
            (m.xSensor ?? '') !== '' && d.y !== '' && (!d.criteria || d.ranges.every(r => r.min !== null && r.max !== null))
        );
        return ok ? null : 'Fill in the required fields above first';
    };

    /** Why Build Model is disabled: everything Save needs, then the gate. */
    const buildBlockReason = (m: FailureModel): string | null => modelBlockReason(m) ?? gateReasonOf(m);

    // Returns the `persist()` promise (rather than firing it and forgetting)
    // so `buildModel` below can await the write actually landing on disk
    // before navigating to the PM page — see that function's own comment for
    // the race this closes.
    const commitModel = async (m: FailureModel) => {
        if (modelBlockReason(m) !== null) return;
        const d = draftOf(m);
        const fields: Partial<FailureModel> =
            m.kind === 'individual' ? { name: d.name.trim() } :
            m.kind === 'relationship' ? { name: d.name.trim(), predictorSensors: d.predictors } :
            { name: d.name.trim(), ySensor: d.y, criteriaSensor: d.criteria, clusterRanges: d.criteria ? d.ranges : [] };
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

    /** The sensor header's category control: writes EVERY model of that sensor
     *  in EVERY failure group, and saves instantly (no Save button). */
    const changeCategory = async (key: string, cat: ModelCategory) => {
        if (sensorCategory(allModels, key) === cat) return;
        const groupNos = [...new Set(allModels.filter(m => modelSensorKey(m) === key).flatMap(m => m.groupNos))].sort((a, b) => a - b);
        await persist((models, groups) => ({ groups, models: setSensorCategory(models, key, cat) }));
        setCategoryWarn(groupNos.length > 1
            ? { key, text: `Category applies to this sensor in every failure group: ${groupNos.map(n => n === 0 ? 'Not in Group' : `FG-${n}`).join(', ')}.` }
            : null);
    };

    const dismissCategoryNotice = async () => {
        if (!workspaceId) return;
        const next = await updateWorkspaceData(workspaceId, prev => withFailureGroupState(prev, { categoryNormalisationNotice: null }));
        if (next?.failureGroupState) {
            applyFg(next.failureGroupState);
            await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
        }
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
     *  never accidentally flip an already-complete model back to
     *  incomplete. Un-marking a model still goes through the status pill
     *  (`toggleModelStatus`). */
    const markModelComplete = (modelId: string) => {
        const target = allModels.find(m => m.id === modelId);
        if (target && gateReasonOf(target) !== null) return;
        persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: true } : m),
        }));
    };

    const trainModel = (modelId: string) => {
        // Guard at the source too, so a future caller can't bypass the gate.
        const target = allModels.find(m => m.id === modelId);
        if (target && gateReasonOf(target) !== null) return;
        setPmPageModelId(modelId);
        setActivePage('model');
    };

    const handleClose = async () => {
        await getCurrentWindow().close();
    };

    // 🆕 2026-09-18 [bug fix]: must await commitModel's write landing on disk
    // before navigating to the PM page. The PM page's own hydration effect
    // reads the workspace file directly (loadWorkspaceData, NOT queued behind
    // a still-in-flight updateWorkspaceData write) and could win the race,
    // loading the model record from BEFORE this commit: predictors picked on
    // this form showed as "No predictors selected" on the PM page.
    const buildModel = async (m: FailureModel) => {
        if (buildBlockReason(m) !== null) return;
        await commitModel(m);
        trainModel(m.id);
    };

    // The fields shared by every model of one sensor: the locked key sensor,
    // its component, and the (read-only) failure groups. Shown once per
    // sensor row, or once per model in the Component / Model Type views.
    const renderSharedFields = (models: FailureModel[]) => {
        const first = models[0];
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        const clusteringOnly = models.every(m => m.kind === 'clustering');
        const component = keyTag ? getComponent(keyTag) : '';
        const groupNos = [...new Set(models.flatMap(m => m.groupNos))].sort((a, b) => a - b);
        return (
            <div data-testid="sensor-shared-fields" style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px' }}>
                <div className="fg-inspector-field">
                    <div className="fg-inspector-field-label-row"><label>{clusteringOnly ? 'X sensor' : 'Target sensor'}</label></div>
                    <div className="model-component-readout">{keyTag ? sensorLabel(keyTag) : '—'}</div>
                    <div style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: '3px' }}>Locked — set when the model was created, to prevent picking the wrong sensor by mistake.</div>
                </div>
                <div className="fg-inspector-field">
                    <div className="fg-inspector-field-label-row"><label>Component</label></div>
                    <div className={`model-component-readout${component ? '' : ' model-component-readout--placeholder'}`}>
                        {component || 'Auto-filled from the sensor'}
                    </div>
                </div>
                {/* Read-only: group membership is changed exclusively via the
                    Dashboard's Sensor tab per-kind toggle (2026-09-01). */}
                <div>
                    <div className="fg-inspector-field-label-row" style={{ marginBottom: '4px' }}><label>Failure groups</label></div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {groupNos.map(no => {
                            const g = realGroups.find(x => x.no === no);
                            const inGroup = models.filter(m => m.groupNos.includes(no));
                            const partial = models.length > 1 && inGroup.length < models.length
                                ? ` (${inGroup.map(m => KIND_ABBREV[m.kind]).join(' ')} only)` : '';
                            return (
                                <span key={no} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '0.72rem', padding: '3px 8px', borderRadius: '999px', background: 'var(--chip-bg)', border: '1px solid var(--border)' }}>
                                    <span style={{ width: '6px', height: '6px', borderRadius: '2px', background: FG_ACCENT[getFgGroupColor(no)], flexShrink: 0 }} />
                                    {no === 0 ? 'Not in Group' : `FG-${no} · ${g?.name ?? ''}`}{partial}
                                </span>
                            );
                        })}
                    </div>
                    <div style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: '4px' }}>
                        Managed from the Dashboard's Sensor tab.
                    </div>
                </div>
            </div>
        );
    };

    // Fields that belong to ONE model (its own tab): name plus whatever its
    // kind needs. Own bounded, independently-scrollable box; the footer is
    // never inside it (a tall form used to leave its own button unreachable).
    const renderKindFields = (m: FailureModel) => {
        const d = draftOf(m);
        return (
        <div data-testid="add-model-form-fields" style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '48vh', overflowY: 'auto', padding: '12px 14px' }}>
            <div className="fg-inspector-field">
                <div className="fg-inspector-field-label-row"><label>Model name</label></div>
                <input
                    className="fg-inspector-input"
                    value={d.name}
                    placeholder="e.g. Bearing vibration model"
                    onChange={e => patchDraft(m, { name: e.target.value })}
                />
            </div>

            {m.kind === 'relationship' && (
                <div className="fg-inspector-field">
                    <div className="fg-inspector-field-label-row"><label>Predictor sensors (≥ 1)</label></div>
                    <SensorPickerModal
                        sensors={allSensors}
                        getDesc={getDesc}
                        getComponent={getComponent}
                        selected={d.predictors}
                        excluded={[m.targetSensor ?? '']}
                        onConfirm={predictors => patchDraft(m, { predictors })}
                        noun="predictors"
                    />
                    {d.predictors.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                            {d.predictors.map(p => (
                                <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.68rem', padding: '2px 6px', borderRadius: '999px', background: 'var(--chip-bg)', border: '1px solid var(--border)' }}>
                                    {sensorLabel(p)}
                                    <button onClick={() => patchDraft(m, { predictors: d.predictors.filter(x => x !== p) })} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex' }}>
                                        <X size={9} />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {m.kind === 'clustering' && (
                <>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <div className="fg-inspector-field" style={{ flex: 1, minWidth: 0 }}>
                            <div className="fg-inspector-field-label-row"><label>X sensor</label></div>
                            <div className="model-component-readout" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.xSensor ? sensorLabel(m.xSensor) : '—'}</div>
                            <div style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: '3px' }}>Locked — set when the model was created.</div>
                        </div>
                        <div className="fg-inspector-field" style={{ flex: 1, minWidth: 0 }}>
                            <div className="fg-inspector-field-label-row"><label>Y sensor (target)</label></div>
                            <SensorPickerModal
                                sensors={allSensors}
                                getDesc={getDesc}
                                getComponent={getComponent}
                                single
                                value={d.y}
                                onSelect={y => patchDraft(m, { y })}
                                noun="Y sensor"
                            />
                        </div>
                    </div>
                    <div className="fg-inspector-field">
                        <div className="fg-inspector-field-label-row"><label>Criteria sensor (optional)</label></div>
                        <SensorPickerModal
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                            single
                            allowNone
                            value={d.criteria}
                            onSelect={criteria => patchDraft(m, { criteria })}
                            noun="criteria sensor"
                        />
                    </div>
                    {d.criteria && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <div className="fg-inspector-field-label-row"><label>Cluster ranges</label></div>
                            {d.ranges.map((r, i) => (
                                <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', width: '16px' }}>{i + 1}</span>
                                    <input
                                        type="number"
                                        className="fg-inspector-input"
                                        value={r.min ?? ''}
                                        placeholder="min"
                                        onChange={e => patchDraft(m, { ranges: d.ranges.map((row, idx) => idx === i ? { ...row, min: e.target.value === '' ? null : Number(e.target.value) } : row) })}
                                    />
                                    <input
                                        type="number"
                                        className="fg-inspector-input"
                                        value={r.max ?? ''}
                                        placeholder="max"
                                        onChange={e => patchDraft(m, { ranges: d.ranges.map((row, idx) => idx === i ? { ...row, max: e.target.value === '' ? null : Number(e.target.value) } : row) })}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
        );
    };

    // Save changes + Build Model → (+ the status pill when `withStatus`, i.e.
    // inside a sensor row's tab, where no row header carries one). Each model
    // keeps its OWN status / Save / Build. `position: sticky, bottom: 0` pins
    // it to the bottom of the visible area however tall the fields above are
    // (requires no `overflow: hidden` on any ancestor up to the page scroller).
    // Bottom corners are rounded to match the card's own 10px radius, or this
    // flat opaque footer paints over the parent's rounded corners.
    const renderModelFooter = (m: FailureModel, withStatus: boolean) => {
        const saveReason = modelBlockReason(m);
        const reason = buildBlockReason(m);
        const statusBlock = !m.status ? gateReasonOf(m) : null;
        return (
        <div style={{ position: 'sticky', bottom: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--card-bg)', borderBottomLeftRadius: '10px', borderBottomRightRadius: '10px', flexWrap: 'wrap' }}>
            {withStatus && (
                <button
                    className={`model-status-pill model-status-pill--${m.status ? 'complete' : 'incomplete'}`}
                    style={{ marginRight: 'auto' }}
                    disabled={statusBlock !== null}
                    title={statusBlock ?? undefined}
                    onClick={() => toggleModelStatus(m.id)}
                >
                    {m.status ? 'Complete' : 'Incomplete'}
                </button>
            )}
            {reason && <span data-testid="build-block-reason" style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>{reason}</span>}
            <button className="fg-build-model-btn" style={{ width: 'auto', padding: '8px 22px' }} disabled={saveReason !== null} onClick={() => commitModel(m)}>
                Save changes
            </button>
            <button
                className="model-open-pm"
                disabled={reason !== null}
                title={reason ?? undefined}
                onClick={() => buildModel(m)}
            >
                Build Model →
            </button>
        </div>
        );
    };

    // One model's whole form outside a sensor row (Component / Model Type views).
    const renderModelForm = (m: FailureModel) => (
        <div data-testid="add-model-form">
            {renderSharedFields([m])}
            {renderKindFields(m)}
            {renderModelFooter(m, false)}
        </div>
    );

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
    }

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModels = allModels.length;
    const componentSections = (() => {
        const byComp = new Map<string, FailureModel[]>();
        for (const m of allModels) {
            const key = modelComponent(m);
            if (!byComp.has(key)) byComp.set(key, []);
            byComp.get(key)!.push(m);
        }
        return Array.from(byComp.entries()).sort(([a], [b]) => a.localeCompare(b));
    })();
    const kindSections = (() => {
        const byKind = new Map<ModelKind, FailureModel[]>();
        for (const m of allModels) {
            if (!byKind.has(m.kind)) byKind.set(m.kind, []);
            byKind.get(m.kind)!.push(m);
        }
        return KIND_ORDER
            .filter(k => byKind.has(k))
            .map((k): [ModelKind, FailureModel[]] => [k, byKind.get(k)!]);
    })();

    // The Component / Model Type views keep one row per MODEL (only the
    // Failure Group view is one-row-per-sensor). Category is per sensor, so
    // here it is a read-only chip with a link to the sensor header that owns it.
    const goToSensorHeader = (model: FailureModel) => {
        const groupNo = model.groupNos.find(n => n !== 0) ?? model.groupNos[0] ?? 0;
        setGroupBy('fg');
        setOpenRow(`fg:${groupNo}:${modelSensorKey(model)}`);
    };

    // One row per model, with its own form directly beneath it when active
    // (accordion) — used by the Component-grouped and Model-Type-grouped views.
    const overviewModelRow = (model: FailureModel, showFgTag: boolean) => {
        // A model can belong to several groups now — the chip lists all of
        // them (comma-separated), and the accordion's own accent border
        // just picks the FIRST one as its primary color rather than trying
        // to blend several.
        const groupTags = model.groupNos.map(no => {
            const grp = allGroups.find(x => x.no === no);
            return no === 0 ? 'Not in Group' : `FG-${no}${grp ? ` · ${grp.name}` : ''}`;
        }).join(', ');
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        const component = targetTag ? getComponent(targetTag) : '';
        const rowId = `m:${model.id}`;
        const isEditingThis = openRow === rowId;
        const accent = FG_ACCENT[getFgGroupColor(model.groupNos[0] ?? 0)];
        const category = categoryOf(model);
        return (
            <div key={model.id} style={{ borderTop: '1px solid var(--border)' }}>
                {/* A real border (not an absolutely-positioned left bar) so the
                    boundary always encloses the sticky footer too — a sticky
                    element can never paint outside its own parent's box, but an
                    absolute-positioned bar is anchored to the row's un-scrolled
                    flow position and visibly detaches from the footer once the
                    page scrolls (the report that prompted this). */}
                <div style={isEditingThis ? { border: `1.5px solid ${accent}`, borderRadius: '10px', margin: '6px 8px' } : undefined}>
                    <div
                        onClick={() => setOpenRow(isEditingThis ? null : rowId)}
                        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px 10px 18px' }}
                    >
                        <div className={`model-kind-icon model-kind-icon--${model.kind}`} style={{ width: '24px', height: '24px', fontSize: '0.62rem' }}>
                            {KIND_ABBREV[model.kind]}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '2px' }}>
                                {showFgTag && (
                                    <span className="model-chip model-chip--component" style={{ fontFamily: 'var(--mono)' }}>
                                        {groupTags}
                                    </span>
                                )}
                                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{modelDisplayLabel(model)}</span>
                                <span
                                    className={`model-chip model-chip--${category === 'condition' ? 'cond' : 'perf'}`}
                                    data-testid={`model-category-chip-${model.id}`}
                                    style={category ? undefined : { opacity: 0.6 }}
                                >
                                    {category ? CATEGORY_LABELS[category] : 'No category'}
                                </span>
                                <button
                                    type="button"
                                    className="text-btn"
                                    style={{ fontSize: '0.64rem' }}
                                    title="Category is set once per sensor, on the sensor header in the Failure Group view"
                                    onClick={e => { e.stopPropagation(); goToSensorHeader(model); }}
                                >
                                    Change in Failure Group view
                                </button>
                                {component && <span className="model-chip model-chip--component">{component}</span>}
                                {needsCondition(model) && (
                                    <span data-testid={`condition-badge-${model.id}`} className="model-chip" style={CONDITION_BADGE_STYLE}>
                                        {model.status ? 'Legacy · all data' : 'Needs condition'}
                                    </span>
                                )}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {sensorSummary(model, sensorLabel)}
                            </div>
                        </div>
                        <button
                            className={`model-status-pill model-status-pill--${model.status ? 'complete' : 'incomplete'}`}
                            disabled={!model.status && gateReasonOf(model) !== null}
                            title={!model.status ? (gateReasonOf(model) ?? undefined) : undefined}
                            onClick={e => { e.stopPropagation(); toggleModelStatus(model.id); }}
                        >
                            {model.status ? 'Complete' : 'Incomplete'}
                        </button>
                    </div>
                    {isEditingThis && (
                        <div style={{ borderTop: '1px solid var(--border)' }}>
                            {renderModelForm(model)}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // Failure Group view: ONE row per sensor per FG (Feature 4-A). Only the
    // kinds that actually exist are shown. Shared fields once, then a tab per
    // model (each keeps its own status / Save / Build Model). The category
    // control lives on this header because category belongs to the sensor.
    // Long text is single-line ellipsis everywhere in the header.
    const sensorRow = (groupNo: number, sg: SensorModelGroup) => {
        const rowId = `fg:${groupNo}:${sg.key}`;
        const isOpen = openRow === rowId;
        const first = sg.models[0];
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        const label = keyTag ? sensorLabel(keyTag) : modelDisplayLabel(first);
        const component = keyTag ? getComponent(keyTag) : '';
        const category = sensorCategory(allModels, sg.key);
        const otherGroups = [...new Set(allModels.filter(m => modelSensorKey(m) === sg.key).flatMap(m => m.groupNos))]
            .filter(n => n !== groupNo && n !== 0).sort((a, b) => a - b);
        const ordered = KIND_ORDER.flatMap(k => sg.models.filter(m => m.kind === k));
        const done = ordered.filter(m => m.status).length;
        const activeModel = ordered.find(m => m.id === activeTab[rowId]) ?? ordered[0];
        const blocked = ordered.filter(m => !m.status && needsCondition(m)).length;
        const accent = FG_ACCENT[getFgGroupColor(groupNo)];
        return (
            <div key={rowId} data-testid={`sensor-row-${rowId}`} style={{ borderTop: '1px solid var(--border)' }}>
                <div style={isOpen ? { border: `1.5px solid ${accent}`, borderRadius: '10px', margin: '6px 8px' } : undefined}>
                    <div
                        onClick={() => setOpenRow(isOpen ? null : rowId)}
                        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px 10px 14px', flexWrap: 'nowrap', minWidth: 0 }}
                    >
                        <ChevronRight size={13} color="var(--text-faint)" style={{ flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }} />
                        <span
                            data-testid="sensor-row-label"
                            title={label}
                            style={{ flex: 1, minWidth: 0, fontSize: '0.8rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                            {label}
                        </span>
                        {component && <span className="model-chip model-chip--component" style={{ flexShrink: 1, minWidth: 0, maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{component}</span>}
                        {otherGroups.map(n => (
                            <span key={n} className="model-chip model-chip--component" style={{ flexShrink: 0, fontFamily: 'var(--mono)' }}>also in FG-{n}</span>
                        ))}
                        {blocked > 0 && (
                            <span data-testid={`sensor-blocked-${rowId}`} className="model-chip" style={{ ...CONDITION_BADGE_STYLE, flexShrink: 0, whiteSpace: 'nowrap' }} title="Set a running condition on the Overview panel to unlock Build Model">
                                {blocked} blocked
                            </span>
                        )}
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', flexShrink: 0, whiteSpace: 'nowrap' }}>{done} of {ordered.length} complete</span>
                        {ordered.map(m => (
                            <span
                                key={m.id}
                                className={`model-kind-icon model-kind-icon--${m.kind}`}
                                title={`${KIND_LABEL[m.kind]} · ${m.status ? 'Complete' : 'Incomplete'}`}
                                data-testid={`sensor-kind-chip-${m.id}`}
                                style={{ position: 'relative', width: '22px', height: '22px', fontSize: '0.6rem', flexShrink: 0 }}
                            >
                                {KIND_ABBREV[m.kind]}
                                <span style={{ position: 'absolute', right: '-2px', top: '-2px', width: '7px', height: '7px', borderRadius: '50%', border: '1px solid var(--card-bg)', background: m.status ? 'var(--success, #3fb950)' : 'var(--text-faint)' }} />
                            </span>
                        ))}
                        {/* Category — per SENSOR, saves instantly, no "Mixed" state. */}
                        <div
                            role="group"
                            aria-label="Category"
                            onClick={e => e.stopPropagation()}
                            style={{ display: 'inline-flex', flexShrink: 0, background: 'var(--input-bg)', border: `1px solid ${category ? 'var(--border-strong)' : 'rgba(245,158,11,0.6)'}`, borderRadius: '7px', padding: '2px', gap: '2px' }}
                        >
                            {(['performance', 'condition'] as ModelCategory[]).map(c => {
                                const active = category === c;
                                const activeColor = c === 'condition' ? 'var(--cond)' : 'var(--accent-color)';
                                const activeBg = c === 'condition' ? 'var(--cond-muted)' : 'var(--accent-muted)';
                                return (
                                    <button
                                        key={c}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => changeCategory(sg.key, c)}
                                        style={{
                                            padding: '3px 9px', borderRadius: '5px', fontSize: '0.68rem', cursor: 'pointer', border: 'none',
                                            background: active ? activeBg : 'none',
                                            color: active ? activeColor : 'var(--text-secondary)',
                                            fontWeight: active ? 600 : 400,
                                        }}
                                    >
                                        {CATEGORY_LABELS[c]}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {category === null && (
                        <div style={{ padding: '0 14px 8px 35px', fontSize: '0.68rem', color: 'var(--warn, #d9a441)' }}>
                            Pick a category — it is set once for this sensor and applies to all of its models.
                        </div>
                    )}
                    {categoryWarn?.key === sg.key && (
                        <div role="status" style={{ padding: '0 14px 8px 35px', fontSize: '0.68rem', color: 'var(--warn, #d9a441)' }}>
                            {categoryWarn.text}
                        </div>
                    )}
                    {isOpen && activeModel && (
                        <div data-testid="add-model-form" style={{ borderTop: '1px solid var(--border)' }}>
                            {renderSharedFields(ordered)}
                            <div role="tablist" style={{ display: 'flex', gap: '2px', padding: '0 14px', borderBottom: '1px solid var(--border)' }}>
                                {ordered.map(m => {
                                    const selected = m.id === activeModel.id;
                                    return (
                                        <button
                                            key={m.id}
                                            type="button"
                                            role="tab"
                                            aria-selected={selected}
                                            onClick={() => setActiveTab(prev => ({ ...prev, [rowId]: m.id }))}
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '7px 12px', fontSize: '0.74rem', cursor: 'pointer',
                                                background: 'none', border: 'none', borderBottom: `2px solid ${selected ? 'var(--accent-color)' : 'transparent'}`,
                                                color: selected ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: selected ? 600 : 400,
                                            }}
                                        >
                                            {KIND_LABEL[m.kind]}
                                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: m.status ? 'var(--success, #3fb950)' : 'var(--text-faint)' }} />
                                            {m.id in drafts && <span style={{ fontSize: '0.6rem', color: 'var(--warn, #d9a441)' }}>edited</span>}
                                            {needsCondition(m) && (
                                                <span data-testid={`condition-badge-${m.id}`} style={{ fontSize: '0.6rem', color: 'var(--warn, #d9a441)' }}>
                                                    {m.status ? 'Legacy · all data' : 'Needs condition'}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            <div role="tabpanel" data-testid={`model-tab-panel-${activeModel.id}`}>
                                {renderKindFields(activeModel)}
                                {renderModelFooter(activeModel, true)}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const pmPageModel = activePage === 'model' ? allModels.find(m => m.id === pmPageModelId) : undefined;

    return (
        // Matches the Dashboard's own card surfaces (`.widget-section`/
        // `.chart-section-large`, which use `--card-bg`) rather than
        // `--bg-primary` — this window's content (the Failure Groups list)
        // is the same content as the Dashboard's own Failure Groups card, so
        // it should read as the same surface tone, not the page canvas one.
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
                    onFinish={() => {
                        markModelComplete(pmPageModel.id);
                        setActivePage('overview');
                    }}
                />
            ) : (
            <>
            {/* Running Condition Filter — workspace-wide, set once here so
                every model of every kind picks it up automatically at train
                time instead of each needing its own "is the machine
                running" filter (2026-09-15 — replaces the old per-model
                Sensor value filter on PredictiveModelBuild.tsx). Also the
                workspace-default TRAINING TIME RANGE since 2026-09-23 — was
                a structurally separate, always-per-model-only field with no
                workspace default at all until the user pointed out the
                filter concept isn't just sensor value, it needs a time
                range too, same as this panel's value conditions. */}
            <div data-testid="rc-panel" style={{ margin: '12px 20px 0', border: `1px solid ${!rcConfigured ? 'rgba(245,158,11,0.6)' : (runningConditionFilters.length > 0 || runningConditionTimePeriods.length > 0) ? 'rgba(59,130,246,0.35)' : 'var(--border)'}`, borderRadius: '10px', background: 'var(--input-bg)' }}>
                <div
                    onClick={() => setRcFilterOpen(o => !o)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '10px 14px', cursor: 'pointer', userSelect: 'none' }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        <div style={{ width: 26, height: 26, borderRadius: 7, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <Gauge size={15} color="var(--accent-color)" />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                Running Condition Filter
                                {!rcConfigured && (
                                    <span data-testid="rc-required-pill" className="model-chip" style={{ ...CONDITION_BADGE_STYLE, fontSize: '0.62rem', fontWeight: 700 }}>Required</span>
                                )}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {runningConditionTimePeriods.length > 0
                                    ? `${runningConditionTimePeriods.length === 1 ? periodChipLabel(runningConditionTimePeriods[0]) : `${runningConditionTimePeriods.length} periods`} · `
                                    : ''}
                                {runningConditionNoneConfirmed
                                    ? 'No condition — use all rows'
                                    : runningConditionFilters.length === 0
                                    ? 'Required — add a condition, or choose "No condition — use all rows" to build models.'
                                    : runningConditionFilters.map(f => `${getDesc(f.sensor) || f.sensor} ${f.operation === 'greater_than' ? '>' : f.operation === 'less_than' ? '<' : f.operation === 'between' ? 'between' : '='} ${f.operation === 'between' ? `${f.value1}–${f.value2}` : f.value1}`).join(runningConditionCombine === 'or' ? ' OR ' : ' AND ')}
                            </div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                        <ChevronDown size={14} color="var(--text-faint)" style={{ transform: rcFilterOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
                    </div>
                </div>

                {rcFilterOpen && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
                        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                            Workspace default training periods + value conditions. A model follows this automatically, or can override either — set per model on its own Build page.
                        </p>

                        <div style={{ marginBottom: '12px' }} data-testid="rc-periods">
                            <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>Training periods</div>
                            <TimePeriodsEditor
                                periods={runningConditionTimePeriods}
                                onChange={updateRunningConditionPeriods}
                                bounds={datasetBounds}
                            />
                        </div>

                        {/* Value conditions vs. an explicit "No condition" — exactly one
                            is active; a running condition is REQUIRED before any model
                            can be built (soft gate A). Choosing "No condition" clears
                            nothing stored, it just stops the saved conditions applying. */}
                        <div role="group" aria-label="Condition mode" style={{ display: 'inline-flex', background: 'var(--card-bg, var(--bg-secondary))', border: '1px solid var(--border-strong)', borderRadius: '7px', padding: '2px', gap: '2px', marginBottom: '12px' }}>
                            {([['condition', 'Filter by condition'], ['none', 'No condition']] as const).map(([mode, label]) => {
                                const active = (mode === 'none') === runningConditionNoneConfirmed;
                                return (
                                    <button
                                        key={mode}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => {
                                            const none = mode === 'none';
                                            if (none === runningConditionNoneConfirmed) return;
                                            setRunningConditionNoneConfirmed(none);
                                            persistRunningCondition({ noneConfirmed: none });
                                        }}
                                        style={{
                                            fontSize: '0.68rem', fontWeight: 600, padding: '4px 12px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                                            background: active ? 'var(--accent-color)' : 'none',
                                            color: active ? '#06111f' : 'var(--text-secondary)',
                                        }}
                                    >
                                        {label}
                                    </button>
                                );
                            })}
                        </div>

                        {runningConditionNoneConfirmed ? (
                            <div data-testid="rc-none-note" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                No condition — use all rows. Models follow this default and train on every row, including idle periods.
                                {runningConditionFilters.length > 0 && ' Your saved conditions are kept but not applied.'}
                            </div>
                        ) : (
                        <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Match</span>
                            <div style={{ display: 'inline-flex', background: 'var(--card-bg, var(--bg-secondary))', border: '1px solid var(--border-strong)', borderRadius: '7px', padding: '2px', gap: '2px' }}>
                                {(['and', 'or'] as const).map(mode => (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => {
                                            setRunningConditionCombine(mode);
                                            persistRunningCondition({ combine: mode });
                                        }}
                                        style={{
                                            fontSize: '0.68rem', fontWeight: 700, padding: '4px 12px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                                            background: runningConditionCombine === mode ? 'var(--accent-color)' : 'none',
                                            color: runningConditionCombine === mode ? '#06111f' : 'var(--text-secondary)',
                                            letterSpacing: '0.03em',
                                        }}
                                    >
                                        {mode.toUpperCase()}
                                    </button>
                                ))}
                            </div>
                            <span style={{ fontSize: '0.64rem', color: 'var(--text-faint)' }}>
                                {runningConditionCombine === 'or' ? '— a row passes if any condition below is true' : '— a row must pass every condition below'}
                            </span>
                        </div>

                        {runningConditionFilters.map(f => (
                            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', marginBottom: '6px', background: 'var(--chip-bg)', border: '1px solid var(--border)', borderRadius: '6px' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <SensorPickerModal
                                        sensors={allSensors}
                                        getDesc={getDesc}
                                        getComponent={getComponent}
                                        single
                                        value={f.sensor}
                                        onSelect={sensor => updateRunningConditionFilter(f.id, { sensor })}
                                        noun="sensor"
                                    />
                                </div>
                                <select
                                    value={f.operation}
                                    onChange={e => updateRunningConditionFilter(f.id, { operation: e.target.value as WorkspaceSensorFilter['operation'] })}
                                    style={{ padding: '4px 6px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: '4px', color: 'var(--accent-color)', fontSize: '0.7rem', fontWeight: 600, outline: 'none', flexShrink: 0 }}
                                >
                                    <option value="greater_than">&gt;</option>
                                    <option value="less_than">&lt;</option>
                                    <option value="between">between</option>
                                    <option value="equals">=</option>
                                </select>
                                <input
                                    type="number"
                                    value={f.value1}
                                    onChange={e => updateRunningConditionFilter(f.id, { value1: e.target.value })}
                                    placeholder="val"
                                    style={{ width: '68px', padding: '4px 6px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.72rem', outline: 'none', flexShrink: 0 }}
                                />
                                {f.operation === 'between' && (
                                    <input
                                        type="number"
                                        value={f.value2}
                                        onChange={e => updateRunningConditionFilter(f.id, { value2: e.target.value })}
                                        placeholder="max"
                                        style={{ width: '68px', padding: '4px 6px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.72rem', outline: 'none', flexShrink: 0 }}
                                    />
                                )}
                                <button
                                    type="button"
                                    onClick={() => removeRunningConditionFilter(f.id)}
                                    title="Remove condition"
                                    style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '3px', display: 'flex', flexShrink: 0 }}
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            onClick={addRunningConditionFilter}
                            disabled={allSensors.length === 0}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 9px',
                                background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '4px',
                                color: 'var(--accent-color)', fontSize: '0.68rem', fontWeight: 600,
                                cursor: allSensors.length === 0 ? 'not-allowed' : 'pointer', opacity: allSensors.length === 0 ? 0.5 : 1,
                            }}
                        >
                            <Plus size={11} /> Add condition
                        </button>
                        </>
                        )}

                        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border)', fontSize: '0.68rem', color: 'var(--text-faint)' }}>
                            Default for every model — override per model on its own Build page.
                        </div>
                    </div>
                )}
            </div>

            {rcLegacyNotice === 'pending' && !rcConfigured && !legacyRemindLater && (
                <div
                    role="status"
                    data-testid="rc-legacy-banner"
                    style={{ margin: '12px 20px 0', display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(245,158,11,0.45)', background: 'rgba(245,158,11,0.08)', fontSize: '0.74rem', lineHeight: 1.5 }}
                >
                    <div style={{ flex: 1, minWidth: '220px' }}>
                        <div style={{ fontWeight: 600, marginBottom: '2px' }}>This workspace has models but no running condition</div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                            Models built so far trained on all rows. A running condition is now required to build or finish a model: set one, or confirm that using all data is intended.
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0, flexWrap: 'wrap' }}>
                        <button type="button" className="text-btn" onClick={() => setRcFilterOpen(true)}>Set a condition</button>
                        <button
                            type="button"
                            className="text-btn"
                            onClick={() => {
                                setRunningConditionNoneConfirmed(true);
                                persistRunningCondition({ noneConfirmed: true });
                            }}
                        >
                            Keep using all data
                        </button>
                        <button type="button" className="text-btn" onClick={() => setLegacyRemindLater(true)}>Remind me later</button>
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '12px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <b style={{ color: 'var(--text-primary)' }}>{totalModels}</b> models ·
                    <b style={{ color: 'var(--text-primary)' }}>{realGroups.length}</b> groups ·
                    <b style={{ color: 'var(--text-primary)' }}>{componentSections.length}</b> components
                </div>
                <div style={{ display: 'inline-flex', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', borderRadius: '8px', padding: '3px', gap: '2px' }}>
                    {(['fg', 'component', 'kind'] as GroupBy[]).map(mode => (
                        <button
                            key={mode}
                            onClick={() => setGroupBy(mode)}
                            style={{
                                fontSize: '0.78rem', padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                                background: groupBy === mode ? 'var(--accent-color)' : 'none',
                                color: groupBy === mode ? '#06111f' : 'var(--text-secondary)',
                                fontWeight: groupBy === mode ? 600 : 500,
                            }}
                        >
                            {mode === 'fg' ? 'Group by Failure Group' : mode === 'component' ? 'Group by Component' : 'Group by Model Type'}
                        </button>
                    ))}
                </div>
            </div>

            {/* `minHeight: 0` is required here — without it, a `flex: 1` item in
                a flex column defaults to `min-height: auto` and refuses to
                shrink below its own content's height, so a tall expanded
                accordion form just grows this div past the window's bottom
                edge instead of scrolling internally (the classic flexbox
                scroll-container bug). This was the real cause of the button
                row repeatedly looking "cut off" — not a width issue. */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {categoryNotice && categoryNotice.length > 0 && (
                    <div
                        role="status"
                        data-testid="category-normalisation-notice"
                        style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(245,158,11,0.45)', background: 'rgba(245,158,11,0.08)', fontSize: '0.74rem', lineHeight: 1.5 }}
                    >
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, marginBottom: '2px' }}>
                                Categories were made consistent — {categoryNotice.length} model{categoryNotice.length === 1 ? '' : 's'} updated
                            </div>
                            <div style={{ color: 'var(--text-secondary)' }}>
                                A sensor now has ONE category for all of its models. Where they disagreed, Individual wins over Relationship over Clustering.
                            </div>
                            <ul style={{ margin: '4px 0 0', paddingLeft: '16px', color: 'var(--text-secondary)' }}>
                                {categoryNotice.map(c => (
                                    <li key={c.modelId} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {sensorLabel(c.sensorKey)} · {KIND_LABEL[c.kind]}: {c.from ? CATEGORY_LABELS[c.from] : 'not set'} → {c.to ? CATEGORY_LABELS[c.to] : 'not set'}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <button type="button" className="text-btn" style={{ flexShrink: 0 }} onClick={dismissCategoryNotice}>Dismiss</button>
                    </div>
                )}

                {groupBy === 'fg' ? (
                    realGroups.length === 0 ? (
                        <div className="no-results">No failure groups yet</div>
                    ) : realGroups.map(g => {
                        const models = allModels.filter(m => m.groupNos.includes(g.no));
                        const color = getFgGroupColor(g.no);
                        // No `overflow: hidden` on the card below (despite the rounded
                        // corners) — it would clip the sticky Save footer instead
                        // of letting it stick to the viewport; nothing inside this card
                        // actually needs edge-to-edge clipping to look right without it.
                        return (
                            <div key={g.no} className={`fg-group-color-${color}`} style={{ border: '1px solid var(--border)', borderRadius: '10px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                    <span className="fg-group-dot" />
                                    <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{g.name}</span>
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.68rem', color: 'var(--text-faint)' }}>FG-{g.no}</span>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                                </div>

                                {models.length === 0 ? (
                                    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px 10px 18px', fontSize: '0.72rem', color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                                ) : groupModelsBySensor(allModels, g.no).map(sg => sensorRow(g.no, sg))}
                            </div>
                        );
                    })
                ) : null}

                {groupBy === 'fg' && (() => {
                    // "Not in Group" (FG-0) — a permanent, non-deletable bucket for
                    // a model whose sensor doesn't belong to any failure mode.
                    // Always rendered (unlike the read-only Dashboard preview,
                    // which only shows this card once it's non-empty). No
                    // "Edit details" — it's not a real failure group, so there's
                    // no name/description/recommendation to edit.
                    const ungroupedModels = allModels.filter(m => m.groupNos.includes(0));
                    return (
                        <div className="fg-group-color-slate" style={{ border: '1px dashed var(--border)', borderRadius: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                <span className="fg-group-dot" />
                                <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1, color: 'var(--text-secondary)' }}>Not in Group</span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{ungroupedModels.length} model{ungroupedModels.length === 1 ? '' : 's'}</span>
                            </div>

                            {ungroupedModels.length === 0 ? (
                                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px 10px 18px', fontSize: '0.72rem', color: 'var(--text-faint)', fontStyle: 'italic' }}>No models yet</div>
                            ) : groupModelsBySensor(allModels, 0).map(sg => sensorRow(0, sg))}
                        </div>
                    );
                })()}

                {groupBy === 'component' && (
                    componentSections.length === 0 ? (
                        <div className="no-results">No models yet</div>
                    ) : componentSections.map(([comp, models]) => {
                        const initials = comp.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                        return (
                            <div key={comp} style={{ border: '1px solid var(--border)', borderRadius: '10px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                    <span style={{ width: '26px', height: '26px', borderRadius: '7px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-hi)', border: '1px solid var(--border)', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                                        {initials}
                                    </span>
                                    <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{comp}</span>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                                </div>
                                {models.map(m => overviewModelRow(m, true))}
                            </div>
                        );
                    })
                )}

                {groupBy === 'kind' && (
                    kindSections.length === 0 ? (
                        <div className="no-results">No models yet</div>
                    ) : kindSections.map(([kind, models]) => (
                        <div key={kind} style={{ border: '1px solid var(--border)', borderRadius: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 14px' }}>
                                <div className={`model-kind-icon model-kind-icon--${kind}`} style={{ width: '26px', height: '26px', fontSize: '0.68rem', flexShrink: 0 }}>
                                    {KIND_ABBREV[kind]}
                                </div>
                                <span style={{ fontSize: '0.88rem', fontWeight: 600, flex: 1 }}>{KIND_LABEL[kind]}</span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
                            </div>
                            {models.map(m => overviewModelRow(m, true))}
                        </div>
                    ))
                )}
            </div>
            </>
            )}
        </div>
    );
}
