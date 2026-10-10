import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { getFgGroupColor } from '../../utils/failureGroupColor';
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../../utils/tauriEvents";
import { X, Check, ChevronRight, Lock, CircleAlert, TriangleAlert, Search, Loader2 } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata, WorkspaceSensorFilter, CategoryChange, TimePeriod, TestPeriod, TimeHighlight, FailureGroupStateSlice, FailureGroupStateChangedPayload, HealthSetPoints, HealthVerdictValue, SpecialSensorRecipe, WorkspaceState } from "../../types";
import type { HealthIssue } from "../../types/health";
import type { RelationshipPreviewResult, ClusteringPreview } from "../../types/commands";
import { loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { modelSensorKey, groupModelsBySensor, sensorCategory, setSensorCategory, type SensorModelGroup } from "../../utils/modelGrouping";
import { normalizeCategories, flagLegacyGate, migratePeriods } from "../../utils/workspaceMigrations";
import { findSameSensorNameConflict, suggestDistinctModelName } from "../../utils/modelNames";
import { CATEGORY_BLOCK_REASON, getBuildBlockReason, isRunningConditionConfigured, isWorkspaceRunningConditionConfigured, effectiveRunningCondition, markCompleteBlockReason, runningConditionApplyBlock, seedCustomFromWorkspace, type RunningConditionFg } from "../../utils/runningCondition";
import { computeTrainFingerprint, isModelTrainedFresh as trainedFreshFor } from "../../utils/trainFingerprint";
import { buildPreviewFilterPayload } from "../../utils/trainingScope";
import { applyIncompleteRule } from "../../utils/incompleteRule";
import { isModelStale as isModelStaleFor, modelDotState, modelSetPointFlag, NOT_TRAINED_BLOCK_REASON, type ModelDotState, type SetPointFlag } from "../../utils/modelStatus";
import { CLUSTERS_NEED_CRITERIA, HEALTH_DEFAULT_MAX_POINTS, relationshipLambda, testPeriodsWireFor } from "../../utils/healthRequest";
import { ensureHealthSetPoints } from "../../utils/healthSetPoints";
import { completeModel, parseHealthError } from "../../utils/completeModel";
import { commitHealthVerdict, commitSetPoints, MARK_COMPLETE_CLOSE_WAIT, persistModelComplete } from "../../utils/healthPersist";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import { useDatasetTimeBounds } from "../../hooks/useDatasetTimeBounds";
import { useHealthPreview } from "../../hooks/useHealthPreview";
import { validatePeriods, testPeriodsKey, testPeriodsError, testPeriodsWirePlan, toScoringPeriods, toTestPeriodsWire } from "../../utils/timePeriods";
import { SLOW_TEST_SCORING_TEXT, testsChangedNotice, testsChangedNoticeText, testsChangedState } from "../../utils/trainTestValidation";
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, stiffnessLabel, snapStiffness } from "../reports/pmReportTypes";
import RunningConditionPanel, { RunningConditionPills } from "./RunningConditionPanel";
import { RunningConditionCard, type RcStepState } from "./RunningConditionCard";
import { useRowCountPreview } from "./useRowCountPreview";
import { SensorPickerModal } from "./SensorPickers";
import { SensorInline, SensorLabel } from "../sensor/SensorLabel";
import { SensorMetaContext, fmtNum, fmtNumExact, fmtNumText, sensorHaystack, sensorTitle, useLayeredSensorLookup } from "../sensor/sensorInfo";
import TimePeriodsEditor from "./TimePeriodsEditor";
import TestPeriodsEditor from "./TestPeriodsEditor";
import { TrainHighlightWarnings } from "./RunningConditionParts";
import { estimateRunningDays, formatStamp } from "./periodDisplay";
import SubModelsModal from "./SubModelsModal";
import { useSubModelFits } from "./useSubModelFits";
import ModelFitPage from "./workbench/ModelFitPage";
import { CLUSTER_COLORS as CLUSTER_PALETTE } from "./workbench/chartTheme";
import HealthScorePage from "./workbench/HealthScorePage";
import { PageSwitch, SaveErrorNotice, StaleBanner, WorkbenchScroll } from "./workbench/WorkbenchShellParts";
import { buildCheckLines, healthVerdict, isBlockingIssue, sameSetPoints, verdictOfIssues, type HealthVerdict } from "./workbench/healthChecks";
import type { SaveInfo, WorkbenchPage } from "./workbench/workbenchTypes";
import { isPickerSurfaceOpen } from "../sensor/SensorPicker";
import { CloseRunDialog, LockedSettingsHeader, QueuedCard, RunSetPointsBanner, RunStrip, SensorTrainButton, sensorTrainMenuCopy, TrainAllBar, TrainAllModal, type TrainGroupInfo, type TrainMenuItem, type TrainReasonTone, type TrainRowModel } from "./workbench/TrainQueueParts";
import { useTrainQueue } from "../../hooks/useTrainQueue";
import type { TrainCandidate, TrainFixTarget, TrainOutcome } from "../../types/trainQueue";
import { classifyTrainPlan, countTrainPlans, formatTrainSeconds, isStaleTrainError, preflightReason, ROUGH_TRAIN_SECONDS, roughTrainSeconds, trainButtonsBlockedReason, TRAIN_NEEDS_RUNNING_CONDITION, TRAIN_STALE_MESSAGE } from "../../utils/trainQueue";

/** How long a Relation-model preview that scores scoring periods must have been loading before
 *  the "this can take up to ~15 s" hint shows (cached re-scores finish sooner). */
const SLOW_SCORING_HINT_DELAY_MS = 1200;

/** `flag`, but only once it has stayed true for `delayMs` (false at once). */
function useDelayedFlag(flag: boolean, delayMs: number): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        if (!flag) {
            setOn(false);
            return;
        }
        const t = setTimeout(() => setOn(true), delayMs);
        return () => clearTimeout(t);
    }, [flag, delayMs]);
    return flag && on;
}

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


/** A typed number whose commas are thousands separators only ("1,234.5", "-12,000"). */
const THOUSANDS_GROUPED = /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/;

/** Decimals in a number's shortest JS form ("33.6" → 1); scientific counts as "long". */
const shortDecimals = (v: number): number => {
    const s = String(v);
    return /e/i.test(s) ? Infinity : (s.split('.')[1]?.length ?? 0);
};
/** Up to this many decimals a stored cluster boundary reads as a value someone TYPED and is
 *  shown in full; more is float noise from auto-dividing or dragging (33.333333333333336). */
const TYPED_DECIMALS_MAX = 10;
/** A cluster boundary for display (2026-10-09): every decimal of a typed-looking value
 *  (`fmtNumExact`, never rounded), the app's `fmtNum` for a computed one. */
function fmtClusterBound(v: number): string {
    return shortDecimals(v) <= TYPED_DECIMALS_MAX ? fmtNumExact(v) : fmtNum(v);
}
/** The same boundary as plain input text (no thousands separators — an `<input>` value). */
function clusterBoundInputText(v: number): string {
    if (shortDecimals(v) <= TYPED_DECIMALS_MAX) return String(v);
    const a = Math.abs(v);
    return String(Number(a !== 0 && a < 0.001 ? v.toPrecision(3) : v.toFixed(3)));
}

// A group's colour comes from `getFgGroupColor` (utils/failureGroupColor.ts),
// the one rule the Dashboard and the Import page's recent-project chip use too.

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
type SidebarFilter = 'all' | 'attn' | 'done' | 'sp';

const LEGACY_BADGE = 'Legacy · all data';

/** The sensor a model belongs to (its Target, or X for Clustering). */
const modelTagOf = (m: FailureModel): string => (m.kind === 'clustering' ? m.xSensor : m.targetSensor) ?? '';
/** Placeholder plan for rows the run strip / close dialog only label (they never read it). */
const LABEL_ONLY_PLAN = { kind: 'ready' } as const;

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
    /** This model's own SCORING periods (Custom mode; "test periods" until
     *  2026-10-10) — staged in the draft like the other Custom lists. */
    customTestPeriods: TestPeriod[];
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
    customTestPeriods: m.customTestPeriods ?? [],
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
/** The words behind a kind tab's state dot (its tooltip). A tab carries NO text
 *  pill (SPEC workbench-redesign §1): a model's status is said in words once, in
 *  the footer. */
const TAB_WORDS: Record<ModelDotState, string> = {
    complete: 'Complete', trained: 'Trained', stale: 'Re-train needed', blocked: 'Needs fixing', none: 'Not trained yet',
};
/** A run of this session failed: red dot on the tab and in the list. */
const TRAIN_FAILED_WORDS = 'Training failed';
/** Next to every Model-settings field that is part of the training inputs
 *  (training data, predictors, sensors, clusters, stiffness): changing it sets a
 *  Complete model back to Incomplete (`applyIncompleteRule`) — say so up front. */
const IncompleteHint = () => (
    <span className="wb2-aff" data-testid="incomplete-hint">changing it sets the model to Incomplete</span>
);
/** Stable empty list for `useSubModelFits` when the active model is not a Relationship. */
const NO_PREDICTORS: string[] = [];
/** Shown when a Train finds the dataset replaced since this window opened. */
const DATASET_CHANGED_MESSAGE = 'The dataset changed since this window was opened — close it and reopen Build Model from the Dashboard.';
const DUPLICATE_NAME_BLOCK_REASON = 'Model name is already used by another model of this sensor';
/** Mark complete, Compare predictors and the Re-train buttons while a training
 *  run is active: one Relation-model sidecar call at a time (coordinator
 *  decision, phase 4 review). */
const TRAIN_RUN_ACTIVE_REASON = 'Wait for the training run to finish';
/** A model whose Mark complete is writing its files is not trained meanwhile. */
const BEING_SAVED_REASON = 'being saved';
/** The close notice when "Stop after this model and close" gave up waiting. */
const RUN_CLOSE_WAIT_NOTICE = 'Still training a model — the window stays open so nothing is cut off half-way. Close it again to leave without waiting.';
const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};
/** Kind names on the tabs: Individual / Relation model / Clustering. */
const KIND_TAB_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relation model',
    clustering: 'Clustering',
};
/** A kind inside a sentence: "the Individual model", "the Relation model". */
const kindModelName = (kind: ModelKind): string => (kind === 'relationship' ? 'Relation model' : `${KIND_LABEL[kind]} model`);
/** The ONE filled button of the detail pane (SPEC workbench-redesign §1: at most
 *  one filled button on screen) — see `primaryActionOf`. */
type PrimaryAction = 'save' | 'train' | 'next' | 'mark' | null;

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
    /** The workspace SCORING periods (start → end only). */
    testPeriods: TestPeriod[];
}

/** Draft vs. persisted comparison. JSON is enough: every draft object is built
 *  by spreading the persisted one (key order preserved) and the period editor
 *  hands back already-sorted lists. Scoring periods are compared as id / start /
 *  end only: the editor hands back periods without the legacy label / event
 *  time an old workspace may still have on disk, and losing those is not an
 *  edit (editing a date and typing it back must not read as "not applied"). */
function rcDraftEqual(a: RcDraft, b: RcDraft): boolean {
    return a.combine === b.combine
        && a.noneConfirmed === b.noneConfirmed
        && JSON.stringify(a.filters) === JSON.stringify(b.filters)
        && JSON.stringify(a.periods) === JSON.stringify(b.periods)
        && JSON.stringify(toScoringPeriods(a.testPeriods)) === JSON.stringify(toScoringPeriods(b.testPeriods));
}

/** A date in the footer ("Trained …", "Files saved …"): the ONE Workbench date
 *  format, "9 Feb 2026 23:50", in mono. */
