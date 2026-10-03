import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../../utils/tauriEvents";
import { X, Check, ChevronRight, Lock, CircleAlert, TriangleAlert, Search, Loader2 } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata, WorkspaceSensorFilter, CategoryChange, TimePeriod, FailureGroupStateSlice, FailureGroupStateChangedPayload, HealthSetPoints } from "../../types";
import type { HealthIssue } from "../../types/health";
import type { RelationshipPreviewResult, ClusteringPreview } from "../../types/commands";
import { loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { modelSensorKey, groupModelsBySensor, sensorCategory, setSensorCategory, type SensorModelGroup } from "../../utils/modelGrouping";
import { normalizeCategories, flagLegacyGate, migratePeriods } from "../../utils/workspaceMigrations";
import { findSameSensorNameConflict, suggestDistinctModelName } from "../../utils/modelNames";
import { CATEGORY_BLOCK_REASON, getBuildBlockReason, isRunningConditionConfigured, isWorkspaceRunningConditionConfigured, effectiveRunningCondition, type RunningConditionFg } from "../../utils/runningCondition";
import { computeTrainFingerprint, isModelTrainedFresh as trainedFreshFor } from "../../utils/trainFingerprint";
import { buildPreviewFilterPayload } from "../../utils/trainingScope";
import { applyIncompleteRule } from "../../utils/incompleteRule";
import { isModelStale as isModelStaleFor, modelDotState, NOT_TRAINED_BLOCK_REASON, type ModelDotState } from "../../utils/modelStatus";
import { HEALTH_DEFAULT_MAX_POINTS, relationshipLambda } from "../../utils/healthRequest";
import { ensureHealthSetPoints } from "../../utils/healthSetPoints";
import { completeModel } from "../../utils/completeModel";
import { commitSetPoints, persistModelComplete } from "../../utils/healthPersist";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import { useDatasetTimeBounds } from "../../hooks/useDatasetTimeBounds";
import { useHealthPreview } from "../../hooks/useHealthPreview";
import { validatePeriods, newPeriodId } from "../../utils/timePeriods";
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, stiffnessLabel, snapStiffness } from "../reports/pmReportTypes";
import RunningConditionPanel, { RunningConditionPills } from "./RunningConditionPanel";
import { RunningConditionCard, type RcStepState } from "./RunningConditionCard";
import { useRowCountPreview } from "./useRowCountPreview";
import PredictiveModelBuild, { SensorPickerModal } from "./PredictiveModelBuild";
import TimePeriodsEditor from "./TimePeriodsEditor";
import SubModelsModal from "./SubModelsModal";
import { useSubModelFits } from "./useSubModelFits";
import ModelFitPage from "./workbench/ModelFitPage";
import { CLUSTER_COLORS as CLUSTER_PALETTE } from "./workbench/chartTheme";
import HealthScorePage from "./workbench/HealthScorePage";
import WorkbenchStepBar, { workbenchStepLooks, type StepKey } from "./workbench/WorkbenchStepBar";
import { PageSwitch, StaleBanner } from "./workbench/WorkbenchShellParts";
import { buildCheckLines, healthVerdict, sameSetPoints, verdictOfIssues, type HealthVerdict } from "./workbench/healthChecks";
import type { SaveInfo, WorkbenchPage } from "./workbench/workbenchTypes";

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
    /** Custom running-condition editor (2026-09-30 port) — unlike the PM
     *  page's own version of these four fields (plain component state,
     *  autosaved), these live in the draft so they follow the same
     *  Save-changes flow as every other field here (SPEC FINAL decision #2). */
    customFilters: WorkspaceSensorFilter[];
    customCombine: 'and' | 'or';
    customNoneConfirmed: boolean;
    customPeriods: TimePeriod[];
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
    customFilters: m.customRunningConditionFilters ?? [],
    customCombine: m.customRunningConditionCombine ?? 'and',
    customNoneConfirmed: m.customRunningConditionNoneConfirmed ?? false,
    customPeriods: m.filterTimePeriods ?? [],
});

// Fixed order (not alphabetical) -- I/R/C is a small, natural taxonomy, not
// an open-ended list like components, so it reads better presented in the
// same order the kind toggles/badges use everywhere else in the app.
const KIND_ORDER: ModelKind[] = ['individual', 'relationship', 'clustering'];
/** Left-list dot colour per status: green = complete, yellow = needs input /
 *  re-train, red = needs fixing, none = never trained (mockup `.kb[data-st]`). */
const DOT_CLASS: Record<ModelDotState, 'complete' | 'need' | 'bad' | null> = {
    complete: 'complete', trained: 'need', stale: 'need', blocked: 'bad', none: null,
};
const DOT_TITLE: Record<ModelDotState, string> = {
    complete: 'Complete', trained: 'Trained — set points needed', stale: 'Re-train needed', blocked: 'Needs fixing', none: 'Incomplete',
};
/** Status pill on a kind tab (mockup `.wd-tabs .pill`) — only the states worth a word. */
const TAB_PILL: Record<ModelDotState, { text: string; cls: string } | null> = {
    complete: { text: 'Complete', cls: 'f4-pill--ok' },
    trained: { text: 'Trained', cls: 'f4-pill--grey' },
    stale: { text: 'Re-train', cls: 'f4-pill--warn' },
    blocked: null,
    none: null,
};
/** Next to every Model-settings field that is part of the training inputs
 *  (training data, predictors, sensors, clusters, stiffness): changing it sets a
 *  Complete model back to Incomplete (`applyIncompleteRule`) — say so up front. */
const IncompleteHint = () => (
    <span className="wb2-aff" data-testid="incomplete-hint">changing it sets the model to Incomplete</span>
);
/** Stable empty list for `useSubModelFits` when the active model is not a Relationship. */
const NO_PREDICTORS: string[] = [];
const DUPLICATE_NAME_BLOCK_REASON = 'Model name is already used by another model of this sensor';
const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

// ─── Build Model Workbench Phase B (Train in place) ───────────────────────
// Shape returned by Rust's `compute_sensor_stats` — mirrors the identically-
// named (and likewise un-exported) interface in PredictiveModelBuild.tsx;
// duplicated rather than imported since that file doesn't export it.
interface SensorStats {
    mean: number;
    sd: number;
    min: number;
    max: number;
    count: number;
    lower1: number;
    upper1: number;
    lower3: number;
    upper3: number;
}

/** One model's cached Phase-B preview result, keyed by kind so the results
 *  stage/expand-modal can render the right chart without re-deriving which
 *  invoke produced it. Session-only — Phase B never writes a file, so this
 *  is never persisted (only `lastTrainedAt`/`trainedFingerprint` are). */
type TrainResult =
    | { kind: 'individual'; stats: SensorStats }
    // `result.health_preview` is the bounded Relationship preview Rust returns
    // when asked to cache the fit (no set points applied — draw it right away);
    // `cacheKey` is the key that fit is cached under, for `compute_health_preview`.
    | { kind: 'relationship'; result: RelationshipPreviewResult; predictorsAtApply: string[]; cacheKey: string }
    | { kind: 'clustering'; preview: ClusteringPreview };

interface TrainCacheEntry {
    /** The fingerprint this result was computed against — lets a stale
     *  auto-recompute effect tell "already have the current result" apart
     *  from "have an old one that happens to still be cached". */
    fingerprint: string;
    result: TrainResult;
}

/** 🆕 2026-09-30 [data-loss fix, repeat report]: `TimePeriodsEditor`'s date
 *  fields only commit an edit to the parent (`onPeriodsChange` ->
 *  `persistRunningCondition`, tracked in `pendingSaveRef`) on blur / Enter —
 *  never per keystroke, by design, so rows don't jump around mid-type (see
 *  that file's own top comment). The Running Condition Filter modal's own
 *  close paths (the X button, backdrop click) used to just call
 *  `setRcFilterOpen(false)` directly — a plain state update, not a real DOM
 *  focus change — so a half-typed date that never naturally blurred (e.g. a
 *  test's `fireEvent.change` with no following `fireEvent.blur`, or, per the
 *  user's real report, some real click paths) unmounted the editor without
 *  its `onCommit` ever firing, silently discarding the edit. Calling this
 *  before any close path (the modal's own, and the whole window's) forces
 *  that commit synchronously and unconditionally — a no-op when nothing
 *  relevant is focused. */
function flushFocusedInput(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && typeof active.blur === 'function') active.blur();
}

/** 🆕 2026-10-03: the four workspace Running condition fields the settings modal
 *  edits as ONE local draft (nothing is written until Apply — see
 *  `applyRcDraft`). Same shape `persistRunningCondition` takes. */
interface RcDraft {
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    periods: TimePeriod[];
    noneConfirmed: boolean;
}

/** Draft vs. persisted comparison. JSON is enough: every draft object is built
 *  by spreading the persisted one (key order preserved) and the period editor
 *  hands back already-sorted lists. */
function rcDraftEqual(a: RcDraft, b: RcDraft): boolean {
    return a.combine === b.combine
        && a.noneConfirmed === b.noneConfirmed
        && JSON.stringify(a.filters) === JSON.stringify(b.filters)
        && JSON.stringify(a.periods) === JSON.stringify(b.periods);
}

/** Footer's "Last trained <date>" (Complete state) — locale-formatted, not a
 *  fixed pattern, since this is a plain human-readable timestamp, not
 *  something any other code parses back. */
function formatTrainedAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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
 *     wrapping `RunningConditionPanel`. (2026-10-03: the bar is now the
 *     Step-1 card + a header step bar, and the modal body is the
 *     two-column redesign — see RunningConditionCard / RunningConditionPanel.)
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
    // Drives the Workbench's Running condition settings modal (opened from the
    // Step-1 card's Edit / Set running condition / Fix period button; was an inline
    // collapsible panel before Phase A; same underlying state, now shown in
    // a modal overlay instead of an always-present card).
    const [rcFilterOpen, setRcFilterOpen] = useState(false);
    // 🆕 2026-10-03: the modal edits this LOCAL DRAFT, never the persisted
    // values above. `null` = nothing edited yet (the modal then just shows the
    // persisted values live — copy-on-write on the first edit), so there is no
    // "seed on open" step to forget on any of the several paths that open the
    // modal. Cleared on every close, so a reopen always starts from persisted.
    // Held in a ref too: a period date only commits on blur, which fires right
    // before the Apply click — the click handler must see that commit
    // synchronously, not wait for a re-render.
    const [rcDraft, setRcDraftState] = useState<RcDraft | null>(null);
    const rcDraftRef = useRef<RcDraft | null>(null);
    // A period date input inside the modal has been typed into but not yet
    // committed (blur / Enter). Keeps Apply clickable in that window — a
    // disabled button would swallow the click, and the commit-on-blur would
    // otherwise never be reached before Apply is judged "clean".
    const [rcPeriodTyping, setRcPeriodTyping] = useState(false);
    // Inline "Discard changes?" row, shown instead of closing when X/backdrop
    // is used with an unapplied draft.
    const [rcDiscardPrompt, setRcDiscardPrompt] = useState(false);
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

    // ---- Train in place (Phase B) ----
    /** Session-only cache of the last successful preview run per model id —
     *  never persisted (Phase B writes only `lastTrainedAt`/`trainedFingerprint`
     *  to the workspace; the actual chart data is cheap to recompute, same as
     *  the PM page's own live queries). */
    const [trainResults, setTrainResults] = useState<Record<string, TrainCacheEntry>>({});
    /** Presence of a key = that model id currently has a preview run in
     *  flight (explicit Train/Re-train click OR the silent auto-recompute on
     *  reopen); absence = idle. There is no separate "done" value — a
     *  finished run is represented by its entry landing in `trainResults`. */
    const [trainStatus, setTrainStatus] = useState<Record<string, 'loading'>>({});
    const [trainError, setTrainError] = useState<Record<string, string>>({});
    // ---- Two pages per model (health score phase 3b-1, 2026-10-04) ----
    /** Which page of the detail pane each model is on ("Model fit" is the
     *  default). Keyed by model id so switching sensors/kind tabs keeps each
     *  model's page. The Health score page can never be SHOWN for a stale or
     *  untrained model — `pageOf` below falls back to "Model fit". */
    const [pageByModel, setPageByModel] = useState<Record<string, WorkbenchPage>>({});
    /** The Rust session generation of the dataset this window was opened on
     *  (`metadata.generation` of the `build-model-data` payload), sent as
     *  `expectedGeneration` so a window left over from an old dataset gets
     *  `STALE_SESSION` instead of another dataset's numbers. */
    const [generation, setGeneration] = useState<number | undefined>(undefined);
    /** Bumped after every Train so `useHealthPreview` refetches even when the
     *  request itself is identical (a Relationship re-train re-fills Rust's fit cache). */
    const [healthRevision, setHealthRevision] = useState(0);
    /** "Compare predictors" (Sub-models) modal of the active Relationship model. */
    const [compareOpen, setCompareOpen] = useState(false);
    // Never leave the comparison open pointed at a model the user has since
    // navigated away from (switching sensor or kind tab).
    useEffect(() => { setCompareOpen(false); }, [selectedSensorKey, activeTab]);

    // ---- Health score page (health score phase 3b-2, 2026-10-04) ----
    /** DRAFT set points per model id: what the user is typing on the Health score
     *  page. A key is present only while there is something typed that has not
     *  been confirmed on disk yet; the page and `useHealthPreview` read
     *  `draft ?? persisted`, so typing moves the charts/score/Checks at once and a
     *  broadcast from another window (which only refreshes the persisted side) can
     *  never overwrite what is being typed. Persisted by `commitSetPointDrafts` (input
     *  blur / Enter, leaving the page or the model, window close). Mirrored in a ref
     *  so the commit paths see the latest value synchronously. */
    const [spDrafts, setSpDraftsState] = useState<Record<string, HealthSetPoints>>({});
    const spDraftsRef = useRef<Record<string, HealthSetPoints>>({});
    const writeSpDrafts = useCallback((next: Record<string, HealthSetPoints>) => {
        spDraftsRef.current = next;
        setSpDraftsState(next);
    }, []);
    /** Mark complete progress / result per model id (session only). */
    const [saveInfo, setSaveInfo] = useState<Record<string, SaveInfo>>({});
    /** Issues Rust returned when the last Mark complete was refused (until the set points change). */
    const [attemptIssues, setAttemptIssues] = useState<Record<string, HealthIssue[] | null>>({});
    /** Models whose Mark complete is running right now (double-click guard; a ref so two
     *  clicks in the same tick cannot both pass). */
    const completeRunningRef = useRef<Set<string>>(new Set());
    /** The last validate verdict Rust gave per model this session (drives the
     *  "Set points needed" / "Fix set point" tab pills and the red dot). */
    const [healthVerdicts, setHealthVerdicts] = useState<Record<string, HealthVerdict>>({});
    /** Models whose first-open set-point snapshot was already written (once per model). */
    const setPointsSeededRef = useRef<Set<string>>(new Set());

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
    /** 🆕 2026-09-30: "Copied N periods and M conditions from Workspace" note
     *  for the Custom running-condition editor, keyed per model id — mirrors
     *  PredictiveModelBuild.tsx's own `seedNote`, session-only (never
     *  persisted), shown once per model per switch-to-Custom that actually
     *  copied something. */
    const [seedNoteFor, setSeedNoteFor] = useState<Record<string, { periods: number; conditions: number } | null>>({});
    /** Clustering's criteria-sensor stats (drives the cluster-range slider's
     *  [min, max] bounds) — scoped to whichever model is currently active,
     *  refetched whenever its (draft-aware) criteria sensor or effective
     *  training-scope filter changes. Mirrors PredictiveModelBuild.tsx's own
     *  `criteriaStats` effect; `null` while unset/loading, same as there. */
    const [criteriaStats, setCriteriaStats] = useState<SensorStats | null>(null);

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getComponent = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.component ?? '', [sensorMetaMap]);
    // Raw description only (not the "description (tag)" combo `sensorLabel`
    // below builds) — matches `SensorAutocomplete`'s own `getDesc` contract,
    // which appends the tag itself separately.
    const getDesc = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description ?? '', [sensorMetaMap]);
    // Unit text for the Running condition chips / value fields ("kW", "BAR"...).
    const getUnit = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.unit ?? '', [sensorMetaMap]);
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

    /** Persists every set-point draft that is not on disk yet (health score
     *  3b-2). Writes ONLY `healthSetPoints` (`commitSetPoints`: no status, no train
     *  record, never stale), tracked in `pendingSaveRef` like every other write so
     *  a window close waits for it. A draft is dropped once its write landed,
     *  unless the user typed something newer meanwhile. No draft = no write. */
    const spInflightRef = useRef<{ drafts: Record<string, HealthSetPoints>; promise: Promise<void> } | null>(null);
    const commitSetPointDrafts = useCallback((): Promise<void> => {
        const ws = workspaceIdRef.current;
        const drafts = spDraftsRef.current;
        const ids = Object.keys(drafts);
        if (!ws || ids.length === 0) return Promise.resolve();
        // Several triggers can fire for one edit (blur, leaving the page, window close): the
        // same drafts already being written are not written a second time.
        const inflight = spInflightRef.current;
        if (inflight && ids.every(id => inflight.drafts[id] === drafts[id])) return inflight.promise;
        const entry: { drafts: Record<string, HealthSetPoints>; promise: Promise<void> | null } = { drafts, promise: null };
        const promise: Promise<void> = trackPending((async () => {
            try {
                for (const id of ids) {
                    const sp = drafts[id];
                    const next = await commitSetPoints(ws, id, sp, 'build-model');
                    if (workspaceIdRef.current !== ws) return;
                    if (next?.failureGroupState) applyFg(next.failureGroupState);
                    if (spDraftsRef.current[id] === sp) {
                        const rest = { ...spDraftsRef.current };
                        delete rest[id];
                        writeSpDrafts(rest);
                    }
                }
            } finally {
                if (spInflightRef.current === entry) spInflightRef.current = null;
            }
        })());
        entry.promise = promise;
        spInflightRef.current = entry as { drafts: Record<string, HealthSetPoints>; promise: Promise<void> };
        return promise;
    }, [trackPending, applyFg, writeSpDrafts]);

    /** Awaits both this window's own pending write and the PM page's pending
     *  debounced write (if that page is open), so no path off this window can
     *  drop an edit made just before closing. A set-point draft that was typed
     *  but never blurred is committed first, so it is part of what is awaited. */
    const flushAllPending = useCallback(async () => {
        void commitSetPointDrafts();
        if (pmFlushRef.current) await pmFlushRef.current();
        if (pendingSaveRef.current) await pendingSaveRef.current;
    }, [commitSetPointDrafts]);

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
        setSeedNoteFor(prev => {
            const ids = new Set(allModels.map(m => m.id));
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
    }, [allModels]);

    // A cached Phase-B preview (or an in-flight one) for a model that no
    // longer exists (deleted on the Dashboard, or the model was re-pointed at
    // a different workspace — see the `switched` reset below) must be thrown
    // away, never written back anywhere.
    useEffect(() => {
        const ids = new Set(allModels.map(m => m.id));
        setTrainResults(prev => {
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
        setTrainStatus(prev => {
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
        setTrainError(prev => {
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
                // The unapplied draft belonged to the old workspace.
                rcDraftRef.current = null;
                setRcDraftState(null);
                setRcPeriodTyping(false);
                setRcDiscardPrompt(false);
                setTrainResults({});
                setTrainStatus({});
                setTrainError({});
                setPageByModel({});
                setCompareOpen(false);
                // Health score page state of the old workspace.
                writeSpDrafts({});
                setSaveInfo({});
                setAttemptIssues({});
                setHealthVerdicts({});
                setPointsSeededRef.current = new Set();
                completeRunningRef.current = new Set();
            }
            setGeneration(d.metadata?.generation);
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
    }, [applyFg, trackPending, writeSpDrafts]);

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
                // "Incomplete immediately": a Complete model whose training inputs this
                // write changed goes back to Incomplete in the SAME write.
                return applyIncompleteRule(prev, withFailureGroupState(prev, { groups: result.groups, models: result.models }));
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
                // Applying a different workspace running condition changes what every
                // Workspace-mode model trains on: those that were Complete go back to
                // Incomplete in this same write (Custom-mode models are unaffected).
                return applyIncompleteRule(prev, withFailureGroupState(applied, { rcLegacyNotice: stillPending ? 'pending' : null }));
            });
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyFg, trackPending]);

    // ---- Running Condition modal: local draft + explicit Apply (2026-10-03) ----
    // Every edit in the modal lands in `rcDraft` only. Nothing is written to
    // disk or broadcast until Apply (`applyRcDraft`), which is ONE
    // `persistRunningCondition` call carrying all four fields. The Step-1 card
    // summary, the build gate and the per-model Workspace mode keep reading the
    // PERSISTED state vars above, so a dirty draft can never leak into them.
    //
    // A persisted change that arrives while the modal is open (another window's
    // broadcast) does NOT clobber a dirty draft; a clean modal just shows it
    // live. Apply then overwrites all four fields with the draft
    // (last-writer-wins, same as every other full-slice write here).
    const rcPersisted: RcDraft = {
        filters: runningConditionFilters,
        combine: runningConditionCombine,
        periods: runningConditionTimePeriods,
        noneConfirmed: runningConditionNoneConfirmed,
    };
    const rcPersistedRef = useRef<RcDraft>(rcPersisted);
    rcPersistedRef.current = rcPersisted;

    /** Applies a patch (or a function of the current draft) to the draft,
     *  updating the ref synchronously so a blur-commit followed immediately by
     *  the Apply click is never missed. */
    const patchRcDraft = useCallback((patch: Partial<RcDraft> | ((base: RcDraft) => Partial<RcDraft>)) => {
        const base = rcDraftRef.current ?? rcPersistedRef.current;
        const next: RcDraft = { ...base, ...(typeof patch === 'function' ? patch(base) : patch) };
        rcDraftRef.current = next;
        setRcDraftState(next);
        // Editing again means "keep editing" — drop a pending discard prompt.
        setRcDiscardPrompt(false);
    }, []);

    const addRunningConditionFilter = useCallback(() => {
        patchRcDraft(base => ({
            filters: [...base.filters, {
                id: `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                sensor: allSensors[0] ?? '',
                operation: 'greater_than' as const,
                value1: '',
                value2: '',
            }],
            // A condition and "No condition" are mutually exclusive.
            noneConfirmed: false,
        }));
    }, [allSensors, patchRcDraft]);

    const updateRunningConditionFilter = useCallback((id: string, patch: Partial<WorkspaceSensorFilter>) => {
        patchRcDraft(base => ({ filters: base.filters.map(f => f.id === id ? { ...f, ...patch } : f) }));
    }, [patchRcDraft]);

    const removeRunningConditionFilter = useCallback((id: string) => {
        patchRcDraft(base => ({ filters: base.filters.filter(f => f.id !== id) }));
    }, [patchRcDraft]);

    // Periods are committed by the editor itself on blur / Enter (sorted).
    const updateRunningConditionPeriods = useCallback((periods: TimePeriod[]) => {
        patchRcDraft({ periods });
    }, [patchRcDraft]);

    /** Discards the draft and closes the modal — the single exit every close
     *  path (Cancel, Discard, successful Apply) goes through. */
    const closeRc = useCallback(() => {
        rcDraftRef.current = null;
        setRcDraftState(null);
        setRcPeriodTyping(false);
        setRcDiscardPrompt(false);
        setRcFilterOpen(false);
    }, []);

    /** X button / backdrop click. A dirty draft is never silently thrown away:
     *  the footer swaps to an inline "Discard changes?" row instead. */
    const requestCloseRc = useCallback(() => {
        // Commit a half-typed period date first, so it counts as "dirty".
        flushFocusedInput();
        const d = rcDraftRef.current;
        if (d && !rcDraftEqual(d, rcPersistedRef.current)) {
            setRcDiscardPrompt(true);
            return;
        }
        closeRc();
    }, [closeRc]);

    const applyRcDraft = useCallback(() => {
        // The click may land before a half-typed period date's blur-commit
        // has re-rendered; this forces it, and the ref picks it up at once.
        flushFocusedInput();
        const d = rcDraftRef.current;
        if (!d || rcDraftEqual(d, rcPersistedRef.current)) { closeRc(); return; }
        if (validatePeriods(d.periods).some(s => s.invalid)) return;
        // Optimistic local mirror (the persisted state vars) so the Step-1 card and
        // the gate are right the moment the modal closes; the write's own
        // `applyFg` then confirms it from disk.
        setRunningConditionFilters(d.filters);
        setRunningConditionCombine(d.combine);
        setRunningConditionTimePeriods(d.periods);
        setRunningConditionNoneConfirmed(d.noneConfirmed);
        void persistRunningCondition({ filters: d.filters, combine: d.combine, periods: d.periods, noneConfirmed: d.noneConfirmed });
        closeRc();
    }, [closeRc, persistRunningCondition]);

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
    // 🆕 2026-09-30 QA fix (bug 3): judge the DRAFT-merged model
    // (`effectiveModelFor`, defined below — closures resolve it fine, it's
    // only ever CALLED after the component's synchronous render body has
    // defined it), not the persisted one. `getBuildBlockReason` reads
    // `runningConditionMode`/`customRunningConditionFilters`/
    // `filterTimePeriods` straight off whatever model it's given; passing
    // the persisted model meant the gate was blind to a pending Custom-mode
    // switch/edit — Train (and "Open full view") could commit a draft that
    // switched to Custom with no condition set (or an invalid period) and
    // train with `filter: null` (every row), exactly what this gate exists
    // to prevent. Staleness (`isModelTrainedFresh`/`isModelStale`) already
    // reads through `effectiveModelFor` for the same reason — this makes the
    // gate check live-reactive the same way, in both directions (blocks a
    // draft that just broke the condition; unblocks one that just fixed it,
    // without waiting for Save).
    const gateReasonOf = (m: FailureModel): string | null => getBuildBlockReason(effectiveModelFor(m), gateFg, gateHeaders);
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
        // 🆕 2026-09-30: Custom now has its own editable conditions/periods
        // (see `switchRunningConditionMode` / the "Training data" field
        // below), so the collapsed summary shows what's actually configured
        // instead of a flat "Custom data" that never changed.
        if (d.runningConditionMode === 'custom') {
            const condLabel = d.customNoneConfirmed ? 'no cond' : `${d.customFilters.length} cond`;
            parts.push(`Custom · ${condLabel} · ${d.customPeriods.length} period${d.customPeriods.length === 1 ? '' : 's'}`);
        } else {
            parts.push('Workspace data');
        }
        return parts.join(' · ');
    };

    // Returns the `persist()` promise (rather than firing it and forgetting)
    // so `buildModel` below can await the write actually landing on disk
    // before navigating to the PM page.
    /** The persistable fields a model's draft would write on Save — factored
     *  out of `commitModel` so `runTrainClick` (Phase B) can compute the exact
     *  same merged-with-draft model to train against, without waiting for a
     *  `persist()` round-trip + re-render to see the fresh values.
     *  🆕 2026-09-30: the custom running-condition editor fields are common
     *  to every kind (same as `runningConditionMode` already was), so they're
     *  folded into `base` rather than repeated per branch. */
    const draftFields = (m: FailureModel, d: ModelDraft): Partial<FailureModel> => {
        const base: Partial<FailureModel> = {
            name: d.name.trim(),
            runningConditionMode: d.runningConditionMode,
            customRunningConditionFilters: d.customFilters,
            customRunningConditionCombine: d.customCombine,
            customRunningConditionNoneConfirmed: d.customNoneConfirmed,
            filterTimePeriods: d.customPeriods,
        };
        if (m.kind === 'individual') return base;
        if (m.kind === 'relationship') return { ...base, predictorSensors: d.predictors, relStiffness: d.stiffness };
        return { ...base, ySensor: d.y, criteriaSensor: d.criteria, clusterRanges: d.criteria ? d.ranges : [], numClusters: d.numClusters };
    };

    const commitModel = async (m: FailureModel) => {
        if (modelBlockReason(m) !== null) return;
        const d = draftOf(m);
        const fields = draftFields(m, d);
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

    /** 🆕 2026-09-30: the Custom running-condition editor's Workspace/Custom
     *  switch — ported from PredictiveModelBuild.tsx's own
     *  `handleRunningConditionModeChange` (see that file's own comment), but
     *  adapted to this window's draft model: everything it touches
     *  (`runningConditionMode`, `customFilters`/`customCombine`/
     *  `customPeriods`) is a DRAFT field, so a switch here (and any seeding it
     *  triggers) is staged, not written until Save changes — the seed check
     *  itself ("does this model already have its own custom rows") reads the
     *  CURRENT draft (which starts out as the model's own stored fields via
     *  `draftFromModel`, then whatever the user has since edited) rather than
     *  a separate, PM-page-style piece of component state — same data, this
     *  window just keeps it in `drafts` instead of a dedicated `useState`. */
    const switchRunningConditionMode = (m: FailureModel, mode: 'workspace' | 'custom') => {
        if (mode === 'workspace') {
            patchDraft(m, { runningConditionMode: 'workspace' });
            setSeedNoteFor(prev => (m.id in prev ? { ...prev, [m.id]: null } : prev));
            return;
        }
        const d = draftOf(m);
        const patch: Partial<ModelDraft> = { runningConditionMode: 'custom' };
        let copiedConditions = 0;
        let copiedPeriods = 0;
        if (d.customFilters.length === 0 && runningConditionFilters.length > 0) {
            copiedConditions = runningConditionFilters.length;
            patch.customFilters = runningConditionFilters.map(f => ({ ...f, id: `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }));
            patch.customCombine = runningConditionCombine;
        }
        if (d.customPeriods.length === 0 && runningConditionTimePeriods.length > 0) {
            copiedPeriods = runningConditionTimePeriods.length;
            patch.customPeriods = runningConditionTimePeriods.map(p => ({ ...p, id: newPeriodId() }));
        }
        patchDraft(m, patch);
        if (copiedConditions > 0 || copiedPeriods > 0) {
            setSeedNoteFor(prev => ({ ...prev, [m.id]: { periods: copiedPeriods, conditions: copiedConditions } }));
        }
    };

    /** 🆕 2026-09-30: the Relationship result chart's X-axis switcher —
     *  writes immediately (per the approved mockup's decision #1: it's a
     *  view choice for the chart, not a model parameter like predictors/
     *  stiffness/training-scope, so it doesn't belong in the draft/Save-
     *  changes flow those use). Same immediate-write shape as `changeCategory`
     *  above — a direct `persist()` call, not a `patchDraft`. */
    const changeScatterX = (modelId: string, xSensor: string) => {
        void persist((models, groups) => ({
            groups,
            models: models.map(x => x.id === modelId ? { ...x, scatterXSensor: xSensor } : x),
        }));
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

    /** The model Train/staleness checks should actually judge RIGHT NOW: the
     *  persisted model, merged with any pending (unsaved) draft edit for it —
     *  same merge `runTrainClick` commits on an actual Train. A draft change
     *  to a fingerprinted field (stiffness, predictors, Y, cluster settings,
     *  Workspace/Custom, …) must make the results area go stale and disable
     *  Mark complete IMMEDIATELY, not only after Save/Train (QA fix,
     *  2026-09-29 — "an unsaved draft edit after training leaves the old
     *  chart up and Mark complete enabled"). The persisted
     *  `trainedFingerprint` write itself only ever happens through
     *  `runTrainClick`/`executeTrain`, never from this. */
    const effectiveModelFor = (m: FailureModel): FailureModel =>
        m.id in drafts ? { ...m, ...draftFields(m, draftOf(m)) } : m;

    /** "Trained" (the status pill, distinct from Complete): a successful
     *  Phase-B preview run exists AND its fingerprint still matches the
     *  model's current inputs AND the model isn't already Complete — see
     *  `src/utils/trainFingerprint.ts` and the SPEC FINAL entry in
     *  `docs/PROJECT_HANDOVER.md`. */
    const isModelTrainedFresh = (m: FailureModel): boolean =>
        !m.status && trainedFreshFor(effectiveModelFor(m), gateFg);
    /** Was trained at some point, but the model's inputs (or the effective
     *  running condition) changed since — "Settings changed — re-train". */
    // 🆕 2026-10-03 (health score): NOT gated on `status` any more — a Complete
    // model whose inputs changed since it was trained is out of date too (the
    // write side already set it Incomplete; this is the read side, for old data
    // and for a pending draft). See `utils/modelStatus.ts`.
    const isModelStale = (m: FailureModel): boolean => isModelStaleFor(effectiveModelFor(m), gateFg);
    /** Complete AND still up to date — what every "Complete" display reads
     *  (never `m.status` alone). */
    const isModelDone = (m: FailureModel): boolean => m.status && !isModelStale(m);

    // 🆕 2026-10-04 (health score 3b-2): the old `toggleModelStatus` is GONE. A model
    // can no longer be marked Complete by flipping a flag: the ONLY way is
    // `runMarkComplete` below (validate the set points -> write the model's files ->
    // persist `status: true`). Going back to Incomplete only writes `status: false`
    // (the files already written stay on disk).
    const markModelIncomplete = (modelId: string) => {
        void persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: false } : m),
        }));
    };

    /** Everything currently wrong with THIS model's own settings, plus (if
     *  distinct from the category reason `missingItems` already covers) the
     *  running-condition/period gate reason — feeds the results area's
     *  "N items to fix" list. Reuses the exact same messaging `missingItems`
     *  already surfaces in the collapsible Model settings section, per the
     *  SPEC FINAL instruction not to invent a second wording for the same
     *  thing. Each item carries its own "take me there" action. */
    const incompleteItems = (m: FailureModel): { text: string; onClick: () => void }[] => {
        const items = missingItems(m).map(text => ({
            text,
            onClick: () => setSettingsOpenOverride(prev => ({ ...prev, [m.id]: true })),
        }));
        const gr = gateReasonOf(m);
        // Avoid double-reporting the category reason: `missingItems` already
        // lists "Pick a category" when it's null; `gateReasonOf` returns the
        // SAME `CATEGORY_BLOCK_REASON` text in that case, not a distinct one.
        // 🆕 2026-09-30 QA fix (bug 4): this link used to always open the
        // WORKSPACE Running Condition modal (`setRcFilterOpen(true)`) — for
        // a Custom-mode model that fixes nothing, since Custom's own
        // condition/period editor lives inline in this model's own Model
        // settings section (the port above), not in that modal. Route a
        // Custom-mode model's link there instead (same action `missingItems`
        // above already uses to jump to a missing field).
        if (gr && categoryOf(m) !== null) {
            const isCustom = draftOf(m).runningConditionMode === 'custom';
            items.push({
                text: gr,
                onClick: () => isCustom
                    ? setSettingsOpenOverride(prev => ({ ...prev, [m.id]: true }))
                    : setRcFilterOpen(true),
            });
        }
        return items;
    };

    /** Runs the read-only preview computation for ONE model (Phase B —
     *  "the SAME preview computations the PM page already runs for
     *  training/preview purposes": `compute_sensor_stats` / `preview_relationship_model` /
     *  `compute_clustering_preview`). Never writes a `*_INFO_*.json` file —
     *  that's the next phase. `opts.persistMeta` distinguishes an explicit
     *  Train/Re-train click (writes `lastTrainedAt`/`trainedFingerprint` via
     *  `persist()`, never a hand-built object literal) from the silent
     *  auto-recompute that runs when reopening an already-Trained-and-fresh
     *  model (session-only — nothing to persist, the fingerprint hasn't
     *  changed). `merged` carries the exact inputs used, so a Train click can
     *  pass the just-committed draft values without waiting for this
     *  window's state to re-render first (see `runTrainClick`). */
    const executeTrain = async (merged: FailureModel, fingerprint: string, opts: { persistMeta: boolean }): Promise<void> => {
        const id = merged.id;
        // 🆕 QA fix (2026-09-29): a Train can still be running when this
        // window gets re-pointed at a different workspace (`build-model-data`
        // for a new project). `persist()`'s write targets whatever
        // `workspaceId` its OWN closure captured at call time, which is
        // fine — but its `applyFg` call replaces this window's CURRENT
        // in-memory state unconditionally, even though `workspaceIdRef`
        // already points elsewhere by the time this resolves. Capture the
        // workspace this run belongs to now, and refuse to write back (or
        // touch any of this window's state) if it no longer matches once the
        // preview actually finishes — "train ค้างแล้ว workspace เปลี่ยน →
        // ทิ้งผล ไม่เขียนกลับ" (SPEC FINAL). A stray `trainStatus`/`trainResults`
        // entry for the abandoned model id is harmless: the effect above
        // already prunes any id no longer in the (now different) `allModels`.
        const capturedWorkspaceId = workspaceIdRef.current;
        setTrainStatus(prev => ({ ...prev, [id]: 'loading' }));
        setTrainError(prev => {
            if (!(id in prev)) return prev;
            const rest = { ...prev };
            delete rest[id];
            return rest;
        });
        try {
            const eff = effectiveRunningCondition(merged, gateFg);
            const filter = buildPreviewFilterPayload(eff, gateHeaders);
            let result: TrainResult;
            if (merged.kind === 'individual') {
                const stats = await invoke<SensorStats>('compute_sensor_stats', { sensor: merged.targetSensor, filter });
                result = { kind: 'individual', stats };
            } else if (merged.kind === 'relationship') {
                // Health score: ask Rust to keep the full-resolution fit under a key that
                // contains the train fingerprint — Rust ignores `filter` for the cached
                // fit, so a key that did not change with the scope/predictors/target/
                // stiffness would serve stale data. (`fingerprint` is the same value that
                // is persisted as `trainedFingerprint`.)
                const cacheKey = `${merged.id}::${fingerprint}`;
                const r = await invoke<RelationshipPreviewResult>('preview_relationship_model', {
                    predictors: merged.predictorSensors,
                    target: merged.targetSensor,
                    lambda: merged.relStiffness,
                    filter,
                    cache_key: cacheKey,
                    max_points: HEALTH_DEFAULT_MAX_POINTS,
                });
                if (r.error) throw new Error(r.error);
                result = { kind: 'relationship', result: r, predictorsAtApply: [...merged.predictorSensors], cacheKey };
            } else {
                const effClusters = merged.numClusters ?? 3;
                const r = await invoke<ClusteringPreview>('compute_clustering_preview', {
                    first_sensor: merged.xSensor,
                    second_sensor: merged.ySensor,
                    n_clusters: effClusters,
                    criteria_sensor: merged.criteriaSensor ? merged.criteriaSensor : null,
                    cluster_ranges: merged.criteriaSensor ? (merged.clusterRanges ?? []).slice(0, effClusters) : null,
                    filter,
                });
                result = { kind: 'clustering', preview: r };
            }
            if (workspaceIdRef.current !== capturedWorkspaceId) return; // abandoned — see comment above
            setTrainResults(prev => ({ ...prev, [id]: { fingerprint, result } }));
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            // The Relationship fit is now in Rust's cache under this key: make the
            // health preview (re)fetch even if its request is byte-identical.
            setHealthRevision(r => r + 1);
            if (opts.persistMeta) {
                await persist((models, groups) => ({
                    groups,
                    // `status: false` too: a (re-)train always lands the model in
                    // Incomplete/Trained — an old-data Complete model that was out of date
                    // must not silently turn Complete again just because its fingerprint
                    // now matches; it is marked complete again explicitly.
                    models: models.map(x => x.id === id ? { ...x, status: false, lastTrainedAt: new Date().toISOString(), trainedFingerprint: fingerprint } : x),
                }));
            }
        } catch (e) {
            if (workspaceIdRef.current !== capturedWorkspaceId) return; // abandoned — see comment above
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            setTrainError(prev => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
        }
    };

    /** The footer's Train/Re-train button. Commits any pending draft edits
     *  FIRST (same as "Open full view" already does via `buildModel` ->
     *  `commitModel`) so a predictor/stiffness/etc. change made just before
     *  clicking Train is what actually gets trained and fingerprinted —
     *  never a stale, unsaved combination. Only actually MERGES the draft
     *  into the trained/fingerprinted model when a draft is genuinely
     *  pending for it (QA fix, 2026-09-29 — "Train never sticks for some
     *  models"): `draftFields`/`draftFromModel` re-derive/re-snap fields
     *  (e.g. `snapStiffness`, or defaulting `clusterRanges` off the DEFAULT
     *  when the model never had any) even with nothing to commit, which
     *  could fingerprint a value that doesn't match what's actually stored —
     *  stale the instant Train finishes, forever. With no pending draft,
     *  train against the persisted `m` directly, unmodified. */
    const runTrainClick = async (m: FailureModel) => {
        if (buildBlockReason(m) !== null) return;
        if (trainStatus[m.id] === 'loading') return;
        const hasDraft = m.id in drafts;
        const merged = effectiveModelFor(m); // = m untouched when no draft is pending
        if (hasDraft) await commitModel(m);
        const fingerprint = computeTrainFingerprint(merged, gateFg);
        await executeTrain(merged, fingerprint, { persistMeta: true });
    };

    // (`NOT_TRAINED_BLOCK_REASON` — the text shown, and the reason
    // `markModelComplete` blocks on, when the gate passes but the model is not
    // Trained-and-fresh — lives in `utils/modelStatus.ts` so the PM page's
    // Finish path, the Workbench's "✓ Mark complete" title and the health-score
    // Mark complete share one wording.)

    // ---- Set points + Mark complete (health score 3b-2) ----
    /** The model's PERSISTED set points, brought up to date: the right empty shape
     *  for its kind, and (Individual) the first-open snapshot of the sensor's
     *  master-data L/H prefilled - derived here so the very first render already shows
     *  it; `setPointsSeed` below writes it once. Never overwrites a value the user
     *  entered. `loading` = metadata not hydrated yet: no snapshot is taken then. */
    const persistedSetPointsOf = (m: FailureModel): HealthSetPoints =>
        ensureHealthSetPoints(m, loading ? undefined : (sensorMetadata ?? [])).healthSetPoints as HealthSetPoints;
    /** What the Health score page shows and previews: the draft being typed, else the persisted ones. */
    const setPointsOf = (m: FailureModel): HealthSetPoints => spDrafts[m.id] ?? persistedSetPointsOf(m);

    /** Every edit of a set point (typing, stepper, quick button, reset to master).
     *  Updates the draft at once; `commit` also persists right away (a discrete
     *  action has nothing more to type). Editing never changes status and never makes
     *  the model stale. */
    const changeSetPoints = (m: FailureModel, next: HealthSetPoints, commit?: boolean) => {
        writeSpDrafts({ ...spDraftsRef.current, [m.id]: next });
        // The refusal Rust gave for the previous values no longer describes these.
        setAttemptIssues(prev => (prev[m.id] ? { ...prev, [m.id]: null } : prev));
        if (commit) void commitSetPointDrafts();
    };

    /** The ONE way a model becomes Complete: `completeModel` (validate the set
     *  points -> `export_model_files`, all-or-nothing) and only then
     *  `persistModelComplete` (`status: true` + the validated set points + the export
     *  record, in one write, gate + "trained and fresh" re-checked against what is on
     *  disk). Returns `null` on success, otherwise the reason it was not marked
     *  (also shown on the Health score page). Never throws; guarded against a
     *  double click (a Relationship export re-runs the sidecar for ~15 s). */
    const runMarkComplete = async (m: FailureModel, disk?: { fg: RunningConditionFg }): Promise<string | null> => {
        // `disk`: the model and workspace slice were just read from DISK (the PM page's
        // Finish: its own edits may not have reached this window's copy yet) - judge those,
        // not this window's possibly lagging state, and use the SAVED set points.
        const fg: RunningConditionFg = disk?.fg ?? gateFg;
        const model = disk ? m : effectiveModelFor(m);
        const ws = workspaceIdRef.current;
        if (!ws) return 'No workspace is open.';
        if (completeRunningRef.current.has(m.id)) return 'Saving is already in progress.';
        const id = m.id;
        const fail = (message: string, issues: HealthIssue[] | null = null): string => {
            setSaveInfo(prev => ({ ...prev, [id]: { phase: 'error', message } }));
            if (issues) setAttemptIssues(prev => ({ ...prev, [id]: issues }));
            return message;
        };
        // Nothing is written for a model that is not allowed to be Complete anyway:
        // the gate, and "trained and still fresh" (the same rules `persistModelComplete`
        // re-checks against the disk inside its write).
        const notAllowed = getBuildBlockReason(model, fg, gateHeaders)
            ?? (trainedFreshFor(model, fg) ? null : (isModelStaleFor(model, fg) ? 'Settings changed — re-train first.' : NOT_TRAINED_BLOCK_REASON));
        if (notAllowed !== null) return fail(notAllowed);
        completeRunningRef.current.add(m.id);
        setSaveInfo(prev => ({ ...prev, [id]: { phase: 'running', slow: m.kind === 'relationship' } }));
        setAttemptIssues(prev => ({ ...prev, [id]: null }));
        try {
            const sp = disk ? (spDraftsRef.current[id] ?? persistedSetPointsOf(m)) : setPointsOf(m);
            const res = await completeModel({
                model,
                fg,
                headers: gateHeaders,
                workspaceId: ws,
                setPoints: sp,
                expectedGeneration: generation,
            });
            if (workspaceIdRef.current !== ws) return 'The workspace changed.';
            if (!res.ok) {
                if (res.reason === 'validation') return fail('Some set points are not valid — fix them in Checks first.', res.issues);
                if (res.code === 'NOT_FITTED') return fail('Re-train first — the fitted Relation model is no longer in memory.');
                if (res.code === 'STALE_SESSION') return fail('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
                return fail(res.error ?? 'The model could not be saved.');
            }
            const record = { at: new Date().toISOString(), outputDir: res.outputDir, setPoints: res.setPoints };
            const persisted: { reason: string | null } = { reason: null };
            await trackPending((async () => {
                const r = await persistModelComplete(ws, id, res.setPoints, gateHeaders, 'build-model', record);
                persisted.reason = r.reason;
                if (workspaceIdRef.current === ws && r.next?.failureGroupState) applyFg(r.next.failureGroupState);
            })());
            if (persisted.reason !== null) return fail(`The files were written, but the model was not marked complete: ${persisted.reason}`);
            // What was typed is now what is on disk.
            if (spDraftsRef.current[id] !== undefined && sameSetPoints(spDraftsRef.current[id], res.setPoints)) {
                const rest = { ...spDraftsRef.current };
                delete rest[id];
                writeSpDrafts(rest);
            }
            setSaveInfo(prev => ({ ...prev, [id]: { phase: 'ok', outputDir: res.outputDir, files: res.files.map(f => ({ file_name: f.file_name, path: f.path })), at: record.at } }));
            return null;
        } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
        } finally {
            completeRunningRef.current.delete(id);
        }
    };

    /** The PM page's "Finish" button. It can no longer mark a model Complete by
     *  itself: it runs the same flow as the Health score page's "Mark complete"
     *  (so the model's files are written) using the model's SAVED set points. When
     *  that is not possible (set points still empty, not trained ...), the model stays
     *  Incomplete, the reason is shown on the overview and the model is opened on
     *  its Health score page. (Phase 4 removes this page and button.) */
    const markModelComplete = async (modelId: string): Promise<void> => {
        const m = allModels.find(x => x.id === modelId);
        if (!m || !workspaceId) return;
        setCompleteBlock(null);
        // The PM page flushed its own edits to disk just before calling this: read what is
        // really there (this window's copy may still be one broadcast behind).
        let onDisk: FailureGroupStateSlice | undefined;
        try { onDisk = (await loadWorkspaceData(workspaceId))?.failureGroupState; } catch { onDisk = undefined; }
        const fresh = onDisk?.models?.find(x => x.id === modelId);
        const reason = onDisk && fresh ? await runMarkComplete(fresh, { fg: onDisk }) : await runMarkComplete(m);
        if (reason === null) return;
        setCompleteBlock(reason);
        const key = modelSensorKey(m);
        setSelectedSensorKey(key);
        setActiveTab(prev => ({ ...prev, [key]: m.id }));
        if (healthPageBlock(m) === null) setPage(m, 'health');
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
    // 🆕 2026-09-30: `flushFocusedInput()` first, so a half-typed Running
    // Condition period date (blur/Enter-committed only, see that function's
    // own comment) is forced to commit — and lands in `pendingSaveRef` below
    // — even if this button click didn't happen to blur it naturally first.
    const handleClose = async () => {
        flushFocusedInput();
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
            // 🆕 2026-09-30: same reasoning as `handleClose` above — a native
            // close (titlebar X, Alt+F4, OS shutdown) must not be able to
            // bypass a period edit that never naturally blurred. Read
            // `pmPending`/`pending` AFTER this, not before, so a write this
            // call itself just kicked off is included below.
            flushFocusedInput();
            // A set-point draft typed but never blurred is a pending write too.
            void commitSetPointDrafts();
            const pmPending = pmFlushRef.current;
            const pending = pendingSaveRef.current;
            if (!pmPending && !pending) return;
            event.preventDefault();
            await flushAllPending();
            await win.close();
        })).then(fn => { if (disposed) fn(); else unlisten = fn; });
        return () => { disposed = true; if (unlisten) unlisten(); };
    }, [flushAllPending, commitSetPointDrafts]);

    // 🆕 2026-09-18 [bug fix]: must await commitModel's write landing on disk
    // before navigating to the PM page — else the PM page's own hydration
    // effect (which reads the workspace file directly) can win the race and
    // load the model record from BEFORE this commit.
    const buildModel = async (m: FailureModel) => {
        if (buildBlockReason(m) !== null) return;
        await commitModel(m);
        trainModel(m.id);
    };

    // Hoisted above the `if (loading)` guard (and therefore above every hook
    // below it) so `individualChartQuery`/the auto-recompute effect can read
    // `activeModel` — every hook in this component must run unconditionally
    // on every render, so none of them can sit after an early return. These
    // three lines are otherwise identical to the ones the render body below
    // used to compute locally; nothing about their VALUE changed, only where
    // they're computed.
    const sensorGroupsAll = allSensorGroups(allModels);
    const fullSensorMap = new Map(sensorGroupsAll.map(sg => [sg.key, sg]));
    const detailModels = selectedSensorKey !== null ? (fullSensorMap.get(selectedSensorKey)?.models ?? []) : [];
    const orderedDetail = KIND_ORDER.flatMap(k => detailModels.filter(m => m.kind === k));
    const activeModel = orderedDetail.find(m => m.id === activeTab[selectedSensorKey ?? '']) ?? orderedDetail[0];

    // ---- Auto-recompute on reopen (Phase B, per explicit user decision) ---
    // A model that is already Trained-and-fresh (per the WORKSPACE'S
    // persisted `lastTrainedAt`/`trainedFingerprint`) shows its result
    // immediately, with no click required — this silently re-runs the same
    // read-only preview query in the background (cheap; same live query the
    // PM page already runs on every mount) whenever the Workbench doesn't yet
    // have a cached result for the CURRENT fingerprint (a fresh session, or
    // this exact model wasn't open before). 🆕 2026-10-04 (health score 3b-1):
    // this now ALSO runs for a Complete model — the Model fit page shows the
    // charts of a Complete model too, and a Relationship model's health preview
    // reads the fit that this run re-fills in Rust's cache after a reload. It
    // never persists anything (`persistMeta: false` — the fingerprint didn't
    // change, and `status` is never touched), and never fires while a run for
    // this model is already in flight.
    useEffect(() => {
        if (!activeModel) return;
        if (buildBlockReason(activeModel) !== null) return;
        const fp = computeTrainFingerprint(activeModel, gateFg);
        if (!activeModel.lastTrainedAt || activeModel.trainedFingerprint !== fp) return;
        const cached = trainResults[activeModel.id];
        if (cached && cached.fingerprint === fp) return;
        if (trainStatus[activeModel.id] === 'loading') return;
        void executeTrain(activeModel, fp, { persistMeta: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, activeModel?.trainedFingerprint, activeModel?.lastTrainedAt, activeModel?.status, activeModel?.category, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionNoneConfirmed]);

    // ---- Health preview + Sub-models for the ACTIVE model (health score 3b-1) ----
    // ONE `useHealthPreview` call feeds both pages of the detail pane: the bounded
    // series/stats Rust returns for the Model fit charts and (3b-2) the score of
    // the Health score page. It is given the DRAFT-merged model (same as Train),
    // so an unsaved edit that changes the training inputs makes it idle ("stale")
    // while the last data stays on screen under the "Out of date" overlay.
    const activeEffective = activeModel ? effectiveModelFor(activeModel) : null;
    const activeFingerprint = activeEffective ? computeTrainFingerprint(activeEffective, gateFg) : null;
    const activeStale = activeEffective ? isModelStaleFor(activeEffective, gateFg) : false;
    const activeTrainEntry = activeModel ? trainResults[activeModel.id] : undefined;
    const activeFitKey = activeEffective
        && activeEffective.kind === 'relationship'
        && activeEffective.scatterXSensor
        && activeEffective.predictorSensors.includes(activeEffective.scatterXSensor)
        ? activeEffective.scatterXSensor : undefined;
    // Only a model that was trained, is still current, has nothing blocking it and
    // whose last run did not fail is asked for a preview. A Relationship preview
    // ALSO needs its fit in Rust's cache — the Train / reopen run that filled it
    // under THIS fingerprint must have landed first (`NOT_FITTED` otherwise).
    const healthReady = !!activeModel && !!activeEffective?.lastTrainedAt && !activeStale
        && buildBlockReason(activeModel) === null
        && !trainError[activeModel.id]
        && trainStatus[activeModel.id] !== 'loading'
        && (activeModel.kind !== 'relationship' || activeTrainEntry?.fingerprint === activeFingerprint);
    const healthPreview = useHealthPreview({
        model: activeEffective,
        fg: gateFg,
        headers: gateHeaders,
        // The DRAFT set points being typed (else the persisted ones): the charts, the
        // score and Rust's validation follow typing (the hook debounces ~250 ms).
        // Set points are NOT part of the train fingerprint, so this never makes the
        // model stale.
        setPoints: activeModel ? setPointsOf(activeModel) : null,
        enabled: healthReady,
        xPredictor: activeFitKey,
        expectedGeneration: generation,
        revision: healthRevision,
    });

    // The last validate verdict Rust gave for the active model - drives the "Set points
    // needed" / "Fix set point" tab pills and the red dot (kept per model for the session).
    // A stale model's old data does not count.
    const activeVerdict: HealthVerdict | null = activeModel && !activeStale ? healthVerdict(healthPreview.data) : null;
    useEffect(() => {
        if (!activeModel || !activeVerdict) return;
        setHealthVerdicts(prev => (prev[activeModel.id] === activeVerdict ? prev : { ...prev, [activeModel.id]: activeVerdict }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, activeVerdict]);

    // First time an Individual model's Health score page opens: write the master-data
    // L/H snapshot (and its prefill) once, so it never moves again when master data
    // changes. Only when `ensureHealthSetPoints` actually changes something, never over
    // a value the user entered, never while a draft exists.
    useEffect(() => {
        if (loading || !activeModel || activeModel.kind !== 'individual') return;
        if (pageByModel[activeModel.id] !== 'health' || !activeModel.lastTrainedAt) return;
        if (setPointsSeededRef.current.has(activeModel.id) || spDraftsRef.current[activeModel.id]) return;
        const ensured = ensureHealthSetPoints(activeModel, sensorMetadata ?? []);
        if (ensured === activeModel || !ensured.healthSetPoints) return;
        setPointsSeededRef.current.add(activeModel.id);
        writeSpDrafts({ ...spDraftsRef.current, [activeModel.id]: ensured.healthSetPoints });
        void commitSetPointDrafts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, activeModel, pageByModel, sensorMetadata]);

    // Leaving the page or the model (page switch, another sensor or kind tab): persist
    // what was typed. No draft = nothing happens.
    useEffect(() => {
        void commitSetPointDrafts();
    }, [selectedSensorKey, activeTab, pageByModel, commitSetPointDrafts]);

    // "Compare predictors" — the shared Sub-models fits (cumulative predictor subsets).
    const subFilter = activeEffective && activeEffective.kind === 'relationship'
        ? buildPreviewFilterPayload(effectiveRunningCondition(activeEffective, gateFg), gateHeaders)
        : null;
    const subLambda = activeEffective ? relationshipLambda(activeEffective) : 0;
    const subModelFits = useSubModelFits({
        targetSensor: activeEffective?.kind === 'relationship' ? (activeEffective.targetSensor ?? '') : '',
        predictors: activeEffective?.kind === 'relationship' ? activeEffective.predictorSensors : NO_PREDICTORS,
        lambda: subLambda,
        filter: subFilter,
        blocked: !activeModel || buildBlockReason(activeModel) !== null,
        // The last step is the model's own fit: reuse it while it is current.
        reusable: activeTrainEntry && activeTrainEntry.result.kind === 'relationship' && activeTrainEntry.fingerprint === activeFingerprint && !activeStale
            ? activeTrainEntry.result.result : null,
        resetKey: `${activeModel?.id ?? ''}|${subLambda}|${JSON.stringify(subFilter)}`,
    });
    const openCompare = () => {
        setCompareOpen(true);
        if (!activeEffective || activeEffective.kind !== 'relationship' || activeEffective.predictorSensors.length === 0) return;
        if ((!subModelFits.subModels || subModelFits.stale) && !subModelFits.loading) void subModelFits.run();
    };

    // ---- Clustering cluster-range slider bounds (2026-09-30 port) ---------
    // Mirrors PredictiveModelBuild.tsx's own `criteriaStats` effect: fetches
    // `compute_sensor_stats` for the criteria sensor so the slider can span
    // its REAL data range instead of an abstract 0-100 scale. Draft-aware (the
    // criteria sensor and the training-scope filter both read through
    // `draftOf`/`effectiveModelFor`, same as the live fingerprint check
    // above) so editing the criteria picker or the Workspace/Custom switch
    // before Save still moves the slider immediately — decision #3 (SPEC
    // FINAL) says this uses "the model's own training-scope filter, same
    // scope Train uses", which for an unsaved draft edit IS the draft's
    // scope, not last-saved. `criteriaFilterKey` collapses everything that
    // could change the resolved filter payload into one string so the effect
    // doesn't need a long, easy-to-miss dependency list of individual draft
    // sub-fields.
    const criteriaSensorForActive = (activeModel && activeModel.kind === 'clustering') ? draftOf(activeModel).criteria : '';
    const criteriaFilterKey = useMemo(() => {
        if (!activeModel || activeModel.kind !== 'clustering' || !criteriaSensorForActive) return '';
        const merged = effectiveModelFor(activeModel);
        const eff = effectiveRunningCondition(merged, gateFg);
        return JSON.stringify(buildPreviewFilterPayload(eff, gateHeaders));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, drafts, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionNoneConfirmed, gateHeaders]);
    useEffect(() => {
        // 🆕 2026-09-30 QA fix (bug 1): `criteriaStats` is ONE piece of state
        // shared by every model (scoped to whichever model is active, not
        // per-model) — it used to only get cleared when there's no criteria
        // sensor at all, so switching to a DIFFERENT clustering model (or
        // sensor) while a fetch is in flight left the PREVIOUS model's
        // resolved stats sitting there: the slider rendered with the wrong
        // [min, max] (and a live handle a drag could write onto the wrong
        // scale) until the new fetch happened to land. Reset unconditionally
        // at the top, before the early-return AND before kicking off a new
        // fetch, so every model/sensor change shows the loading state until
        // its OWN stats resolve.
        setCriteriaStats(null);
        if (!activeModel || activeModel.kind !== 'clustering' || !criteriaSensorForActive) {
            return;
        }
        let cancelled = false;
        const filter = criteriaFilterKey ? JSON.parse(criteriaFilterKey) : null;
        invoke<SensorStats>('compute_sensor_stats', { sensor: criteriaSensorForActive, filter })
            .then(s => { if (!cancelled) setCriteriaStats(s); })
            .catch(() => { if (!cancelled) setCriteriaStats(null); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, criteriaFilterKey]);

    // ---- Clustering auto-divide (2026-09-30 QA fix, bug 2) -----------------
    // The PM page auto-divides `clusterRanges` across the criteria sensor's
    // REAL [min, max] whenever the criteria sensor or the cluster count
    // changes (`PredictiveModelBuild.tsx`'s own `divisionKey` effect). The
    // Workbench port (above) carried the slider's RENDERING but not this
    // effect, so picking a criteria sensor on a Dashboard-created model left
    // the abstract 0-100 default ranges in place — on a sensor whose real
    // data is e.g. 500-900, every segment collapses to the left edge, and
    // the handles can't fix it (each is clamped between its neighbours, and
    // there's no handle at all for the outer min/max). The +/- cluster-count
    // stepper had the same gap: it changed `numClusters` alone, with nothing
    // keeping `ranges.length` in sync, so Train could send N-1 or N+1
    // `cluster_ranges` for `n_clusters: N`.
    //
    // Ported with one deliberate difference from the PM page's own version:
    // the PM page's `prevDivisionKeyRef` starts at `''`, so the very first
    // time ANY already-configured model's stats resolve, it unconditionally
    // recomputes (and — on the PM page, which has no separate draft concept
    // — immediately WRITES) an equal division, discarding whatever
    // (possibly intentional, non-equal) ranges were already saved. Doing
    // that literally here would create a phantom, unprompted DRAFT (and
    // "Unsaved changes" state) on every already-configured clustering model
    // the instant its stats finish loading, merely from opening it — and
    // would overwrite an already-correct saved custom split with a fresh
    // equal one. Anchoring the "previous key" on the PERSISTED model's own
    // (criteria, numClusters) pair instead means this only fires once the
    // draft has actually DIVERGED from what's saved — which can only happen
    // via `patchDraft` (the criteria picker or the +/- stepper), i.e. a real
    // user edit — or the array length itself is out of sync with
    // `numClusters` (legacy/mismatched data), which self-heals immediately
    // either way.
    const persistedClusterKeyForActive = (activeModel && activeModel.kind === 'clustering')
        ? `${activeModel.criteriaSensor ?? ''}::${activeModel.numClusters ?? 3}`
        : '';
    const numClustersForActive = (activeModel && activeModel.kind === 'clustering') ? draftOf(activeModel).numClusters : 0;
    const clusterRangesLenForActive = (activeModel && activeModel.kind === 'clustering') ? draftOf(activeModel).ranges.length : 0;
    const prevClusterDivisionKeyRef = useRef<Record<string, string>>({});
    useEffect(() => {
        if (!activeModel || activeModel.kind !== 'clustering' || !criteriaSensorForActive) return;
        if (numClustersForActive <= 0) return;
        const divisionKey = `${criteriaSensorForActive}::${numClustersForActive}`;
        const prevKey = prevClusterDivisionKeyRef.current[activeModel.id] ?? persistedClusterKeyForActive;
        const keyChanged = divisionKey !== prevKey;
        const lengthMismatch = clusterRangesLenForActive !== numClustersForActive;
        if (!keyChanged && !lengthMismatch) return;
        // Wait for real stats unless the length is already wrong — there's
        // no valid range set to show in the meantime for a mismatch, so it
        // can't wait (same tradeoff the PM page's own effect makes).
        if (!criteriaStats && !lengthMismatch) return;
        prevClusterDivisionKeyRef.current[activeModel.id] = divisionKey;
        const lo = criteriaStats?.min ?? 0;
        const hi = criteriaStats?.max ?? 100;
        const step = (hi - lo) / numClustersForActive;
        const ranges = Array.from({ length: numClustersForActive }, (_, i) => ({
            min: lo + step * i,
            max: lo + step * (i + 1),
        }));
        patchDraft(activeModel, { ranges });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, numClustersForActive, clusterRangesLenForActive, criteriaStats, persistedClusterKeyForActive]);

    // ---- Running condition: row-count previews (2026-10-03) ----
    // Two instances of the same hook: one for the PERSISTED condition (the
    // Step-1 card) and one for the modal's DRAFT (what Apply would commit).
    // They share a cache, so opening the modal on an unedited draft costs no
    // query, and the draft one waits for typing to settle.
    const rowCountCache = useRef(new Map<string, number>());
    const rcCountSensor = allSensors[0] ?? null;
    const persistedCountFilter = useMemo(
        () => buildPreviewFilterPayload(
            { filters: runningConditionFilters, combine: runningConditionCombine, noneConfirmed: runningConditionNoneConfirmed, periods: runningConditionTimePeriods },
            gateHeaders,
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [runningConditionFilters, runningConditionCombine, runningConditionNoneConfirmed, runningConditionTimePeriods, allSensors],
    );
    const draftCountFilter = useMemo(
        () => buildPreviewFilterPayload(
            rcDraft ?? { filters: runningConditionFilters, combine: runningConditionCombine, noneConfirmed: runningConditionNoneConfirmed, periods: runningConditionTimePeriods },
            gateHeaders,
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [rcDraft, runningConditionFilters, runningConditionCombine, runningConditionNoneConfirmed, runningConditionTimePeriods, allSensors],
    );
    const persistedPeriodsInvalid = validatePeriods(runningConditionTimePeriods).some(st => st.invalid);
    const draftPeriodsInvalid = validatePeriods((rcDraft ?? { periods: runningConditionTimePeriods }).periods).some(st => st.invalid);
    const persistedRows = useRowCountPreview({
        enabled: !loading && activePage === 'overview' && rcConfigured && !persistedPeriodsInvalid,
        workspaceId, sensor: rcCountSensor, filter: persistedCountFilter, cache: rowCountCache,
    });
    const draftRows = useRowCountPreview({
        enabled: !loading && rcFilterOpen && !draftPeriodsInvalid,
        workspaceId, sensor: rcCountSensor, filter: draftCountFilter, cache: rowCountCache, debounceMs: 300,
    });

    // Esc closes the Running condition modal — through the same dirty-draft
    // guard as X / backdrop. Registered in the CAPTURE phase and ignored while a
    // nested sensor picker is open: that picker closes itself on Esc (its own
    // window listener), and by the time a bubble-phase listener of ours ran,
    // React may already have unmounted it, so this one Esc would close both.
    useEffect(() => {
        if (!rcFilterOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            if (document.querySelector('.predictor-picker-backdrop')) return;
            requestCloseRc();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [rcFilterOpen, requestCloseRc]);

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
    }

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModelsCount = allModels.length;
    const completeModelsCount = allModels.filter(isModelDone).length;

    const sensorBuildBlocked = (sg: SensorModelGroup) => sg.models.some(m => buildBlockReason(m) !== null);
    const sensorAllComplete = (sg: SensorModelGroup) => sg.models.length > 0 && sg.models.every(isModelDone);
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

    /** The status of one model for the left list's dot / the tab pill. A failed
     *  run of this session overrides an otherwise "trained" model. */
    const dotStateOf = (m: FailureModel): ModelDotState => {
        const st = modelDotState(effectiveModelFor(m), gateFg, gateHeaders);
        return st === 'trained' && trainError[m.id] ? 'stale' : st;
    };

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
                    {ordered.map(m => {
                        // Status dot in the badge's corner (mockup `.kb[data-st]`), straight
                        // from the ONE status rule (`modelDotState`, draft-aware):
                        //   green  complete          (marked complete AND up to date)
                        //   yellow needs input       (trained, waiting for set points / re-train;
                        //                             incl. a Complete model whose inputs changed)
                        //   red    needs fixing      (the gate blocks it: no category / running
                        //                             condition / bad period)
                        //   none   never trained, nothing wrong yet
                        // A run that failed in THIS session never reads as "trained": it is
                        // yellow ("needs input") like any other model that wants a re-train.
                        const st = dotStateOf(m);
                        // A trained model whose set points Rust rejected reads red ("Fix set point").
                        const fixSetPoint = st === 'trained' && healthVerdicts[m.id] === 'bad';
                        const dot = fixSetPoint ? 'bad' : DOT_CLASS[st];
                        return (
                            <span
                                key={m.id}
                                data-testid={`sensor-kind-badge-${m.id}`}
                                className={`f4-kb model-kind-icon--${m.kind}`}
                                title={`${KIND_LABEL[m.kind]} · ${fixSetPoint ? 'Fix set point' : DOT_TITLE[st]}`}
                            >
                                {KIND_ABBREV[m.kind]}
                                {dot && <span data-testid={`sensor-kind-badge-dot-${m.id}`} data-state={st} className={`f4-kb-dot f4-kb-dot--${dot}`} aria-hidden="true" />}
                            </span>
                        );
                    })}
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

    // ---- Detail pane (Phase A) ---- `detailModels`/`orderedDetail`/
    // `activeModel` are computed above (before the `if (loading)` guard —
    // every hook needs them, see the comment there); reused here as-is.

    /** Cluster-range slider (2026-09-30 port of PredictiveModelBuild.tsx's
     *  own ~L2862-3013) — colored `CLUSTER_PALETTE` segments spanning the
     *  criteria sensor's REAL [min, max] (`criteriaStats`, fetched by the
     *  effect above), N-1 draggable boundary handles, read-only value pills
     *  below. Drag reads/writes through `patchDraft` (the draft, not
     *  component state, per this window's own edit model) — `startSplitDrag`
     *  re-reads `draftOf(m).ranges` on every mousemove rather than closing
     *  over a stale `d.ranges` snapshot from the render that started the
     *  drag, since a drag session outlives any single render. Only ever
     *  called for the CURRENTLY ACTIVE model (via `renderModelSettingsFields`
     *  below), so `criteriaStats` (scoped to `activeModel`) is always the
     *  right sensor's stats for whichever `m`/`d` this renders. */
    const renderClusterRangeSlider = (m: FailureModel, d: ModelDraft) => {
        const disabled = d.numClusters <= 1 || !d.criteria;
        if (disabled) {
            return (
                <div className="pm-cluster-slider pm-cluster-slider--empty" data-testid="cluster-slider-empty">
                    {d.numClusters <= 1
                        ? 'One cluster — every row goes in. No ranges to set.'
                        : !d.criteria
                        ? 'Pick a criteria sensor above to define cluster ranges.'
                        : '—'}
                </div>
            );
        }
        if (!criteriaStats) {
            return (
                <div className="pm-cluster-slider pm-cluster-slider--empty" data-testid="cluster-slider-loading">
                    <Loader2 size={12} className="pm-spin" aria-hidden="true" /> Loading {sensorLabel(d.criteria)} range…
                </div>
            );
        }
        if (criteriaStats.min === criteriaStats.max) {
            return (
                <div className="pm-cluster-slider pm-cluster-slider--empty" data-testid="cluster-slider-constant">
                    {sensorLabel(d.criteria)} has a constant value ({criteriaStats.min}) — cannot partition.
                </div>
            );
        }
        const lo = criteriaStats.min;
        const hi = criteriaStats.max;
        const span = hi - lo;
        const fmt = (v: number | null) =>
            v == null ? '—' : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3);
        const pctOf = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
        const ranges = d.ranges;

        const startSplitDrag = (idx: number, e: React.MouseEvent) => {
            e.preventDefault();
            const track = (e.currentTarget.parentElement) as HTMLDivElement | null;
            if (!track) return;
            const rect = track.getBoundingClientRect();
            const onMove = (moveEvt: MouseEvent) => {
                const x = moveEvt.clientX - rect.left;
                const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
                const value = lo + (pct / 100) * span;
                const current = draftOf(m).ranges;
                const leftBound = current[idx]?.min ?? lo;
                const rightBound = current[idx + 1]?.max ?? hi;
                const eps = span * 0.001;
                const clamped = Math.max(leftBound + eps, Math.min(rightBound - eps, value));
                const next = current.map((r, i) => {
                    if (i === idx) return { ...r, max: clamped };
                    if (i === idx + 1) return { ...r, min: clamped };
                    return r;
                });
                patchDraft(m, { ranges: next });
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        return (
            <div className="pm-cluster-slider" data-testid="cluster-slider">
                <div className="pm-cluster-slider-header">
                    <span className="pm-cluster-slider-bound">{fmt(lo)}</span>
                    <span className="pm-cluster-slider-sensor">{d.criteria}</span>
                    <span className="pm-cluster-slider-bound">{fmt(hi)}</span>
                </div>
                <div className="pm-cluster-slider-track">
                    {ranges.map((r, i) => {
                        const segLo = r.min ?? lo;
                        const segHi = r.max ?? hi;
                        const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
                        return (
                            <div
                                key={`seg-${i}`}
                                className="pm-cluster-slider-segment"
                                style={{ left: `${pctOf(segLo)}%`, width: `${pctOf(segHi) - pctOf(segLo)}%`, background: color }}
                                title={`Cluster ${i + 1}: ${fmt(segLo)} – ${fmt(segHi)}`}
                            >
                                <span className="pm-cluster-slider-seg-label">#{i + 1}</span>
                            </div>
                        );
                    })}
                    {ranges.slice(0, -1).map((r, i) => {
                        const splitVal = r.max ?? hi;
                        return (
                            <div
                                key={`handle-${i}`}
                                className="pm-cluster-slider-handle"
                                style={{ left: `${pctOf(splitVal)}%` }}
                                onMouseDown={e => startSplitDrag(i, e)}
                                role="slider"
                                aria-label={`Split between cluster ${i + 1} and ${i + 2}`}
                                aria-valuemin={lo}
                                aria-valuemax={hi}
                                aria-valuenow={splitVal}
                                title={`${fmt(splitVal)}`}
                            />
                        );
                    })}
                </div>
                <div className="pm-cluster-slider-values">
                    {ranges.map((r, i) => {
                        const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
                        return (
                            <span key={`pill-${i}`} className="pm-cluster-slider-pill">
                                <span className="pm-cluster-range-dot" style={{ background: color }} />
                                #{i + 1}: {fmt(r.min)} – {fmt(r.max)}
                            </span>
                        );
                    })}
                </div>
            </div>
        );
    };

    const renderModelSettingsFields = (m: FailureModel, d: ModelDraft) => (
        <>
            {/* 🆕 2026-09-30 (issue 2/3 fix): a fixed, generous width shared by
                all three kinds — was `minWidth: 200px` with no cap, which let
                a long real sensor name (e.g. "GENERATOR BEARING METAL
                TEMPERATURE") render far narrower than its text, scrolling
                off-screen with no ellipsis/tooltip. `.f4-fld--name` (App.css)
                grows with available space up to a real cap instead. */}
            <div className="f4-fld f4-fld--name">
                <label>Model name</label>
                <input
                    className="fg-inspector-input"
                    value={d.name}
                    placeholder="e.g. Bearing vibration model"
                    title={d.name || undefined}
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

            {/* 🆕 2026-09-30 (issue 3 fix): every kind's OWN fields (as opposed
                to Model name / Training data, which are shared and always
                the same shape) live in one wrapping group so they read as a
                consistent block across Individual/Relationship/Clustering
                instead of each kind cramming a different field count into
                the same single flex row. `.bmw-sets-kind` (App.css) is
                itself flex-wrap, so Clustering's 4-5 fields fall onto a
                second line rather than being squeezed narrower than their
                content — see that class's own comment for the exact widths. */}
            <div className="bmw-sets-kind">
            {m.kind === 'individual' && (
                <div className="f4-fld">
                    <span className="f4-lbl">Boundary</span>
                    <span className="f4-pill f4-pill--grey" style={{ height: '28px', display: 'inline-flex' }}>1σ + 3σ · automatic</span>
                    <div className="f4-hint">Everything else is automatic for an Individual model.</div>
                </div>
            )}

            {m.kind === 'relationship' && (
                <>
                    <div className="f4-fld f4-fld--grow" style={{ flex: 1, minWidth: '260px' }}>
                        <span className="f4-lbl">Predictor sensors (≥ 1)</span>
                        <IncompleteHint />
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
                        <IncompleteHint />
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
                        <IncompleteHint />
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
                        <IncompleteHint />
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
                        <IncompleteHint />
                        <span className="bmw-step">
                            <button type="button" aria-label="Fewer clusters" onClick={() => patchDraft(m, { numClusters: Math.max(1, d.numClusters - 1) })}>−</button>
                            <span>{d.numClusters}</span>
                            <button type="button" aria-label="More clusters" onClick={() => patchDraft(m, { numClusters: Math.min(8, d.numClusters + 1) })}>+</button>
                        </span>
                    </div>
                    {/* 🆕 2026-09-30 [cluster-range slider port]: always shown
                        now (was `{d.criteria && (...)}` — hidden entirely with
                        no criteria sensor), matching the PM page's own
                        always-visible-with-empty-state behavior (SPEC/design
                        decision #3) — `renderClusterRangeSlider` covers every
                        empty state (no criteria sensor, N<=1, loading,
                        constant-value sensor) itself, same wording as the PM
                        page's own slider. */}
                    <div className="f4-fld f4-fld--grow">
                        <span className="f4-lbl">
                            Cluster ranges
                            {(d.numClusters <= 1 || !d.criteria) && (
                                <span className="pm-field-hint-inline"> · requires criteria sensor + N≥2</span>
                            )}
                        </span>
                        {renderClusterRangeSlider(m, d)}
                    </div>
                </>
            )}
            </div>

            {/* Always last, same fixed width in all three kinds (issue 3 fix) —
                `.f4-fld--traindata` (App.css). */}
            <div className="f4-fld f4-fld--traindata">
                <span className="f4-lbl">Training data</span>
                <IncompleteHint />
                <div className="f4-seg">
                    <button type="button" className={d.runningConditionMode === 'workspace' ? 'on' : undefined} onClick={() => switchRunningConditionMode(m, 'workspace')}>Workspace</button>
                    <button type="button" className={d.runningConditionMode === 'custom' ? 'on' : undefined} onClick={() => switchRunningConditionMode(m, 'custom')}>Custom</button>
                </div>
                {d.runningConditionMode === 'workspace' && (
                    <div className="f4-hint">Follows the workspace Running condition above.</div>
                )}
            </div>

            {/* 🆕 2026-09-30 [Custom running-condition editor port]: a direct
                port of PredictiveModelBuild.tsx's own Custom section (periods
                via TimePeriodsEditor, conditions via SensorPickerModal
                single+mutedTag, AND/OR via .f4-seg--andor, "No condition" via
                .f4-nofilter) — SPEC decision #2 says this is bound to the
                draft/Save-changes flow, unlike the PM page's own autosaved
                version, so every field below reads/writes `d`/`patchDraft`,
                never its own component state. Sibling of `.f4-fld--traindata`
                (not nested inside it — the narrow 170px field has no room for
                this), `flex: 1 1 100%` (App.css `.rc-custom`) so it wraps
                onto its own full-width row in flex mode, and spans every
                column in Clustering's grid mode. */}
            {d.runningConditionMode === 'custom' && (
                <div className="rc-custom" data-testid="custom-rc-editor">
                    {seedNoteFor[m.id] && (
                        <div data-testid="pm-seed-note" className="f4-seed">
                            <span>
                                Copied <b>{seedNoteFor[m.id]!.periods} period{seedNoteFor[m.id]!.periods === 1 ? '' : 's'}</b> and {seedNoteFor[m.id]!.conditions} condition{seedNoteFor[m.id]!.conditions === 1 ? '' : 's'} from Workspace. Edits here affect only this model.
                            </span>
                            <button type="button" className="f4-x" aria-label="Dismiss" onClick={() => setSeedNoteFor(prev => ({ ...prev, [m.id]: null }))}><X size={12} /></button>
                        </div>
                    )}

                    <div className="f4-side-blk" data-testid="custom-periods">
                        <div className="f4-slabel">
                            <span>Training periods <span className="f4-count">{d.customPeriods.length}</span></span>
                        </div>
                        <div className="rc-scroll">
                            <TimePeriodsEditor compact periods={d.customPeriods} onChange={periods => patchDraft(m, { customPeriods: periods })} bounds={datasetBounds} />
                        </div>
                    </div>

                    <div className="f4-side-blk">
                        <div className="f4-slabel">
                            <span>Running condition</span>
                            {!d.customNoneConfirmed && (
                                <div className="f4-seg f4-seg--andor" role="group" aria-label="Match">
                                    {(['and', 'or'] as const).map(mode => (
                                        <button
                                            key={mode}
                                            type="button"
                                            className={d.customCombine === mode ? 'on' : undefined}
                                            aria-pressed={d.customCombine === mode}
                                            onClick={() => patchDraft(m, { customCombine: mode })}
                                        >
                                            {mode.toUpperCase()}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {d.customNoneConfirmed ? (
                            <div className="f4-nofilter">
                                <span className="f4-pill f4-pill--ok">✓ No condition — all rows</span>
                                <div data-testid="custom-none-warning" className="f4-note" style={{ fontSize: '11px' }}>
                                    Idle periods stay in training.{d.customFilters.length > 0 && ' Saved conditions are kept but not applied.'}
                                </div>
                                <div className="f4-acts">
                                    <button type="button" className="f4-btn f4-btn--small" onClick={() => patchDraft(m, { customNoneConfirmed: false })}>Switch to conditions</button>
                                </div>
                            </div>
                        ) : (
                            <>
                                {d.customFilters.length === 0 && (
                                    <div role="alert" data-testid="custom-condition-required" className="f4-callout f4-callout--compact">
                                        <div><b>Required.</b> Add at least one condition, or confirm that this machine always runs.</div>
                                    </div>
                                )}
                                <div className="rc-scroll">
                                    {d.customFilters.map(f => (
                                        <div key={f.id} className="f4-cond f4-cond--compact">
                                            <div className="f4-cond-s">
                                                <SensorPickerModal
                                                    sensors={allSensors}
                                                    getDesc={getDesc}
                                                    getComponent={getComponent}
                                                    single
                                                    mutedTag
                                                    value={f.sensor}
                                                    onSelect={sensor => patchDraft(m, { customFilters: d.customFilters.map(x => x.id === f.id ? { ...x, sensor } : x) })}
                                                    noun="sensor"
                                                />
                                            </div>
                                            <select
                                                className="f4-cond-o"
                                                aria-label="Operator"
                                                value={f.operation}
                                                onChange={e => patchDraft(m, { customFilters: d.customFilters.map(x => x.id === f.id ? { ...x, operation: e.target.value as WorkspaceSensorFilter['operation'] } : x) })}
                                            >
                                                <option value="greater_than">&gt;</option>
                                                <option value="less_than">&lt;</option>
                                                <option value="between">between</option>
                                                <option value="equals">=</option>
                                            </select>
                                            <input
                                                type="number"
                                                className="f4-cond-v"
                                                value={f.value1}
                                                onChange={e => patchDraft(m, { customFilters: d.customFilters.map(x => x.id === f.id ? { ...x, value1: e.target.value } : x) })}
                                                placeholder="val"
                                            />
                                            {f.operation === 'between' && (
                                                <input
                                                    type="number"
                                                    className="f4-cond-v"
                                                    value={f.value2}
                                                    onChange={e => patchDraft(m, { customFilters: d.customFilters.map(x => x.id === f.id ? { ...x, value2: e.target.value } : x) })}
                                                    placeholder="max"
                                                />
                                            )}
                                            <button type="button" className="f4-x" onClick={() => patchDraft(m, { customFilters: d.customFilters.filter(x => x.id !== f.id) })} title="Remove condition" aria-label="Remove condition">
                                                <X size={11} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <div className="f4-acts">
                                    <button
                                        type="button"
                                        className="f4-btn f4-btn--small"
                                        disabled={allSensors.length === 0}
                                        onClick={() => patchDraft(m, {
                                            customNoneConfirmed: false,
                                            customFilters: [...d.customFilters, {
                                                id: `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                                                sensor: allSensors[0] ?? '', operation: 'greater_than', value1: '', value2: '',
                                            }],
                                        })}
                                    >
                                        + Add condition
                                    </button>
                                    <button type="button" className="f4-btn f4-btn--plain f4-btn--small" onClick={() => patchDraft(m, { customNoneConfirmed: true })}>No condition — use all rows</button>
                                </div>
                            </>
                        )}
                    </div>
                    <div className="f4-foot-note">Only this model · the workspace default is untouched.</div>
                </div>
            )}
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
                    <div
                        data-testid="add-model-form"
                        className={`bmw-sets-body${m.kind === 'clustering' ? ' bmw-sets-body--clustering' : ''}`}
                    >
                        {renderModelSettingsFields(m, d)}
                    </div>
                )}
            </div>
        );
    };

    /** The pill on a kind tab: the central status (`modelDotState`), refined for a
     *  trained model by the last verdict Rust gave on its set points. */
    const tabPillOf = (m: FailureModel, st: ModelDotState): { text: string; cls: string } | null => {
        if (st === 'trained') {
            const v = healthVerdicts[m.id];
            if (v === 'bad') return { text: 'Fix set point', cls: 'f4-pill--bad' };
            if (v === 'needs') return { text: 'Set points needed', cls: 'f4-pill--warn' };
        }
        return TAB_PILL[st];
    };

    /** Props the two pages share (`WorkbenchPageProps`) for the ACTIVE model. */
    const pagePropsFor = (m: FailureModel) => {
        const eff = effectiveModelFor(m);
        const unitTag = (m.kind === 'clustering' ? m.ySensor : m.targetSensor) ?? '';
        return {
            model: eff,
            stale: isModelStale(m),
            preview: healthPreview,
            unit: unitTag ? getUnit(unitTag) : '',
            sensorLabel,
            getDesc,
        };
    };

    /** Which page of the detail pane a model shows. The Health score page is only
     *  ever shown for a model that was trained and is up to date (it reads the
     *  trained fit); otherwise the stored choice is ignored, not erased. */
    const pageOf = (m: FailureModel): WorkbenchPage => {
        const want = pageByModel[m.id] ?? 'model';
        return want === 'health' && (isModelStale(m) || !m.lastTrainedAt) ? 'model' : want;
    };
    const setPage = (m: FailureModel, page: WorkbenchPage) => setPageByModel(prev => (prev[m.id] === page ? prev : { ...prev, [m.id]: page }));
    /** Why the Health score page (and the "Health set points" / "Complete" steps)
     *  cannot be opened right now, or null. */
    const healthPageBlock = (m: FailureModel): string | null =>
        isModelStale(m) ? 'Re-train first'
            : !m.lastTrainedAt ? 'Train the model first'
            : buildBlockReason(m) !== null ? 'Fix the settings first'
            // The last run of THIS session failed: the numbers on screen are not trustworthy.
            : trainError[m.id] ? 'Re-train first'
            : null;

    /** The Model fit page body — the old "results area" state machine, now ending
     *  in the charts of `ModelFitPage`:
     *  Complete without a train record -> placeholder · incomplete config/gate ->
     *  "N items to fix" list with jump-to-field links (reuses `missingItems`'
     *  wording) · running -> progress · never trained -> "Not trained yet" ·
     *  stale -> "Out of date" charts (or a message when there is nothing to
     *  draw) · Relationship fit gone from memory -> "Re-train to recompute" ·
     *  otherwise the charts. */
    const renderModelFitBody = (m: FailureModel) => {
        const reason = buildBlockReason(m);
        if (isModelDone(m) && (reason !== null || !m.lastTrainedAt)) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-placeholder">
                        Marked complete — train the model to see its charts.
                    </div>
                </div>
            );
        }
        if (reason !== null) {
            // Step 1 not done (2026-10-03): a model that FOLLOWS the workspace
            // condition is locked until the workspace running condition is
            // set / fixed — say that first, with a button straight into the
            // settings. A model on its own Custom condition is not affected by
            // the workspace one, so it keeps the plain list below.
            const gr = gateReasonOf(m);
            const wsLocked = gr !== null && categoryOf(m) !== null
                && effectiveModelFor(m).runningConditionMode !== 'custom'
                && (rcStepState !== 'set');
            const items = incompleteItems(m).filter(it => !(wsLocked && it.text === gr));
            return (
                <div className="bmw-stage" style={wsLocked ? { flexDirection: 'column', gap: '12px' } : undefined}>
                    {wsLocked && (
                        <div className="bmw-stage-empty bmw-stage-lock" data-testid="results-rc-locked">
                            <Lock size={22} aria-hidden="true" />
                            <div>
                                <b>{rcStepState === 'invalid' ? 'Fix the running condition first' : 'Set the running condition first'}</b>
                                <span>Training is locked until Step 1 is done.</span>
                            </div>
                            <button type="button" className="rcx-btn" data-testid="results-rc-locked-open" onClick={() => setRcFilterOpen(true)}>
                                {rcStepState === 'invalid' ? 'Fix period' : 'Set running condition'}
                            </button>
                        </div>
                    )}
                    {items.length > 0 && (
                        <div className="bmw-stage-empty" data-testid="results-incomplete" style={{ textAlign: 'left', alignItems: 'flex-start' }}>
                            <div style={{ fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>
                                {items.length} item{items.length === 1 ? '' : 's'} to fix before training
                            </div>
                            <ul style={{ margin: 0, paddingLeft: '18px' }}>
                                {items.map((it, i) => (
                                    <li key={i}>
                                        <button type="button" className="bmw-fix-link" onClick={it.onClick}>{it.text}</button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            );
        }
        if (trainStatus[m.id] === 'loading') {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-loading">
                        <Loader2 size={20} className="pm-spin" aria-hidden="true" /> Running…
                    </div>
                </div>
            );
        }
        const err = trainError[m.id];
        if (err) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-error" style={{ color: 'var(--warn)' }}>
                        Couldn't compute the preview: {err}
                    </div>
                </div>
            );
        }
        if (!m.lastTrainedAt) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-placeholder">Not trained yet</div>
                </div>
            );
        }
        const props = pagePropsFor(m);
        if (props.stale) {
            // The last charts of this session (if any) stay up under "Out of date".
            return healthPreview.data ? (
                <div data-testid="results-chart" data-stale="true">
                    <ModelFitPage {...props} data={healthPreview.data} onXPredictorChange={xSensor => changeScatterX(m.id, xSensor)} onCompare={openCompare} />
                </div>
            ) : (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-stale">Settings changed — re-train to see the result.</div>
                </div>
            );
        }
        if (healthPreview.notFitted) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-not-fitted">
                        <div>
                            <b style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '4px' }}>Re-train to recompute</b>
                            The fitted Relation model is no longer in memory (the data was reloaded or a special sensor changed).
                            <div style={{ marginTop: '10px' }}>
                                <button type="button" className="bmw-btn-retrain bmw-btn-retrain--stale" data-testid="results-not-fitted-retrain" onClick={() => runTrainClick(m)}>↻ Re-train</button>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }
        if (healthPreview.error && !healthPreview.data) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-health-error" style={{ color: 'var(--warn)' }}>
                        Couldn't load the charts: {healthPreview.error}
                    </div>
                </div>
            );
        }
        if (!healthPreview.data) {
            // Trained-and-fresh per the workspace's persisted fields, but the
            // auto-recompute / preview has not landed its first result in THIS
            // session yet.
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-loading">
                        <Loader2 size={20} className="pm-spin" aria-hidden="true" /> Loading the last result…
                    </div>
                </div>
            );
        }
        return (
            <div data-testid="results-chart">
                <ModelFitPage {...props} data={healthPreview.data} onXPredictorChange={xSensor => changeScatterX(m.id, xSensor)} onCompare={openCompare} />
            </div>
        );
    };

    /** Why Mark complete is not possible right now (the FIRST blocking reason), or
     *  null. Only the active model has a health preview, so this is for the active
     *  model. Rust's validation is the source of "set points not valid". */
    const markCompleteBlock = (m: FailureModel): string | null => {
        if (isModelStale(m)) return 'Settings changed — re-train first.';
        const gate = gateReasonOf(m);
        if (gate !== null) return gate;
        if (!trainedFreshFor(effectiveModelFor(m), gateFg)) return NOT_TRAINED_BLOCK_REASON;
        if (trainError[m.id]) return "Couldn't refresh the result — fix the problem, then re-train.";
        if (healthPreview.notFitted) return 'Re-train first — the fitted Relation model is no longer in memory.';
        const data = healthPreview.data;
        if (!data) return healthPreview.loading ? 'Checking the set points…' : (healthPreview.error ?? 'The health score could not be loaded.');
        if (healthPreview.loading) return 'Checking the set points…';
        if (!data.valid) {
            const issues = attemptIssues[m.id] ?? data.validation;
            const n = Math.max(1, buildCheckLines(data.kind, issues).length);
            return verdictOfIssues(issues) === 'bad'
                ? `${n} set point${n > 1 ? 's' : ''} not valid — fix before marking complete`
                : `${n} set point${n > 1 ? 's' : ''} still empty`;
        }
        return null;
    };

    /** What the Health score page says about the model's saved files. */
    const saveInfoFor = (m: FailureModel): SaveInfo =>
        saveInfo[m.id] ?? (m.healthExport && isModelDone(m)
            ? { phase: 'ok', outputDir: m.healthExport.outputDir, files: null, at: m.healthExport.at }
            : { phase: 'idle' });
    /** Complete, but the set points on screen differ from the ones the files were written with. */
    const filesOutOfDateFor = (m: FailureModel): boolean =>
        isModelDone(m) && !!m.healthExport && !sameSetPoints(m.healthExport.setPoints, setPointsOf(m));

    /** Footer of BOTH pages (mockup `.wd-foot`). Model fit: status · Open full
     *  view · Save changes · Re-train · "Next: Health score →" (NO Mark complete:
     *  a model is completed only from the Health score page).
     *  Health score: "← Model fit" · status / blocking reason · Mark complete
     *  ("Mark incomplete" once Complete). */
    const renderFooter = (m: FailureModel, page: WorkbenchPage) => {
        const saveReason = modelBlockReason(m);
        const reason = buildBlockReason(m);
        const cat = categoryOf(m);
        const trainedFresh = isModelTrainedFresh(m);
        const stale = isModelStale(m);
        const training = trainStatus[m.id] === 'loading';
        // 🆕 QA fix (2026-09-29): a run that failed IN THIS SESSION — whether
        // an explicit Re-train click or the silent auto-recompute on reopen —
        // must override the happy-path pill/footer/Mark-complete-enabled
        // state even though the PERSISTED fields still say "fresh" (nothing
        // was written back on failure). Mirrors how a failed MANUAL Train
        // already keeps the Train/Re-train button visible for retry without
        // touching persisted fields — this just extends the same "in-session
        // error overrides the happy path" treatment to the pill/footer text/
        // Mark complete, which previously only looked at `trainedFresh`.
        const hasSessionError = !!trainError[m.id];
        const pillState: 'complete' | 'trained' | 'incomplete' =
            isModelDone(m) ? 'complete' : (trainedFresh && !hasSessionError && reason === null) ? 'trained' : 'incomplete';
        const pillLabel = pillState === 'complete' ? 'Complete' : pillState === 'trained' ? 'Trained' : 'Incomplete';
        const healthBlock = healthPageBlock(m);
        const markBlock = page === 'health' ? markCompleteBlock(m) : null;
        const saving = saveInfo[m.id]?.phase === 'running';
        const outOfDate = page === 'health' && filesOutOfDateFor(m);
        return (
            <div className="f4-foot">
                {page === 'health' && (
                    <button type="button" className="f4-btn f4-btn--plain f4-btn--small" data-testid="footer-back-to-fit" onClick={() => setPage(m, 'model')}>
                        ← Model fit
                    </button>
                )}
                <span className={`model-status-pill model-status-pill--${pillState}`} style={{ cursor: 'default' }}>
                    {pillLabel}
                </span>
                {page === 'health' && saving ? (
                    <span data-testid="footer-status" className="f4-foot-reason">
                        <Loader2 size={11} className="pm-spin" aria-hidden="true" /> Saving results…
                    </span>
                ) : page === 'health' && !isModelDone(m) && markBlock !== null ? (
                    <span data-testid="mark-block-reason" className="f4-foot-reason f4-foot-reason--block">
                        <CircleAlert size={11} aria-hidden="true" />
                        {markBlock}
                    </span>
                ) : page === 'health' && !isModelDone(m) ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Set points valid — check the score, then mark complete</span>
                ) : reason ? (
                    <span data-testid="build-block-reason" className="f4-foot-reason f4-foot-reason--block">
                        <CircleAlert size={11} aria-hidden="true" />
                        {reason}
                    </span>
                ) : m.id in drafts ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Unsaved changes to the {KIND_LABEL[m.kind]} model</span>
                ) : isModelDone(m) ? (
                    <span data-testid="footer-status" className="f4-foot-reason">
                        {m.lastTrainedAt ? `Last trained ${formatTrainedAt(m.lastTrainedAt)}` : `${KIND_LABEL[m.kind]}${cat ? ` · ${CATEGORY_LABELS[cat]}` : ''}`}
                    </span>
                ) : hasSessionError ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Couldn't refresh the result — fix the problem, then re-train</span>
                ) : trainedFresh ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Check the chart, then mark it complete</span>
                ) : stale ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Settings changed — re-train</span>
                ) : (
                    <span data-testid="footer-status" className="f4-foot-reason">{KIND_LABEL[m.kind]}{cat ? ` · ${CATEGORY_LABELS[cat]}` : ''}</span>
                )}
                {page === 'model' && (
                    <>
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
                        {/* Train/Re-train — fixed position (SPEC FINAL footer rule 6): always
                            this same slot, never moves around based on state. Nothing renders
                            here at all once the model is Complete or Trained-and-fresh with no
                            error — there is nothing further to do until settings change. A
                            failed preview run (this session) still shows the button even
                            though the persisted fields still say "fresh", so there's always a
                            way to retry. */}
                        {!isModelDone(m) && !(reason === null && trainedFresh && !training && !trainError[m.id]) && (
                            <button
                                type="button"
                                className={reason !== null ? 'f4-btn f4-btn--plain f4-btn--small' : (stale || trainError[m.id]) ? 'bmw-btn-retrain bmw-btn-retrain--stale' : 'bmw-btn-retrain'}
                                disabled={reason !== null || training}
                                title={reason ?? undefined}
                                onClick={() => runTrainClick(m)}
                            >
                                {training ? 'Training…' : (stale || trainError[m.id]) ? '↻ Re-train' : '▶ Train model'}
                            </button>
                        )}
                    </>
                )}
                {page === 'health' && (
                    <>
                        {isModelDone(m) ? (
                            <>
                                {outOfDate && (
                                    <button
                                        type="button"
                                        className="bmw-btn-ok"
                                        data-testid="mark-complete-again"
                                        disabled={markBlock !== null || saving}
                                        title={markBlock ?? 'Write the files again with the current set points'}
                                        onClick={() => { void runMarkComplete(m); }}
                                    >
                                        {saving ? 'Saving…' : '✓ Mark complete again'}
                                    </button>
                                )}
                                <button type="button" className="f4-btn f4-btn--plain f4-btn--small" data-testid="mark-incomplete" disabled={saving} onClick={() => markModelIncomplete(m.id)}>
                                    Mark incomplete
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                className="bmw-btn-ok"
                                data-testid="mark-complete"
                                disabled={markBlock !== null || saving}
                                title={markBlock ?? 'Write the model files and mark it complete'}
                                onClick={() => { void runMarkComplete(m); }}
                            >
                                {saving ? 'Saving…' : '✓ Mark complete'}
                            </button>
                        )}
                    </>
                )}
                {page === 'model' && (
                    <button
                        type="button"
                        className="rcx-btn rcx-btn--pri"
                        data-testid="next-health-score"
                        disabled={healthBlock !== null || training}
                        title={healthBlock ?? undefined}
                        onClick={() => setPage(m, 'health')}
                    >
                        Next: Health score →
                    </button>
                )}
            </div>
        );
    };

    /** Step-bar click: jump to the page / section that step lives on. */
    const goToStep = (key: StepKey) => {
        if (key === 'running-condition') { setRcFilterOpen(true); return; }
        if (!activeModel) return;
        if (key === 'model-settings') {
            setPage(activeModel, 'model');
            setSettingsOpenOverride(prev => ({ ...prev, [activeModel.id]: true }));
            return;
        }
        if (key === 'train') { setPage(activeModel, 'model'); return; }
        // 'health-set-points' and 'complete' both live on the Health score page.
        if (healthPageBlock(activeModel) === null) setPage(activeModel, 'health');
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
        const page = pageOf(activeModel);
        const stale = isModelStale(activeModel);
        const healthBlock = healthPageBlock(activeModel);
        const training = trainStatus[activeModel.id] === 'loading';
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
                    <PageSwitch
                        page={page}
                        modelFitDone={!!activeModel.lastTrainedAt && !stale}
                        healthDone={isModelDone(activeModel)}
                        healthDisabled={healthBlock !== null}
                        healthDisabledTitle={healthBlock ?? undefined}
                        onPage={p => setPage(activeModel, p)}
                    />
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
                        const st = dotStateOf(m);
                        return (
                            <button
                                key={m.id}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className={`f4-tab${selected ? ' f4-tab--on' : ''}`}
                                style={{ '--kc': KIND_COLOR[m.kind] } as CSSProperties}
                                title={`${KIND_LABEL[m.kind]} · ${isModelDone(m) ? 'Complete' : 'Incomplete'}`}
                                onClick={() => setActiveTab(prev => ({ ...prev, [selectedSensorKey!]: m.id }))}
                            >
                                <span className={`f4-kmini model-kind-icon--${m.kind}`} aria-hidden="true">{KIND_ABBREV[m.kind]}</span>
                                <span className="f4-tab-l">{KIND_LABEL[m.kind]}</span>
                                <span className={`f4-sdot${isModelDone(m) ? ' f4-sdot--done' : ''}`} />
                                {m.id in drafts && <span className="f4-dirty" title="Unsaved changes">edited</span>}
                                {badge && <GateBadgePill text={badge} testId={`condition-badge-${m.id}`} title={gateReasonOf(m) ?? undefined} />}
                                {!badge && tabPillOf(m, st) && (
                                    <span data-testid={`tab-status-${m.id}`} aria-hidden="true" className={`f4-pill ${tabPillOf(m, st)!.cls}`}>{tabPillOf(m, st)!.text}</span>
                                )}
                            </button>
                        );
                    })}
                    <span className="f4-tabs-spacer" />
                </div>

                <div role="tabpanel" data-testid={`model-tab-panel-${activeModel.id}`} style={{ display: 'contents' }}>
                    {/* One scroll area for settings + banner + the page body, so the
                        footer below always stays in view however tall the charts are. */}
                    <div className="wb2-scroll" data-testid="wb-scroll" data-page={page}>
                        {page === 'model' && renderModelSettings(activeModel)}
                        {stale && (
                            <StaleBanner
                                training={training}
                                disabled={buildBlockReason(activeModel) !== null}
                                disabledTitle={buildBlockReason(activeModel) ?? undefined}
                                onRetrain={() => runTrainClick(activeModel)}
                            />
                        )}
                        {page === 'model' ? renderModelFitBody(activeModel) : (
                            <HealthScorePage
                                key={activeModel.id}
                                {...pagePropsFor(activeModel)}
                                setPoints={setPointsOf(activeModel)}
                                onSetPointsChange={(next, commit) => changeSetPoints(activeModel, next, commit)}
                                onSetPointsCommit={() => { void commitSetPointDrafts(); }}
                                attemptIssues={attemptIssues[activeModel.id] ?? null}
                                save={saveInfoFor(activeModel)}
                                filesOutOfDate={filesOutOfDateFor(activeModel)}
                                onRetrain={() => runTrainClick(activeModel)}
                            />
                        )}
                    </div>
                    {renderFooter(activeModel, page)}
                </div>
            </>
        );
    };

    const periodStatus = validatePeriods(runningConditionTimePeriods);
    // Step-1 card / step bar / lock message all read the PERSISTED condition.
    const rcPersistedInvalid = periodStatus.some(st => st.invalid);
    const rcStepState: RcStepState = !rcConfigured ? 'unset' : rcPersistedInvalid ? 'invalid' : 'set';

    // Header step bar: looks from the ONE status rule, jumps via `goToStep`.
    const activeDetailPage = activeModel ? pageOf(activeModel) : 'model';
    const stepLooks = workbenchStepLooks({
        rcState: rcStepState,
        hasModel: !!activeModel,
        settingsReady: !!activeModel && buildBlockReason(activeModel) === null,
        trained: !!activeModel?.lastTrainedAt,
        stale: !!activeModel && isModelStale(activeModel),
        complete: !!activeModel && isModelDone(activeModel),
        // Rust's verdict on the set points: valid -> done, something rejected ->
        // red, only empty fields -> still "now".
        healthValid: activeVerdict === 'valid' ? true : activeVerdict === 'bad' ? false : null,
    });
    const stepCurrent: StepKey[] = !activeModel ? [] : activeDetailPage === 'health' ? ['health-set-points'] : ['model-settings', 'train'];
    const stepHealthBlock = activeModel ? healthPageBlock(activeModel) : 'Select a model first';
    const stepDisabled: Partial<Record<StepKey, boolean>> = {
        'model-settings': !activeModel,
        train: !activeModel,
        'health-set-points': stepHealthBlock !== null,
        complete: stepHealthBlock !== null,
    };
    const stepDisabledTitle: Partial<Record<StepKey, string>> = {
        'health-set-points': stepHealthBlock ?? undefined,
        complete: stepHealthBlock ?? undefined,
    };

    // The settings modal's own view: its draft once edited, else the persisted
    // values. Only the modal reads these — everything above (Step-1 card, gate,
    // models) stays on the persisted state.
    const rcView = rcDraft ?? rcPersisted;
    const rcDirty = rcDraft !== null && !rcDraftEqual(rcDraft, rcPersisted);
    const rcViewInvalid = validatePeriods(rcView.periods).some(s => s.invalid);
    const rcApplyEnabled = !rcViewInvalid && (rcDirty || rcPeriodTyping);
    const rcViewConfigured = isWorkspaceRunningConditionConfigured(
        { runningConditionFilters: rcView.filters, runningConditionNoneConfirmed: rcView.noneConfirmed },
        gateHeaders,
    );

    const pmPageModel = activePage === 'model' ? allModels.find(m => m.id === pmPageModelId) : undefined;

    return (
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {pmPageModel ? `Build Model — ${modelDisplayLabel(pmPageModel)}` : 'Build Model — Overview'}
                </h2>
                {/* Step bar (2026-10-04): Running condition -> Model settings -> Train ->
                    Health set points -> Complete. Overview only. Every step is a button
                    (the `data-tauri-drag-region` above applies to this bar's own element
                    only, never to its children, so the buttons stay clickable). */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center' }}>
                    {!pmPageModel && (
                        <WorkbenchStepBar
                            looks={stepLooks}
                            current={stepCurrent}
                            disabled={stepDisabled}
                            disabledTitle={stepDisabledTitle}
                            onStep={goToStep}
                        />
                    )}
                </div>
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
                    <RunningConditionCard
                        state={rcStepState}
                        periods={runningConditionTimePeriods}
                        filters={runningConditionFilters}
                        combine={runningConditionCombine}
                        noneConfirmed={runningConditionNoneConfirmed}
                        headers={gateHeaders}
                        getDesc={getDesc}
                        getUnit={getUnit}
                        rows={persistedRows}
                        bounds={datasetBounds}
                        onOpen={() => setRcFilterOpen(true)}
                    />

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

                    {/* Hidden list: the <aside> is not rendered at all, so the detail pane must be the
                        ONLY column (a leftover "0 1fr" template would put it in the 0px track). */}
                    <div className={`bmw-wb${sidebarCollapsed ? ' bmw-wb--nolist' : ''}`} style={{ gridTemplateColumns: sidebarCollapsed ? 'minmax(0,1fr)' : '300px minmax(0,1fr)' }}>
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
                                <div className="bmw-leg" data-testid="status-legend">
                                    <span><i style={{ background: 'var(--warn)' }} />Needs input / re-train</span>
                                    <span><i style={{ background: 'var(--danger)' }} />Fix</span>
                                    <span><i style={{ background: 'var(--ok)' }} />Complete</span>
                                </div>
                            </aside>
                        )}
                        <section className="bmw-detail">{renderDetailPane()}</section>
                    </div>
                </div>
            )}

            {rcFilterOpen && (
                // 🆕 2026-10-03: edits go to a local draft; only Apply writes
                // (see `applyRcDraft`). X / backdrop / Esc go through
                // `requestCloseRc`, which `flushFocusedInput()`s first (a
                // half-typed period date commits on blur only — 2026-09-30
                // data-loss fix) and then asks before discarding a dirty draft.
                // Same day: the body was redesigned (two columns + live row
                // count, mockup 1pp59aydphzaDu2R1SvKGh) — see RunningConditionPanel.
                <div className="bmw-modal-backdrop" role="presentation" onClick={requestCloseRc}>
                    <div className="bmw-modal bmw-modal--rc" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Running condition">
                        <div className="bmw-modal-head rcm-head">
                            <div className="rcm-head-t">
                                <h2>Running condition</h2>
                                <div className="rcm-sub">Default for every model · a model can use its own on its settings (Custom)</div>
                            </div>
                            <RunningConditionPills
                                configured={rcViewConfigured}
                                noneConfirmed={rcView.noneConfirmed}
                                conditionCount={rcView.filters.length}
                                periodInvalid={rcViewInvalid}
                            />
                            <button type="button" className="bmw-modal-x" onClick={requestCloseRc} aria-label="Close">
                                <X size={16} />
                            </button>
                        </div>
                        {/* `display: contents` wrapper: only here to notice a period date
                            being typed into (change) / committed (blur) — see rcPeriodTyping. */}
                        <div
                            style={{ display: 'contents' }}
                            onChange={e => { if ((e.target as HTMLElement).closest('[data-testid="time-periods-editor"]')) setRcPeriodTyping(true); }}
                            onBlur={e => { if ((e.target as HTMLElement).closest('[data-testid="time-periods-editor"]')) setRcPeriodTyping(false); }}
                        >
                            <RunningConditionPanel
                                configured={rcViewConfigured}
                                periods={rcView.periods}
                                onPeriodsChange={updateRunningConditionPeriods}
                                bounds={datasetBounds}
                                filters={rcView.filters}
                                combine={rcView.combine}
                                noneConfirmed={rcView.noneConfirmed}
                                onNoneChange={none => patchRcDraft({ noneConfirmed: none })}
                                onCombineChange={mode => patchRcDraft({ combine: mode })}
                                onAddFilter={addRunningConditionFilter}
                                onUpdateFilter={updateRunningConditionFilter}
                                onRemoveFilter={removeRunningConditionFilter}
                                sensors={allSensors}
                                getDesc={getDesc}
                                getComponent={getComponent}
                                getUnit={getUnit}
                                preview={draftRows}
                            />
                        </div>
                        <div className="bmw-modal-foot" data-testid="rc-modal-foot">
                            {rcDiscardPrompt ? (
                                <>
                                    <span data-testid="rc-discard-prompt" role="alert" className="filter-dirty-hint" style={{ fontSize: '0.75rem' }}>
                                        Discard your unapplied changes?
                                    </span>
                                    <span className="filter-panel-spacer" />
                                    <button type="button" data-testid="rc-discard-confirm" className="f4-btn f4-btn--plain" onClick={closeRc}>Discard</button>
                                    <button type="button" data-testid="rc-discard-keep" className="f4-btn" onClick={() => setRcDiscardPrompt(false)}>Keep editing</button>
                                </>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        data-testid="rc-apply"
                                        className="filter-apply-btn"
                                        disabled={!rcApplyEnabled}
                                        title={rcViewInvalid ? 'Fix the invalid training period first.' : undefined}
                                        onClick={applyRcDraft}
                                    >
                                        <Check size={12} /> Apply
                                    </button>
                                    <button type="button" data-testid="rc-cancel" className="f4-btn f4-btn--plain" onClick={closeRc}>Cancel</button>
                                    <span className="filter-panel-spacer" />
                                    {(rcDirty || rcPeriodTyping) && (
                                        <span data-testid="rc-dirty-hint" className="filter-dirty-hint">Changes not applied yet</span>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* "Compare predictors": the shared Sub-models comparison (one fit per
                cumulative predictor subset) for the active Relationship model. */}
            {compareOpen && activeModel && activeModel.kind === 'relationship' && (
                <SubModelsModal
                    fits={subModelFits}
                    targetSensor={activeModel.targetSensor ?? ''}
                    predictorCount={effectiveModelFor(activeModel).predictorSensors.length}
                    stiffnessText={stiffnessLabel(effectiveModelFor(activeModel).relStiffness)}
                    onClose={() => setCompareOpen(false)}
                />
            )}
        </div>
    );
}