const Stamp = ({ at }: { at: string }) => <span className="wbx-dt">{formatStamp(at)}</span>;

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
 *     per-model footer (status pill, Save, Train; Mark complete lives on
 *     the Health score page).
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
 * Owns `failureGroupState` jointly with Dashboard —
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
    // Workspace-default TRAIN periods (Feature 4-C; "train" since the Train/Test
    // validation change, 2026-10-07). At least one is REQUIRED to train — an
    // empty list no longer means "whole dataset" (`getBuildBlockReason`).
    // A model in Workspace mode uses THIS list; Custom mode uses its own
    // `filterTimePeriods`.
    const [runningConditionTimePeriods, setRunningConditionTimePeriods] = useState<TimePeriod[]>([]);
    // Workspace-default SCORING periods ("test periods" until 2026-10-10): the
    // time the trained model gives a health score for; at least one is needed
    // before Mark complete. Custom mode uses the model's own `customTestPeriods`.
    const [runningConditionTestPeriods, setRunningConditionTestPeriods] = useState<TestPeriod[]>([]);
    // The workspace's Dashboard time highlights — only feed the amber TRAIN-period
    // overlap warning ("Remove the overlap"; never drawn on Workbench charts, and
    // no longer a source of scoring periods). Read from the workspace file at
    // hydration and again whenever the Running condition settings open.
    const [dashHighlights, setDashHighlights] = useState<TimeHighlight[]>([]);
    // The workspace's special-sensor recipes, read from disk (customer batch 2026-10, item 6):
    // a model trained on a special sensor whose formula changed since reads as out of date in
    // every status (`isModelStale` & co. take them). Kept as ONE array per read, so the recipe
    // signatures (memoised per array) are computed once, not per render.
    const [specialRecipes, setSpecialRecipes] = useState<SpecialSensorRecipe[] | null>(null);
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
    // (The last validate verdict Rust gave per model - "Set points needed" /
    // "Fix set point" - is no longer window state: it is PERSISTED on the model
    // (`healthVerdict`, QA fix 2026-10-04) so the Dashboard's dot reads the same
    // value; see `modelSetPointFlag` and the effect that writes it below.)
    /** Every "Mark complete" run in flight (the WHOLE run: validate -> export -> save),
     *  so a window close can wait for it (QA fix 2026-10-04: only the final save was
     *  tracked, and `pendingSaveRef` is a single slot a later write overwrites). */
    const markRunsRef = useRef<Set<Promise<unknown>>>(new Set());
    /** The user was told the close is waiting too long for a running save; the next
     *  close attempt does not wait for it again. */
    const closeWaitGivenUpRef = useRef(false);
    const [closeNotice, setCloseNotice] = useState<string | null>(null);

    // ---- Train sensor / Train all with a queue (customer batch 2026-10, items 8 + 9) ----
    // `useTrainQueue` runs models strictly one at a time through `trainForQueue`
    // (defined further down, it needs the window's train rules). The hook reads
    // `train` through its own ref, so this indirection only exists because the
    // hook has to be called before those functions are defined.
    const queueTrainRef = useRef<(id: string) => Promise<TrainOutcome>>(async () => ({ ok: false, abandoned: true }));
    const queue = useTrainQueue({ train: id => queueTrainRef.current(id), scopeKey: workspaceId });
    /** For handlers registered once (the native close). */
    const queueRef = useRef(queue);
    queueRef.current = queue;
    /** Stable (useCallback inside the hook) — safe in the once-registered listeners below. */
    const queueReset = queue.reset;
    /** Train all modal: `preflight`, or the current / last run's details (`run`). */
    const [trainAllView, setTrainAllView] = useState<null | 'preflight' | 'run'>(null);
    const [includeUpToDate, setIncludeUpToDate] = useState(false);
    /** The close-during-a-run dialog is open. */
    const [closeAsk, setCloseAsk] = useState(false);
    /** The silent auto-recompute in flight (a run waits for it: one sidecar call at a time). */
    const autoRecomputeRef = useRef<Promise<unknown> | null>(null);
    /** The header's Train sensor button (the footer's "Train sensor ↑" focuses it). */
    const trainSensorBtnRef = useRef<HTMLButtonElement>(null);
    /** Close WITHOUT the run dialog: the Dashboard said this workspace is closing
     *  (`workspace-closing`), or "Stop after this model and close" gave up waiting. */
    const closeBypassRef = useRef(false);
    /** "Stop after this model and close" is already waiting (double-click guard). */
    const stopClosingRef = useRef(false);
    /** Mirror of `closeAsk` for the once-registered `workspace-closing` listener. */
    const closeAskRef = useRef(false);
    closeAskRef.current = closeAsk;
    /** Relationship models whose fit Rust no longer holds (NOT_FITTED seen this
     *  session, e.g. evicted from the fit cache during a long run): planned as
     *  ready again until a train of them succeeds. */
    const [notFittedIds, setNotFittedIds] = useState<ReadonlySet<string>>(() => new Set());
    /** `id::fingerprint` already re-fitted automatically after a NOT_FITTED (once each). */
    const refitTriedRef = useRef<Set<string>>(new Set());
    /** Models whose first-open set-point snapshot was already written (once per model). */
    const setPointsSeededRef = useRef<Set<string>>(new Set());

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
    const [seedNoteFor, setSeedNoteFor] = useState<Record<string, { periods: number; conditions: number; tests: number } | null>>({});
    /** Clustering's criteria-sensor stats (drives the cluster-range slider's
     *  [min, max] bounds) — scoped to whichever model is currently active,
     *  refetched whenever its (draft-aware) criteria sensor or effective
     *  training-scope filter changes. Mirrors PredictiveModelBuild.tsx's own
     *  `criteriaStats` effect; `null` while unset/loading, same as there.
     *  Stored with the key it was fetched for (model + criteria sensor +
     *  filter); the `criteriaStats` read further down is only non-null when
     *  that key matches what is selected NOW (2026-10-09). */
    const [criteriaStatsEntry, setCriteriaStatsEntry] = useState<{ key: string; stats: SensorStats } | null>(null);
    /** Cluster-range boundary being typed (2026-10-09): `idx` = the boundary between cluster
     *  idx+1 and idx+2. `initial` is the text the box showed on focus (an unchanged box
     *  commits nothing, so a rounded readout of a dragged value is never written back). */
    const [boundaryEdit, setBoundaryEdit] = useState<{ modelId: string; idx: number; text: string; initial: string; error: string | null } | null>(null);
    /** The exact text of each boundary the user typed (`modelId:idx`), shown while the stored
     *  number still equals it — a typed "33.60" keeps its "33.60" (never rounded). Session only. */
    const [typedBoundaryText, setTypedBoundaryText] = useState<Record<string, { value: number; text: string }>>({});

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    // Customer item 3: every sensor label / picker in this window resolves through this lookup.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);
    const getComponent = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.component ?? '', [sensorMetaMap]);
    // Raw description only (not the "description (tag)" combo `sensorLabel`
    // below builds). Sensor labels in the UI come from `sensorLookup` (the
    // shared SensorLabel standard, customer item 3).
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
    const recipeSeq = useRef(0);

    // 🆕 2026-09-29 [data-loss fix]: the most recent in-flight
    // `updateWorkspaceData` write from ANY persist path in this window
    // (running-condition edits, a model draft Save, Mark complete,
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
    // Mirrors the whole slice into local state — used by every path that
    // receives a fresh copy (hydration, broadcasts, our own writes).
    const applyFg = useCallback((fg: FailureGroupStateSlice | undefined | null) => {
        setAllGroups(fg?.groups ?? []);
        setAllModels(fg?.models ?? []);
        setRunningConditionFilters(fg?.runningConditionFilters ?? []);
        setRunningConditionCombine(fg?.runningConditionCombine ?? 'and');
        setRunningConditionTimePeriods(fg?.runningConditionTimePeriods ?? []);
        setRunningConditionTestPeriods(fg?.runningConditionTestPeriods ?? []);
        setRunningConditionNoneConfirmed(fg?.runningConditionNoneConfirmed ?? false);
        setRcLegacyNotice(fg?.rcLegacyNotice ?? null);
        setCategoryNotice(fg?.categoryNormalisationNotice ?? null);
    }, []);

    /** Adopts what one of THIS window's writes put on disk: the slice and the
     *  special-sensor recipes the write read (review 2026-10-09: a Train after a
     *  Repair stamps `trainedFormulas` from the recipes on disk, so this window
     *  must judge freshness against those same recipes, not an older copy). Any
     *  recipe read still in flight is older than this write. */
    const applyWritten = useCallback((ws: WorkspaceState | null | undefined) => {
        if (!ws?.failureGroupState) return;
        applyFg(ws.failureGroupState);
        recipeSeq.current++;
        setSpecialRecipes(ws.specialSensorRecipes ?? null);
    }, [applyFg]);

    /** Re-reads the workspace's Dashboard time highlights from disk (the Dashboard
     *  may have changed them since this window opened). Never touches anything
     *  else; a failure keeps the last list. */
    const refreshHighlights = useCallback(async (): Promise<void> => {
        const ws = workspaceIdRef.current;
        if (!ws) return;
        try {
            const data = await loadWorkspaceData(ws);
            if (workspaceIdRef.current !== ws) return;
            setDashHighlights(data?.timeHighlights ?? []);
            setSpecialRecipes(data?.specialSensorRecipes ?? null);
        } catch {
            // keep the last list
        }
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
                    // The window may have been re-pointed at another workspace meanwhile:
                    // the remaining drafts still belong to `ws` and are still written
                    // there; only this window's own state is left alone.
                    if (workspaceIdRef.current !== ws) continue;
                    applyWritten(next);
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
    }, [trackPending, applyWritten, writeSpDrafts]);

    /** Awaits this window's own pending write (and any running Mark complete),
     *  so no path off this window can drop an edit made just before closing. A set-point draft that was typed
     *  but never blurred is committed first, so it is part of what is awaited. */
    const flushAllPending = useCallback(async (): Promise<boolean> => {
        void commitSetPointDrafts();
        // A running "Mark complete" (export + save) is waited for, so files that were
        // written always end with the status saved or a clear refusal — but never
        // forever: a hung sidecar makes the close wait give up once, with a message.
        // (Holds even when the window was re-pointed at another workspace mid-run:
        // `runMarkComplete` saves into the workspace captured at click time.)
        if (markRunsRef.current.size > 0 && !closeWaitGivenUpRef.current) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finished = Promise.allSettled([...markRunsRef.current]).then(() => true);
            const gaveUp = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), MARK_COMPLETE_CLOSE_WAIT.ms); });
            const ok = await Promise.race([finished, gaveUp]);
            if (timer) clearTimeout(timer);
            if (!ok) {
                closeWaitGivenUpRef.current = true;
                setCloseNotice('Still saving the model files — the window stays open so nothing is lost. Close it again to leave without waiting.');
                return false;
            }
        }
        if (pendingSaveRef.current) await pendingSaveRef.current;
        return true;
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
            // including a half-edited form for a model that does
            // not exist in the new workspace.
            const switched = workspaceIdRef.current !== null && workspaceIdRef.current !== d.workspaceId;
            // A set point typed (not yet blurred) in the OLD workspace is written THERE
            // first — `commitSetPointDrafts` captures the old workspace id and its drafts
            // synchronously, before the ref below moves, and never writes into the new one.
            if (switched) void commitSetPointDrafts();
            workspaceIdRef.current = d.workspaceId;
            setWorkspaceId(d.workspaceId);
            if (switched) {
                setSelectedSensorKey(null);
                setActiveTab({});
                setSettingsOpenOverride({});
                // A half-typed cluster boundary (or its error) belongs to the old workspace.
                setBoundaryEdit(null);
                setTypedBoundaryText({});
                // The auto-divide memory and the criteria stats are keyed by MODEL id, and
                // `duplicateWorkspace` keeps model ids: left behind, a copy's model would read
                // the other workspace's last division key as its own, re-divide its saved
                // (uneven) cluster ranges and show an unprompted "edited" draft.
                prevClusterDivisionKeyRef.current = {};
                setCriteriaStatsEntry(null);
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
                setRunningConditionTestPeriods([]);
                setDashHighlights([]);
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
                setPointsSeededRef.current = new Set();
                // `completeRunningRef` / `markRunsRef` are deliberately NOT reset: a Mark
                // complete of the old workspace may still be exporting. It finishes and saves
                // into ITS workspace (see `runMarkComplete`), and a window close must still
                // wait for it (`flushAllPending`); model ids are unique across workspaces, so
                // keeping them cannot block a model of the new one.
                closeWaitGivenUpRef.current = false;
                // A `workspace-closing` for the old workspace set the bypass; the new
                // workspace's runs must ask before closing again.
                closeBypassRef.current = false;
                stopClosingRef.current = false;
                setCloseNotice(null);
                // The run belonged to the old workspace: drop it (a train still in
                // flight finishes, but its result is ignored — see `executeTrain`).
                queueReset();
                setNotFittedIds(new Set());
                refitTriedRef.current = new Set();
                setTrainAllView(null);
                setIncludeUpToDate(false);
                setCloseAsk(false);
            }
            setGeneration(d.metadata?.generation);
            setAllSensors(d.sensorHeaders);
            setSensorMetadata(d.sensorMetadata);
            const seq = ++loadSeq.current;
            try {
                const ws = await loadWorkspaceData(d.workspaceId);
                if (seq !== loadSeq.current || workspaceIdRef.current !== d.workspaceId) return;
                setDashHighlights(ws?.timeHighlights ?? []);
                recipeSeq.current++;
                setSpecialRecipes(ws?.specialSensorRecipes ?? null);
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
                            applyWritten(written);
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

        // Any other window (Dashboard) that
        // persists failureGroupState broadcasts this so our copy never
        // goes stale. Ignores another workspace's broadcast (events are
        // global) and this window's own echo.
        const offChanged = subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
            if (event.payload.workspaceId !== workspaceIdRef.current) return;
            if (event.payload.origin === 'build-model') return;
            // A load already in flight is now older than this broadcast.
            loadSeq.current++;
            applyFg(event.payload);
            // The Dashboard's autosave WROTE a special-sensor recipe change (`recipesChanged`):
            // re-read the recipes from disk -- never carried in a payload. Any other broadcast
            // costs no disk read.
            if (event.payload.recipesChanged === true) {
                const ws = event.payload.workspaceId;
                const mySeq = ++recipeSeq.current;
                loadWorkspaceData(ws)
                    .then(data => {
                        if (mySeq !== recipeSeq.current || workspaceIdRef.current !== ws) return;
                        setSpecialRecipes(data?.specialSensorRecipes ?? null);
                    })
                    .catch(() => { /* keep the last recipes */ });
            }
        });

        // Register both before asking, so the reply can't be missed.
        Promise.all([offData.ready, offChanged.ready]).then(() => emit('request-build-model-data'));

        return () => {
            offData();
            offChanged();
        };
    }, [applyFg, applyWritten, trackPending, writeSpDrafts, commitSetPointDrafts, queueReset]);

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
            // Re-pointed at another workspace meanwhile: the write landed in ITS
            // workspace; this window now shows another one — touch nothing here.
            if (workspaceIdRef.current !== workspaceId) return;
            if (next?.failureGroupState) {
                applyWritten(next);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyWritten, trackPending]);

    // The one path that actually changes the workspace-wide running
    // condition — edited entirely from the "Running Condition Filter" modal
    // (see the JSX below), never per-model. One function for every
    // sub-field (filters/combine/train periods/none/scoring periods) rather than a
    // near-duplicate persist-function per field.
    const persistRunningCondition = useCallback((patch: {
        filters?: WorkspaceSensorFilter[];
        combine?: 'and' | 'or';
        periods?: TimePeriod[];
        noneConfirmed?: boolean;
        testPeriods?: TestPeriod[];
    }): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        return trackPending((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => {
                const applied = withFailureGroupState(prev, {
                    ...(patch.filters !== undefined ? { runningConditionFilters: patch.filters } : {}),
                    ...(patch.combine !== undefined ? { runningConditionCombine: patch.combine } : {}),
                    ...(patch.periods !== undefined ? { runningConditionTimePeriods: patch.periods } : {}),
                    ...(patch.noneConfirmed !== undefined ? { runningConditionNoneConfirmed: patch.noneConfirmed } : {}),
                    // Scoring periods are WRITTEN as id / start / end only: a legacy label /
                    // event time (workspace saved before 2026-10-10) never goes back to disk.
                    ...(patch.testPeriods !== undefined ? { runningConditionTestPeriods: toScoringPeriods(patch.testPeriods) } : {}),
                });
                // Any edit made through this panel settles the legacy notice.
                const fg = applied.failureGroupState;
                const stillPending = fg?.rcLegacyNotice === 'pending' && !isWorkspaceRunningConditionConfigured(fg);
                // Applying a different workspace running condition changes what every
                // Workspace-mode model trains on: those that were Complete go back to
                // Incomplete in this same write (Custom-mode models are unaffected).
                // A change of ONLY the scoring periods keeps them trained but still needs
                // Mark complete again (`testsChangedAt`) — `applyIncompleteRule` does
                // both, never this window by hand.
                return applyIncompleteRule(prev, withFailureGroupState(applied, { rcLegacyNotice: stillPending ? 'pending' : null }));
            });
            if (next?.failureGroupState) {
                applyWritten(next);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyWritten, trackPending]);

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
        testPeriods: runningConditionTestPeriods,
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
    // Scoring periods are committed by `TestPeriodsEditor` on blur / Enter / a discrete action.
    const updateRunningConditionTestPeriods = useCallback((testPeriods: TestPeriod[]) => {
        patchRcDraft({ testPeriods });
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
        // Invalid train period, NO train period (rule 1), or an invalid scoring period
        // (a missing date, or an end before its start) keeps the modal open; the
        // footer says why.
        if (runningConditionApplyBlock(d.periods, d.testPeriods) !== null) return;
        // Optimistic local mirror (the persisted state vars) so the Step-1 card and
        // the gate are right the moment the modal closes; the write's own
        // `applyFg` then confirms it from disk.
        setRunningConditionFilters(d.filters);
        setRunningConditionCombine(d.combine);
        setRunningConditionTimePeriods(d.periods);
        setRunningConditionNoneConfirmed(d.noneConfirmed);
        setRunningConditionTestPeriods(d.testPeriods);
        void persistRunningCondition({ filters: d.filters, combine: d.combine, periods: d.periods, noneConfirmed: d.noneConfirmed, testPeriods: d.testPeriods });
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
    /** Raw draft write (no side effects) — the cluster auto-divide effect uses this. */
    const writeDraft = (m: FailureModel, patch: Partial<ModelDraft>) =>
        setDrafts(prev => ({ ...prev, [m.id]: { ...(prev[m.id] ?? draftFromModel(m)), ...patch } }));
    /** A user edit in "Model settings". It also pins the section open when it was only open
     *  because something was missing (2026-10-09): fixing the last missing item (e.g. picking the
     *  criteria sensor) must not collapse the section under the user's hands. */
    const patchDraft = (m: FailureModel, patch: Partial<ModelDraft>) => {
        writeDraft(m, patch);
        setSettingsOpenOverride(prev => (m.id in prev ? prev : { ...prev, [m.id]: true }));
    };

    /** Category of the model's sensor across every FG (never per-model any more). */
    const categoryOf = (m: FailureModel): ModelCategory | null => sensorCategory(allModels, modelSensorKey(m));

    // ---- Running-condition gate (Feature 4-B, soft gate A). ONE source of
    //      truth: `getBuildBlockReason`. Every Train / "mark Complete"
    //      path below asks it; Save is deliberately NOT gated by it. ----
    const gateFg: RunningConditionFg = {
        models: allModels, runningConditionFilters, runningConditionCombine,
        runningConditionTimePeriods, runningConditionNoneConfirmed, runningConditionTestPeriods,
    };
    const gateHeaders = allSensors.length ? allSensors : null;
    // 🆕 2026-09-30 QA fix (bug 3): judge the DRAFT-merged model
    // (`effectiveModelFor`, defined below — closures resolve it fine, it's
    // only ever CALLED after the component's synchronous render body has
    // defined it), not the persisted one. `getBuildBlockReason` reads
    // `runningConditionMode`/`customRunningConditionFilters`/
    // `filterTimePeriods` straight off whatever model it's given; passing
    // the persisted model meant the gate was blind to a pending Custom-mode
    // switch/edit — Train could commit a draft that
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
    /** Badge text for a model the gate blocks, for ANY reason (missing condition,
     *  missing category, invalid period), else null. Hover text is the reason. */
    const gateBadge = (m: FailureModel): string | null => {
        if (gateReasonOf(m) === null) return null;
        if (needsCondition(m)) return m.status ? LEGACY_BADGE : 'Needs condition';
        if (categoryOf(m) === null) return 'Needs category';
        return effectiveRunningCondition(effectiveModelFor(m), gateFg).periods.length === 0 ? 'Needs train period' : 'Fix periods';
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
            // 2+ clusters are split by the criteria sensor — Rust rejects n_clusters > 1 without one.
            && (!!d.criteria || d.numClusters <= 1)
        );
        if (!ok) return 'Fill in the required fields above first';
        // A Custom model's own scoring periods are saved with Save changes: an invalid
        // one (a missing date, or an end before its start) blocks the save, exactly
        // like it blocks the workspace Apply.
        if (d.runningConditionMode === 'custom') {
            const badTest = testPeriodsError(d.customTestPeriods);
            if (badTest) return badTest;
        }
        return nameConflictOf(m) ? DUPLICATE_NAME_BLOCK_REASON : null;
    };

    /** Why Train / Mark complete are disabled: everything Save needs, then the gate. */
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
            if (!d.criteria && d.numClusters > 1) items.push(CLUSTERS_NEED_CRITERIA);
        }
        if (d.runningConditionMode === 'custom') {
            const badTest = testPeriodsError(d.customTestPeriods);
            if (badTest) items.push(badTest);
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
            parts.push(`Custom · ${condLabel} · ${d.customPeriods.length} train · ${d.customTestPeriods.length} scoring`);
        } else {
            parts.push('Workspace data');
        }
        return parts.join(' · ');
    };

    // `commitModel` returns the `persist()` promise (rather than firing it and
    // forgetting) so `trainForQueue` can await the write landing on disk first.
    /** The persistable fields a model's draft would write on Save — factored
     *  out of `commitModel` so `trainForQueue` (Phase B) can compute the exact
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
            // WRITTEN as id / start / end only (never a legacy label / event time).
            customTestPeriods: toScoringPeriods(d.customTestPeriods),
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
        // Each of the model's own lists (conditions, train periods, scoring periods) is
        // copied from the workspace ONCE — only while it is still empty.
        const { patch: seed, copied } = seedCustomFromWorkspace(
            { customFilters: d.customFilters, customPeriods: d.customPeriods, customTestPeriods: d.customTestPeriods },
            { filters: runningConditionFilters, combine: runningConditionCombine, periods: runningConditionTimePeriods, testPeriods: runningConditionTestPeriods },
        );
        patchDraft(m, { runningConditionMode: 'custom', ...seed });
        if (copied.conditions > 0 || copied.periods > 0 || copied.tests > 0) {
            setSeedNoteFor(prev => ({ ...prev, [m.id]: copied }));
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
                applyWritten(next);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    };

    /** The model Train/staleness checks should actually judge RIGHT NOW: the
     *  persisted model, merged with any pending (unsaved) draft edit for it —
     *  same merge `trainForQueue` commits on an actual Train. A draft change
     *  to a fingerprinted field (stiffness, predictors, Y, cluster settings,
     *  Workspace/Custom, …) must make the results area go stale and disable
     *  Mark complete IMMEDIATELY, not only after Save/Train (QA fix,
     *  2026-09-29 — "an unsaved draft edit after training leaves the old
     *  chart up and Mark complete enabled"). The persisted
     *  `trainedFingerprint` write itself only ever happens through
     *  `trainForQueue`/`executeTrain`, never from this. */
    const effectiveModelFor = (m: FailureModel): FailureModel =>
        m.id in drafts ? { ...m, ...draftFields(m, draftOf(m)) } : m;

    /** "Trained" (the status pill, distinct from Complete): a successful
     *  Phase-B preview run exists AND its fingerprint still matches the
     *  model's current inputs AND the model isn't already Complete — see
     *  `src/utils/trainFingerprint.ts` and the SPEC FINAL entry in
     *  `docs/PROJECT_HANDOVER.md`. */
    const isModelTrainedFresh = (m: FailureModel): boolean =>
        !m.status && trainedFreshFor(effectiveModelFor(m), gateFg, specialRecipes);
    /** Was trained at some point, but the model's inputs (or the effective
     *  running condition) changed since — "Settings changed — re-train". */
    // 🆕 2026-10-03 (health score): NOT gated on `status` any more — a Complete
    // model whose inputs changed since it was trained is out of date too (the
    // write side already set it Incomplete; this is the read side, for old data
    // and for a pending draft). See `utils/modelStatus.ts`.
    const isModelStale = (m: FailureModel): boolean => isModelStaleFor(effectiveModelFor(m), gateFg, specialRecipes);
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
    /** A Custom-mode model whose OWN running condition is what blocks it: the fix is inside Model settings. */
    const customFixInside = (m: FailureModel): boolean =>
        draftOf(m).runningConditionMode === 'custom' && categoryOf(m) !== null && gateReasonOf(m) !== null;
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
     *  window's state to re-render first (see `trainForQueue`). */
    /** `true` when the Rust dataset is no longer the one this window was opened on. */
    const datasetChangedSinceOpen = async (): Promise<boolean> => {
        if (generation === undefined) return false;
        try {
            const current = await invoke<number | null>('get_session_generation');
            return typeof current === 'number' && current !== generation;
        } catch {
            return false;
        }
    };
    /** Returns its outcome for the train queue (`useTrainQueue`) while still
     *  setting `trainError` for the window's own UI: `{ ok: true }`, a failure
     *  (`stale` when the dataset is no longer this window's — the run then
     *  stops), or `abandoned` when the window was re-pointed at another
     *  workspace meanwhile. */
    const executeTrain = async (merged: FailureModel, fingerprint: string, opts: { persistMeta: boolean }): Promise<TrainOutcome> => {
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
            // This window was opened on ONE dataset generation. The train commands carry
            // no generation of their own, so if the dataset was replaced since (another
            // CSV loaded in the main window) they would train on the OTHER data and the
            // model would be stamped "Trained" with numbers from the wrong dataset. Check
            // before AND after (diagnostic `get_session_generation`; unavailable /
            // unknown = no check).
            if (await datasetChangedSinceOpen()) throw new Error(DATASET_CHANGED_MESSAGE);
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true };
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
                const trainTestPeriods = testPeriodsWireFor(merged, gateFg);
                const r = await invoke<RelationshipPreviewResult>('preview_relationship_model', {
                    predictors: merged.predictorSensors,
                    target: merged.targetSensor,
                    lambda: merged.relStiffness,
                    filter,
                    cache_key: cacheKey,
                    max_points: HEALTH_DEFAULT_MAX_POINTS,
                    // The active scoring periods ride along (start / end only), so this
                    // one sidecar run also predicts their rows and the health preview
                    // that follows scores them at once (no second ~15 s run). Same wire
                    // as `compute_health_preview`; omitted when there is none.
                    ...(trainTestPeriods ? { test_periods: trainTestPeriods } : {}),
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
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true }; // abandoned — see comment above
            if (await datasetChangedSinceOpen()) throw new Error(DATASET_CHANGED_MESSAGE);
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true };
            setTrainResults(prev => ({ ...prev, [id]: { fingerprint, result } }));
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            // The Relationship fit is now in Rust's cache under this key: make the
            // health preview (re)fetch even if its request is byte-identical. Only
            // for the model on screen (the one preview there is): a training run
            // must not refetch the open model's charts after every OTHER model.
            if (activeModelIdRef.current === id) setHealthRevision(r => r + 1);
            if (opts.persistMeta) {
                // An explicit train re-filled the fit: no longer "fit gone", and a later
                // NOT_FITTED of this model may be re-fitted automatically again. (A silent
                // re-fit clears the mark only once its preview loads — see the effect below.)
                setNotFittedIds(prev => {
                    if (!prev.has(id)) return prev;
                    const rest = new Set(prev);
                    rest.delete(id);
                    return rest;
                });
                for (const k of [...refitTriedRef.current]) if (k.startsWith(`${id}::`)) refitTriedRef.current.delete(k);
                await persist((models, groups) => ({
                    groups,
                    // `status: false` too: a (re-)train always lands the model in
                    // Incomplete/Trained — an old-data Complete model that was out of date
                    // must not silently turn Complete again just because its fingerprint
                    // now matches; it is marked complete again explicitly.
                    // A new fit also starts a new verdict (it is written again once the preview of this
                    // fit lands): the old one described the old fit.
                    models: models.map(x => {
                        if (x.id !== id) return x;
                        const { healthVerdict: dropped, ...rest } = x;
                        void dropped;
                        return { ...rest, status: false, lastTrainedAt: new Date().toISOString(), trainedFingerprint: fingerprint };
                    }),
                }));
            }
            return { ok: true };
        } catch (e) {
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true }; // abandoned — see comment above
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            // The bundled Relation model engine is too old: show the app's own wording.
            const parsed = parseHealthError(e);
            const message = parsed.code === 'SIDECAR_OUTDATED' ? parsed.message : (e instanceof Error ? e.message : String(e));
            setTrainError(prev => ({ ...prev, [id]: message }));
            // The train commands never answer STALE_SESSION themselves: the real
            // "this data is not ours any more" signal is the generation check above
            // (DATASET_CHANGED_MESSAGE). Either one stops a run.
            const stale = message === DATASET_CHANGED_MESSAGE || parsed.code === 'STALE_SESSION' || isStaleTrainError(message);
            return stale ? { ok: false, error: message, stale: true } : { ok: false, error: message };
        }
    };

    /** The footer's Train/Re-train button. Commits any pending draft edits
     *  FIRST (`commitModel`) so a predictor/stiffness/etc. change made just before
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
    /** Forget a model's Mark complete outcome (its refusal banner was dismissed, or the
     *  user moved on with a new action). */
    const dismissSaveInfo = (modelId: string) => setSaveInfo(prev => {
        if (!(modelId in prev) || prev[modelId].phase === 'running') return prev;
        const rest = { ...prev };
        delete rest[modelId];
        return rest;
    });
    /** The ONE per-model train every Train control goes through — called by the
     *  train queue (`useTrainQueue`), one model at a time, never two at once
     *  (one shared Rust session, one sidecar). Looks the model up fresh (it may
     *  have been deleted, or its settings / the gate changed since the run
     *  started: then it is SKIPPED, not failed). Commits a pending draft FIRST
     *  (`commitModel`), so what gets trained and fingerprinted is exactly what
     *  is saved; with no draft pending, the persisted model is trained
     *  untouched (QA fix 2026-09-29: re-deriving fields from an empty draft
     *  could fingerprint a value that is not what is stored). */
    const trainForQueue = async (id: string): Promise<TrainOutcome> => {
        // Captured BEFORE any await: a re-point while waiting abandons this model.
        const ws = workspaceIdRef.current;
        // The silent auto-recompute may still be running: wait, never two sidecar calls at once.
        if (autoRecomputeRef.current) await autoRecomputeRef.current.catch(() => undefined);
        if (workspaceIdRef.current !== ws) return { ok: false, abandoned: true };
        const m = allModels.find(x => x.id === id);
        if (!m) return { ok: false, skip: 'the model no longer exists' };
        if (completeRunningRef.current.has(id)) return { ok: false, skip: BEING_SAVED_REASON };
        const block = buildBlockReason(m);
        if (block !== null) {
            return { ok: false, skip: preflightReason(block, { missing: missingItems(m), customMode: draftOf(m).runningConditionMode === 'custom' }).text };
        }
        if (saveInfo[m.id]?.phase === 'error') dismissSaveInfo(m.id);
        const hasDraft = m.id in drafts;
        const merged = effectiveModelFor(m); // = m untouched when no draft is pending
        if (hasDraft) await commitModel(m);
        if (workspaceIdRef.current !== ws) return { ok: false, abandoned: true };
        return executeTrain(merged, computeTrainFingerprint(merged, gateFg), { persistMeta: true });
    };
    queueTrainRef.current = trainForQueue;

    /** A model's plan for a run right now (`classifyTrainPlan`: the window's own
     *  block rule + the ONE status rule; a failed run this session = ready again). */
    const candidateOf = (m: FailureModel): TrainCandidate => ({
        id: m.id,
        kind: m.kind,
        // Mark complete is writing this model's files (a Relation model re-runs the sidecar): skipped.
        plan: saveInfo[m.id]?.phase === 'running'
            ? { kind: 'missing', reason: BEING_SAVED_REASON, fix: 'settings' }
            : classifyTrainPlan({
                blockReason: buildBlockReason(m),
                dotState: modelDotState(effectiveModelFor(m), gateFg, gateHeaders, specialRecipes),
                // A failed run this session, or a Relation-model fit Rust no longer holds: ready again.
                hasSessionError: !!trainError[m.id] || notFittedIds.has(m.id)
                    || (activeModel?.id === m.id && healthPreview.notFitted),
                missing: missingItems(m),
                customMode: draftOf(m).runningConditionMode === 'custom',
            }),
    });
    /** Re-train / Try again / the ▾ menu's "Train only…": exactly this model, up to date or not. */
    const trainOnly = (m: FailureModel) => { queue.start([candidateOf(m)], { includeUpToDate: true, source: 'subset' }); };

    // (`NOT_TRAINED_BLOCK_REASON` — the text shown, and the reason
    // `runMarkComplete` blocks on, when the gate passes but the model is not
    // Trained-and-fresh — lives in `utils/modelStatus.ts` so the Workbench's
    // "✓ Mark complete" title and the health-score Mark complete share one wording.)

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
    const runMarkComplete = async (m: FailureModel): Promise<string | null> => {
        const fg: RunningConditionFg = gateFg;
        const model = effectiveModelFor(m);
        const ws = workspaceIdRef.current;
        if (!ws) return 'No workspace is open.';
        if (completeRunningRef.current.has(m.id)) return 'Saving is already in progress.';
        const id = m.id;
        // `true` while this window still shows the workspace the click was made in. The
        // run can outlive that (the window is re-pointed at another project meanwhile): the
        // files and the save always go to `ws`, but window state (banner, drafts, in-memory
        // workspace slice) is only touched while it still describes `ws`.
        const stillHere = (): boolean => workspaceIdRef.current === ws;
        const fail = (message: string, issues: HealthIssue[] | null = null): string => {
            if (!stillHere()) return message; // re-pointed: nothing on screen is about this model any more
            setSaveInfo(prev => ({ ...prev, [id]: { phase: 'error', message } }));
            if (issues) setAttemptIssues(prev => ({ ...prev, [id]: issues }));
            return message;
        };
        // Nothing is written for a model that is not allowed to be Complete anyway:
        // the gate, and "trained and still fresh" (the same rules `persistModelComplete`
        // re-checks against the disk inside its write).
        const notAllowed = getBuildBlockReason(model, fg, gateHeaders)
            // At least one valid scoring period (SPEC rule 2).
            ?? markCompleteBlockReason(model, fg)
            ?? (trainedFreshFor(model, fg, specialRecipes) ? null : (isModelStaleFor(model, fg, specialRecipes) ? 'Settings changed — re-train first.' : NOT_TRAINED_BLOCK_REASON));
        if (notAllowed !== null) return fail(notAllowed);
        if (queueRef.current.isRunningNow()) return fail(TRAIN_RUN_ACTIVE_REASON);
        // Unsaved Model-settings edits (e.g. a Custom model's scoring periods) are SAVED
        // first, like Train does (`trainForQueue`): the files describe `model` (the
        // draft-merged one) and the save below re-checks the scoring periods and the
        // fingerprint against the DISK, so exporting a draft that never reached the
        // disk would write the files and then refuse the save on every retry. A
        // draft that cannot be saved (invalid) stops here, before anything is written.
        const hasDraft = m.id in drafts;
        if (hasDraft) {
            const draftBlock = modelBlockReason(m);
            if (draftBlock !== null) return fail(draftBlock);
        }
        completeRunningRef.current.add(m.id);
        setSaveInfo(prev => ({ ...prev, [id]: { phase: 'running', slow: m.kind === 'relationship' } }));
        setAttemptIssues(prev => ({ ...prev, [id]: null }));
        // The model's fingerprint at CLICK time: the files carry exactly this model, so the
        // save below is refused when the model on disk no longer has it (re-configured and
        // re-trained during the export).
        // The scoring periods at click time too: the files' `validation` block describes
        // exactly these, so a scoring-period edit during the export keeps it Incomplete.
        const race = {
            fingerprint: computeTrainFingerprint(model, fg),
            setPointsBefore: m.healthSetPoints,
            testsKey: testPeriodsKey(effectiveRunningCondition(model, fg).testPeriods),
        };
        const exec = async (): Promise<string | null> => {
            try {
                if (hasDraft) await commitModel(m);
                const sp = setPointsOf(m);
                const res = await completeModel({
                    model,
                    fg,
                    headers: gateHeaders,
                    workspaceId: ws,
                    setPoints: sp,
                    expectedGeneration: generation,
                });
                // No "workspace changed" bail-out here: `completeModel` has already written
                // the model files into A's output folder, so the save below MUST still
                // happen — into `ws` (the id captured at click time), never into whatever
                // this window points at now.
                if (!res.ok) {
                    if (res.reason === 'validation') return fail('Some set points are not valid — fix them in Checks first.', res.issues);
                    if (res.code === 'NOT_FITTED') return fail('Re-train first — the fitted Relation model is no longer in memory.');
                    if (res.code === 'STALE_SESSION') return fail('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
                    return fail(res.error ?? 'The model could not be saved.');
                }
                const record = { at: new Date().toISOString(), outputDir: res.outputDir, setPoints: res.setPoints };
                const persisted: { reason: string | null } = { reason: null };
                await trackPending((async () => {
                    const r = await persistModelComplete(ws, id, res.setPoints, gateHeaders, 'build-model', record, race);
                    persisted.reason = r.reason;
                    if (stillHere()) applyWritten(r.next);
                })());
                if (persisted.reason !== null) return fail(`The files were written, but the model was not marked complete: ${persisted.reason}`);
                // Re-pointed meanwhile: A's Complete is on disk (and was broadcast with A's
                // id by `persistModelComplete`); this window's own state is B's — leave it.
                if (!stillHere()) return null;
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
        // The WHOLE run is registered so a window close waits for it (see `flushAllPending`).
        const run = exec();
        markRunsRef.current.add(run);
        try {
            return await run;
        } finally {
            markRunsRef.current.delete(run);
        }
    };

    // 🆕 2026-09-29 [data-loss fix]: awaits every in-flight write before
    // actually closing the window. See `flushAllPending` above and the
    // `onCloseRequested` effect below for the native-close equivalent.
    // 🆕 2026-09-30: `flushFocusedInput()` first, so a half-typed Running
    // Condition period date (blur/Enter-committed only, see that function's
    // own comment) is forced to commit — and lands in `pendingSaveRef` below
    // — even if this button click didn't happen to blur it naturally first.
    /** The close itself: flush every pending write (and wait for a running Mark
     *  complete, capped), then close. */
    const closeNow = async () => {
        flushFocusedInput();
        // `false` = a running save did not finish in time: the window stays open (notice shown).
        if (!(await flushAllPending())) return;
        try {
            await getCurrentWindow().close();
        } catch {
            // A second close of a window that is already closing: nothing to do.
        }
    };
    const closeNowRef = useRef(closeNow);
    closeNowRef.current = closeNow;
    /** A training run is active and nothing allows closing past it: ask first. */
    const mustAskBeforeClose = (): boolean => queueRef.current.isRunningNow() && !closeBypassRef.current;
    const handleClose = async () => {
        // In-window dialog, "Keep training" is the default.
        if (mustAskBeforeClose()) { setCloseAsk(true); return; }
        await closeNow();
    };
    /** The close dialog's "Stop after this model and close": the run ends after the
     *  model in training (a sidecar call is never cut off), then the usual close.
     *  The wait is capped like the Mark complete wait: a hung sidecar gives up with
     *  a notice, and the NEXT close goes through without the dialog. */
    const stopRunAndClose = async () => {
        setCloseAsk(false);
        if (stopClosingRef.current) return;
        stopClosingRef.current = true;
        try {
            queue.stopAfterCurrent('close');
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = queue.whenIdle().then(() => true);
            const gaveUp = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), MARK_COMPLETE_CLOSE_WAIT.ms); });
            const finished = await Promise.race([idle, gaveUp]);
            if (timer) clearTimeout(timer);
            if (!finished) {
                closeBypassRef.current = true;
                setCloseNotice(RUN_CLOSE_WAIT_NOTICE);
                return;
            }
            await closeNow();
        } finally {
            stopClosingRef.current = false;
        }
    };

    // 🆕 2026-09-29 [data-loss fix]: a native close (the window's own X
    // button, Alt+F4, or the OS closing the app) bypasses `handleClose`
    // entirely. Only intercepts the close when this window has an in-flight
    // write of its own.
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const win = getCurrentWindow();
        Promise.resolve(win.onCloseRequested(async (event) => {
            // 🆕 2026-09-30: same reasoning as `handleClose` above — a native
            // close (titlebar X, Alt+F4, OS shutdown) must not be able to
            // bypass a period edit that never naturally blurred. Read
            // `pending` AFTER this, not before, so a write this
            // call itself just kicked off is included below.
            // A training run is active: keep the window and ask (in-window alertdialog) —
            // unless the workspace is closing or an earlier "stop and close" gave up.
            if (queueRef.current.isRunningNow() && !closeBypassRef.current) {
                event.preventDefault();
                setCloseAsk(true);
                return;
            }
            flushFocusedInput();
            // A set-point draft typed but never blurred is a pending write too.
            void commitSetPointDrafts();
            const pending = pendingSaveRef.current;
            // A running "Mark complete" (export + save) counts as pending too.
            if (!pending && markRunsRef.current.size === 0) return;
            event.preventDefault();
            if (!(await flushAllPending())) return;
            await win.close();
        })).then(fn => { if (disposed) fn(); else unlisten = fn; });
        return () => { disposed = true; if (unlisten) unlisten(); };
    }, [flushAllPending, commitSetPointDrafts]);

    // The Dashboard that opened this window is going away (Back to Import / another
    // project): it closes this window right after. A run would hold that close
    // (the dialog above), so the window would outlive its project. Drop the run and
    // close without asking. Scoped to this window's workspace and dataset — a late
    // copy for an earlier project must not close a window already re-pointed.
    const generationRef = useRef<number | undefined>(undefined);
    generationRef.current = generation;
    useEffect(() => {
        const off = subscribe<{ workspaceId?: string; generation?: number }>('workspace-closing', (event) => {
            if (!workspaceIdRef.current || event.payload?.workspaceId !== workspaceIdRef.current) return;
            const g = event.payload?.generation;
            if (typeof g === 'number' && generationRef.current !== undefined && g !== generationRef.current) return;
            const wasHeld = queueRef.current.isRunningNow() || closeAskRef.current;
            closeBypassRef.current = true;
            queueReset();
            setCloseAsk(false);
            // A close that already arrived was held by the dialog: close now.
            if (wasHeld) void closeNowRef.current();
        });
        return () => off();
    }, [queueReset]);

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
    /** The model on screen, for code that finishes after an await (`executeTrain`). */
    const activeModelIdRef = useRef<string | null>(null);
    activeModelIdRef.current = activeModel?.id ?? null;

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
        // A training run owns the sidecar: two calls must never run at once. The
        // effect runs again when the run ends (`queue.isRunning` is a dependency).
        if (queue.isRunning) return;
        const p = executeTrain(activeModel, fp, { persistMeta: false });
        autoRecomputeRef.current = p;
        void p.finally(() => { if (autoRecomputeRef.current === p) autoRecomputeRef.current = null; });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, activeModel?.trainedFingerprint, activeModel?.lastTrainedAt, activeModel?.status, activeModel?.category, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionNoneConfirmed, queue.isRunning, activeModel ? trainResults[activeModel.id]?.fingerprint : undefined]);

    // ---- Health preview + Sub-models for the ACTIVE model (health score 3b-1) ----
    // ONE `useHealthPreview` call feeds both pages of the detail pane: the bounded
    // series/stats Rust returns for the Model fit charts and (3b-2) the score of
    // the Health score page. It is given the DRAFT-merged model (same as Train),
    // so an unsaved edit that changes the training inputs makes it idle ("stale")
    // while the last data stays on screen under the "Out of date" overlay.
    const activeEffective = activeModel ? effectiveModelFor(activeModel) : null;
    const activeFingerprint = activeEffective ? computeTrainFingerprint(activeEffective, gateFg) : null;
    const activeStale = activeEffective ? isModelStaleFor(activeEffective, gateFg, specialRecipes) : false;
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
    // A Relation-model preview that scores scoring periods may have to run the
    // sidecar for their rows (~15 s, e.g. right after the scoring periods
    // changed) — say so, but only once it has been loading for a moment:
    // set-point typing re-scores from Rust's cache in well under a second and must
    // not flash the hint.
    // The Relation-model fit is no longer in Rust's cache (NOT_FITTED — e.g. evicted
    // during a long Train all): forget the session result, so the auto-recompute
    // above re-fits it once no run is active (once per model and fingerprint), and
    // plan it as ready for Train sensor / Train all meanwhile.
    useEffect(() => {
        if (!activeModel || !healthPreview.notFitted) return;
        const id = activeModel.id;
        setNotFittedIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
        const key = `${id}::${activeFingerprint}`;
        if (refitTriedRef.current.has(key)) return;
        refitTriedRef.current.add(key);
        setTrainResults(prev => {
            if (!(id in prev)) return prev;
            const rest = { ...prev };
            delete rest[id];
            return rest;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, healthPreview.notFitted, activeFingerprint]);
    // ...and the mark goes once the preview of that model loads again.
    useEffect(() => {
        if (!activeModel || !healthPreview.data || healthPreview.notFitted || healthPreview.loading) return;
        const id = activeModel.id;
        setNotFittedIds(prev => {
            if (!prev.has(id)) return prev;
            const rest = new Set(prev);
            rest.delete(id);
            return rest;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, healthPreview.data, healthPreview.notFitted, healthPreview.loading]);
    const scoringTestsNow = !!activeEffective && activeEffective.kind === 'relationship' && healthPreview.loading
        && testPeriodsWireFor(activeEffective, gateFg) !== undefined;
    const slowScoring = useDelayedFlag(scoringTestsNow, SLOW_SCORING_HINT_DELAY_MS);

    // The last validate verdict Rust gave for the active model. A stale model's old data
    // does not count. It drives the step bar live; the "Set points needed" / "Fix set point"
    // tab pills and dots (here AND on the Dashboard) read the PERSISTED copy of it
    // (`healthVerdict` on the model, QA fix 2026-10-04), written by the effect below.
    const activeVerdict: HealthVerdict | null = activeModel && !activeStale ? healthVerdict(healthPreview.data) : null;
    const verdictToPersist: HealthVerdictValue | null = activeVerdict === 'valid' ? 'valid' : activeVerdict === 'needs' ? 'incomplete' : activeVerdict === 'bad' ? 'invalid' : null;
    const activeHasDraft = !!activeModel && activeModel.id in spDrafts;
    useEffect(() => {
        const ws = workspaceIdRef.current;
        if (!ws || loading || !activeModel || !verdictToPersist || activeModel.healthVerdict === verdictToPersist) return;
        // Only a verdict that is about the SAVED set points: the answer must be settled (not
        // loading / failed), nothing typed but unsaved, and what the preview used must equal
        // what is on disk (an unseeded Individual model previews its master prefill).
        if (!healthReady || healthPreview.loading || healthPreview.error || activeHasDraft) return;
        if (!sameSetPoints(activeModel.healthSetPoints, persistedSetPointsOf(activeModel))) return;
        void trackPending((async () => {
            const next = await commitHealthVerdict(ws, activeModel.id, verdictToPersist, 'build-model');
            if (workspaceIdRef.current === ws) applyWritten(next);
        })());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, activeModel?.id, activeModel?.healthVerdict, activeModel?.healthSetPoints, verdictToPersist, healthReady, healthPreview.loading, healthPreview.error, activeHasDraft]);

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
    // 🆕 2026-10-09: the stats only count for the model + criteria sensor + filter they were
    // fetched for. The reset below runs in an effect, i.e. AFTER the render that switched the
    // criteria sensor A -> B, so in that render the state still held A's stats — the auto-divide
    // effect read them as B's, divided B's ranges over A's [min, max] and locked that result
    // (a wrong training scope). Deriving per render means stats for another key read as "not
    // arrived yet", so the divide waits for B's own stats.
    // The workspace id is part of the key: a duplicated workspace has the SAME model ids (and
    // often the same criteria sensor + filter), so without it a window re-pointed at the copy
    // would keep reading the other workspace's stats as its own and never fetch again.
    const criteriaStatsKey = (activeModel && activeModel.kind === 'clustering' && criteriaSensorForActive)
        ? `${workspaceId ?? ''}::${activeModel.id}::${criteriaSensorForActive}::${criteriaFilterKey}`
        : '';
    const criteriaStats: SensorStats | null = (criteriaStatsEntry && criteriaStatsEntry.key === criteriaStatsKey)
        ? criteriaStatsEntry.stats
        : null;
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
        setCriteriaStatsEntry(null);
        if (!activeModel || activeModel.kind !== 'clustering' || !criteriaSensorForActive) {
            return;
        }
        let cancelled = false;
        const key = criteriaStatsKey;
        const filter = criteriaFilterKey ? JSON.parse(criteriaFilterKey) : null;
        invoke<SensorStats>('compute_sensor_stats', { sensor: criteriaSensorForActive, filter })
            .then(s => { if (!cancelled) setCriteriaStatsEntry({ key, stats: s }); })
            .catch(() => { if (!cancelled) setCriteriaStatsEntry(null); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, criteriaFilterKey, criteriaStatsKey]);

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
        // Empty ranges left in the DRAFT by a pending division (below) still need the real
        // one, even once the key/length look settled (e.g. after a model switch and back).
        const pendingInDraft = (drafts[activeModel.id]?.ranges ?? []).some(r => r.min === null || r.max === null);
        // `drafts` is read fresh on each run but is not a dependency: the stats landing is the trigger.
        if (!keyChanged && !lengthMismatch && !pendingInDraft) return;
        if (!criteriaStats) {
            // 🆕 2026-10-09: the division is PENDING until the criteria sensor's stats arrive.
            // For 2+ clusters the draft gets EMPTY ranges meanwhile, so the "Fill in the cluster
            // ranges" check blocks Save and Train: a placeholder range persisted now would
            // become the saved key and the real division would never happen — a 500-900
            // sensor would then train clusters with no rows. The stats landing re-runs this
            // effect and fills them in. One cluster is never blocked: Rust ignores
            // `cluster_ranges` when `n_clusters == 1`, so a 0-100 placeholder there is
            // harmless and only re-divided to keep the saved ranges tidy.
            if (numClustersForActive > 1) {
                const current = draftOf(activeModel).ranges;
                if (current.length === numClustersForActive && current.every(r => r.min === null && r.max === null)) return;
                writeDraft(activeModel, { ranges: Array.from({ length: numClustersForActive }, () => ({ min: null, max: null })) });
                return;
            }
            // 1 cluster: only a length mismatch can't wait (no valid range set to show).
            if (!lengthMismatch) return;
        }
        // Only a division over the REAL [min, max] settles the key. A 1-cluster length fix
        // made before the stats arrive (0-100 placeholder) leaves it open, so the stats
        // landing re-divides over the real range and the saved range stays tidy.
        if (criteriaStats) prevClusterDivisionKeyRef.current[activeModel.id] = divisionKey;
        const lo = criteriaStats?.min ?? 0;
        const hi = criteriaStats?.max ?? 100;
        const step = (hi - lo) / numClustersForActive;
        const ranges = Array.from({ length: numClustersForActive }, (_, i) => ({
            min: lo + step * i,
            max: lo + step * (i + 1),
        }));
        writeDraft(activeModel, { ranges });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, numClustersForActive, clusterRangesLenForActive, criteriaStats, persistedClusterKeyForActive]);

    // A cluster boundary being typed never survives a model switch: a valid one was already
    // committed to its own model by the box's blur (which fires before the click that switches);
    // an invalid one (and its error) is dropped, never shown on — or written into — another model.
    useEffect(() => { setBoundaryEdit(null); }, [activeModel?.id]);

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
        // No train period = nothing is trained on (rule 1): no whole-dataset count.
        enabled: !loading && rcConfigured && !persistedPeriodsInvalid && runningConditionTimePeriods.length > 0,
        workspaceId, sensor: rcCountSensor, filter: persistedCountFilter, cache: rowCountCache,
    });
    const draftRows = useRowCountPreview({
        enabled: !loading && rcFilterOpen && !draftPeriodsInvalid && (rcDraft ?? { periods: runningConditionTimePeriods }).periods.length > 0,
        workspaceId, sensor: rcCountSensor, filter: draftCountFilter, cache: rowCountCache, debounceMs: 300,
    });
    // Train running time of the ACTIVE Custom model (its own condition + train
    // periods, draft included) for the amber "below the recommended train time"
    // note (`trainDaysEstimateFor`) — the Step-1 counts above are the workspace's.
    // Only asked while the model could train (nothing blocks it).
    const activeCustomScope = activeEffective && activeEffective.runningConditionMode === 'custom'
        && getBuildBlockReason(activeEffective, gateFg, gateHeaders) === null
        ? effectiveRunningCondition(activeEffective, gateFg) : null;
    const customRows = useRowCountPreview({
        enabled: !loading && activeCustomScope !== null,
        workspaceId,
        sensor: rcCountSensor,
        filter: activeCustomScope ? buildPreviewFilterPayload(activeCustomScope, gateHeaders) : null,
        cache: rowCountCache,
        debounceMs: 300,
    });

    // The Dashboard may have changed its highlights since this window opened:
    // re-read them whenever the Running condition settings open.
    useEffect(() => {
        if (rcFilterOpen) void refreshHighlights();
    }, [rcFilterOpen, refreshHighlights]);

    // Esc closes the Running condition modal — through the same dirty-draft
    // guard as X / backdrop. Registered in the CAPTURE phase and ignored while a
    // nested sensor picker is open: that picker closes itself on Esc (its own
    // window listener), and by the time a bubble-phase listener of ours ran,
    // React may already have unmounted it, so this one Esc would close both.
    useEffect(() => {
        if (!rcFilterOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            if (isPickerSurfaceOpen()) return;
            requestCloseRc();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [rcFilterOpen, requestCloseRc]);

    // ---- Train queue: stable props for the memoised parts ----
    // A run updates the window ~3 times per model. The run strip (`RunStrip`) and
    // the Model fit charts (`ModelFitPage`) are memoised, so their props must not
    // change identity on those renders: labels come from a memo over `allModels`,
    // and the callbacks forward to `actionsRef`, refreshed on every render.
    const runRowsById = useMemo(
        () => new Map<string, TrainRowModel>(allModels.map(m => [m.id, { id: m.id, kind: m.kind, tag: modelTagOf(m), groupNos: m.groupNos, plan: LABEL_ONLY_PLAN }])),
        [allModels],
    );
    const actionsRef = useRef<{
        runDetails: () => void;
        runCancel: () => void;
        runDismiss: () => void;
        runCloseWindow: () => void;
        runNotStarted: () => void;
        fitX: (tag: string) => void;
        compare: () => void;
        spChange: (next: HealthSetPoints, commit?: boolean) => void;
        spCommit: () => void;
        retrain: () => void;
    } | null>(null);
    const onRunDetails = useCallback(() => actionsRef.current?.runDetails(), []);
    const onRunCancel = useCallback(() => actionsRef.current?.runCancel(), []);
    const onRunDismiss = useCallback(() => actionsRef.current?.runDismiss(), []);
    const onRunCloseWindow = useCallback(() => actionsRef.current?.runCloseWindow(), []);
    const onRunNotStarted = useCallback(() => actionsRef.current?.runNotStarted(), []);
    const onFitX = useCallback((tag: string) => actionsRef.current?.fitX(tag), []);
    const onCompare = useCallback(() => actionsRef.current?.compare(), []);
    const onSpChange = useCallback((next: HealthSetPoints, commit?: boolean) => actionsRef.current?.spChange(next, commit), []);
    const onSpCommit = useCallback(() => actionsRef.current?.spCommit(), []);
    const onRetrainActive = useCallback(() => actionsRef.current?.retrain(), []);

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
    }

    const periodStatus = validatePeriods(runningConditionTimePeriods);
    // Step-1 card / step bar / lock message / Train buttons all read the PERSISTED condition.
    const rcPersistedInvalid = periodStatus.some(st => st.invalid);
    const rcStepState: RcStepState = !rcConfigured ? 'unset' : rcPersistedInvalid ? 'invalid' : 'set';

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModelsCount = allModels.length;
    const completeModelsCount = allModels.filter(isModelDone).length;

    /** The status of one model for the left list's dot / the tab pill. A failed
     *  run of this session overrides an otherwise "trained" model. */
    const dotStateOf = (m: FailureModel): ModelDotState => {
        const st = modelDotState(effectiveModelFor(m), gateFg, gateHeaders, specialRecipes);
        return st === 'trained' && trainError[m.id] ? 'stale' : st;
    };

    // ---- Train queue (customer batch items 8 + 9) ----
    /** Trained and up to date, not Complete yet: set points (then Mark complete) are next. */
    const needSetPoints = (m: FailureModel): boolean => dotStateOf(m) === 'trained';
    /** Every model in run order: by sensor, I → R → C within a sensor. */
    const runOrder = sensorGroupsAll.flatMap(sg => KIND_ORDER.flatMap(k => sg.models.filter(m => m.kind === k)));
    const allCandidates = runOrder.map(candidateOf);
    const allCounts = countTrainPlans(allCandidates);
    const trainRows: TrainRowModel[] = runOrder.map((m, i) => ({
        id: m.id, kind: m.kind, tag: modelTagOf(m), groupNos: m.groupNos.length ? m.groupNos : [0], plan: allCandidates[i].plan,
    }));
    const trainGroups: TrainGroupInfo[] = [
        ...realGroups.map(g => ({ no: g.no, name: g.name, color: FG_ACCENT[getFgGroupColor(g.no)] })),
        { no: 0, name: '', color: FG_ACCENT[getFgGroupColor(0)] },
    ];
    /** Why BOTH Train buttons are disabled (shared rule). A workspace without a
     *  running condition only blocks when nothing can train anyway (a Custom
     *  model with its own condition can still train). */
    const trainAllReason = trainButtonsBlockedReason({
        stale: queue.stale,
        runningConditionSet: rcStepState !== 'unset' || allCounts.ready > 0,
        running: queue.isRunning,
        readyCount: allCounts.ready,
    });
    const reasonToneOf = (reason: string | null): TrainReasonTone =>
        reason === TRAIN_STALE_MESSAGE ? 'danger' : reason === TRAIN_NEEDS_RUNNING_CONDITION ? 'warn' : 'neutral';
    /** Show a model (sensor + kind tab + page); used by Fix → / Open → / Next needing set points. */
    const focusModel = (id: string, page: WorkbenchPage = 'model') => {
        const m = allModels.find(x => x.id === id);
        if (!m) return;
        const key = modelSensorKey(m);
        setSelectedSensorKey(key);
        setActiveTab(prev => ({ ...prev, [key]: m.id }));
        setPage(m, page);
    };
    const fixModel = (id: string, fix: TrainFixTarget) => {
        setTrainAllView(null);
        focusModel(id, 'model');
        if (fix === 'settings') setSettingsOpenOverride(prev => ({ ...prev, [id]: true }));
        else if (fix === 'runningCondition') setRcFilterOpen(true);
    };
    const closeTrainAll = () => setTrainAllView(null);
    const keepTraining = () => setCloseAsk(false);
    const startTrainAll = () => {
        if (queue.start(allCandidates, { includeUpToDate, source: 'all' })) setTrainAllView('run');
    };
    const retryModels = (ids: string[]) => {
        const ms = ids.map(id => allModels.find(m => m.id === id)).filter((m): m is FailureModel => !!m);
        queue.start(ms.map(candidateOf), { includeUpToDate: true, source: 'retry' });
    };
    actionsRef.current = {
        runDetails: () => setTrainAllView('run'),
        runCancel: () => queue.stopAfterCurrent('cancel'),
        runDismiss: () => { queue.dismiss(); setTrainAllView(v => (v === 'run' ? null : v)); },
        runCloseWindow: () => { void closeNow(); },
        runNotStarted: () => retryModels(queue.summary?.notStartedIds ?? []),
        fitX: (tag: string) => { if (activeModel) changeScatterX(activeModel.id, tag); },
        // One sidecar call at a time: no Sub-models comparison while a run is active.
        compare: () => { if (!queueRef.current.isRunningNow()) openCompare(); },
        spChange: (next: HealthSetPoints, commit?: boolean) => { if (activeModel) changeSetPoints(activeModel, next, commit); },
        spCommit: () => { void commitSetPointDrafts(); },
        retrain: () => { if (activeModel) trainOnly(activeModel); },
    };
    /** Why a Re-train button cannot train now (the model's own block, out-of-date data, a run), else undefined. */
    const retrainBlockOf = (m: FailureModel): string | undefined =>
        buildBlockReason(m) ?? (queue.stale ? TRAIN_STALE_MESSAGE : queue.isRunning ? TRAIN_RUN_ACTIVE_REASON : undefined);
    /** "Set points needed" list chip: only after a run trained something here. */
    const spCount = sensorGroupsAll.filter(sg => sg.models.some(needSetPoints)).length;
    const showSpChip = !!queue.lastTrained && queue.lastTrained.ids.length > 0 && spCount > 0;
    const listFilter: SidebarFilter = sidebarFilter === 'sp' && !showSpChip ? 'all' : sidebarFilter;

    const sensorBuildBlocked = (sg: SensorModelGroup) => sg.models.some(m => buildBlockReason(m) !== null);
    const sensorAllComplete = (sg: SensorModelGroup) => sg.models.length > 0 && sg.models.every(isModelDone);
    const matchesSidebarFilter = (sg: SensorModelGroup) =>
        listFilter === 'all' ? true
            : listFilter === 'attn' ? sensorBuildBlocked(sg)
            : listFilter === 'sp' ? sg.models.some(needSetPoints)
            : sensorAllComplete(sg);
    const matchesSearch = (sg: SensorModelGroup) => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        const first = sg.models[0];
        if (!first) return false;
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        // Search matches description, tag, unit and component (DESIGN_SYSTEM §4).
        return keyTag ? sensorHaystack(sensorLookup(keyTag)).includes(q) : false;
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
        const label = keyTag ? sensorTitle(sensorLookup(keyTag)) : title;
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
                <div style={{ minWidth: 0 }} data-testid="sensor-row-label" title={label}>
                    {/* Customer item 3: the stacked SensorLabel (unit chip, tag on line 2). */}
                    {keyTag ? <SensorLabel tag={keyTag} /> : <div className="f4-sr-title">{title}</div>}
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
                        // A trained model whose SAVED set points Rust rejected reads red ("Fix set
                        // point") — the persisted verdict, the same one the Dashboard dot reads.
                        const fixSetPoint = setPointFlagOf(m, st) === 'fix';
                        // A run that failed in THIS session is red too (same dot as its kind tab).
                        const failedRun = !!trainError[m.id];
                        const dot = fixSetPoint || failedRun ? 'bad' : DOT_CLASS[st];
                        return (
                            <span
                                key={m.id}
                                data-testid={`sensor-kind-badge-${m.id}`}
                                className={`f4-kb model-kind-icon--${m.kind}`}
                                title={`${KIND_LABEL[m.kind]} · ${failedRun ? TRAIN_FAILED_WORDS : fixSetPoint ? 'Fix set point' : DOT_TITLE[st]}`}
                            >
                                {KIND_ABBREV[m.kind]}
                                {dot && <span data-testid={`sensor-kind-badge-dot-${m.id}`} data-state={st} className={`f4-kb-dot f4-kb-dot--${dot}`} aria-hidden="true" />}
                                {/* Train queue: dashed ring = queued, spinner = training now. */}
                                {queue.isRunning && queue.itemOf(m.id)?.state === 'queued' && (
                                    <span className="tq-qring" data-testid={`sensor-kind-badge-queued-${m.id}`} title="Queued in the run" />
                                )}
                                {queue.isRunning && queue.itemOf(m.id)?.state === 'running' && (
                                    <span className="tq-busy" data-testid={`sensor-kind-badge-running-${m.id}`} title="Training now"><Loader2 size={11} className="pm-spin" aria-hidden="true" /></span>
                                )}
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
        const pctOf = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
        const ranges = d.ranges;
        // A boundary the user typed shows exactly as typed while it is still the stored value.
        const typedOf = (i: number, v: number | null) => {
            const t = typedBoundaryText[`${m.id}:${i}`];
            return t && v !== null && t.value === v ? t.text : null;
        };
        const fmt = (v: number | null, typedIdx?: number) => {
            if (v == null) return '—';
            const t = typedIdx === undefined ? null : typedOf(typedIdx, v);
            return t !== null ? fmtNumText(t) : fmtClusterBound(v);
        };
        const edit = boundaryEdit && boundaryEdit.modelId === m.id ? boundaryEdit : null;
        const errorId = `cluster-bound-error-${m.id}`;
        /** Typed boundary `idx` (between cluster idx+1 and idx+2): Enter / blur commit, Esc reverts.
         *  Must stay strictly between its neighbours and inside the criteria sensor's [min, max];
         *  anything else shows the inline error and is not committed. */
        const commitBoundary = (idx: number) => {
            if (!edit || edit.idx !== idx) return;
            const text = edit.text.trim();
            if (text === edit.initial.trim()) { setBoundaryEdit(null); return; }
            // A comma is only a thousands separator ("1,234.5"); anything else ("33,6") is a
            // decimal comma and would silently become 336 if stripped — refuse it instead.
            if (text.includes(',') && !THOUSANDS_GROUPED.test(text)) {
                setBoundaryEdit({ ...edit, error: 'Use . for decimals (e.g. 33.6).' });
                return;
            }
            const clean = text.replace(/,/g, '');
            const v = clean === '' ? NaN : Number(clean);
            if (!Number.isFinite(v)) { setBoundaryEdit({ ...edit, error: 'Enter a number.' }); return; }
            const current = draftOf(m).ranges;
            const key = `${m.id}:${idx}`;
            // The same number typed another way ("4" -> "4.0"): keep the typed form, but no draft.
            if (v === (current[idx]?.max ?? hi)) {
                setTypedBoundaryText(prev => ({ ...prev, [key]: { value: v, text: clean } }));
                setBoundaryEdit(null);
                return;
            }
            const low = Math.max(lo, current[idx]?.min ?? lo);
            const high = Math.min(hi, current[idx + 1]?.max ?? hi);
            if (!(v > low && v < high)) {
                setBoundaryEdit({ ...edit, error: `Enter a value between ${fmt(low, idx - 1)} and ${fmt(high, idx + 1)} — boundaries stay in order inside the ${sensorLabel(d.criteria)} range.` });
                return;
            }
            patchDraft(m, { ranges: current.map((r, i) => (i === idx ? { ...r, max: v } : i === idx + 1 ? { ...r, min: v } : r)) });
            setTypedBoundaryText(prev => ({ ...prev, [key]: { value: v, text: clean } }));
            setBoundaryEdit(null);
        };

        const startSplitDrag = (idx: number, e: React.MouseEvent) => {
            e.preventDefault();
            setBoundaryEdit(null); // a drag replaces whatever was being typed
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
                                title={`Cluster ${i + 1}: ${fmt(segLo, i - 1)} – ${fmt(segHi, i)}`}
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
                                title={`${fmt(splitVal, i)}`}
                            />
                        );
                    })}
                </div>
                {/* Value pills (2026-10-09): every inner boundary is typeable — the upper bound of
                    clusters 1..N-1 is an input (the next pill's lower bound mirrors it); the
                    outer bounds are the criteria sensor's own min / max and stay read-only. */}
                <div className="pm-cluster-slider-values">
                    {ranges.map((r, i) => {
                        const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
                        const last = i === ranges.length - 1;
                        const upper = r.max ?? hi;
                        const editing = edit && edit.idx === i ? edit : null;
                        const shown = typedOf(i, upper) ?? clusterBoundInputText(upper);
                        return (
                            <span key={`pill-${i}`} className="pm-cluster-slider-pill" data-testid={`cluster-pill-${i}`}>
                                <span className="pm-cluster-range-dot" style={{ background: color }} />
                                #{i + 1}: {fmt(r.min ?? lo, i - 1)} –{' '}
                                {last ? fmt(upper) : (
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        className={`pm-cluster-bound-input${editing?.error ? ' pm-cluster-bound-input--bad' : ''}`}
                                        data-testid={`cluster-bound-${i}`}
                                        aria-label={`Boundary between cluster ${i + 1} and ${i + 2}`}
                                        aria-invalid={editing?.error ? true : undefined}
                                        aria-describedby={editing?.error ? errorId : undefined}
                                        value={editing ? editing.text : shown}
                                        onFocus={() => { if (!editing) setBoundaryEdit({ modelId: m.id, idx: i, text: shown, initial: shown, error: null }); }}
                                        onChange={e => {
                                            const text = e.target.value;
                                            setBoundaryEdit(prev => ({ modelId: m.id, idx: i, initial: prev && prev.modelId === m.id && prev.idx === i ? prev.initial : shown, text, error: null }));
                                        }}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') { e.preventDefault(); commitBoundary(i); }
                                            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setBoundaryEdit(null); }
                                        }}
                                        onBlur={() => commitBoundary(i)}
                                    />
                                )}
                            </span>
                        );
                    })}
                </div>
                {edit?.error && (
                    <div id={errorId} role="alert" className="f4-req-note" data-testid="cluster-bound-error">{edit.error}</div>
                )}
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
                        {/* Customer item 3: predictors as chips (× removes one) + a dashed
                            "Add…" that opens the multi modal; the target is excluded and the
                            scope line says so. */}
                        <SensorPickerModal
                            sensors={allSensors}
                            getComponent={getComponent}
                            selected={d.predictors}
                            excluded={[m.targetSensor ?? '']}
                            onConfirm={predictors => patchDraft(m, { predictors })}
                            noun="predictors"
                            invalid={d.predictors.length === 0}
                            scope={<>All sensors except the target · {allSensors.filter(s => s !== m.targetSensor).length}</>}
                        />
                        {d.predictors.length === 0 && (
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
                        <div className="f4-readout f4-readout--sl" title={m.xSensor ? sensorTitle(sensorLookup(m.xSensor)) : undefined}>
                            <Lock size={12} aria-hidden="true" />
                            {m.xSensor ? <SensorInline tag={m.xSensor} fit /> : <span>—</span>}
                        </div>
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Y sensor (target)</span>
                        <IncompleteHint />
                        <SensorPickerModal
                            sensors={allSensors}
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
                            getComponent={getComponent}
                            single
                            allowNone
                            value={d.criteria}
                            // Cleared (None or the trigger's ×, 2026-10-09): without a criteria
                            // sensor there is only one cluster (every row) — Rust rejects 2+ — so
                            // the count drops to 1 in the same draft edit and the model stays
                            // trainable. Its ranges are dropped on Save (`draftFields`).
                            onSelect={criteria => patchDraft(m, criteria ? { criteria } : { criteria: '', numClusters: 1 })}
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
                single (the shared single picker), AND/OR via .f4-seg--andor, "No condition" via
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
                                Copied <b>{seedNoteFor[m.id]!.periods} train period{seedNoteFor[m.id]!.periods === 1 ? '' : 's'}</b>, <b>{seedNoteFor[m.id]!.tests} scoring period{seedNoteFor[m.id]!.tests === 1 ? '' : 's'}</b> and {seedNoteFor[m.id]!.conditions} condition{seedNoteFor[m.id]!.conditions === 1 ? '' : 's'} from Workspace. Edits here affect only this model.
                            </span>
                            <button type="button" className="f4-x" aria-label="Dismiss" onClick={() => setSeedNoteFor(prev => ({ ...prev, [m.id]: null }))}><X size={12} /></button>
                        </div>
                    )}

                    <div className="f4-side-blk" data-testid="custom-periods">
                        <div className="f4-slabel">
                            <span><i className="tpe-sw tpe-sw--tr" aria-hidden="true" /> Train periods <span className="f4-count">{d.customPeriods.length}</span></span>
                            <span className="f4-note f4-note--faint">required · healthy running time only</span>
                        </div>
                        <div className="rc-scroll">
                            <TimePeriodsEditor compact periods={d.customPeriods} onChange={periods => patchDraft(m, { customPeriods: periods })} bounds={datasetBounds} tests={d.customTestPeriods} />
                        </div>
                        <TrainHighlightWarnings periods={d.customPeriods} highlights={dashHighlights} onPeriodsChange={periods => patchDraft(m, { customPeriods: periods })} />
                    </div>

                    <div className="f4-side-blk" data-testid="custom-test-periods">
                        <div className="f4-slabel">
                            <span><i className="tpe-sw tpe-sw--te" aria-hidden="true" /> Scoring periods <span className="f4-count">{d.customTestPeriods.length}</span></span>
                            <span className="f4-note f4-note--faint">the trained model gives a health score for this time · needed before Mark complete · may include train time</span>
                        </div>
                        <TestPeriodsEditor
                            compact
                            blocks="save"
                            tests={d.customTestPeriods}
                            train={d.customPeriods}
                            onChange={tests => patchDraft(m, { customTestPeriods: tests })}
                            bounds={datasetBounds}
                        />
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
                                                    getComponent={getComponent}
                                                    single
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
        // Queued or training in the run: read-only until it has trained.
        if (queue.isLocked(m.id)) {
            return (
                <LockedSettingsHeader
                    summary={settingsSummaryLine(m, d)}
                    queued={queue.itemOf(m.id)?.state === 'queued'}
                    onRemove={() => { queue.removeFromRun(m.id); }}
                />
            );
        }
        const missing = missingItems(m);
        // Opens by itself when the thing to fix is INSIDE it: a missing setting, or a
        // Custom model's own running condition (that editor lives in this section).
        // The user's own open / close (the override) still wins.
        const isOpen = settingsOpenOverride[m.id] ?? (missing.length > 0 || customFixInside(m));
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

    /** "Fix set point" / "Set points needed" for a TRAINED model: the persisted verdict
     *  (`modelSetPointFlag`, the one the Dashboard dot reads), except that the model on
     *  screen follows its live verdict as soon as Rust has answered for what is typed
     *  (the persisted copy catches up once the set points are saved). */
    const setPointFlagOf = (m: FailureModel, st: ModelDotState): SetPointFlag => {
        if (st !== 'trained') return null;
        if (activeModel && m.id === activeModel.id && activeVerdict !== null) {
            return activeVerdict === 'bad' ? 'fix' : activeVerdict === 'needs' ? 'needed' : null;
        }
        return modelSetPointFlag(effectiveModelFor(m), gateFg, gateHeaders, st, specialRecipes);
    };

    /** The state dot of a kind tab: colour (the sensor list's colours) + the words of
     *  its tooltip — the central status (`modelDotState`), refined for a trained model
     *  by the verdict on its set points, by the gate badge, and red for a model whose
     *  run failed in this session. */
    const tabDotOf = (m: FailureModel, st: ModelDotState): { dot: 'complete' | 'need' | 'bad' | null; words: string } => {
        if (trainError[m.id]) return { dot: 'bad', words: TRAIN_FAILED_WORDS };
        const flag = setPointFlagOf(m, st);
        const words = gateBadge(m) ?? (flag === 'fix' ? 'Fix set point' : flag === 'needed' ? 'Set points needed' : TAB_WORDS[st]);
        return { dot: flag === 'fix' ? 'bad' : DOT_CLASS[st], words };
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
            // Results carry their WIRE index; the user numbers the full list.
            testNumbers: testPeriodsWirePlan(effectiveRunningCondition(eff, gateFg).testPeriods).numbers,
            slowScoring: activeModel?.id === m.id && slowScoring,
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
    /** "Train sensor ↑": the text link every sentence uses to point at the ONE place
     *  to train (it focuses the header's Train sensor button). */
    const trainSensorLink = (testId: string) => (
        <button type="button" className="tq-inline-link" data-testid={testId} onClick={() => trainSensorBtnRef.current?.focus()}>
            Train sensor ↑
        </button>
    );
    /** The ONE board shape of every chart-less state (SPEC workbench-redesign §1): a
     *  title, one sentence and an optional mono line. Its actions are text links to
     *  the one place for them ("Train sensor ↑", "Model settings", "Running
     *  condition ↑") — never a button of its own. */
    const board = (testId: string, tone: 'plain' | 'bad' | 'run', title: ReactNode, text?: ReactNode, detail?: ReactNode) => (
        <div className="bmw-stage">
            <div className={`bmw-stage-empty wbx-msg${tone === 'plain' ? '' : ` wbx-msg--${tone}`}`} data-testid={testId}>
                <div className="wbx-msg-in">
                    <b className="wbx-msg-t">
                        {tone === 'run' && <Loader2 size={14} className="pm-spin" aria-hidden="true" />}
                        {title}
                    </b>
                    {text && <span className="wbx-msg-s">{text}</span>}
                    {detail && <span className="wbx-msg-d">{detail}</span>}
                </div>
            </div>
        </div>
    );
    const renderModelFitBody = (m: FailureModel) => {
        const reason = buildBlockReason(m);
        const qItem = queue.isRunning ? queue.itemOf(m.id) : undefined;
        if (qItem?.state === 'queued' && queue.run) {
            // Rough wait: the model in training + every model queued before this one.
            const ahead: ModelKind[] = [];
            for (const it of queue.run.items) {
                if (it.id === m.id) break;
                if (it.state === 'running' || it.state === 'queued') ahead.push(it.kind);
            }
            return (
                <QueuedCard
                    kind={m.kind}
                    position={queue.queuePositionOf(m.id)}
                    waitSeconds={roughTrainSeconds(ahead)}
                    current={queue.run.currentId ? runRowsById.get(queue.run.currentId) : undefined}
                />
            );
        }
        if (isModelDone(m) && (reason !== null || !m.lastTrainedAt)) {
            return board('results-placeholder', 'plain', 'Marked complete',
                <>Train it with {trainSensorLink('board-train-sensor')} to see its charts.</>);
        }
        if (reason !== null) {
            // No running condition yet (2026-10-03): a model that FOLLOWS the workspace
            // condition is locked until the workspace running condition is
            // set / fixed — say that first, with a link straight into the
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
                        <div className="bmw-stage-empty wbx-msg" data-testid="results-rc-locked">
                            <div className="wbx-msg-in">
                                <b className="wbx-msg-t">
                                    <Lock size={14} aria-hidden="true" />
                                    {rcStepState === 'invalid' ? 'Fix the running condition first' : 'Set the running condition first'}
                                </b>
                                <span className="wbx-msg-s">
                                    Nothing that follows the workspace running condition can train until it is {rcStepState === 'invalid' ? 'fixed' : 'set'} — open{' '}
                                    <button type="button" className="tq-inline-link" data-testid="results-rc-locked-open" onClick={() => setRcFilterOpen(true)}>
                                        Running condition ↑
                                    </button>
                                </span>
                            </div>
                        </div>
                    )}
                    {items.length > 0 && (
                        <div className="bmw-stage-empty wbx-msg" data-testid="results-incomplete">
                            <div className="wbx-msg-in">
                                <b className="wbx-msg-t">{items.length} item{items.length === 1 ? '' : 's'} to fix before training</b>
                                <ul className="wbx-msg-list">
                                    {items.map((it, i) => (
                                        <li key={i}>
                                            <button type="button" className="bmw-fix-link" onClick={it.onClick}>{it.text}</button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    )}
                </div>
            );
        }
        if (trainStatus[m.id] === 'loading') {
            // "Training" is said only about a model IN THE RUN; a trained model whose
            // result is being worked out again (reopening it) is "Loading" — no time estimate.
            return qItem?.state === 'running'
                ? board('results-loading', 'run', `Training the ${kindModelName(m.kind)} · about ${formatTrainSeconds(ROUGH_TRAIN_SECONDS[m.kind])}`,
                    'Its settings are locked until it finishes. The charts appear here when it is done.')
                : board('results-loading', 'run', `Loading the ${kindModelName(m.kind)}…`, 'The charts appear here when it is ready.');
        }
        const err = trainError[m.id];
        if (err) {
            return board('results-error', 'bad', 'Training failed',
                <>Fix the problem, then train again with {trainSensorLink('board-train-sensor')}. The model keeps its last state.</>, err);
        }
        if (!m.lastTrainedAt) {
            return board('results-placeholder', 'plain', 'Not trained yet',
                <>Train it with {trainSensorLink('board-train-sensor')} — the charts of the trained model appear here.</>,
                `${KIND_TAB_LABEL[m.kind]} · uses ${effectiveModelFor(m).runningConditionMode === 'custom' ? 'its own running condition (Custom)' : 'the workspace running condition'} · ≈ ${formatTrainSeconds(ROUGH_TRAIN_SECONDS[m.kind])}`);
        }
        const props = pagePropsFor(m);
        if (props.stale) {
            // The last charts of this session (if any) stay up under "Out of date".
            return healthPreview.data ? (
                <div data-testid="results-chart" data-stale="true">
                    <ModelFitPage {...props} data={healthPreview.data} onXPredictorChange={onFitX} onCompare={onCompare} compareDisabledReason={queue.isRunning ? TRAIN_RUN_ACTIVE_REASON : undefined} trainDaysEstimate={trainDaysEstimateFor(m)} />
                </div>
            ) : board('results-stale', 'plain', 'Out of date',
                <>Settings changed — re-train with {trainSensorLink('board-train-sensor')} to see the result.</>);
        }
        if (healthPreview.notFitted) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-not-fitted">
                        <div>
                            <b style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '4px' }}>Re-train to recompute</b>
                            The fitted Relation model is no longer in memory (the data was reloaded or a special sensor changed).
                            <div style={{ marginTop: '10px' }}>
                                <button type="button" className="rcx-btn rcx-btn--sm" data-testid="results-not-fitted-retrain" disabled={retrainBlockOf(m) !== undefined} title={retrainBlockOf(m)} onClick={() => trainOnly(m)}>↻ Re-train</button>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }
        if (healthPreview.error && !healthPreview.data) {
            return board('results-health-error', 'bad', "Couldn't load the charts", undefined, healthPreview.error);
        }
        if (!healthPreview.data) {
            // Trained-and-fresh per the workspace's persisted fields, but the
            // auto-recompute / preview has not landed its first result in THIS
            // session yet.
            return board('results-loading', 'run', `Loading the ${kindModelName(m.kind)}…`,
                slowScoring ? <span data-testid="slow-test-scoring">{SLOW_TEST_SCORING_TEXT}</span> : 'The charts appear here when it is ready.');
        }
        return (
            <div data-testid="results-chart">
                <ModelFitPage {...props} data={healthPreview.data} onXPredictorChange={onFitX} onCompare={onCompare} compareDisabledReason={queue.isRunning ? TRAIN_RUN_ACTIVE_REASON : undefined} trainDaysEstimate={trainDaysEstimateFor(m)} />
            </div>
        );
    };

    /** Train running days of a model, estimated from a row count: the Step-1 count
     *  for a Workspace-mode model, the active Custom model's own count
     *  (`customRows`) for a Custom one. Only feeds the amber "below the
     *  recommended train time" note until Rust's exact figure exists (it does once
     *  a scoring period is scored). */
    const trainDaysEstimateFor = (m: FailureModel): number | null => {
        if (effectiveModelFor(m).runningConditionMode === 'custom') {
            return activeModel?.id === m.id && customRows.status === 'ok'
                ? estimateRunningDays(customRows.used, customRows.total, datasetBounds)
                : null;
        }
        return persistedRows.status !== 'ok' ? null : estimateRunningDays(persistedRows.used, persistedRows.total, datasetBounds);
    };

    /** Why Mark complete is not possible right now (the FIRST blocking reason), or
     *  null. Only the active model has a health preview, so this is for the active
     *  model. Rust's validation is the source of "set points not valid". */
    const markCompleteBlock = (m: FailureModel): string | null => {
        // A training run owns the sidecar (a Relation-model export re-runs it): wait for the run.
        if (queue.isRunning) return TRAIN_RUN_ACTIVE_REASON;
        if (isModelStale(m)) return 'Settings changed — re-train first.';
        // Unsaved settings are saved by Mark complete first; ones that cannot be saved block it.
        const draftBlock = m.id in drafts ? modelBlockReason(m) : null;
        if (draftBlock !== null) return draftBlock;
        const gate = gateReasonOf(m);
        if (gate !== null) return gate;
        // At least one valid scoring period (SPEC rule 2) — Train does not need one.
        const noTest = markCompleteBlockReason(effectiveModelFor(m), gateFg);
        if (noTest !== null) return noTest;
        if (!trainedFreshFor(effectiveModelFor(m), gateFg, specialRecipes)) return NOT_TRAINED_BLOCK_REASON;
        if (trainError[m.id]) return "Couldn't refresh the result — fix the problem, then re-train.";
        if (healthPreview.notFitted) return 'Re-train first — the fitted Relation model is no longer in memory.';
        const data = healthPreview.data;
        if (!data) return healthPreview.loading ? 'Checking the set points…' : (healthPreview.error ?? 'The health score could not be loaded.');
        if (healthPreview.loading) return 'Checking the set points…';
        if (!data.valid) {
            const issues = attemptIssues[m.id] ?? data.validation;
            if (verdictOfIssues(issues) === 'bad') {
                const n = Math.max(1, buildCheckLines(data.kind, issues).filter(l => !l.warning).length);
                return `${n} set point${n > 1 ? 's' : ''} not valid — fix before marking complete`;
            }
            // Empty set points are counted from Rust's `required` issues (one per empty set
            // point), not from the Checks lines: a Relation model's 4 empty points collapse
            // into ONE line there, and the footer used to say "1 set point still empty".
            const empty = Math.max(1, issues.filter(i => isBlockingIssue(i) && i.code === 'required').length);
            return `${empty} set point${empty > 1 ? 's' : ''} still empty`;
        }
        return null;
    };

    /** What the Health score page says about the model's saved files. */
    const saveInfoFor = (m: FailureModel): SaveInfo =>
        // "Saved N files" only while the model is still Complete: a change of only its
        // scoring periods makes it Incomplete without touching
        // this session's record, and the old message would then be misleading.
        (saveInfo[m.id]?.phase === 'ok' && !isModelDone(m) ? undefined : saveInfo[m.id]) ?? (m.healthExport && isModelDone(m)
            ? { phase: 'ok', outputDir: m.healthExport.outputDir, files: null, at: m.healthExport.at }
            : { phase: 'idle' });
    /** Complete, but the set points on screen differ from the ones the files were written with. */
    const filesOutOfDateFor = (m: FailureModel): boolean =>
        isModelDone(m) && !!m.healthExport && !sameSetPoints(m.healthExport.setPoints, setPointsOf(m));

    /** "…\workspaces\<id>\output\<sensor>": the saved folder without the machine's own prefix (the full path is the tooltip). */
    const shortOutputDir = (dir: string): string => dir.replace(/^.*([\\/])(workspaces[\\/])/, '…$1$2');

    /** THE one filled button of the detail pane right now (SPEC workbench-redesign §1,
     *  "at most ONE filled button on screen"). Every other button is a ghost or a text
     *  button:
     *   - the running condition is not set / not valid -> none here (its own card has it)
     *   - Model fit:    Save changes while a draft exists · else Train sensor while a
     *                   model of this sensor needs training · else "Next: Health score"
     *                   for a trained model · a Complete model has none
     *   - Health score: Train sensor when THIS model must train again · else Mark
     *                   complete (again, when the files are out of date) · a Complete
     *                   model has none, unless a sibling model needs training
     *  Presentation only: it never enables, disables or hides anything. */
    const primaryActionOf = (m: FailureModel, page: WorkbenchPage, cands: readonly TrainCandidate[]): PrimaryAction => {
        if (rcStepState !== 'set') return null;
        const sensorNeedsTrain = cands.some(c => c.plan.kind === 'ready');
        if (page === 'model') {
            if (m.id in drafts) return 'save';
            if (sensorNeedsTrain) return 'train';
            if (isModelDone(m)) return null;
            return healthPageBlock(m) === null && !queue.isLocked(m.id) ? 'next' : null;
        }
        if (cands.find(c => c.id === m.id)?.plan.kind === 'ready') return 'train';
        if (!isModelDone(m) || filesOutOfDateFor(m)) return 'mark';
        return sensorNeedsTrain ? 'train' : null;
    };

    /** Footer of BOTH pages (SPEC workbench-redesign §1): ONE status pill + ONE
     *  sentence + at most one filled button (`primary`). This is the only place a
     *  model's status is said in words — tabs, list and set-point card carry a dot.
     *  Model fit: "Save changes" (only while a draft exists) · "Next: Health score →"
     *  (NO Mark complete: a model is completed only from the Health score page).
     *  Health score: "← Model fit" · Mark complete ("Mark incomplete", a text
     *  button, once Complete; "Mark complete again" only when the files are out of date). */
    const renderFooter = (m: FailureModel, page: WorkbenchPage, primary: PrimaryAction) => {
        const saveReason = modelBlockReason(m);
        const reason = buildBlockReason(m);
        const cat = categoryOf(m);
        const trainedFresh = isModelTrainedFresh(m);
        const stale = isModelStale(m);
        const training = trainStatus[m.id] === 'loading';
        const done = isModelDone(m);
        // 🆕 QA fix (2026-09-29): a run that failed IN THIS SESSION — whether
        // an explicit Re-train click or the silent auto-recompute on reopen —
        // must override the happy-path pill/footer/Mark-complete-enabled
        // state even though the PERSISTED fields still say "fresh" (nothing
        // was written back on failure).
        const hasSessionError = !!trainError[m.id];
        const pillState: 'complete' | 'trained' | 'incomplete' =
            done ? 'complete' : (trainedFresh && !hasSessionError && reason === null) ? 'trained' : 'incomplete';
        const pillLabel = pillState === 'complete' ? 'Complete' : pillState === 'trained' ? 'Trained' : 'Incomplete';
        const healthBlock = healthPageBlock(m);
        const markBlock = page === 'health' ? markCompleteBlock(m) : null;
        const savePhase = saveInfo[m.id]?.phase;
        const saving = savePhase === 'running';
        const outOfDate = page === 'health' && filesOutOfDateFor(m);
        const scoredCount = toTestPeriodsWire(effectiveRunningCondition(effectiveModelFor(m), gateFg).testPeriods).length;
        // Train queue: queued or training in the run = settings locked (Save disabled).
        const qItem = queue.isRunning ? queue.itemOf(m.id) : undefined;
        const locked = queue.isLocked(m.id);
        const hasDraft = m.id in drafts;
        // The per-model Train button left this footer (customer items 8 + 9): the
        // header's Train sensor is the one place. This link focuses it.
        const goTrainSensor = trainSensorLink('footer-train-sensor');
        // "Trained 9 Feb 2026 23:50 · scored on 2 periods" (what used to be the
        // "Scored · N" pill and the "Last trained" caption).
        const trainedLine: ReactNode = m.lastTrainedAt
            ? <>Trained <Stamp at={m.lastTrainedAt} />{scoredCount > 0 ? ` · scored on ${scoredCount} period${scoredCount === 1 ? '' : 's'}` : ''}</>
            : null;
        const identityLine = `${kindModelName(m.kind)}${cat ? ` · ${CATEGORY_LABELS[cat]}` : ''}`;
        // A successful save is THIS sentence (there is no "Files saved to …" banner).
        const saved = saveInfoFor(m);
        const savedLine: ReactNode = saved.phase === 'ok'
            ? <span data-testid="save-ok">Files saved <Stamp at={saved.at} /> · <span className="hs-path" data-testid="footer-saved-path" title={saved.outputDir}>{shortOutputDir(saved.outputDir)}</span></span>
            : null;

        // The ONE sentence (first match wins).
        let line: ReactNode;
        let tone: 'plain' | 'warn' | 'bad' = 'plain';
        let lineId: 'footer-status' | 'mark-block-reason' | 'build-block-reason' | 'files-out-of-date' = 'footer-status';
        if (page === 'health') {
            if (saving) line = <><Loader2 size={11} className="pm-spin" aria-hidden="true" /> Saving the model files…</>;
            else if (savePhase === 'error') { line = 'Not saved · fix it, then Mark complete again'; tone = 'bad'; }
            else if (done && outOfDate) { line = 'Files out of date — set points changed after saving · Mark complete again to update them'; tone = 'warn'; lineId = 'files-out-of-date'; }
            else if (done) line = savedLine ?? trainedLine ?? identityLine;
            else if (markBlock !== null) { line = markBlock; tone = 'warn'; lineId = 'mark-block-reason'; }
            else line = 'Set points valid — check the score chart, then Mark complete';
        } else if (qItem && locked) {
            line = qItem.state === 'running'
                ? <><Loader2 size={11} className="pm-spin" aria-hidden="true" /> Training now · about {formatTrainSeconds(ROUGH_TRAIN_SECONDS[m.kind])}</>
                : `Queued in the run · ${queue.queuePositionOf(m.id) === 1 ? 'next' : `#${queue.queuePositionOf(m.id)}`}`;
        } else if (reason) { line = reason; tone = 'warn'; lineId = 'build-block-reason'; }
        // An unsaved draft is said here, once (the tab carries no "edited" pill).
        else if (hasDraft) line = `Unsaved changes to the ${kindModelName(m.kind)}`;
        else if (done) line = trainedLine ?? identityLine;
        else if (hasSessionError) { line = <>Training failed · fix the problem, then {goTrainSensor}</>; tone = 'bad'; }
        else if (trainedFresh) line = <>{trainedLine} · check the charts, then set the health set points</>;
        else if (stale) { line = <>Settings changed · re-train with {goTrainSensor}</>; tone = 'warn'; }
        // Also why "Next: Health score →" is disabled.
        else if (!m.lastTrainedAt) line = <>Not trained yet · {goTrainSensor}</>;
        else line = identityLine;

        const markClass = primary === 'mark' ? 'bmw-btn-ok' : 'rcx-btn';
        return (
            <div className="f4-foot wbx-foot" data-testid="wb-footer" data-primary={primary ?? 'none'}>
                {page === 'health' && (
                    <button type="button" className="f4-btn f4-btn--plain f4-btn--small" data-testid="footer-back-to-fit" onClick={() => setPage(m, 'model')}>
                        ← Model fit
                    </button>
                )}
                <span className={`model-status-pill model-status-pill--${pillState}`} data-testid="footer-pill" style={{ cursor: 'default' }}>
                    {pillLabel}
                </span>
                <span
                    data-testid={lineId}
                    data-tone={tone}
                    className={`f4-foot-reason wbx-reason${tone === 'warn' ? ' f4-foot-reason--block' : tone === 'bad' ? ' f4-foot-reason--bad' : ''}`}
                >
                    {tone !== 'plain' && <CircleAlert size={11} aria-hidden="true" />}
                    {line}
                </span>
                {page === 'model' && hasDraft && (
                    <button
                        type="button"
                        className={primary === 'save' ? 'f4-btn-save' : 'rcx-btn'}
                        data-testid="save-changes"
                        disabled={saveReason !== null || locked}
                        title={locked ? 'Settings are locked while this model is in the run' : saveReason ?? undefined}
                        onClick={() => commitModel(m)}
                    >
                        Save changes
                    </button>
                )}
                {page === 'model' && (
                    <button
                        type="button"
                        className={`rcx-btn${primary === 'next' ? ' rcx-btn--pri' : ''}`}
                        data-testid="next-health-score"
                        disabled={healthBlock !== null || training}
                        title={healthBlock ?? undefined}
                        onClick={() => setPage(m, 'health')}
                    >
                        Next: Health score →
                    </button>
                )}
                {page === 'health' && (done ? (
                    <>
                        <button type="button" className="f4-btn f4-btn--plain f4-btn--small" data-testid="mark-incomplete" disabled={saving} onClick={() => markModelIncomplete(m.id)}>
                            Mark incomplete
                        </button>
                        {outOfDate && (
                            <button
                                type="button"
                                className={markClass}
                                data-testid="mark-complete-again"
                                disabled={markBlock !== null || saving}
                                title={markBlock ?? 'Write the files again with the current set points'}
                                onClick={() => { void runMarkComplete(m); }}
                            >
                                {saving ? 'Saving…' : '✓ Mark complete again'}
                            </button>
                        )}
                    </>
                ) : (
                    <button
                        type="button"
                        className={markClass}
                        data-testid="mark-complete"
                        disabled={markBlock !== null || saving}
                        title={markBlock ?? 'Write the model files and mark it complete'}
                        onClick={() => { void runMarkComplete(m); }}
                    >
                        {saving ? 'Saving…' : '✓ Mark complete'}
                    </button>
                ))}
            </div>
        );
    };

    /** The detail header's sensor-level Train (customer items 8 + 9): one primary
     *  "▶ Train sensor · n of m" that trains every model of the sensor that needs
     *  it (I → R → C, up-to-date ones skipped), a ▾ menu ("Train all N models" /
     *  "<Kind> only" — "Re-train …" once trained before, see `sensorTrainMenuCopy`)
     *  and ONE short line under it saying what it will do. The reason a model can't
     *  train is said once, on its own board — this line only points there (the
     *  button's tooltip keeps the full reason). Filled only while it is the pane's
     *  primary action (`primaryActionOf`), a ghost otherwise. */
    const renderSensorTrain = (cands: readonly TrainCandidate[], filled: boolean) => {
        const plans = new Map(cands.map(c => [c.id, c.plan]));
        const ready = orderedDetail.filter(m => plans.get(m.id)?.kind === 'ready');
        const up = orderedDetail.filter(m => plans.get(m.id)?.kind === 'upToDate');
        const cant = orderedDetail.filter(m => plans.get(m.id)?.kind === 'missing');
        const whyOf = (m: FailureModel): string => {
            const p = plans.get(m.id);
            return p && p.kind !== 'ready' ? p.reason : '';
        };
        const name = (m: FailureModel) => KIND_TAB_LABEL[m.kind];
        const names = (list: FailureModel[], sep: string) => list.map(name).join(sep);
        /** "Trains the Relation model", "Trains Individual + Relation model". */
        const trains = (list: FailureModel[]) => `Trains ${list.length === 1 && list[0].kind === 'relationship' ? 'the ' : ''}${names(list, ' + ')}`;
        /** The full reason, for the button's tooltip. */
        const cantDetail = `Can't train: ${cant.map(m => `${name(m)} — ${whyOf(m)}`).join(' · ')}`;
        const thisRunning = queue.isRunning && orderedDetail.some(m => queue.itemOf(m.id)?.state === 'running');
        const inRun = orderedDetail.filter(m => queue.isLocked(m.id));
        // No workspace running condition at all (an invalid period has its own, more specific reason per model).
        const rcBlocks = rcStepState === 'unset' && ready.length === 0;
        let why: string;
        let tone: TrainReasonTone = 'neutral';
        if (queue.stale) { why = TRAIN_STALE_MESSAGE; tone = 'danger'; }
        else if (thisRunning) why = 'Training this sensor…';
        else if (inRun.length) why = `${inRun.length} model${inRun.length === 1 ? '' : 's'} of this sensor queued in the run`;
        else if (rcBlocks) { why = TRAIN_NEEDS_RUNNING_CONDITION; tone = 'warn'; }
        else if (ready.length === 0 && cant.length === 0) why = `${up.length} model${up.length === 1 ? '' : 's'} up to date — nothing to train`;
        else if (ready.length === 0) {
            why = cant.some(m => m.id === activeModel?.id)
                ? "Can't train · see below"
                : `${names(cant, ', ')} can't train · see ${cant.length === 1 ? 'its tab' : 'their tabs'}`;
            tone = 'warn';
        }
        else if (cant.length) { why = `${trains(ready)} · ${names(cant, ', ')} can't train, skipped`; tone = 'warn'; }
        else if (up.length) why = `${trains(ready)} · ${names(up, ', ')} up to date, skipped`;
        else why = `${trains(ready)} · ≈ ${formatTrainSeconds(roughTrainSeconds(ready.map(m => m.kind)))}`;
        const busy = !queue.canStart;
        const title = queue.stale ? TRAIN_STALE_MESSAGE
            : queue.isRunning ? TRAIN_RUN_ACTIVE_REASON
            : rcBlocks ? TRAIN_NEEDS_RUNNING_CONDITION
            : ready.length === 0 ? (cant.length ? cantDetail : why)
            : cant.length ? cantDetail
            : undefined;
        // Menu copy: "Re-train" is only said about a model that has a train record
        // (`lastTrainedAt` — what `isModelStale` / the up-to-date rule read as "was trained").
        const copy = sensorTrainMenuCopy(orderedDetail.map((m, i) => ({ kind: m.kind, plan: cands[i].plan, trainedBefore: !!m.lastTrainedAt })));
        const menu: TrainMenuItem[] = [
            {
                key: 'retrain-all',
                label: copy.all.label,
                small: copy.all.small,
                disabled: busy || ready.length + up.length === 0,
                onClick: () => { queue.start(cands, { includeUpToDate: true, source: 'sensor-all' }); },
            },
            ...orderedDetail.map((m, i): TrainMenuItem => ({
                key: `only-${m.kind}`,
                label: copy.only[i].label,
                small: copy.only[i].small,
                disabled: busy || plans.get(m.id)?.kind === 'missing',
                onClick: () => trainOnly(m),
            })),
        ];
        return (
            <SensorTrainButton
                buttonRef={trainSensorBtnRef}
                filled={filled}
                label={thisRunning ? <><Loader2 size={12} className="pm-spin" aria-hidden="true" /> Training…</> : `▶ Train sensor · ${ready.length} of ${orderedDetail.length}`}
                disabled={busy || ready.length === 0}
                title={title}
                why={why}
                whyTone={tone}
                onTrain={() => { queue.start(cands, { includeUpToDate: false, source: 'sensor' }); }}
                menu={menu}
            />
        );
    };

    /** Health score page after a run: how many trained in it still need set points. */
    const renderRunSetPointsBanner = (m: FailureModel) => {
        const last = queue.lastTrained;
        if (!last || last.ids.length === 0) return null;
        const inRun = last.ids
            .map(id => allModels.find(x => x.id === id))
            .filter((x): x is FailureModel => !!x && needSetPoints(x));
        if (inRun.length === 0) return null;
        const k = inRun.findIndex(x => x.id === m.id);
        const next = [...inRun.slice(k + 1), ...inRun.slice(0, Math.max(k, 0))].find(x => x.id !== m.id);
        return (
            <RunSetPointsBanner
                at={last.finishedAt}
                inRun={inRun.length}
                total={allModels.filter(needSetPoints).length}
                position={k + 1}
                nextDisabled={!next}
                onNext={() => { if (next) focusModel(next.id, 'health'); }}
            />
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
        const page = pageOf(activeModel);
        const stale = isModelStale(activeModel);
        const healthBlock = healthPageBlock(activeModel);
        const training = trainStatus[activeModel.id] === 'loading';
        // One plan per model of the sensor, computed once: the Train sensor button and
        // the one-filled-button rule both read it.
        const cands = orderedDetail.map(candidateOf);
        const primary = primaryActionOf(activeModel, page, cands);
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
                        {/* Customer item 3: the stacked label at header size, component chip after the tag. */}
                        {keyTag
                            ? <h3 className="bmw-dh-sl" aria-label={title}><SensorLabel tag={keyTag} size="lg" after={component ? <span className="comp-chip">{component}</span> : undefined} /></h3>
                            : <h3>{title}</h3>}
                        <div className="bmw-dmeta">
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
                    {/* ONE control group — category switch · page switch · Train sensor — that
                        moves as a row under the name on a narrow pane (never one control per row). */}
                    <div className="wbx-dh-ctl" data-testid="detail-controls">
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
                        healthDisabled={healthBlock !== null}
                        healthDisabledTitle={healthBlock ?? undefined}
                        onPage={p => setPage(activeModel, p)}
                    />
                    {renderSensorTrain(cands, primary === 'train')}
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
                        // No text pill on a tab — ONE dot in the list's colours, the words in the tooltip.
                        const { dot, words } = tabDotOf(m, dotStateOf(m));
                        return (
                            <button
                                key={m.id}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className={`f4-tab${selected ? ' f4-tab--on' : ''}`}
                                style={{ '--kc': KIND_COLOR[m.kind] } as CSSProperties}
                                title={`${KIND_TAB_LABEL[m.kind]} · ${words}`}
                                onClick={() => setActiveTab(prev => ({ ...prev, [selectedSensorKey!]: m.id }))}
                            >
                                <span className={`f4-kmini model-kind-icon--${m.kind}`} aria-hidden="true">{KIND_ABBREV[m.kind]}</span>
                                <span className="f4-tab-l">{KIND_TAB_LABEL[m.kind]}</span>
                                <span
                                    className={`f4-sdot${dot ? ` f4-sdot--${dot}` : ''}`}
                                    data-testid={`tab-status-${m.id}`}
                                    data-dot={dot ?? 'none'}
                                    title={words}
                                    aria-hidden="true"
                                />
                            </button>
                        );
                    })}
                    <span className="f4-tabs-spacer" />
                </div>

                <div role="tabpanel" data-testid={`model-tab-panel-${activeModel.id}`} style={{ display: 'contents' }}>
                    {/* One scroll area for settings + banner + the page body, so the
                        footer below always stays in view however tall the charts are. */}
                    <WorkbenchScroll resetKey={`${activeModel.id}:${page}`} page={page}>
                        {page === 'model' && renderModelSettings(activeModel)}
                        {stale && (
                            <StaleBanner
                                training={training}
                                queued={queue.isRunning && queue.itemOf(activeModel.id)?.state === 'queued'}
                                disabled={buildBlockReason(activeModel) !== null || !queue.canStart}
                                disabledTitle={buildBlockReason(activeModel) ?? (queue.stale ? TRAIN_STALE_MESSAGE : queue.isRunning ? TRAIN_RUN_ACTIVE_REASON : undefined)}
                                onRetrain={() => trainOnly(activeModel)}
                            />
                        )}
                        {page === 'model' && saveInfo[activeModel.id]?.phase === 'error' && (
                            <SaveErrorNotice
                                message={(saveInfo[activeModel.id] as { phase: 'error'; message: string }).message}
                                onDismiss={() => dismissSaveInfo(activeModel.id)}
                            />
                        )}
                        {page === 'health' && renderRunSetPointsBanner(activeModel)}
                        {page === 'model' ? renderModelFitBody(activeModel) : (
                            <HealthScorePage
                                key={activeModel.id}
                                {...pagePropsFor(activeModel)}
                                setPoints={setPointsOf(activeModel)}
                                onSetPointsChange={onSpChange}
                                onSetPointsCommit={onSpCommit}
                                attemptIssues={attemptIssues[activeModel.id] ?? null}
                                save={saveInfoFor(activeModel)}
                                onRetrain={onRetrainActive}
                                retrainDisabledReason={retrainBlockOf(activeModel)}
                                onRetryPreview={healthPreview.retry}
                                onRetryTestScoring={healthPreview.retryTestScoring}
                                testsChanged={testsChangedState(activeModel, gateFg)}
                            />
                        )}
                    </WorkbenchScroll>
                    {renderFooter(activeModel, page, primary)}
                </div>
            </>
        );
    };


    // The settings modal's own view: its draft once edited, else the persisted
    // values. Only the modal reads these — everything above (Step-1 card, gate,
    // models) stays on the persisted state.
    const rcView = rcDraft ?? rcPersisted;
    const rcDirty = rcDraft !== null && !rcDraftEqual(rcDraft, rcPersisted);
    const rcViewInvalid = validatePeriods(rcView.periods).some(s => s.invalid);
    // Apply gate: an invalid train period, NO train period, or an invalid scoring
    // period (a missing date, or an end before its start). Scoring periods
    // overlapping train time and train periods overlapping a highlight never block.
    const rcApplyBlock = runningConditionApplyBlock(rcView.periods, rcView.testPeriods);
    const rcApplyEnabled = rcApplyBlock === null && (rcDirty || rcPeriodTyping);
    const rcTestsNotice = testsChangedNotice(allModels, gateFg);
    const rcViewConfigured = isWorkspaceRunningConditionConfigured(
        { runningConditionFilters: rcView.filters, runningConditionNoneConfirmed: rcView.noneConfirmed },
        gateHeaders,
    );

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Build Model
                </h2>
                {/* The 5-step progress bar that sat here was removed on 2026-10-09 at the
                    user's request: building a model goes back and forth all the time, so
                    a linear progress did not fit. The header is title + Close only. */}
                <button onClick={handleClose} className="scatter-regl-btn scatter-regl-btn-icon" title="Close">
                    <X size={14} />
                </button>
            </div>

            {closeNotice && (
                <div className="wb2-stale" role="alert" data-testid="close-wait-notice" style={{ margin: '8px 16px 0' }}>
                    <span>{closeNotice}</span>
                    <span className="wb2-sp" />
                    <button type="button" className="rcx-btn rcx-btn--sm" onClick={() => setCloseNotice(null)}>Dismiss</button>
                </div>
            )}

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
                    testPeriods={runningConditionTestPeriods}
                />
                {/* Train queue run strip (its own memoised component): progress never
                    re-renders the Model fit charts. */}
                {queue.run && queue.summary && (
                    <RunStrip
                        run={queue.run}
                        summary={queue.summary}
                        timeLeftMs={queue.timeLeftMs}
                        rows={runRowsById}
                        onDetails={onRunDetails}
                        onCancel={onRunCancel}
                        onDismiss={onRunDismiss}
                        onCloseWindow={onRunCloseWindow}
                        onTrainNotStarted={onRunNotStarted}
                    />
                )}
                {rcTestsNotice && (
                    <div className="wb2-stale vt-rcnotice" role="status" data-testid="tests-changed-notice">
                        <span>
                            <b>{testsChangedNoticeText(rcTestsNotice)}</b>. {rcTestsNotice.count === 1 ? 'It was' : 'They were'} not re-trained.
                        </span>
                    </div>
                )}

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

                {/* The "N of M models can't be built yet" line that sat here is gone
                    (workbench redesign 2026-10-10): the card above and each model's footer say it. */}

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
                                <TrainAllBar
                                    counts={allCounts}
                                    running={queue.isRunning}
                                    reason={trainAllReason}
                                    reasonTone={reasonToneOf(trainAllReason)}
                                    onOpen={() => { setIncludeUpToDate(false); setTrainAllView('preflight'); }}
                                />
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
                                        placeholder="Search description, tag, unit or component…"
                                        aria-label="Search sensors"
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value)}
                                    />
                                </div>
                                <div className="bmw-chips">
                                    <button type="button" className={`bmw-chip${listFilter === 'all' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('all')}>All <b>{sensorGroupsAll.length}</b></button>
                                    <button type="button" className={`bmw-chip${listFilter === 'attn' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('attn')}>Needs setup <b>{attnCount}</b></button>
                                    {showSpChip && (
                                        <button type="button" data-testid="chip-set-points-needed" className={`bmw-chip${listFilter === 'sp' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('sp')}>Set points needed <b>{spCount}</b></button>
                                    )}
                                    <button type="button" className={`bmw-chip${listFilter === 'done' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('done')}>Complete <b>{doneCount}</b></button>
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
                            onChange={e => { if ((e.target as HTMLElement).closest('[data-testid="time-periods-editor"], [data-testid="test-periods-editor"]')) setRcPeriodTyping(true); }}
                            onBlur={e => { if ((e.target as HTMLElement).closest('[data-testid="time-periods-editor"], [data-testid="test-periods-editor"]')) setRcPeriodTyping(false); }}
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
                                testPeriods={rcView.testPeriods}
                                onTestPeriodsChange={updateRunningConditionTestPeriods}
                                highlights={dashHighlights}
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
                                        title={rcApplyBlock?.reason}
                                        onClick={applyRcDraft}
                                    >
                                        <Check size={12} /> Apply
                                    </button>
                                    <button type="button" data-testid="rc-cancel" className="f4-btn f4-btn--plain" onClick={closeRc}>Cancel</button>
                                    <span className="filter-panel-spacer" />
                                    {rcApplyBlock?.kind === 'no-train' ? (
                                        <span data-testid="rc-apply-block" data-kind="no-train" className="filter-dirty-hint tpe-block-hint">{rcApplyBlock.reason}</span>
                                    ) : rcApplyBlock?.kind === 'invalid-test' ? (
                                        <span data-testid="rc-apply-block" data-kind="invalid-test" className="filter-dirty-hint tpe-block-hint tpe-block-hint--bad">{rcApplyBlock.reason}</span>
                                    ) : (rcDirty || rcPeriodTyping) && (
                                        <span data-testid="rc-dirty-hint" className="filter-dirty-hint">Changes not applied yet</span>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Train all: the pre-flight list, then the run's details (also the strip's Details). */}
            {trainAllView && (
                <TrainAllModal
                    view={trainAllView === 'run' && queue.run ? 'run' : 'preflight'}
                    run={queue.run}
                    summary={queue.summary}
                    rows={trainRows}
                    groups={trainGroups}
                    includeUpToDate={includeUpToDate}
                    onIncludeUpToDate={setIncludeUpToDate}
                    onClose={closeTrainAll}
                    onStart={startTrainAll}
                    onCancelRun={() => queue.stopAfterCurrent('cancel')}
                    onFix={fixModel}
                    onOpenModel={id => { setTrainAllView(null); focusModel(id, 'health'); }}
                    onRetry={id => retryModels([id])}
                    onTrainNotStarted={() => retryModels(queue.summary?.notStartedIds ?? [])}
                    onRemoveFromRun={id => { queue.removeFromRun(id); }}
                />
            )}
            {/* Close while a run is active (toolbar X and the native close). */}
            {closeAsk && queue.run && queue.summary && (
                <CloseRunDialog
                    run={queue.run}
                    summary={queue.summary}
                    current={queue.run.currentId ? runRowsById.get(queue.run.currentId) : undefined}
                    onKeep={keepTraining}
                    onStopAndClose={() => { void stopRunAndClose(); }}
                    onClose={() => { setCloseAsk(false); void closeNow(); }}
                />
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
        </SensorMetaContext.Provider>
    );
}
