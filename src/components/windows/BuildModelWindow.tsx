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
import { findSameSensorNameConflict, kindModelName, MODEL_KIND_LABEL, suggestDistinctModelName } from "../../utils/modelNames";
import { CATEGORY_BLOCK_REASON, customBlockText, customSummaryText, getBuildBlock, getBuildBlockReason, isRunningConditionConfigured, isWorkspaceRunningConditionConfigured, effectiveRunningCondition, markCompleteBlockReason, NO_MODEL_DATA_TITLE, NO_MODEL_DATA_WORDS, NO_TRAIN_DATA_SHORT, NO_TRAIN_PERIOD_REASON_CUSTOM, NO_TRAIN_ROWS_FOOTER, noModelDataCauseText, noModelDataFooter, noModelDataMarkReason, noTrainRowsReason, runningConditionApplyBlock, seedCustomFromWorkspace, type BuildBlock, type GateOptions, type NoModelDataCause, type RunningConditionApplyBlock, type RunningConditionFg } from "../../utils/runningCondition";
import { modelsStillNeedingTraining, retrainNoticeParts, runningConditionImpact } from "../../utils/runningConditionImpact";
import { usePeriodCounts } from "../../hooks/usePeriodCounts";
import { countedNoTrainRows, countedTrainRunningDays, trainCountKey } from "../../utils/periodCounts";
import { computeTrainFingerprint, isModelTrainedFresh as trainedFreshFor } from "../../utils/trainFingerprint";
import { buildPreviewFilterPayload } from "../../utils/trainingScope";
import { applyIncompleteRule } from "../../utils/incompleteRule";
import { EARLIER_SCORING_HINT_TEXT, isModelStale as isModelStaleFor, modelDotState, modelSetPointFlag, NOT_TRAINED_BLOCK_REASON, savedResultsUseEarlierScoring, type ModelDotState, type SetPointFlag } from "../../utils/modelStatus";
import { CLUSTERS_NEED_CRITERIA, HEALTH_DEFAULT_MAX_POINTS, relationshipLambda, testPeriodsWireFor } from "../../utils/healthRequest";
import { ensureHealthSetPoints } from "../../utils/healthSetPoints";
import { completeModel, healthExportRecord, parseHealthError } from "../../utils/completeModel";
import { commitHealthVerdict, commitSetPoints, MARK_COMPLETE_CLOSE_WAIT, persistModelComplete } from "../../utils/healthPersist";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import { useDatasetTimeBounds } from "../../hooks/useDatasetTimeBounds";
import { useHealthPreview } from "../../hooks/useHealthPreview";
import { validatePeriods, testPeriodsKey, testPeriodsError, testPeriodsWirePlan, toScoringPeriods, toTestPeriodsWire, type PeriodDataBounds } from "../../utils/timePeriods";
import { SLOW_TEST_SCORING_TEXT, testsChangedNotice, testsChangedNoticeParts, testsChangedState } from "../../utils/trainTestValidation";
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, stiffnessLabel, snapStiffness } from "../reports/pmReportTypes";
import RunningConditionPanel, { RunningConditionPills } from "./RunningConditionPanel";
import { RunningConditionCard, cardRowsFromCounts, type RcStepState } from "./RunningConditionCard";
import { SensorPickerModal } from "./SensorPickers";
import { SensorInline, SensorLabel } from "../sensor/SensorLabel";
import { SensorMetaContext, fmtNumText, sensorHaystack, sensorTitle, useLayeredSensorLookup } from "../sensor/sensorInfo";
import { useModalFocus } from "./useModalFocus";
import { formatStamp } from "./periodDisplay";
import SubModelsModal from "./SubModelsModal";
import { useSubModelFits } from "./useSubModelFits";
import ModelFitPage from "./workbench/ModelFitPage";
import { CLUSTER_COLORS as CLUSTER_PALETTE, TYPED_DECIMALS_MAX, fmtClusterBound, shortDecimals } from "./workbench/chartTheme";
import HealthScorePage from "./workbench/HealthScorePage";
import { FIT_GONE_WORDS, FitGoneBoard, LoadFailedBoard, SaveErrorNotice, StaleBanner, StateBoard, TrainSensorLink, WorkbenchScroll, type FitGoneActions, type StaleCantTrain } from "./workbench/WorkbenchShellParts";
import { buildCheckLines, healthVerdict, isBlockingIssue, sameSetPoints, verdictOfIssues, type HealthVerdict } from "./workbench/healthChecks";
import type { SaveInfo, WorkbenchPage } from "./workbench/workbenchTypes";
import { isPickerSurfaceOpen } from "../sensor/SensorPicker";
import { CloseRunDialog, LockedSettingsHeader, QueuedCard, RunSetPointsBanner, RunStrip, SensorTrainButton, sensorTrainMenuCopy, TrainAllBar, TrainAllModal, type TrainGroupInfo, type TrainMenuItem, type TrainReasonTone, type TrainRowModel } from "./workbench/TrainQueueParts";
import { useTrainQueue } from "../../hooks/useTrainQueue";
import type { TrainCandidate, TrainFixTarget, TrainOutcome } from "../../types/trainQueue";
import { classifyTrainPlan, countTrainPlans, formatTrainSeconds, isStaleTrainError, missingSettingsText, noRowsTrainError, preflightReason, REQUIRED_FIELDS_BLOCK_REASON, ROUGH_TRAIN_SECONDS, roughTrainSeconds, trainButtonsBlockedReason, TRAIN_NEEDS_RUNNING_CONDITION, TRAIN_STALE_MESSAGE } from "../../utils/trainQueue";

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

// `shortDecimals` / `TYPED_DECIMALS_MAX` / `fmtClusterBound` (a cluster boundary for display:
// typed-looking values in full, float noise through `fmtNum`) live in `workbench/chartTheme.ts`,
// shared with the Model fit page's cluster summary.
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
    /** Custom running-condition editor fields — they live in the draft, so they follow
     *  the same Save-changes flow as every other field here. */
    customFilters: WorkspaceSensorFilter[];
    customCombine: 'and' | 'or';
    customNoneConfirmed: boolean;
    customPeriods: TimePeriod[];
    /** This model's own SCORING periods (Custom mode) — staged in the draft like the
     *  other Custom lists. */
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
 *  re-train, red = needs fixing, none = never trained. */
type TabDot = 'complete' | 'need' | 'bad' | null;
const DOT_CLASS: Record<ModelDotState, TabDot> = {
    complete: 'complete', trained: 'need', stale: 'need', blocked: 'bad', none: null,
};
const DOT_TITLE: Record<ModelDotState, string> = {
    complete: 'Complete', trained: 'Trained — set points needed', stale: 'Re-train needed', blocked: 'Needs fixing', none: 'Incomplete',
};
/** The status words of a kind tab: shown beside its state dot and in its tooltip
 *  (Workbench detail v2 §2 — see `tabDotOf`). */
const TAB_WORDS: Record<ModelDotState, string> = {
    complete: 'Complete', trained: 'Trained', stale: 'Re-train needed', blocked: 'Needs fixing', none: 'Not trained yet',
};
/** A run of this session failed: red dot on the tab and in the list. */
const TRAIN_FAILED_WORDS = 'Training failed';
// (`FIT_GONE_WORDS` — the Relation-model fit Rust held is gone, NOT_FITTED: tab tooltip,
// board title and the start of the footer sentence — lives next to the board itself.)
/** Why Mark complete is blocked then, as the button's tooltip (the footer sentence turns
 *  "load it again" — and, for a model that is not Complete, "Train sensor ↑" — into links).
 *  A Complete model is never trained by Train sensor, so its reason does not name it. */
const FIT_GONE_BLOCK_REASON = `${FIT_GONE_WORDS} · load it again, or re-train with Train sensor ↑`;
const FIT_GONE_BLOCK_REASON_COMPLETE = `${FIT_GONE_WORDS} · load it again first`;
/** Mark complete answered NOT_FITTED: the files need the fit Rust no longer holds. */
const FIT_GONE_SAVE_MESSAGE = 'The fitted Relation model was no longer in memory, so its files were not written. Mark complete again once it is loaded.';
/** A COMPLETE model whose result could not be worked out again when it was opened (the
 *  silent load failed for another reason than a lost fit): tab / list tooltip, and the
 *  reason Mark complete again is blocked. Train sensor never trains an up-to-date
 *  Complete model, so these never point at it — "Load it again" is the way out. */
const LOAD_FAILED_WORDS = "Couldn't load the model";
const LOAD_FAILED_BLOCK_REASON = `${LOAD_FAILED_WORDS} · load it again first`;
/** The gate badge (tab / list tooltip) of a model that still has to train and whose
 *  train periods hold no running row. */
const NO_ROWS_BADGE = NO_TRAIN_ROWS_FOOTER;
/** The line under Train sensor for a model on its OWN (Custom) running condition while the
 *  workspace one is not set / not valid: the card's "Set running condition" is the only
 *  filled button then, but nothing is blocked for this model. */
const OWN_RC_NOT_BLOCKED = 'own running condition, not blocked';
/** A model with results whose training scope holds no row of the loaded data (`noDataOf`). */
interface ModelNoData { cause: NoModelDataCause; mode: 'workspace' | 'custom'; hasCondition: boolean }
/** "Load it again" while Mark complete is writing this model's files (it runs the engine too). */
const FIT_RELOAD_SAVING_REASON = 'Wait for the save to finish';
/** Mark complete while Rust is still answering for what was just typed (a moment). */
const CHECKING_SET_POINTS = 'Checking the set points…';
/** Mark complete while the health score could not be loaded (its red card has the Retry). */
const PREVIEW_FAILED_BLOCK_REASON = 'The health score did not load · Retry above, then Mark complete';
/** ...and when it could not be loaded because the dataset was replaced (STALE_SESSION):
 *  asking again cannot help, so that card has NO Retry — the footer must not point at one. */
const PREVIEW_STALE_BLOCK_REASON = TRAIN_STALE_MESSAGE;
// (No note beside the Model-settings fields: the amber "changing it sets the model to
// Incomplete" line that stood next to every training input, on every model whatever its
// state, read as "something here is wrong" — removed 2026-10-12, user decision. A change
// that needs a re-train is said when it happens: the stale banner and the Incomplete pill.)
/** The most clusters a Clustering model can be SET to. Only the stepper is capped: a
 *  model saved with more keeps its count untouched — clamping it on open would change
 *  its train fingerprint and set it back to Incomplete — it just cannot be raised
 *  further ("−" still works). */
const MAX_CLUSTERS = 5;
const MAX_CLUSTERS_REASON = `At most ${MAX_CLUSTERS} clusters`;
/** Stable empty list for `useSubModelFits` when the active model is not a Relationship. */
const NO_PREDICTORS: string[] = [];
/** Shown when a Train finds the dataset replaced since this window opened. */
const DATASET_CHANGED_MESSAGE = 'The dataset changed since this window was opened — close it and reopen Build Model from the Dashboard.';
const DUPLICATE_NAME_BLOCK_REASON = 'Model name is already used by another model of this sensor';
/** Mark complete, Compare predictors and the Re-train buttons while a training
 *  run is active: one Relation-model sidecar call at a time. */
const TRAIN_RUN_ACTIVE_REASON = 'Wait for the training run to finish';
/** A model whose Mark complete is writing its files is not trained meanwhile. */
const BEING_SAVED_REASON = 'Its files are being saved';
/** The close notice when "Stop after this model and close" gave up waiting. */
const RUN_CLOSE_WAIT_NOTICE = 'Still training a model — the window stays open so nothing is cut off half-way. Close it again to leave without waiting.';
/** THE kind names of this window — tabs, tooltips, notices: Individual / Relation
 *  model / Clustering. (The UI never says "Relationship": CLAUDE.md naming rule.)
 *  The app-wide map (`utils/modelNames.ts`) — the Dashboard and the special-sensor
 *  lock sentences read the same one; `kindModelName` (a kind inside a sentence:
 *  "the Individual model", "the Relation model") comes from there too. */
const KIND_TAB_LABEL: Record<ModelKind, string> = MODEL_KIND_LABEL;
/** The ONE filled button of the detail pane (at most one filled button on
 *  screen) — see `primaryActionOf`. */
type PrimaryAction = 'save' | 'train' | 'next' | 'mark' | null;

// ─── Train in place ───────────────────────────────────────────────────────
// Shape returned by Rust's `compute_sensor_stats`.
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

/** One model's cached preview result, keyed by kind so the results stage can
 *  render the right chart without re-deriving which invoke produced it.
 *  Session-only: never persisted (only `lastTrainedAt`/`trainedFingerprint` are). */
type TrainResult =
    | { kind: 'individual'; stats: SensorStats }
    // `result.health_preview` is the bounded Relationship preview Rust returns
    // when asked to cache the fit (no set points applied — draw it right away).
    | { kind: 'relationship'; result: RelationshipPreviewResult }
    | { kind: 'clustering'; preview: ClusteringPreview };

interface TrainCacheEntry {
    /** The fingerprint this result was computed against — lets a stale
     *  auto-recompute effect tell "already have the current result" apart
     *  from "have an old one that happens to still be cached". */
    fingerprint: string;
    result: TrainResult;
}

/** `TimePeriodsEditor`'s date fields hand a COMPLETE typed date to the parent on
 *  change; the blur re-sorts the list and commits a date that was still pending (a
 *  year being typed), and a half-typed field goes back to its committed date. A close
 *  path that is a plain state update (the modal's X / backdrop, the whole window's
 *  close) causes no DOM blur, so the editor would unmount without settling. Calling
 *  this before any close / Apply forces that blur synchronously — a no-op when
 *  nothing relevant is focused. */
function flushFocusedInput(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && typeof active.blur === 'function') active.blur();
}

/** One shared empty list, so a hook input does not change identity per render. */
const NO_PERIODS: TimePeriod[] = [];

/** The neutral line next to Apply while a period date is half-typed (`name` =
 *  the row, "P1" / "S2"): its change is not in the draft yet, so there is no
 *  impact to show for it. */
const pendingDateText = (name: string): string => `Finish the date in ${name} to see what this changes`;

/** The four workspace Running condition fields the settings modal edits as ONE
 *  local draft (nothing is written until Apply — see `applyRcDraft`). Same shape
 *  `persistRunningCondition` takes. */
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

/** A date in the footer ("Trained …", "Files saved …"): an instant the app
 *  recorded, in the app's one date format — "2026/02/09 23:50", in mono. */
const Stamp = ({ at }: { at: string }) => <span className="wbx-dt">{formatStamp(at)}</span>;

/**
 * The single Build Model window — a singleton (label `build-model`) opened
 * from the Failure Groups tab's "Build Model" button.
 *
 * A master/detail "Workbench":
 *   - A left sensor list (search + filter chips + Failure-group/Component
 *     grouping) selects a sensor; the right detail pane shows that sensor's
 *     I/R/C tabs and, per model, two pages — Model fit (settings, Train,
 *     charts) and Health score (set points, checks, Mark complete) — with one
 *     footer (status pill, one sentence, at most one filled button).
 *   - The workspace-wide running condition is the Step-1 card plus a settings
 *     modal wrapping `RunningConditionPanel` (see RunningConditionCard /
 *     RunningConditionPanel).
 *   - There is no "add" flow: toggling a sensor into a group (Dashboard's
 *     Sensor tab) is the sole way a model comes into existence, always as kind
 *     'individual'. A model's kind, its auto-filled identity sensor (Target / X)
 *     and FG membership are not editable here.
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
    // Workspace-wide "machine running" filter — set once here, every model in
    // Workspace mode picks it up automatically at train time.
    const [runningConditionFilters, setRunningConditionFilters] = useState<WorkspaceSensorFilter[]>([]);
    // How the conditions above combine — 'and' (default) or 'or'.
    const [runningConditionCombine, setRunningConditionCombine] = useState<'and' | 'or'>('and');
    // Workspace-default TRAIN periods. At least one is REQUIRED to train — an
    // empty list does not mean "whole dataset" (`getBuildBlockReason`).
    // A model in Workspace mode uses THIS list; Custom mode uses its own
    // `filterTimePeriods`.
    const [runningConditionTimePeriods, setRunningConditionTimePeriods] = useState<TimePeriod[]>([]);
    // Workspace-default SCORING periods: the time the trained model gives a health
    // score for; at least one is needed before Mark complete. Custom mode uses the
    // model's own `customTestPeriods`.
    const [runningConditionTestPeriods, setRunningConditionTestPeriods] = useState<TestPeriod[]>([]);
    // The workspace's Dashboard time highlights — only feed the amber TRAIN-period
    // overlap warning ("Remove the overlap"; never drawn on Workbench charts, and
    // not a source of scoring periods). Read from the workspace file at
    // hydration and again whenever the Running condition settings open.
    const [dashHighlights, setDashHighlights] = useState<TimeHighlight[]>([]);
    // The workspace's special-sensor recipes, read from disk: a model trained on a
    // special sensor whose formula changed since reads as out of date in every status
    // (`isModelStale` & co. take them). Kept as ONE array per read, so the recipe
    // signatures (memoised per array) are computed once, not per render.
    const [specialRecipes, setSpecialRecipes] = useState<SpecialSensorRecipe[] | null>(null);
    // Drives the Workbench's Running condition settings modal (opened from the
    // Step-1 card's Edit / Set running condition / Fix period button).
    const [rcFilterOpen, setRcFilterOpen] = useState(false);
    // The modal edits this LOCAL DRAFT, never the persisted
    // values above. `null` = nothing edited yet (the modal then just shows the
    // persisted values live — copy-on-write on the first edit), so there is no
    // "seed on open" step to forget on any of the several paths that open the
    // modal. Cleared on every close, so a reopen always starts from persisted.
    // Held in a ref too: the blur of a period date (which re-sorts the list and
    // commits a date that was still pending) fires right before the Apply click —
    // the click handler must see that commit synchronously, not wait for a re-render.
    const [rcDraft, setRcDraftState] = useState<RcDraft | null>(null);
    const rcDraftRef = useRef<RcDraft | null>(null);
    // A period date inside the modal that is HALF-TYPED (the field reports no
    // complete date yet): the row's name per list ("P1" / "S2"), else null. A
    // complete date is in the draft the moment it is typed (the editors commit on
    // change), so this only drives the neutral "Finish the date in P1 …" line —
    // it never enables Apply and nothing half-typed is ever written.
    const [rcPendingDate, setRcPendingDate] = useState<{ train: string | null; scoring: string | null }>({ train: null, scoring: null });
    const onRcPendingDate = useCallback((list: 'train' | 'scoring', name: string | null) => {
        setRcPendingDate(prev => (prev[list] === name ? prev : { ...prev, [list]: name }));
    }, []);
    // Inline "Discard changes?" row, shown instead of closing when X/backdrop
    // is used with an unapplied draft.
    const [rcDiscardPrompt, setRcDiscardPrompt] = useState(false);
    // Models an Apply made in THIS session sent back to training: the notice
    // under the running-condition line counts the ones still not trained again
    // (`modelsStillNeedingTraining`). Session-only by decision — the amber dots
    // in the list are what persists.
    const [rcRetrainIds, setRcRetrainIds] = useState<string[]>([]);
    // What the gate reads (`gateFg`, built further down) and the special-sensor
    // recipes, for `applyRcDraft` (a stable callback defined before them).
    const gateFgRef = useRef<RunningConditionFg>(null);
    const specialRecipesRef = useRef<SpecialSensorRecipe[] | null>(null);
    // The Running-condition dialog element (focus on open, Tab kept inside).
    const rcDialogRef = useRef<HTMLDivElement>(null);
    // "No condition - use all rows" was explicitly confirmed for the workspace.
    // Mirrors failureGroupState.runningConditionNoneConfirmed.
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

    // ---- Workbench left list ----
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

    // ---- Train in place ----
    /** Session-only cache of the last successful preview run per model id —
     *  never persisted (only `lastTrainedAt`/`trainedFingerprint` go to the
     *  workspace; the actual chart data is cheap to recompute). */
    const [trainResults, setTrainResults] = useState<Record<string, TrainCacheEntry>>({});
    /** Presence of a key = that model id currently has a preview run in
     *  flight (explicit Train/Re-train click OR the silent auto-recompute on
     *  reopen); absence = idle. There is no separate "done" value — a
     *  finished run is represented by its entry landing in `trainResults`. */
    const [trainStatus, setTrainStatus] = useState<Record<string, 'loading'>>({});
    const [trainError, setTrainError] = useState<Record<string, string>>({});
    /** Models whose SILENT load (opening a trained / Complete model, "Load it again")
     *  the engine answered "no rows" for, as model id -> `noRowsLoadKey` (the train
     *  fingerprint + dataset generation it was asked with). Nobody trained it and
     *  nothing about the model changed: it is not a `trainError` — the window shows
     *  the "No data for this model in the loaded file" board (`noDataOf`) and does
     *  not ask again for the same scope and data. */
    const [noRowsLoads, setNoRowsLoads] = useState<Record<string, string>>({});
    // ---- Two pages per model ----
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
    // The loaded data's time range, for the "no data to train on" guards and the
    // timelines. Known ONLY for the dataset this window is pointed at right now
    // (workspace + Rust dataset generation): it is asked again whenever that
    // changes, and it is `null` (unknown — nothing is judged against it) from the
    // very render the window is re-pointed in until the new dataset's answer lands.
    const { bounds: datasetBounds } = useDatasetTimeBounds(workspaceId === null ? null : `${workspaceId}|${generation ?? ''}`);
    /** Bumped after every Train so `useHealthPreview` refetches even when the
     *  request itself is identical (a Relationship re-train re-fills Rust's fit cache). */
    const [healthRevision, setHealthRevision] = useState(0);
    /** "Compare predictors" (Sub-models) modal of the active Relationship model. */
    const [compareOpen, setCompareOpen] = useState(false);
    // Never leave the comparison open pointed at a model the user has since
    // navigated away from (switching sensor or kind tab).
    useEffect(() => { setCompareOpen(false); }, [selectedSensorKey, activeTab]);

    // ---- Health score page ----
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
    // "Fix set point" - is not window state: it is PERSISTED on the model
    // (`healthVerdict`) so the Dashboard's dot reads the same value; see
    // `modelSetPointFlag` and the effect that writes it below.)
    /** Every "Mark complete" run in flight (the WHOLE run: validate -> export -> save),
     *  so a window close can wait for it (`pendingSaveRef` is a single slot a later
     *  write overwrites). */
    const markRunsRef = useRef<Set<Promise<unknown>>>(new Set());
    /** The user was told the close is waiting too long for a running save; the next
     *  close attempt does not wait for it again. */
    const closeWaitGivenUpRef = useRef(false);
    const [closeNotice, setCloseNotice] = useState<string | null>(null);

    // ---- Train sensor / Train all with a queue ----
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
    /** The ▾ of Train sensor: the "Marked complete" board points at its menu. */
    const trainMenuBtnRef = useRef<HTMLButtonElement>(null);
    /** Footer pieces the focus moves to when the focused "Save changes" unmounts. */
    const nextHealthBtnRef = useRef<HTMLButtonElement>(null);
    const footerRef = useRef<HTMLDivElement>(null);
    /** Id of the model whose "Save changes" was pressed (see the effect on `drafts`). */
    const saveFocusRef = useRef<string | null>(null);
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
    /** Models whose "Load it again" is under way (double-click guard). */
    const fitReloadingRef = useRef<Set<string>>(new Set());
    /** Models whose first-open set-point snapshot was already written (once per model). */
    const setPointsSeededRef = useRef<Set<string>>(new Set());

    /** Unsaved edits, keyed by model id. */
    const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
    /** One-time "categories were made consistent" notice — STORED in the
     *  workspace (failureGroupState.categoryNormalisationNotice), not computed
     *  per render, so it survives whichever window writes the file first. */
    const [categoryNotice, setCategoryNotice] = useState<CategoryChange[] | null>(null);
    const [categoryWarn, setCategoryWarn] = useState<{ key: string; text: string } | null>(null);
    /** "Copied N periods and M conditions from Workspace" note for the Custom
     *  running-condition editor, keyed per model id — session-only (never
     *  persisted), shown once per model per switch-to-Custom that actually
     *  copied something. */
    const [seedNoteFor, setSeedNoteFor] = useState<Record<string, { periods: number; conditions: number; tests: number } | null>>({});
    /** Clustering's criteria-sensor stats (drives the cluster-range slider's
     *  [min, max] bounds) — scoped to whichever model is currently active,
     *  refetched whenever its (draft-aware) criteria sensor or effective
     *  training-scope filter changes; `null` while unset/loading.
     *  Stored with the key it was fetched for (model + criteria sensor +
     *  filter); the `criteriaStats` read further down is only non-null when
     *  that key matches what is selected NOW. */
    const [criteriaStatsEntry, setCriteriaStatsEntry] = useState<{ key: string; stats: SensorStats } | null>(null);
    /** Cluster-range boundary being typed: `idx` = the boundary between cluster
     *  idx+1 and idx+2. `initial` is the text the box showed on focus (an unchanged box
     *  commits nothing, so a rounded readout of a dragged value is never written back). */
    const [boundaryEdit, setBoundaryEdit] = useState<{ modelId: string; idx: number; text: string; initial: string; error: string | null } | null>(null);
    /** The exact text of each boundary the user typed (`modelId:idx`), shown while the stored
     *  number still equals it — a typed "33.60" keeps its "33.60" (never rounded). Session only. */
    const [typedBoundaryText, setTypedBoundaryText] = useState<Record<string, { value: number; text: string }>>({});

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    // Every sensor label / picker in this window resolves through this lookup.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);
    const getComponent = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.component ?? '', [sensorMetaMap]);
    // Raw description only (not the "description (tag)" combo `sensorLabel`
    // below builds). Sensor labels in the UI come from `sensorLookup` (the
    // shared SensorLabel standard).
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
    // overwriting a newer one (several `build-model-data` replies can be in
    // flight at once).
    const workspaceIdRef = useRef<string | null>(null);
    const loadSeq = useRef(0);
    const recipeSeq = useRef(0);

    // The most recent in-flight `updateWorkspaceData` write from ANY persist path
    // in this window (running-condition edits, a model draft Save, Mark complete,
    // the hydration-time migration write, …). Always overwritten to the LATEST
    // write; a superseded one is simply abandoned, never left dangling.
    // `handleClose` and the `onCloseRequested` handler below await whatever this
    // currently holds before actually letting the window close.
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
     *  special-sensor recipes the write read (a Train after a Repair stamps
     *  `trainedFormulas` from the recipes on disk, so this window must judge
     *  freshness against those same recipes, not an older copy). Any recipe read
     *  still in flight is older than this write. */
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

    // A cached preview (or an in-flight one) for a model that no longer exists
    // (deleted on the Dashboard, or the window was re-pointed at a different
    // workspace — see the `switched` reset below) must be thrown away, never
    // written back anywhere.
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
                setRcPendingDate({ train: null, scoring: null });
                setRcDiscardPrompt(false);
                // The "need training again" notice belonged to the old workspace too.
                setRcRetrainIds([]);
                setTrainResults({});
                setTrainStatus({});
                setTrainError({});
                setNoRowsLoads({});
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
                fitReloadingRef.current = new Set();
                setTrainAllView(null);
                setIncludeUpToDate(false);
                setCloseAsk(false);
            }
            // (The dataset bounds follow by themselves: `useDatasetTimeBounds` is keyed on
            // the workspace + this generation, so from this very render they are unknown
            // until the answer for the NEW dataset lands — never the old dataset's range.)
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
                // One-time legacy cleanup: a sensor whose models disagree on category is
                // made consistent. When that changed something, the result + notice are
                // WRITTEN BACK here so the notice is stored data (Dashboard's autosave
                // can't lose it, and it never re-fires once dismissed).
                // Same for the running-condition gate: a workspace that already has
                // models but nothing configured is flagged `rcLegacyNotice: 'pending'`
                // and written back, so the banner is stored data rather than something
                // recomputed per render.
                // Old single time ranges become periods and the old keys are dropped;
                // written back only when that changed something.
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
                    // event time (an old workspace file) never goes back to disk.
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
            // Re-pointed at another workspace meanwhile (same guard as `persist`): the
            // write landed in ITS workspace; this window now shows another one — never
            // put the old workspace's slice into this state, never broadcast it from here.
            if (workspaceIdRef.current !== workspaceId) return;
            if (next?.failureGroupState) {
                applyWritten(next);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyWritten, trackPending]);

    // ---- Running Condition modal: local draft + explicit Apply ----
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
    /** What the modal's Apply gate knew about the loaded data on the last render:
     *  the dataset bounds and — for exactly `draft` — whether its settled row count
     *  is zero AND the draft changed what is trained on. `applyRcDraft` re-checks
     *  the gate with it. */
    const rcGateRef = useRef<{ draft: RcDraft | null; bounds: PeriodDataBounds | null; noTrainRows: boolean }>({ draft: null, bounds: null, noTrainRows: false });

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

    // The editor hands up a typed date as soon as it is complete (in the order on
    // screen) and the sorted list on blur / Enter / a discrete action.
    const updateRunningConditionPeriods = useCallback((periods: TimePeriod[]) => {
        patchRcDraft({ periods });
    }, [patchRcDraft]);
    // Scoring periods: the same from `TestPeriodsEditor`.
    const updateRunningConditionTestPeriods = useCallback((testPeriods: TestPeriod[]) => {
        patchRcDraft({ testPeriods });
    }, [patchRcDraft]);

    /** Discards the draft and closes the modal — the single exit every close
     *  path (Cancel, Discard, successful Apply) goes through. */
    const closeRc = useCallback(() => {
        rcDraftRef.current = null;
        setRcDraftState(null);
        setRcPendingDate(prev => (prev.train === null && prev.scoring === null ? prev : { train: null, scoring: null }));
        setRcDiscardPrompt(false);
        setRcFilterOpen(false);
    }, []);

    /** X button / backdrop click. A dirty draft is never silently thrown away:
     *  the footer swaps to an inline "Discard changes?" row instead. */
    const requestCloseRc = useCallback(() => {
        // Settle the focused period date first (a pending one commits, the list is
        // sorted), so it counts as "dirty".
        flushFocusedInput();
        const d = rcDraftRef.current;
        if (d && !rcDraftEqual(d, rcPersistedRef.current)) {
            setRcDiscardPrompt(true);
            return;
        }
        closeRc();
    }, [closeRc]);

    const applyRcDraft = useCallback(() => {
        // The click may land before the focused period date's blur (sort, and the
        // commit of a date still pending) has re-rendered; this forces it, and the
        // ref picks it up at once.
        flushFocusedInput();
        const d = rcDraftRef.current;
        if (!d || rcDraftEqual(d, rcPersistedRef.current)) { closeRc(); return; }
        // Invalid train period, NO train period (rule 1), an invalid scoring period (a
        // missing date, or an end before its start), a period that was added / changed
        // in this draft and lies entirely outside the loaded data, or a settled count
        // of zero running rows for a draft that changed what is trained on keeps the
        // modal open; the footer says why. A period that is exactly as it was saved
        // never blocks (it only warns), and the zero-rows answer only counts for the
        // very draft it was counted for.
        const gate = rcGateRef.current;
        if (runningConditionApplyBlock(d.periods, d.testPeriods, 'applying', {
            bounds: gate.bounds,
            savedPeriods: rcPersistedRef.current.periods,
            savedTestPeriods: rcPersistedRef.current.testPeriods,
            noTrainRows: gate.draft === d && gate.noTrainRows,
            hasCondition: !d.noneConfirmed,
        }) !== null) return;
        // The models this Apply sends back to training (the same answer the impact
        // line next to Apply showed): kept for the notice under the running-condition
        // line. Models an earlier Apply of this session already sent back stay listed.
        const retrain = runningConditionImpact(gateFgRef.current, d, { recipes: specialRecipesRef.current ?? undefined }).retrainIds;
        if (retrain.length > 0) setRcRetrainIds(prev => [...new Set([...prev, ...retrain])]);
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

    // ---- Model editing ----
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
     *  because something was missing: fixing the last missing item (e.g. picking the
     *  criteria sensor) must not collapse the section under the user's hands. */
    const patchDraft = (m: FailureModel, patch: Partial<ModelDraft>) => {
        writeDraft(m, patch);
        setSettingsOpenOverride(prev => (m.id in prev ? prev : { ...prev, [m.id]: true }));
    };

    /** Category of the model's sensor across every FG (never per-model any more). */
    const categoryOf = (m: FailureModel): ModelCategory | null => sensorCategory(allModels, modelSensorKey(m));

    // ---- Running-condition gate. ONE source of truth: `getBuildBlockReason`.
    //      Every Train / "mark Complete" path below asks it; Save is
    //      deliberately NOT gated by it. ----
    const gateFg: RunningConditionFg = {
        models: allModels, runningConditionFilters, runningConditionCombine,
        runningConditionTimePeriods, runningConditionNoneConfirmed, runningConditionTestPeriods,
    };
    gateFgRef.current = gateFg;
    specialRecipesRef.current = specialRecipes;
    const gateHeaders = allSensors.length ? allSensors : null;
    const rcConfigured = isWorkspaceRunningConditionConfigured(gateFg, gateHeaders);

    // ---- "No data to train on" guards ----
    // The intent: stop a train that has NO data, and warn at once when a period is
    // chosen beyond the data — never take away results that already exist.
    //  R1. The data's range (`datasetBounds`) is known only for the CURRENT dataset
    //      (see `useDatasetTimeBounds` above). Unknown = nothing is judged.
    //  R2. In a DRAFT (the settings modal, a Custom model's own panel): a train or
    //      scoring period that is NEW or was CHANGED there and lies entirely outside
    //      the data is invalid — red row, reason line, Apply / Save changes disabled.
    //  R3. A period that is exactly as it was SAVED and lies entirely outside the
    //      data (an old workspace, the data file changed) is an AMBER warning on its
    //      row and on the card. It blocks nothing and flips no pill.
    //  R4. Train is blocked ("nothing to train on") only when there truly is no
    //      data: NO train period is inside the data (pure — from the dates), or the
    //      settled count of that model's training scope is zero rows (the counts the
    //      card / the panels already ask for — no new request).
    //  R5. The guards block ACTIONS only — Train (`trainBlockReason`), Apply and
    //      Save changes. The READ paths (`buildBlockReason` and `gateReasonOf`: a
    //      trained model's charts, its Health score page, "Next: Health score →",
    //      the preview / auto-recompute, the sub-model fits, Mark complete, Mark
    //      incomplete, the dots of a trained or Complete model) never see them.
    // Nothing is written, and no model's `status`, fingerprint or `healthVerdict`
    // changes.
    //
    // Row counts — ONE source for every "rows used" / "running days" number of this
    // window: Rust's `count_period_rows` (`usePeriodCounts`), so the one-line card,
    // the settings modal and the amber "below the recommended train time" note can
    // never disagree about the same condition. Three instances:
    //  - the card (here): the PERSISTED workspace condition — its train periods
    //    only, so ONE call per settled persisted state (none while the window loads);
    //  - the settings modal: its draft, only while it is open (debounced, at most
    //    two calls per settled draft);
    //  - the active Custom model's own lists, only while its Model fit page is on
    //    screen (see `customCountsWanted`).
    const persistedCountFilter = useMemo(
        () => buildPreviewFilterPayload(
            { filters: runningConditionFilters, combine: runningConditionCombine, noneConfirmed: runningConditionNoneConfirmed, periods: runningConditionTimePeriods },
            gateHeaders,
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [runningConditionFilters, runningConditionCombine, runningConditionNoneConfirmed, runningConditionTimePeriods, allSensors],
    );
    // A persisted train period that is broken (the plain date rules: a saved period
    // outside the data is a warning on the card, never "invalid").
    const persistedPeriodsInvalid = validatePeriods(runningConditionTimePeriods).some(st => st.invalid);
    const cardCounts = usePeriodCounts({
        // No train period = nothing is trained on (rule 1): no whole-dataset count.
        enabled: !loading && rcConfigured && !persistedPeriodsInvalid && runningConditionTimePeriods.length > 0,
        workspaceId,
        trainPeriods: runningConditionTimePeriods,
        // The card prints no scoring count: no second call.
        scoringPeriods: NO_PERIODS,
        filter: persistedCountFilter,
        expectedGeneration: generation,
        // The persisted condition changes in whole steps (Apply, another window's
        // write), never per keystroke: nothing to wait for.
        debounceMs: 0,
    });
    const cardRows = useMemo(() => cardRowsFromCounts(cardCounts), [cardCounts]);
    /** The persisted workspace condition is counted (settled) and its train periods
     *  hold no running row: no Workspace-mode model can TRAIN (nothing else changes). */
    const cardNoRows = countedNoTrainRows(cardCounts);
    /** What a Custom model's own training scope is, as the count sees it
     *  (`trainCountKey`): its train periods + its condition. */
    const customCountKeyOf = (d: ModelDraft): string => trainCountKey(
        d.customPeriods,
        buildPreviewFilterPayload({ filters: d.customFilters, combine: d.customCombine, noneConfirmed: d.customNoneConfirmed, periods: d.customPeriods }, gateHeaders),
    );
    /** The training scope (`customCountKeyOf`) the ACTIVE Custom model's settled
     *  count found NO running row for, else null. Assigned further down, right
     *  after its counts hook has run this render (the hook needs the active model);
     *  every reader below that point — and every handler / effect — sees this
     *  render's value. */
    let customNoRowsKey: string | null = null;
    /** This Custom model's own training scope is known to hold no running row: it is
     *  the active model, or its scope is the very one counted for the active model
     *  (two Custom models of a sensor on the same own condition — the answer is the
     *  same, so the story must not flip with the open tab). A Custom model whose
     *  scope was never counted is not known here: its train is stopped by the
     *  engine's answer instead (`noRowsTrainError`). */
    const customNoRowsOf = (m: FailureModel): boolean => {
        if (customNoRowsKey === null) return false;
        const eff = effectiveModelFor(m);
        return eff.runningConditionMode === 'custom'
            && isRunningConditionConfigured(eff, gateFg, gateHeaders)
            && customCountKeyOf(draftOf(m)) === customNoRowsKey;
    };
    /** What the TRAIN gate may know about the loaded data for this model (`GateOptions`). */
    const trainGuardOptsOf = (m: FailureModel): GateOptions => ({
        bounds: datasetBounds,
        noTrainRows: effectiveModelFor(m).runningConditionMode === 'custom' ? customNoRowsOf(m) : cardNoRows,
    });
    // Judges the DRAFT-merged model (`effectiveModelFor`, defined below — only
    // ever CALLED after the render body has defined it), not the persisted one:
    // `getBuildBlockReason` reads `runningConditionMode` /
    // `customRunningConditionFilters` / `filterTimePeriods` straight off the model
    // it is given, so a pending Custom-mode switch/edit must be visible to the
    // gate — otherwise Train could commit a draft with no condition set (or an
    // invalid period) and train on every row. Staleness
    // (`isModelTrainedFresh`/`isModelStale`) reads through `effectiveModelFor`
    // for the same reason, so the gate is live in both directions (blocks a
    // draft that just broke the condition; unblocks one that just fixed it,
    // without waiting for Save).
    //
    // TWO gates (R5 above):
    //  - `gateBlockOf` / `gateReasonOf` — category, no condition, an invalid or
    //    missing train period. Every READ path asks this.
    //  - `trainGateBlockOf` — the same, PLUS the data guards (`no-rows`: no train
    //    period inside the data / a settled count of zero rows). Only where Train
    //    is the action.
    const gateBlockOf = (m: FailureModel): BuildBlock | null => getBuildBlock(effectiveModelFor(m), gateFg, gateHeaders);
    const gateReasonOf = (m: FailureModel): string | null => gateBlockOf(m)?.reason ?? null;
    const trainGateBlockOf = (m: FailureModel): BuildBlock | null => getBuildBlock(effectiveModelFor(m), gateFg, gateHeaders, trainGuardOptsOf(m));
    /** The data guard alone: "nothing to train on" for a model nothing else blocks. */
    const trainGuardBlockOf = (m: FailureModel): BuildBlock | null => {
        const block = trainGateBlockOf(m);
        return block !== null && block.kind === 'no-rows' ? block : null;
    };
    /** The data guard as part of what a model SHOWS about itself (dot, badge, board,
     *  footer sentence): only for a model that still has to train — never trained, or
     *  out of date. A trained or Complete model keeps its own words; that it cannot be
     *  trained AGAIN is said where Train is offered — and, since its charts are
     *  computed from the loaded data, its pages show the "No data for this model in
     *  the loaded file" board instead of them (`noDataOf`, further down). */
    const shownGuardBlockOf = (m: FailureModel): BuildBlock | null =>
        isModelDone(m) || isModelTrainedFresh(m) ? null : trainGuardBlockOf(m);
    /** The part of the shown gate that needs NO row count (the gate + "no train
     *  period inside the data"). What decides whether Model settings open by
     *  themselves — and with them whether a Custom model's own counts are asked for —
     *  must not depend on those counts. */
    const countFreeGateReasonOf = (m: FailureModel): string | null =>
        gateReasonOf(m) ?? (isModelDone(m) || isModelTrainedFresh(m)
            ? null
            : getBuildBlockReason(effectiveModelFor(m), gateFg, gateHeaders, { bounds: datasetBounds }));
    /** A model's own (save) block and the gate's, in ONE order — the gate's: a Custom
     *  model with neither a condition nor a train period is told about the condition
     *  first, like its badge ("Needs condition", then "Needs train period"). */
    const orderedBlockReason = (own: string | null, gate: BuildBlock | null): string | null =>
        own === NO_TRAIN_PERIOD_REASON_CUSTOM && gate?.kind === 'no-condition' ? gate.reason : own ?? gate?.reason ?? null;
    /** The gate reason as the model's OWN page words it. A Custom model's own
     *  running condition is fixed inside its Model settings, so the wording says
     *  where: "Own running condition: P1 ends before it starts. Fix it in Model
     *  settings", or "Fix P1's end above" while that section is open
     *  (`customBlockText`). Any other text is returned unchanged. */
    const ownGateText = (m: FailureModel, text: string | null): string | null => {
        if (text === null) return null;
        const block = trainGateBlockOf(m);
        if (!block || block.mode !== 'custom' || block.kind === 'category' || block.reason !== text) return text;
        return customBlockText(block, { settingsOpen: isSettingsOpen(m) });
    };
    /** A block reason shown AWAY from the Model settings form (the Health score page,
     *  the save card, a tooltip in the header): "Fill in the required fields above
     *  first" reads wrong there — nothing is "above" — so the missing setting is named
     *  ("Add at least 1 predictor (+1 more)"). Everything else as `ownGateText`. */
    const awayFromFormText = (m: FailureModel, text: string | null): string | null =>
        text === REQUIRED_FIELDS_BLOCK_REASON ? missingSettingsText(missingItems(m)) : ownGateText(m, text);
    // The DRAFT-merged model, like the gate itself: the badge and the sentence then
    // name the same thing while a Custom model's own condition is being edited.
    const needsCondition = (m: FailureModel): boolean => !isRunningConditionConfigured(effectiveModelFor(m), gateFg, gateHeaders);
    const legacyCompleteCount = allModels.filter(m => m.status).length;
    /** Badge text for a model the gate blocks, for ANY reason (missing condition,
     *  missing category, invalid period — and, for a model that still has to train,
     *  nothing to train on), else null. Hover text is the reason. */
    const gateBadge = (m: FailureModel): string | null => {
        const block = gateBlockOf(m) ?? shownGuardBlockOf(m);
        if (block === null) return null;
        if (needsCondition(m)) return m.status ? LEGACY_BADGE : 'Needs condition';
        if (categoryOf(m) === null) return 'Needs category';
        if (block.kind === 'no-rows') return block.cause === 'outside-data' ? NO_TRAIN_DATA_SHORT : NO_ROWS_BADGE;
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

    /** A Custom model's own lists as they are SAVED — what its draft is judged
     *  against (R2 / R3): the model's own saved lists. For a model that is saved in
     *  Workspace mode and is being switched to Custom, ALSO the periods the switch
     *  copied from the workspace (`seedCustomFromWorkspace` gives the copies fresh
     *  ids, so they are matched by their dates): the user did not pick those — a
     *  saved workspace period outside the data must not block the switch, it warns
     *  here exactly as it does in the workspace settings. */
    const savedCustomListsOf = (m: FailureModel): { periods: TimePeriod[]; tests: TestPeriod[] } => {
        const own = { periods: m.filterTimePeriods ?? NO_PERIODS, tests: m.customTestPeriods ?? NO_PERIODS };
        if (m.runningConditionMode === 'custom') return own;
        const d = drafts[m.id];
        if (!d || d.runningConditionMode !== 'custom') return own;
        const sameDates = (a: { start: string; end: string }, b: { start: string; end: string }) =>
            (a.start ?? '').trim() === (b.start ?? '').trim() && (a.end ?? '').trim() === (b.end ?? '').trim();
        const copied = <T extends TimePeriod>(list: T[], from: readonly TimePeriod[]): T[] => list.filter(x => from.some(w => sameDates(w, x)));
        return {
            periods: [...own.periods, ...copied(d.customPeriods, runningConditionTimePeriods)],
            tests: [...own.tests, ...copied(d.customTestPeriods, runningConditionTestPeriods)],
        };
    };
    /** The training scope a model has as it is SAVED (`trainCountKey`): its own
     *  lists in Custom mode, the workspace's in Workspace mode. A draft whose scope
     *  equals it did not change what is trained on. */
    const savedScopeKeyOf = (m: FailureModel): string =>
        m.runningConditionMode === 'custom'
            ? customCountKeyOf(draftFromModel(m))
            : trainCountKey(runningConditionTimePeriods, persistedCountFilter);
    /** What blocks Save changes in a Custom model's OWN lists, or null — exactly what
     *  blocks Apply in the workspace settings (`runningConditionApplyBlock`, whole).
     *  (ANY invalid own period blocks the save — train as well as scoring.)
     *   - `data: false` — the plain rules only: an invalid train period, NO train
     *     period, an invalid scoring period. What every READ path sees.
     *   - `data: true` — plus the data guards of the DRAFT, for the Save / Train
     *     actions: a period that is new or was changed here and lies entirely outside
     *     the loaded data, and a settled count of zero running rows when the draft
     *     changed what is trained on. A period (or a scope) that is exactly as it was
     *     saved never blocks: renaming such a model saves fine. */
    const customSaveBlockOf = (m: FailureModel, data = false): RunningConditionApplyBlock | null => {
        const d = draftOf(m);
        if (d.runningConditionMode !== 'custom') return null;
        if (!data) return runningConditionApplyBlock(d.customPeriods, d.customTestPeriods, 'saving');
        const saved = savedCustomListsOf(m);
        const scopeChanged = customCountKeyOf(d) !== savedScopeKeyOf(m);
        return runningConditionApplyBlock(d.customPeriods, d.customTestPeriods, 'saving', {
            bounds: datasetBounds,
            savedPeriods: saved.periods,
            savedTestPeriods: saved.tests,
            noTrainRows: scopeChanged && customNoRowsOf(m),
            hasCondition: !d.customNoneConfirmed,
        });
    };
    /** That block as the reason Save / Train show. The two train-side blocks use the
     *  gate's own sentences, so every place that words a gate reason (`ownGateText`,
     *  the preflight list) reads them the same whichever rule found them first. */
    const customSaveReason = (m: FailureModel, block: RunningConditionApplyBlock): string =>
        block.kind === 'no-train' ? NO_TRAIN_PERIOD_REASON_CUSTOM
            : block.kind === 'no-rows' ? noTrainRowsReason('custom', !draftOf(m).customNoneConfirmed)
            : block.reason;

    /** Why Save is disabled (category / required fields / the model's own lists), or
     *  null. `data` as in `customSaveBlockOf`: `true` only where saving (or training,
     *  which saves first) is the action. */
    const modelBlockReason = (m: FailureModel, data = false): string | null => {
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
        if (!ok) return REQUIRED_FIELDS_BLOCK_REASON;
        // A Custom model's own periods are saved with Save changes: whatever blocks
        // the workspace Apply blocks this save too (`customSaveBlockOf`).
        const own = customSaveBlockOf(m, data);
        if (own) return customSaveReason(m, own);
        return nameConflictOf(m) ? DUPLICATE_NAME_BLOCK_REASON : null;
    };

    /** The footer's words when what blocks Save changes is in the Custom model's
     *  OWN lists: "Fix P1 before saving" / "Add a train period" / "Fix S1 before
     *  saving" / "No rows to train on" — the wording of the workspace settings'
     *  footer next to Apply; the row itself (or the red line under the timeline)
     *  says what is wrong. Null for any other reason, and while there is nothing
     *  to save (no draft). */
    const customSaveBlockText = (m: FailureModel, reason: string | null): string | null => {
        if (reason === null || !(m.id in drafts)) return null;
        const own = customSaveBlockOf(m, true);
        return own && reason === customSaveReason(m, own) ? own.footer : null;
    };

    /** The READ gate: everything Save needs (plain rules), then the gate — without
     *  the data guards. What a model may SHOW is decided by this: its charts, the
     *  Health score page, the preview, Mark complete. */
    const buildBlockReason = (m: FailureModel): string | null => orderedBlockReason(modelBlockReason(m), gateBlockOf(m));
    /** The ACTION gate — why TRAIN cannot run for this model: the read gate plus the
     *  data guards (a draft period outside the data, no train period inside the data,
     *  no rows). Asked only where Train is offered or started. */
    const trainBlockReason = (m: FailureModel): string | null => orderedBlockReason(modelBlockReason(m, true), trainGateBlockOf(m));

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
            // A scoring period that is new / changed in the draft and outside the data
            // included; one that is exactly as it was saved is not "to fix".
            const badTest = testPeriodsError(d.customTestPeriods, datasetBounds, savedCustomListsOf(m).tests);
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
        // Custom has its own editable conditions/periods (see
        // `switchRunningConditionMode` / the "Training data" field below), so the
        // collapsed summary shows what is actually configured.
        if (d.runningConditionMode === 'custom') {
            parts.push(customSummaryText({
                noneConfirmed: d.customNoneConfirmed,
                conditions: d.customFilters.length,
                trainPeriods: d.customPeriods.length,
                scoringPeriods: d.customTestPeriods.length,
            }));
        } else {
            parts.push('Workspace data');
        }
        return parts.join(' · ');
    };

    // `commitModel` returns the `persist()` promise (rather than firing it and
    // forgetting) so `trainForQueue` can await the write landing on disk first.
    /** The persistable fields a model's draft would write on Save — factored
     *  out of `commitModel` so `trainForQueue` can compute the exact same
     *  merged-with-draft model to train against, without waiting for a
     *  `persist()` round-trip + re-render to see the fresh values. The custom
     *  running-condition fields are common to every kind, so they are in `base`. */
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
        // Saving is an action: the draft's data guards apply.
        if (modelBlockReason(m, true) !== null) return;
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

    /** The Custom running-condition editor's Workspace/Custom switch. Everything
     *  it touches (`runningConditionMode`, `customFilters`/`customCombine`/
     *  `customPeriods`) is a DRAFT field, so a switch here (and any seeding it
     *  triggers) is staged, not written until Save changes. The seed check ("does
     *  this model already have its own custom rows") reads the CURRENT draft, which
     *  starts out as the model's own stored fields (`draftFromModel`) plus whatever
     *  the user has since edited. */
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

    /** The Relationship result chart's X-axis switcher — writes immediately: it is
     *  a view choice for the chart, not a model parameter like predictors /
     *  stiffness / training scope, so it does not belong in the draft / Save-
     *  changes flow. Same immediate-write shape as `changeCategory` above — a
     *  direct `persist()` call, not a `patchDraft`. */
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
     *  Workspace/Custom, …) makes the results area go stale and disables
     *  Mark complete IMMEDIATELY, not only after Save/Train. The persisted
     *  `trainedFingerprint` write itself only ever happens through
     *  `trainForQueue`/`executeTrain`, never from this. */
    const effectiveModelFor = (m: FailureModel): FailureModel =>
        m.id in drafts ? { ...m, ...draftFields(m, draftOf(m)) } : m;

    /** "Trained" (the status pill, distinct from Complete): a successful
     *  preview run exists AND its fingerprint still matches the model's current
     *  inputs AND the model isn't already Complete — see
     *  `src/utils/trainFingerprint.ts`. */
    const isModelTrainedFresh = (m: FailureModel): boolean =>
        !m.status && trainedFreshFor(effectiveModelFor(m), gateFg, specialRecipes);
    /** Was trained at some point, but the model's inputs (or the effective
     *  running condition) changed since — "Settings changed — re-train". */
    // NOT gated on `status`: a Complete model whose inputs changed since it was
    // trained is out of date too (the write side already set it Incomplete; this
    // is the read side, for old data and for a pending draft). See
    // `utils/modelStatus.ts`.
    const isModelStale = (m: FailureModel): boolean => isModelStaleFor(effectiveModelFor(m), gateFg, specialRecipes);
    /** Complete AND still up to date — what every "Complete" display reads
     *  (never `m.status` alone). */
    const isModelDone = (m: FailureModel): boolean => m.status && !isModelStale(m);

    // A model is marked Complete ONLY through `runMarkComplete` below (validate the
    // set points -> write the model's files -> persist `status: true`). Going back
    // to Incomplete only writes `status: false` (the files already written stay on
    // disk).
    const markModelIncomplete = (modelId: string) => {
        void persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: false } : m),
        }));
    };

    /** A Custom-mode model whose OWN running condition is what blocks it: the fix is inside Model settings. */
    const customFixInside = (m: FailureModel): boolean =>
        draftOf(m).runningConditionMode === 'custom' && categoryOf(m) !== null && countFreeGateReasonOf(m) !== null;
    /** "Model settings" of this model is open on screen. It opens by itself when
     *  the thing to fix is INSIDE it (a missing setting, or a Custom model's own
     *  running condition — that panel lives in this section); the user's own open /
     *  close (the override) wins; a model queued or training in the run shows the
     *  locked one-line header instead. */
    const isSettingsOpen = (m: FailureModel): boolean =>
        !queue.isLocked(m.id) && (settingsOpenOverride[m.id] ?? (missingItems(m).length > 0 || customFixInside(m)));
    /** Everything currently wrong with THIS model's own settings, plus (if
     *  distinct from the category reason `missingItems` already covers) the
     *  running-condition/period gate reason — feeds the results area's
     *  "N items to fix" list, in the same wording `missingItems` uses in the
     *  Model settings section. Each item carries its own "take me there" action. */
    const incompleteItems = (m: FailureModel): { text: string; onClick: () => void }[] => {
        const items = missingItems(m).map(text => ({
            text,
            onClick: () => setSettingsOpenOverride(prev => ({ ...prev, [m.id]: true })),
        }));
        // The gate — and, for a model that still has to train, "nothing to train on".
        const gr = gateReasonOf(m) ?? shownGuardBlockOf(m)?.reason ?? null;
        // Avoid double-reporting the category reason: `missingItems` already
        // lists "Pick a category" when it's null; `gateReasonOf` returns the
        // SAME `CATEGORY_BLOCK_REASON` text in that case, not a distinct one.
        // A Custom-mode model's own condition/period editor lives inline in
        // its Model settings section, not in the workspace Running Condition
        // modal, so its link goes there (same action `missingItems` above
        // uses to jump to a missing field).
        if (gr && categoryOf(m) !== null) {
            const isCustom = draftOf(m).runningConditionMode === 'custom';
            items.push({
                text: ownGateText(m, gr) ?? gr,
                onClick: () => isCustom
                    ? setSettingsOpenOverride(prev => ({ ...prev, [m.id]: true }))
                    : setRcFilterOpen(true),
            });
        }
        return items;
    };

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
    /** What a "no rows" answer of the engine is about: this training scope (the train
     *  fingerprint) on this dataset (`noRowsLoads`). */
    const noRowsLoadKey = (fingerprint: string): string => `${fingerprint}|${generation ?? ''}`;
    const forgetNoRowsLoad = (id: string) => setNoRowsLoads(prev => {
        if (!(id in prev)) return prev;
        const rest = { ...prev };
        delete rest[id];
        return rest;
    });
    /** A model that HAS results (trained and up to date, or Complete) and whose
     *  training scope holds NO row of the loaded data — else null. Its charts are
     *  computed from the loaded data, so they cannot be drawn; nothing about the model
     *  changed. Known from the same source that blocks its Train (`trainGuardBlockOf`:
     *  no train period inside the data — known at once — or a settled count of zero),
     *  or, while that was not known yet, from the engine's own "no rows" answer to
     *  the silent load (`noRowsLoads`). Display only — nothing is ever written for it:
     *  the model keeps its own status words, ONE board says why there are no charts
     *  and where to fix it, and the window does not ask the engine for it.
     *  Not while it is being loaded (the answer is on its way), not for a run of this
     *  session that failed for another reason, and not while the gate itself blocks
     *  the model (those boards say what to fix first). */
    const noDataOf = (m: FailureModel): ModelNoData | null => {
        if (!m.lastTrainedAt || isModelStale(m)) return null;
        if (trainStatus[m.id] === 'loading' || trainError[m.id]) return null;
        if (buildBlockReason(m) !== null) return null;
        const guard = trainGuardBlockOf(m);
        if (guard !== null && guard.kind === 'no-rows') return { cause: guard.cause, mode: guard.mode, hasCondition: guard.hasCondition };
        if (noRowsLoads[m.id] !== undefined && noRowsLoads[m.id] === noRowsLoadKey(computeTrainFingerprint(m, gateFg))) {
            return { cause: 'engine', mode: effectiveModelFor(m).runningConditionMode === 'custom' ? 'custom' : 'workspace', hasCondition: true };
        }
        return null;
    };
    /** Runs the read-only preview computation for ONE model (`compute_sensor_stats` /
     *  `preview_relationship_model` / `compute_clustering_preview`). Never writes a
     *  `*_INFO_*.json` file — Mark complete does. `opts.persistMeta` distinguishes
     *  an explicit Train/Re-train (writes `lastTrainedAt`/`trainedFingerprint` via
     *  `persist()`, never a hand-built object literal) from the silent
     *  auto-recompute that runs when reopening an already-Trained-and-fresh model
     *  (session-only — nothing to persist, the fingerprint hasn't changed).
     *  `merged` carries the exact inputs used, so a Train can pass the
     *  just-committed draft values without waiting for this window's state to
     *  re-render first (see `trainForQueue`).
     *  Returns its outcome for the train queue (`useTrainQueue`) while still
     *  setting `trainError` for the window's own UI: `{ ok: true }`, a failure
     *  (`stale` when the dataset is no longer this window's — the run then
     *  stops), or `abandoned` when the window was re-pointed at another
     *  workspace meanwhile. */
    const executeTrain = async (merged: FailureModel, fingerprint: string, opts: { persistMeta: boolean }): Promise<TrainOutcome> => {
        const id = merged.id;
        // A Train can still be running when this window gets re-pointed at a
        // different workspace (`build-model-data` for a new project).
        // `persist()`'s write targets the `workspaceId` its own closure
        // captured, which is fine — but its `applyFg` call would replace this
        // window's CURRENT in-memory state even though `workspaceIdRef` already
        // points elsewhere. So capture the workspace this run belongs to now,
        // and refuse to write back (or touch any of this window's state) if it
        // no longer matches once the preview finishes. A stray
        // `trainStatus`/`trainResults` entry for the abandoned model id is
        // harmless: the effect above prunes any id no longer in `allModels`.
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
                result = { kind: 'relationship', result: r };
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
            forgetNoRowsLoad(id);
            // The Relationship fit is now in Rust's cache under this key: make the
            // health preview (re)fetch even if its request is byte-identical. Only
            // for the model on screen (the one preview there is): a training run
            // must not refetch the open model's charts after every OTHER model.
            if (activeModelIdRef.current === id) setHealthRevision(r => r + 1);
            // Rust holds the fit again (an explicit train, the silent re-fit or "Load it
            // again"): no longer "fit gone". Should the next preview still answer
            // NOT_FITTED, the effect below marks it again.
            setNotFittedIds(prev => {
                if (!prev.has(id)) return prev;
                const rest = new Set(prev);
                rest.delete(id);
                return rest;
            });
            if (opts.persistMeta) {
                // An explicit train: a later NOT_FITTED of this model may be re-fitted
                // automatically again.
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
            // The engine found nothing to train on (a scope the window had not counted —
            // a Custom model that is not the open one — or a sensor with no value in the
            // train periods): the named reason and where to fix it, not the raw text.
            const raw = e instanceof Error ? e.message : String(e);
            const noRows = parsed.code === 'SIDECAR_OUTDATED' ? null : noRowsTrainError(raw, merged.runningConditionMode === 'custom');
            const message = parsed.code === 'SIDECAR_OUTDATED' ? parsed.message : noRows ?? raw;
            if (noRows !== null && !opts.persistMeta) {
                // A SILENT load (opening a trained / Complete model, "Load it again") that
                // found no row: nobody trained it and nothing about the model changed, so
                // this is not a failed train. Remembered for this scope and dataset — the
                // window shows the "No data for this model in the loaded file" board
                // (`noDataOf`) and does not ask again.
                setNoRowsLoads(prev => ({ ...prev, [id]: noRowsLoadKey(fingerprint) }));
                return { ok: false, error: message };
            }
            forgetNoRowsLoad(id);
            setTrainError(prev => ({ ...prev, [id]: message }));
            // The train commands never answer STALE_SESSION themselves: the real
            // "this data is not ours any more" signal is the generation check above
            // (DATASET_CHANGED_MESSAGE). Either one stops a run.
            const stale = message === DATASET_CHANGED_MESSAGE || parsed.code === 'STALE_SESSION' || isStaleTrainError(message);
            return stale ? { ok: false, error: message, stale: true } : { ok: false, error: message };
        }
    };

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
     *  untouched (re-deriving fields from an empty draft could fingerprint a
     *  value that is not what is stored). */
    const trainForQueue = async (id: string): Promise<TrainOutcome> => {
        // Captured BEFORE any await: a re-point while waiting abandons this model.
        const ws = workspaceIdRef.current;
        // The silent auto-recompute may still be running: wait, never two sidecar calls at once.
        if (autoRecomputeRef.current) await autoRecomputeRef.current.catch(() => undefined);
        if (workspaceIdRef.current !== ws) return { ok: false, abandoned: true };
        const m = allModels.find(x => x.id === id);
        if (!m) return { ok: false, skip: 'the model no longer exists' };
        if (completeRunningRef.current.has(id)) return { ok: false, skip: BEING_SAVED_REASON };
        // Training is THE action the data guards exist for: re-checked at run time.
        const block = trainBlockReason(m);
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
                blockReason: trainBlockReason(m),
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

    /** Why "Load it again" cannot run right now, or null: one engine call at a time. */
    const fitReloadBlock = (m: FailureModel): string | null => {
        if (queue.stale) return TRAIN_STALE_MESSAGE;
        if (queue.isRunning) return TRAIN_RUN_ACTIVE_REASON;
        if (saveInfo[m.id]?.phase === 'running') return FIT_RELOAD_SAVING_REASON;
        // A model whose settings (an unsaved draft that cannot be saved) or running
        // condition block it cannot be loaded: the link is disabled with that reason
        // instead of doing nothing. (The read gate: loading a trained model again is
        // not a train — the data guards do not stand in its way.)
        return awayFromFormText(m, buildBlockReason(m));
    };
    /** "Load it again" on the "Fit no longer in memory" boards (and the footer): the
     *  SAME silent re-fit the window runs by itself the first time a fit is lost
     *  (`persistMeta: false`), asked for by the user once that automatic try is used up.
     *  Nothing about the model changed, so NOTHING is written: status, `lastTrainedAt`
     *  and the fingerprint stay — a Complete model stays Complete (Train sensor never
     *  trains one, and a re-train would set it back to Incomplete). The board reads
     *  "Loading the Relation model…" meanwhile; a load that fails comes back to the
     *  board with its reason (`trainError`). */
    const reloadFit = (id: string) => {
        const m = allModels.find(x => x.id === id);
        if (!m || fitReloadBlock(m) !== null) return;
        if (trainStatus[id] === 'loading' || fitReloadingRef.current.has(id)) return;
        // Only a model that is trained and still current has a fit to load again.
        const fp = computeTrainFingerprint(m, gateFg);
        if (!m.lastTrainedAt || m.trainedFingerprint !== fp) return;
        const ws = workspaceIdRef.current;
        const before = autoRecomputeRef.current;
        fitReloadingRef.current.add(id);
        const p = (async (): Promise<TrainOutcome> => {
            try {
                // Another model's silent load may still be running: never two engine calls at once.
                if (before) await before.catch(() => undefined);
                if (workspaceIdRef.current !== ws || queueRef.current.isRunningNow()) return { ok: false, abandoned: true };
                const out = await executeTrain(m, fp, { persistMeta: false });
                // Loaded: should this fit be lost again later, it is re-fitted automatically once more.
                if (out.ok) for (const k of [...refitTriedRef.current]) if (k.startsWith(`${id}::`)) refitTriedRef.current.delete(k);
                // A Mark complete that was refused ONLY because the fit was gone has nothing
                // left to fix now: its red card and the footer's "Not saved" go with the
                // user's own "Load it again". (Any other refusal stays until it is acted on.)
                if (out.ok && workspaceIdRef.current === ws) {
                    setSaveInfo(prev => {
                        const cur = prev[id];
                        if (!cur || cur.phase !== 'error' || cur.message !== FIT_GONE_SAVE_MESSAGE) return prev;
                        const rest = { ...prev };
                        delete rest[id];
                        return rest;
                    });
                }
                return out;
            } finally {
                fitReloadingRef.current.delete(id);
            }
        })();
        // A training run started meanwhile waits for it (`trainForQueue`).
        autoRecomputeRef.current = p;
        void p.finally(() => { if (autoRecomputeRef.current === p) autoRecomputeRef.current = null; });
    };

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
        // The refusal Rust gave for the previous values no longer describes these — and
        // neither does the "not saved" outcome of that attempt (its red card and the
        // footer's "Not saved" would otherwise stay for the rest of the session and
        // hide the real reason Mark complete is blocked).
        setAttemptIssues(prev => (prev[m.id] ? { ...prev, [m.id]: null } : prev));
        dismissSaveInfo(m.id);
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
        // (The gate as it always was: Mark complete is not a train, the data guards
        // do not block it.)
        const notAllowed = getBuildBlockReason(model, fg, gateHeaders)
            // At least one valid scoring period.
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
            const draftBlock = modelBlockReason(m, true);
            if (draftBlock !== null) return fail(awayFromFormText(m, draftBlock) ?? draftBlock);
        }
        completeRunningRef.current.add(m.id);
        setSaveInfo(prev => ({ ...prev, [id]: { phase: 'running' } }));
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
                    if (res.code === 'NOT_FITTED') {
                        // The page still shows a valid preview, so Mark complete would stay
                        // enabled and fail the same way on every click: mark the fit as gone
                        // and ask the preview again (it answers NOT_FITTED too — the fit is
                        // then loaded again silently once, or the board offers "Load it again").
                        if (stillHere()) {
                            setNotFittedIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
                            setHealthRevision(r => r + 1);
                        }
                        return fail(FIT_GONE_SAVE_MESSAGE);
                    }
                    if (res.code === 'STALE_SESSION') return fail('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
                    return fail(res.error ?? 'The model could not be saved.');
                }
                // Built by the ONE builder: it carries the scoring interval the validating
                // preview reported (`scoringIntervalSecs`, 3600 = 1-hour averages).
                const record = healthExportRecord(res, new Date().toISOString());
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
                setSaveInfo(prev => ({ ...prev, [id]: { phase: 'ok', outputDir: res.outputDir, at: record.at } }));
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

    /** The close itself: `flushFocusedInput()` first (a half-typed period date
     *  settles on blur only), then flush every pending write (and wait for a
     *  running Mark complete, capped), then close. */
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

    // A native close (the window's own X button, Alt+F4, or the OS closing the
    // app) bypasses `handleClose` entirely. Only intercepts the close when this
    // window has an in-flight write of its own.
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const win = getCurrentWindow();
        Promise.resolve(win.onCloseRequested(async (event) => {
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

    // Computed above the `if (loading)` guard (and therefore above every hook
    // below it) so `individualChartQuery`/the auto-recompute effect can read
    // `activeModel` — every hook in this component must run unconditionally
    // on every render, so none of them can sit after an early return.
    const sensorGroupsAll = allSensorGroups(allModels);
    const fullSensorMap = new Map(sensorGroupsAll.map(sg => [sg.key, sg]));
    const detailModels = selectedSensorKey !== null ? (fullSensorMap.get(selectedSensorKey)?.models ?? []) : [];
    const orderedDetail = KIND_ORDER.flatMap(k => detailModels.filter(m => m.kind === k));
    const activeModel = orderedDetail.find(m => m.id === activeTab[selectedSensorKey ?? '']) ?? orderedDetail[0];
    /** The model on screen, for code that finishes after an await (`executeTrain`). */
    const activeModelIdRef = useRef<string | null>(null);
    activeModelIdRef.current = activeModel?.id ?? null;

    // ---- Auto-recompute on reopen ---
    // A model that is already Trained-and-fresh (per the WORKSPACE'S
    // persisted `lastTrainedAt`/`trainedFingerprint`) shows its result
    // immediately, with no click required — this silently re-runs the same
    // read-only preview query in the background whenever the Workbench doesn't
    // yet have a cached result for the CURRENT fingerprint (a fresh session, or
    // this exact model wasn't open before). It ALSO runs for a Complete model —
    // the Model fit page shows the charts of a Complete model too, and a
    // Relationship model's health preview reads the fit that this run re-fills
    // in Rust's cache after a reload. It never persists anything
    // (`persistMeta: false` — the fingerprint didn't change, and `status` is
    // never touched), and never fires while a run for this model is already in
    // flight.
    // (The effect itself sits further down, right after the active Custom model's
    // row count: it must not ask the engine for a model that is known to have no
    // row in the loaded data — `noDataOf`.)

    // ---- Health preview + Sub-models for the ACTIVE model ----
    // ONE `useHealthPreview` call feeds both pages of the detail pane: the bounded
    // series/stats Rust returns for the Model fit charts and the score of
    // the Health score page. It is given the DRAFT-merged model (same as Train),
    // so an unsaved edit that changes the training inputs makes it idle ("stale")
    // while the last data stays on screen under the "Out of date" overlay.
    const activeEffective = activeModel ? effectiveModelFor(activeModel) : null;

    /** Which page of the detail pane a model shows. The Health score page is only
     *  ever shown for a model that was trained and is up to date (it reads the
     *  trained fit); otherwise the stored choice is ignored, not erased. */
    const pageOf = (m: FailureModel): WorkbenchPage => {
        const want = pageByModel[m.id] ?? 'model';
        return want === 'health' && (isModelStale(m) || !m.lastTrainedAt) ? 'model' : want;
    };

    // A Custom model's OWN running condition, as drafted. `activeCustomDraft` keeps
    // one identity per draft / saved model, so the hook's inputs do not change on
    // unrelated renders.
    const activeDraftEntry = activeModel ? drafts[activeModel.id] : undefined;
    const activeCustomDraft = useMemo(
        () => (activeModel ? (activeDraftEntry ?? draftFromModel(activeModel)) : null),
        [activeModel, activeDraftEntry],
    );
    const activeIsCustom = !!activeModel && activeCustomDraft?.runningConditionMode === 'custom';
    // Model settings — and with them a Custom model's own panel — are drawn on the
    // Model fit page only. On the Health score page NOTHING of it is on screen, so
    // nothing may be counted or re-read for it there.
    const activeOnFitPage = !!activeModel && pageOf(activeModel) === 'model';
    const customPanelOpen = activeIsCustom && activeOnFitPage && isSettingsOpen(activeModel);
    // With the panel closed the train running time still feeds the amber "below
    // the recommended train time" note on the Model fit charts
    // (`trainDaysEstimateFor`) and the zero-rows guard — asked only while the model
    // could train (nothing but the count itself blocks it), and then for the train
    // periods alone: one call.
    const activeCustomCanTrain = !!activeEffective && activeEffective.runningConditionMode === 'custom'
        && getBuildBlockReason(activeEffective, gateFg, gateHeaders, { bounds: datasetBounds }) === null;
    const customCountsWanted = activeIsCustom && activeOnFitPage && (customPanelOpen || activeCustomCanTrain);
    const customCountFilter = useMemo(
        () => (activeCustomDraft && activeCustomDraft.runningConditionMode === 'custom'
            ? buildPreviewFilterPayload(
                { filters: activeCustomDraft.customFilters, combine: activeCustomDraft.customCombine, noneConfirmed: activeCustomDraft.customNoneConfirmed, periods: activeCustomDraft.customPeriods },
                gateHeaders,
            )
            : null),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [activeCustomDraft, allSensors],
    );
    const customCounts = usePeriodCounts({
        enabled: !loading && customCountsWanted,
        workspaceId,
        trainPeriods: activeCustomDraft?.customPeriods ?? NO_PERIODS,
        // The scoring rows are only printed by the open panel.
        scoringPeriods: customPanelOpen ? (activeCustomDraft?.customTestPeriods ?? NO_PERIODS) : NO_PERIODS,
        filter: customCountFilter,
        expectedGeneration: generation,
    });
    // The zero-rows guard of the active Custom model (see `customNoRowsKey` above):
    // its own condition is configured, its count is settled, and no row is left —
    // remembered as the training scope that was counted, so a sibling Custom model
    // on the very same scope reads the same answer (`customNoRowsOf`).
    customNoRowsKey = activeModel && activeEffective && activeCustomDraft && activeIsCustom
        && isRunningConditionConfigured(activeEffective, gateFg, gateHeaders)
        && countedNoTrainRows(customCounts)
        ? customCountKeyOf(activeCustomDraft) : null;

    /** The model on screen has results but no row in the loaded data (`noDataOf`):
     *  nothing is asked of the engine for it (no silent load, no health preview) and
     *  nothing is written — both pages show the one "No data…" board. */
    const activeNoData = activeModel ? noDataOf(activeModel) : null;
    const activeGuardHolds = !!activeModel && trainGuardBlockOf(activeModel) !== null;
    // The auto-recompute on reopen (see the block comment above).
    useEffect(() => {
        if (!activeModel) return;
        if (buildBlockReason(activeModel) !== null) return;
        const fp = computeTrainFingerprint(activeModel, gateFg);
        if (!activeModel.lastTrainedAt || activeModel.trainedFingerprint !== fp) return;
        const cached = trainResults[activeModel.id];
        if (cached && cached.fingerprint === fp) return;
        if (trainStatus[activeModel.id] === 'loading') return;
        // No row of the loaded data is in its training scope (no train period inside
        // the data, a settled count of zero, or the engine already said so for this
        // scope): a load could only fail — the board says why instead. (A count that
        // is not settled yet is not known here: the load is attempted, and the
        // engine's "no rows" answer leads to the same board.)
        if (activeGuardHolds || noRowsLoads[activeModel.id] === noRowsLoadKey(fp)) return;
        // A training run owns the sidecar: two calls must never run at once. The
        // effect runs again when the run ends (`queue.isRunning` is a dependency).
        if (queue.isRunning) return;
        const p = executeTrain(activeModel, fp, { persistMeta: false });
        autoRecomputeRef.current = p;
        void p.finally(() => { if (autoRecomputeRef.current === p) autoRecomputeRef.current = null; });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, activeModel?.trainedFingerprint, activeModel?.lastTrainedAt, activeModel?.status, activeModel?.category, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionNoneConfirmed, queue.isRunning, activeModel ? trainResults[activeModel.id]?.fingerprint : undefined, activeGuardHolds, activeNoData !== null]);

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
        // No row of the loaded data in its training scope: there is nothing to preview.
        && activeNoData === null
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
    // Any Relation-model preview: the engine now predicts the training hours too, so it can
    // run with no scoring period (the delay keeps the hint off the fast, cached previews).
    const scoringTestsNow = !!activeEffective && activeEffective.kind === 'relationship' && healthPreview.loading;
    const slowScoring = useDelayedFlag(scoringTestsNow, SLOW_SCORING_HINT_DELAY_MS);

    // The last validate verdict Rust gave for the active model. A stale model's old data
    // does not count. It drives the step bar live; the "Set points needed" / "Fix set point"
    // tab pills and dots (here AND on the Dashboard) read the PERSISTED copy of it
    // (`healthVerdict` on the model), written by the effect below.
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
        // No data for it in the loaded file: its Health score page is the "No data…"
        // board — nothing is written for a model in that state.
        if (activeNoData !== null) return;
        if (setPointsSeededRef.current.has(activeModel.id) || spDraftsRef.current[activeModel.id]) return;
        const ensured = ensureHealthSetPoints(activeModel, sensorMetadata ?? []);
        if (ensured === activeModel || !ensured.healthSetPoints) return;
        setPointsSeededRef.current.add(activeModel.id);
        writeSpDrafts({ ...spDraftsRef.current, [activeModel.id]: ensured.healthSetPoints });
        void commitSetPointDrafts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, activeModel, pageByModel, sensorMetadata, activeNoData !== null]);

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

    // ---- Clustering cluster-range slider bounds ---------------------------
    // Fetches `compute_sensor_stats` for the criteria sensor so the slider can
    // span its REAL data range instead of an abstract 0-100 scale. Draft-aware
    // (the criteria sensor and the training-scope filter both read through
    // `draftOf`/`effectiveModelFor`, same as the live fingerprint check above)
    // so editing the criteria picker or the Workspace/Custom switch before Save
    // still moves the slider immediately — the scope is the one Train would
    // use, which for an unsaved draft edit IS the draft's scope.
    // `criteriaFilterKey` collapses everything that could change the resolved
    // filter payload into one string so the effect doesn't need a long,
    // easy-to-miss dependency list of individual draft sub-fields.
    const criteriaSensorForActive = (activeModel && activeModel.kind === 'clustering') ? draftOf(activeModel).criteria : '';
    const criteriaFilterKey = useMemo(() => {
        if (!activeModel || activeModel.kind !== 'clustering' || !criteriaSensorForActive) return '';
        const merged = effectiveModelFor(activeModel);
        const eff = effectiveRunningCondition(merged, gateFg);
        return JSON.stringify(buildPreviewFilterPayload(eff, gateHeaders));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, drafts, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionNoneConfirmed, gateHeaders]);
    // The stats only count for the model + criteria sensor + filter they were fetched for.
    // The reset below runs in an effect, i.e. AFTER the render that switched the criteria
    // sensor A -> B, so in that render the state still holds A's stats. Deriving per render
    // means stats for another key read as "not arrived yet", so the auto-divide waits for
    // B's own stats instead of dividing B's ranges over A's [min, max].
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
        // `criteriaStats` is ONE piece of state shared by every model (scoped to
        // whichever model is active). Reset unconditionally at the top, before
        // the early-return AND before kicking off a new fetch, so every
        // model/sensor change shows the loading state until its OWN stats
        // resolve — never the previous model's [min, max].
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

    // ---- Clustering auto-divide --------------------------------------------
    // Divides `clusterRanges` equally across the criteria sensor's REAL
    // [min, max] whenever the criteria sensor or the cluster count changes, and
    // keeps `ranges.length` in sync with `numClusters` (so Train never sends
    // N-1 or N+1 `cluster_ranges` for `n_clusters: N`).
    //
    // The "previous key" is anchored on the PERSISTED model's own
    // (criteria, numClusters) pair, so this only fires once the draft has
    // actually DIVERGED from what is saved — a real user edit via `patchDraft`
    // (the criteria picker or the +/- stepper) — or when the array length is
    // out of sync with `numClusters` (legacy/mismatched data), which self-heals.
    // Merely opening an already-configured model never creates a phantom draft
    // ("Unsaved changes") and never overwrites a saved custom (non-equal) split.
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
            // The division is PENDING until the criteria sensor's stats arrive.
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

    // ---- Running condition: row counts of the settings modal ----
    // (The card's count of the persisted condition and the active Custom model's
    // own count are asked further up — the gate reads them.)
    const draftCountFilter = useMemo(
        () => buildPreviewFilterPayload(
            rcDraft ?? { filters: runningConditionFilters, combine: runningConditionCombine, noneConfirmed: runningConditionNoneConfirmed, periods: runningConditionTimePeriods },
            gateHeaders,
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [rcDraft, runningConditionFilters, runningConditionCombine, runningConditionNoneConfirmed, runningConditionTimePeriods, allSensors],
    );
    // The modal's DRAFT (what Apply would commit). The lists are the draft's own
    // arrays (stable until the draft changes), the filter is memoised above.
    const rcCountPeriods = rcDraft ? rcDraft.periods : runningConditionTimePeriods;
    const rcCountTests = rcDraft ? rcDraft.testPeriods : runningConditionTestPeriods;
    const rcCounts = usePeriodCounts({
        enabled: !loading && rcFilterOpen,
        workspaceId,
        trainPeriods: rcCountPeriods,
        scoringPeriods: rcCountTests,
        filter: draftCountFilter,
        expectedGeneration: generation,
    });
    // The modal's zero-rows guard: the count shown is the draft's own (settled), the
    // condition is configured (else nothing is counted for it), no running row is
    // left in its train periods — AND the draft changed what is trained on (its
    // train periods or its condition). Apply is disabled on it (`rcApplyBlock`). A
    // draft that left the training scope as it was saved (only a scoring period
    // moved, say) is not blocked by a zero the saved state already had: the red line
    // under the timeline and the red card say it, and Train is what is blocked.
    const rcCountView = rcDraft ?? rcPersisted;
    const rcNoRows = rcFilterOpen
        && isWorkspaceRunningConditionConfigured(
            { runningConditionFilters: rcCountView.filters, runningConditionNoneConfirmed: rcCountView.noneConfirmed },
            gateHeaders,
        )
        && countedNoTrainRows(rcCounts)
        && trainCountKey(rcCountPeriods, draftCountFilter) !== trainCountKey(runningConditionTimePeriods, persistedCountFilter);
    rcGateRef.current = { draft: rcDraft, bounds: datasetBounds, noTrainRows: rcNoRows };

    // The Dashboard may have changed its highlights since this window opened:
    // re-read them whenever the Running condition settings open — and whenever a
    // Custom model's own panel is shown (its train-overlap line reads them too).
    // One cheap read of the workspace file.
    useEffect(() => {
        if (rcFilterOpen || customPanelOpen) void refreshHighlights();
    }, [rcFilterOpen, customPanelOpen, refreshHighlights]);

    // Keyboard focus of the modal: the first field on open, Tab kept inside.
    useModalFocus(rcDialogRef, rcFilterOpen, '[data-testid="rc-panel"]');

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
        reloadFit: () => void;
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
    /** "Load it again" of the model on screen (stable: the Health score page is memoised). */
    const onReloadFit = useCallback(() => actionsRef.current?.reloadFit(), []);
    /** "Train sensor ↑": every sentence's link to the ONE place to train. */
    const focusTrainSensor = useCallback(() => { trainSensorBtnRef.current?.focus(); }, []);
    // The focused "Save changes" disappears once its draft is saved. Move the focus to
    // the button that takes its place ("Next: Health score →"), or to the footer's
    // status line when that one is disabled, so it does not fall back to <body>.
    useEffect(() => {
        const id = saveFocusRef.current;
        if (!id) return;
        saveFocusRef.current = null;
        if (id in drafts) return; // not saved (or edited again): the button is still there
        const active = document.activeElement;
        if (active && active !== document.body) return; // the focus is somewhere real
        const next = nextHealthBtnRef.current;
        (next && !next.disabled ? next : footerRef.current)?.focus();
    }, [drafts]);

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
    }

    // Step-1 card / lock message / Train buttons all read the PERSISTED condition
    // (the plain date rules — a saved period outside the loaded data only warns).
    const rcStepState: RcStepState = !rcConfigured ? 'unset' : persistedPeriodsInvalid ? 'invalid' : 'set';

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModelsCount = allModels.length;
    const completeModelsCount = allModels.filter(isModelDone).length;

    /** The status of one model for the left list's dot / the tab pill. A failed
     *  run of this session overrides an otherwise "trained" model. */
    const dotStateOf = (m: FailureModel): ModelDotState => {
        const st = modelDotState(effectiveModelFor(m), gateFg, gateHeaders, specialRecipes);
        // A model that still has to train (never trained, or out of date) and has
        // nothing to train on: "needs fixing" like any other gate block. Display only
        // — the model's saved status is untouched. A trained or Complete model keeps
        // its own state (it has results; the guard only stops training it AGAIN).
        if ((st === 'none' || st === 'stale') && trainGuardBlockOf(m) !== null) return 'blocked';
        return st === 'trained' && trainError[m.id] ? 'stale' : st;
    };

    // ---- Train queue ----
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
        reloadFit: () => { if (activeModel) reloadFit(activeModel.id); },
    };
    /** The Relation-model fit Rust held for a trained model is gone (NOT_FITTED was
     *  answered for it in this session and it has not been fitted again since): it
     *  needs training again — Train sensor / Train all already plan it as ready
     *  (`candidateOf`). Known for EVERY model the window was told NOT_FITTED about, not
     *  only the one on screen; a fit dropped for a model that has not been opened since
     *  is only found out when it is opened (finding out takes a request). Not while it
     *  is being fitted again. For the model on screen: the LIVE answer, or — until an
     *  answer for it is there (its tab was just opened again) — its own mark, so a
     *  fit-gone model never reads "Trained" for the moment the request takes. (Every
     *  successful fit clears the mark, see `executeTrain`.) */
    const fitGoneOf = (m: FailureModel): boolean =>
        trainStatus[m.id] !== 'loading'
        && (activeModel?.id === m.id
            ? healthPreview.notFitted || (notFittedIds.has(m.id) && !healthPreview.data)
            : notFittedIds.has(m.id));
    /** What the "Fit no longer in memory" board of the model ON SCREEN offers: "Load it
     *  again" for every status, and "Train sensor ↑" only for a model it really trains —
     *  a Complete model is "up to date" for Train sensor, so that link would do nothing. */
    const fitGoneActionsOf = (m: FailureModel): FitGoneActions => ({
        onReload: onReloadFit,
        reloadDisabledReason: fitReloadBlock(m) ?? undefined,
        onGoTrainSensor: isModelDone(m) ? undefined : focusTrainSensor,
        // A load (or a train) of it that failed since.
        error: trainError[m.id] ?? null,
        // The window's own knowledge that the fit is gone: the live answer is not
        // there any more once the tab was left and opened again after a failed load.
        gone: fitGoneOf(m),
    });
    /** A COMPLETE model whose last load (or train) of this session failed, with its fit
     *  not reported gone: Train sensor never trains it ("up to date"), so every sentence
     *  about it offers "Load it again" — the same silent load, nothing written — instead
     *  of "Train sensor ↑". (A model that is not Complete is planned as ready by Train
     *  sensor after a failure, so it keeps "Training failed · Train sensor ↑".) */
    /* Only a model WITH a train record has something to load again (`reloadFit`
     *  returns for one without). */
    const loadFailedOf = (m: FailureModel): boolean =>
        !!trainError[m.id] && trainStatus[m.id] !== 'loading' && isModelDone(m) && !!m.lastTrainedAt && !fitGoneOf(m);
    /** A COMPLETE model with NO train record (marked complete before train records
     *  existed) whose train from the ▾ menu failed in this session: there is nothing
     *  to "load again" — it says "Training failed" and the way out is the ▾ menu row
     *  that trains it; its "Marked complete" board carries the reason. */
    const legacyTrainFailedOf = (m: FailureModel): boolean =>
        !!trainError[m.id] && trainStatus[m.id] !== 'loading' && isModelDone(m) && !m.lastTrainedAt;
    /** The words of a failed run on the tab / list dot. */
    const failedWordsOf = (m: FailureModel): string =>
        !isModelDone(m) ? TRAIN_FAILED_WORDS
            : m.lastTrainedAt ? `Complete · ${LOAD_FAILED_WORDS}`
            : `Complete · ${TRAIN_FAILED_WORDS}`;
    /** Why "Train sensor ↑" would not train this out-of-date model right now (the stale
     *  banner then says that instead of offering a link that does nothing): the data is
     *  not this window's any more, the model itself cannot train, or a run is active. */
    const staleCantTrainOf = (m: FailureModel): StaleCantTrain | undefined => {
        if (queue.stale) return { kind: 'stale', text: TRAIN_STALE_MESSAGE };
        const own = awayFromFormText(m, trainBlockReason(m));
        if (own) return { kind: 'reason', text: own };
        if (queue.isRunning) return { kind: 'run', text: TRAIN_RUN_ACTIVE_REASON };
        return undefined;
    };
    /** "Set points needed" list chip: only after a run trained something here. */
    const spCount = sensorGroupsAll.filter(sg => sg.models.some(needSetPoints)).length;
    const showSpChip = !!queue.lastTrained && queue.lastTrained.ids.length > 0 && spCount > 0;
    const listFilter: SidebarFilter = sidebarFilter === 'sp' && !showSpChip ? 'all' : sidebarFilter;

    // "Needs setup": what the red dot says — the gate, or (for a model that still
    // has to train) nothing to train on. Never a trained or Complete model's guard.
    const sensorBuildBlocked = (sg: SensorModelGroup) => sg.models.some(m => buildBlockReason(m) !== null || shownGuardBlockOf(m) !== null);
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
                    {/* The stacked SensorLabel (unit chip, tag on line 2). */}
                    {keyTag ? <SensorLabel tag={keyTag} /> : <div className="f4-sr-title">{title}</div>}
                </div>
                <div className="f4-kinds">
                    {ordered.map(m => {
                        // Status dot in the badge's corner, straight
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
                                // A model with results but no row in the loaded data keeps its own dot and words.
                                title={`${KIND_TAB_LABEL[m.kind]} · ${failedRun ? failedWordsOf(m) : fixSetPoint ? 'Fix set point' : DOT_TITLE[st]}${noDataOf(m) ? ` · ${NO_MODEL_DATA_WORDS}` : ''}`}
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

    // ---- Detail pane ---- `detailModels`/`orderedDetail`/`activeModel` are
    // computed above (before the `if (loading)` guard — every hook needs them,
    // see the comment there).

    /** Cluster-range slider — colored `CLUSTER_PALETTE` segments spanning the
     *  criteria sensor's REAL [min, max] (`criteriaStats`, fetched by the
     *  effect above), N-1 draggable boundary handles, value pills below. Drag
     *  reads/writes through `patchDraft` — `startSplitDrag` re-reads
     *  `draftOf(m).ranges` on every mousemove rather than closing over a stale
     *  `d.ranges` snapshot from the render that started the drag, since a drag
     *  session outlives any single render. Only ever called for the CURRENTLY
     *  ACTIVE model (via `renderModelSettingsFields` below), so `criteriaStats`
     *  (scoped to `activeModel`) is always the right sensor's stats for
     *  whichever `m`/`d` this renders. */
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
                {/* Value pills: every inner boundary is typeable — the upper bound of
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
            {/* Model settings is ONE grid of three equal columns for all three kinds (SPEC
                docs/design/handoff/model-settings-layout): row 1 is always Model name · the
                kind's own setting · Training data; every control is 30 px high. */}
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
                            Same name as this sensor's {kindModelName(conflict.kind)} — give it a different name so they can be told apart
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

            {/* Row 1, middle column: the kind's own "how" setting — Boundary (Individual),
                Stiffness (Relation model) or Clusters (Clustering). `.bmw-sets-kind` is
                `display: contents`: a grouping with no box, so its field is a cell of the
                form's grid. The DOM order is the order on screen (name · how · training
                data, then the sensors), so Tab walks the form as it reads. */}
            <div className="bmw-sets-kind">
            {m.kind === 'individual' && (
                <div className="f4-fld">
                    <span className="f4-lbl">Boundary</span>
                    <span className="f4-readout ms-ro" data-testid="boundary-readout"><Lock size={12} aria-hidden="true" /><span>1σ + 3σ · automatic</span></span>
                    <div className="f4-hint">Everything else is automatic for an Individual model.</div>
                </div>
            )}
            {m.kind === 'relationship' && (
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
            )}
            {m.kind === 'clustering' && (
                <div className="f4-fld">
                    <span className="f4-lbl">Clusters</span>
                    <span className="bmw-step">
                        <button type="button" aria-label="Fewer clusters" onClick={() => patchDraft(m, { numClusters: Math.max(1, d.numClusters - 1) })}>−</button>
                        <span>{d.numClusters}</span>
                        {/* Never `Math.min(MAX_CLUSTERS, …)`: that would LOWER a legacy model that has more. */}
                        <button
                            type="button"
                            aria-label="More clusters"
                            disabled={d.numClusters >= MAX_CLUSTERS}
                            title={d.numClusters >= MAX_CLUSTERS ? MAX_CLUSTERS_REASON : undefined}
                            onClick={() => { if (d.numClusters < MAX_CLUSTERS) patchDraft(m, { numClusters: d.numClusters + 1 }); }}
                        >
                            +
                        </button>
                    </span>
                </div>
            )}
            </div>

            {/* Row 1, last column, in all three kinds. */}
            <div className="f4-fld f4-fld--traindata">
                <span className="f4-lbl">Training data</span>
                <div className="f4-seg">
                    <button type="button" className={d.runningConditionMode === 'workspace' ? 'on' : undefined} onClick={() => switchRunningConditionMode(m, 'workspace')}>Workspace</button>
                    <button type="button" className={d.runningConditionMode === 'custom' ? 'on' : undefined} onClick={() => switchRunningConditionMode(m, 'custom')}>Custom</button>
                </div>
                {d.runningConditionMode === 'workspace' && (
                    <div className="f4-hint">Follows the workspace Running condition above.</div>
                )}
            </div>

            {/* Row 2 on: the kind's sensors. Wide fields (predictors, cluster ranges) take a
                full row (`.f4-fld--grow`). An Individual model has none. */}
            <div className="bmw-sets-kind">
            {m.kind === 'relationship' && (
                <div className="f4-fld f4-fld--grow">
                    <span className="f4-lbl">Predictor sensors (≥ 1)</span>
                    {/* Predictors as chips (× removes one) + a dashed
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
                        <SensorPickerModal
                            sensors={allSensors}
                            getComponent={getComponent}
                            single
                            allowNone
                            value={d.criteria}
                            // Cleared (None or the trigger's ×): without a criteria
                            // sensor there is only one cluster (every row) — Rust rejects 2+ — so
                            // the count drops to 1 in the same draft edit and the model stays
                            // trainable. Its ranges are dropped on Save (`draftFields`).
                            onSelect={criteria => patchDraft(m, criteria ? { criteria } : { criteria: '', numClusters: 1 })}
                            noun="criteria sensor"
                            placeholder="None"
                        />
                    </div>
                    {/* Always shown: `renderClusterRangeSlider` covers every empty
                        state (no criteria sensor, N<=1, loading, constant-value
                        sensor) itself. */}
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

            {/* A Custom model's OWN running condition: the same
                panel as the workspace settings — timeline, rows and states — bound to
                the model's DRAFT (saved with Save changes, never on its own). A sibling
                of `.f4-fld--traindata`, on its own full-width row (`.rc-custom`). */}
            {d.runningConditionMode === 'custom' && (
                <div className="rc-custom" data-testid="custom-rc-editor">
                    {seedNoteFor[m.id] && (
                        <div data-testid="pm-seed-note" className="rcx-line rc-seed">
                            <span>
                                Copied <b>{seedNoteFor[m.id]!.periods} train period{seedNoteFor[m.id]!.periods === 1 ? '' : 's'}</b>, <b>{seedNoteFor[m.id]!.tests} scoring period{seedNoteFor[m.id]!.tests === 1 ? '' : 's'}</b> and {seedNoteFor[m.id]!.conditions} condition{seedNoteFor[m.id]!.conditions === 1 ? '' : 's'} from Workspace. Edits here affect only this model.
                            </span>
                            <button type="button" className="f4-x" aria-label="Dismiss" onClick={() => setSeedNoteFor(prev => ({ ...prev, [m.id]: null }))}><X size={12} /></button>
                        </div>
                    )}
                    <RunningConditionPanel
                        scope="custom"
                        configured={isRunningConditionConfigured(effectiveModelFor(m), gateFg, gateHeaders)}
                        periods={d.customPeriods}
                        onPeriodsChange={periods => patchDraft(m, { customPeriods: periods })}
                        bounds={datasetBounds}
                        filters={d.customFilters}
                        combine={d.customCombine}
                        noneConfirmed={d.customNoneConfirmed}
                        onNoneChange={none => patchDraft(m, { customNoneConfirmed: none })}
                        onCombineChange={mode => patchDraft(m, { customCombine: mode })}
                        onAddFilter={() => patchDraft(m, {
                            customNoneConfirmed: false,
                            customFilters: [...d.customFilters, {
                                id: `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                                sensor: allSensors[0] ?? '', operation: 'greater_than', value1: '', value2: '',
                            }],
                        })}
                        onUpdateFilter={(id, patch) => patchDraft(m, { customFilters: d.customFilters.map(x => (x.id === id ? { ...x, ...patch } : x)) })}
                        onRemoveFilter={id => patchDraft(m, { customFilters: d.customFilters.filter(x => x.id !== id) })}
                        sensors={allSensors}
                        getComponent={getComponent}
                        getUnit={getUnit}
                        counts={activeModel?.id === m.id ? customCounts : undefined}
                        testPeriods={d.customTestPeriods}
                        onTestPeriodsChange={tests => patchDraft(m, { customTestPeriods: tests })}
                        highlights={dashHighlights}
                        savedPeriods={savedCustomListsOf(m).periods}
                        savedTestPeriods={savedCustomListsOf(m).tests}
                    />
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
        const isOpen = isSettingsOpen(m);
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
                        className="bmw-sets-body"
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

    /** The state of a kind tab — ONE rule for its dot, the words shown beside it and
     *  its tooltip / accessible name: the central status (`modelDotState`), refined for
     *  a trained model by the verdict on its set points, by the gate badge, and red for
     *  a model whose run failed in this session.
     *   - `dot`:   the dot's colour (the sensor list's colours);
     *   - `words`: the status in words, with every suffix ("· no data in the loaded
     *              file", "· files out of date", "· unsaved changes") — shown on the tab
     *              uncut, and the same string in the tooltip and the tab's name;
     *   - `tone`:  the colour of those words — the dot's colour, except that a plain
     *              "Trained" asks for nothing and stays neutral grey. */
    const tabDotOf = (m: FailureModel, st: ModelDotState): { dot: TabDot; tone: TabDot; words: string } => {
        // Unsaved Model-settings edits and saved files that no longer match the set
        // points are said for EVERY tab of the sensor, not only the one that is open.
        const tail = `${filesOutOfDateFor(m) ? ' · files out of date' : ''}${m.id in drafts ? ' · unsaved changes' : ''}`;
        if (trainError[m.id]) return { dot: 'bad', tone: 'bad', words: `${failedWordsOf(m)}${tail}` };
        const badge = gateBadge(m);
        // Results, but no row of the loaded data: nothing about the model changed — its
        // own dot and words ("Complete", "Trained", its set-point flag), plus why there
        // are no charts.
        if (noDataOf(m)) {
            const flag = setPointFlagOf(m, st);
            const own = flag === 'fix' ? 'Fix set point' : flag === 'needed' ? 'Set points needed' : TAB_WORDS[st];
            const dot = flag === 'fix' ? 'bad' : DOT_CLASS[st];
            return { dot, tone: own === TAB_WORDS.trained ? null : dot, words: `${own} · ${NO_MODEL_DATA_WORDS}${tail}` };
        }
        // A trained model whose fit is gone needs training again (amber, like "Re-train needed").
        if (badge === null && fitGoneOf(m) && (st === 'trained' || st === 'complete')) {
            return { dot: DOT_CLASS[st], tone: DOT_CLASS[st], words: `${st === 'complete' ? 'Complete · ' : ''}${FIT_GONE_WORDS}${tail}` };
        }
        const flag = setPointFlagOf(m, st);
        const words = badge ?? (flag === 'fix' ? 'Fix set point' : flag === 'needed' ? 'Set points needed' : TAB_WORDS[st]);
        const dot = flag === 'fix' ? 'bad' : DOT_CLASS[st];
        return { dot, tone: words === TAB_WORDS.trained ? null : dot, words: `${words}${tail}` };
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
            // Results carry their WIRE index; the user numbers the full list.
            testNumbers: testPeriodsWirePlan(effectiveRunningCondition(eff, gateFg).testPeriods).numbers,
            slowScoring: activeModel?.id === m.id && slowScoring,
        };
    };

    const setPage = (m: FailureModel, page: WorkbenchPage) => setPageByModel(prev => (prev[m.id] === page ? prev : { ...prev, [m.id]: page }));
    /** Why the Health score page (and the "Health set points" / "Complete" steps)
     *  cannot be opened right now, or null. */
    const healthPageBlock = (m: FailureModel): string | null =>
        isModelStale(m) ? 'Re-train first'
            : !m.lastTrainedAt ? 'Train the model first'
            : buildBlockReason(m) !== null ? 'Fix the settings first'
            // The last run of THIS session failed: the numbers on screen are not trustworthy.
            // (A Complete model is never trained by Train sensor: its way back is "Load it again".)
            : trainError[m.id] ? (isModelDone(m) ? 'Load the model again first' : 'Re-train first')
            : null;

    /** "Train sensor ↑": the text link every sentence uses to point at the ONE place
     *  to train (it focuses the header's Train sensor button). */
    const trainSensorLink = (testId: string) => <TrainSensorLink testId={testId} onClick={focusTrainSensor} />;
    /** "Train sensor ▾": opens the menu next to Train sensor — the only place that
     *  trains a model that is up to date (a Complete one), with its "<Kind> only" row. */
    const trainMenuLink = (testId: string) => (
        <button
            type="button"
            className="tq-inline-link"
            data-testid={testId}
            onClick={() => {
                const caret = trainMenuBtnRef.current;
                if (!caret || caret.disabled) return;
                caret.focus();
                if (caret.getAttribute('aria-expanded') !== 'true') caret.click();
            }}
        >
            Train sensor ▾
        </button>
    );
    /** "the Train sensor ▾ menu" in a sentence. While nothing can be started from the
     *  menu (a run is active, or the data is not this window's any more) its ▾ is
     *  disabled, so a link there would do nothing: the phrase is plain text then and
     *  says when — or why not. */
    const trainMenuPhrase = (testId: string, m?: FailureModel): ReactNode => {
        const why = queue.stale ? 'not available: the data in this window is out of date'
            : queue.isRunning ? 'when the training run finishes'
            // The menu row that trains THIS model is disabled (and with nothing to
            // train on the sensor's ▾ itself is): no link to it either.
            : m && trainBlockReason(m) !== null ? "not available: it can't be trained yet"
            : null;
        return why === null
            ? <>the {trainMenuLink(testId)} menu</>
            : <>the Train sensor ▾ menu <span data-testid={`${testId}-blocked`}>({why})</span></>;
    };
    /** "Train sensor ↑" in a sentence about ONE model: the link — or, while Train
     *  sensor would not train it (the data is not this window's any more, a run is
     *  active, the model cannot train), plain text that says so. Never a link to a
     *  control that does nothing. */
    const trainSensorPhrase = (testId: string, m: FailureModel): ReactNode => {
        const cant = staleCantTrainOf(m);
        if (!cant) return trainSensorLink(testId);
        const why = cant.kind === 'stale' ? 'not available: the data in this window is out of date'
            : cant.kind === 'run' ? 'when the training run finishes'
            : "it can't train yet";
        return <>Train sensor ↑ <span data-testid={`${testId}-blocked`} title={cant.text}>({why})</span></>;
    };
    /** The ONE board of a model that has results but no row in the loaded data
     *  (`noDataOf`), on BOTH pages: what is true (nothing about the model changed —
     *  its charts are computed from the loaded data, and there is none for it), the
     *  cause as the data guard found it, and ONE link to where it is fixed — the
     *  Running-condition settings for a model on the workspace condition, its own
     *  Model settings for a Custom one. Never "Load it again" / "Train sensor":
     *  neither can work. */
    const noDataBoard = (m: FailureModel, nd: ModelNoData) => board('results-no-data', 'plain', NO_MODEL_DATA_TITLE,
        <>
            <span data-testid="no-data-cause">{noModelDataCauseText(nd.cause, datasetBounds, nd.hasCondition)}</span> Fix it in{' '}
            {nd.mode === 'custom' ? (
                <button
                    type="button"
                    className="tq-inline-link"
                    data-testid="board-open-settings"
                    onClick={() => { setPage(m, 'model'); setSettingsOpenOverride(prev => ({ ...prev, [m.id]: true })); }}
                >
                    Model settings
                </button>
            ) : (
                <button type="button" className="tq-inline-link" data-testid="board-open-rc" onClick={() => setRcFilterOpen(true)}>
                    Running condition ↑
                </button>
            )}
            {' '}to see its charts.
        </>,
        `${isModelDone(m) ? 'Complete' : 'Trained'} · nothing about the model changed`);
    /** The ONE board shape of every chart-less state: a
     *  title, one sentence and an optional mono line. Its actions are text links to
     *  the one place for them ("Train sensor ↑", "Model settings", "Running
     *  condition ↑") — never a button of its own. */
    const board = (testId: string, tone: 'plain' | 'bad' | 'run', title: ReactNode, text?: ReactNode, detail?: ReactNode) => (
        <div className="bmw-stage">
            <StateBoard testId={testId} tone={tone} title={title} text={text} detail={detail} />
        </div>
    );
    /** The Model fit page body — a state machine ending in the charts of `ModelFitPage`:
     *  Complete without a train record -> placeholder · incomplete config/gate ->
     *  "N items to fix" list with jump-to-field links (reuses `missingItems`'
     *  wording) · running -> progress · never trained -> "Not trained yet" ·
     *  stale -> "Out of date" charts (or a message when there is nothing to
     *  draw) · Relationship fit gone from memory -> the "Fit no longer in memory"
     *  board ("Load it again") · otherwise the charts. */
    const renderModelFitBody = (m: FailureModel) => {
        // The read gate — plus "nothing to train on" for a model that has no result at
        // all yet (never trained): its board is the place that says why Train will not
        // start. A model with results keeps them (charts, or the "Out of date" view).
        const reason = buildBlockReason(m)
            ?? (!m.lastTrainedAt && !isModelDone(m) ? shownGuardBlockOf(m)?.reason ?? null : null);
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
            // A Complete model is "up to date" for Train sensor, which therefore never trains
            // it (and is disabled when nothing else needs training): only the ▾ menu's
            // "<Kind> only" row does — the board points there. A model that cannot train at
            // all gets its reason instead of a link that would do nothing.
            // A train from that menu that FAILED in this session (a model with no train
            // record has nothing to "load again"): the board turns red and its mono line
            // carries the reason — the menu row is still the way out.
            const failed = legacyTrainFailedOf(m) ? trainError[m.id] : undefined;
            // (Its menu row is disabled by the data guards too — nothing to train on —
            // so those are a reason here as well, never a link to that row.)
            const cantTrain = reason ?? trainBlockReason(m);
            return cantTrain !== null
                ? board('results-placeholder', 'plain', 'Marked complete',
                    "It has no charts to show, and it can't be trained yet.", ownGateText(m, cantTrain))
                : board('results-placeholder', failed ? 'bad' : 'plain', 'Marked complete',
                    // The row's own name: a single-model sensor has no "… only" rows.
                    <>{failed ? 'Training it did not work, so it still has no charts. Fix the problem, then train it again from ' : 'To see its charts, train it from '}{trainMenuPhrase('board-train-menu', m)} (“{orderedDetail.length === 1 ? `Train the ${kindModelName(m.kind)}` : `${KIND_TAB_LABEL[m.kind]} only`}”). It then needs Mark complete again.</>,
                    failed ? <span data-testid="board-train-error">{`Training failed: ${failed}`}</span> : undefined);
        }
        if (reason !== null) {
            // No running condition yet: a model that FOLLOWS the workspace
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
        // Results, but no row of the loaded data for it: say that — before any
        // "fit gone" / "couldn't load" board, whose links could not work here.
        const noData = noDataOf(m);
        if (noData) return noDataBoard(m, noData);
        const err = trainError[m.id];
        // The fit is gone: ONE board, whatever came after it — a load that failed is its
        // reason line, never the "Training failed" board (whose "Train sensor ↑" cannot
        // train a Complete model).
        if ((healthPreview.notFitted || (!!err && fitGoneOf(m))) && m.lastTrainedAt && !isModelStale(m)) {
            return (
                <div className="bmw-stage">
                    <FitGoneBoard
                        testId="results-not-fitted"
                        linkTestId="board-load-fit"
                        trainTestId="board-train-sensor"
                        tail="The charts come back when it is loaded."
                        actions={fitGoneActionsOf(m)}
                    />
                </div>
            );
        }
        if (err && isModelDone(m)) {
            // A Complete model is "up to date" for Train sensor, which never trains it: a
            // "Train sensor ↑" link here would be a dead end. The ways out that work are
            // "Load it again" (the same silent load: nothing written, it stays Complete)
            // and the ▾ menu row that really trains it.
            return (
                <div className="bmw-stage">
                    <LoadFailedBoard
                        testId="results-load-failed"
                        linkTestId="board-load-again"
                        kindName={kindModelName(m.kind)}
                        tail="The charts come back when it is loaded."
                        error={err}
                        onReload={onReloadFit}
                        reloadDisabledReason={fitReloadBlock(m) ?? undefined}
                        // Only while that row can really train it: a model that cannot train
                        // (e.g. nothing to train on) gets no pointer to a disabled menu.
                        trainMenu={trainBlockReason(m) === null
                            ? <>, or train it from {trainMenuPhrase('board-train-menu', m)} (it then needs Mark complete again)</>
                            : undefined}
                    />
                </div>
            );
        }
        if (err) {
            return board('results-error', 'bad', 'Training failed',
                <>Fix the problem, then train again with {trainSensorPhrase('board-train-sensor', m)}. The model keeps its last state.</>, err);
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
                <>Settings or running condition changed — train it again with {trainSensorLink('board-train-sensor')} to see the charts.</>);
        }
        if (healthPreview.error && !healthPreview.data) {
            // The trained model itself is fine: only its charts could not be worked out.
            // The way out is asking again (a text link — the board has no button of its
            // own); after the dataset was replaced asking again cannot help, so no link.
            return board('results-health-error', 'bad', "Couldn't load the charts",
                healthPreview.errorCode === 'STALE_SESSION'
                    ? 'The trained model is kept, but its charts can only be loaded from the data it was trained on.'
                    : <>The trained model is kept — <button type="button" className="tq-inline-link" data-testid="board-retry-charts" onClick={healthPreview.retry}>Try again</button>.</>,
                healthPreview.error);
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

    /** Train running days of a model as Rust counted them (`count_period_rows`):
     *  the card's count of the persisted workspace condition for a Workspace-mode
     *  model, the active Custom model's own count for a Custom one — the SAME
     *  figure the Running-condition caption prints ("about N d running time").
     *  Only feeds the amber "below the recommended train time" note until the
     *  health preview's own figure exists (it does once a scoring period is scored). */
    const trainDaysEstimateFor = (m: FailureModel): number | null => {
        if (effectiveModelFor(m).runningConditionMode === 'custom') {
            return activeModel?.id === m.id ? countedTrainRunningDays(customCounts) : null;
        }
        return countedTrainRunningDays(cardCounts);
    };

    /** Why Mark complete is not possible right now (the FIRST blocking reason), or
     *  null. Only the active model has a health preview, so this is for the active
     *  model. Rust's validation is the source of "set points not valid". */
    const markCompleteBlock = (m: FailureModel): string | null => {
        // A training run owns the sidecar (a Relation-model export re-runs it): wait for the run.
        if (queue.isRunning) return TRAIN_RUN_ACTIVE_REASON;
        if (isModelStale(m)) return 'Settings changed — re-train first.';
        // Unsaved settings are saved by Mark complete first; ones that cannot be saved block it.
        const draftBlock = m.id in drafts ? modelBlockReason(m, true) : null;
        if (draftBlock !== null) return awayFromFormText(m, draftBlock);
        const gate = gateReasonOf(m);
        if (gate !== null) return gate;
        // No row of the loaded data is in its training scope: the export could only fail.
        const noData = noDataOf(m);
        if (noData) return noModelDataMarkReason(noData.mode);
        // At least one valid scoring period — Train does not need one.
        const noTest = markCompleteBlockReason(effectiveModelFor(m), gateFg);
        if (noTest !== null) return noTest;
        if (!trainedFreshFor(effectiveModelFor(m), gateFg, specialRecipes)) return NOT_TRAINED_BLOCK_REASON;
        // The model is being loaded (or trained) again right now — also while an earlier
        // answer is still on screen under it: nothing may be saved from that one.
        if (trainStatus[m.id] === 'loading') return CHECKING_SET_POINTS;
        // The fit is gone (a load of it that failed included): its own reason, which names
        // only what works for this model.
        if (fitGoneOf(m)) return isModelDone(m) ? FIT_GONE_BLOCK_REASON_COMPLETE : FIT_GONE_BLOCK_REASON;
        // A Complete model is never trained by Train sensor: its way out is "Load it again".
        if (trainError[m.id]) return isModelDone(m) ? LOAD_FAILED_BLOCK_REASON : "Couldn't refresh the result — fix the problem, then re-train.";
        const data = healthPreview.data;
        if (!data) {
            // Being worked out (the model is loaded again, or Rust is answering): a moment.
            if (healthPreview.loading || trainStatus[m.id] === 'loading' || !healthPreview.error) return CHECKING_SET_POINTS;
            // It failed: the red card on the page has the reason and the Retry; the footer says
            // what to do. After the dataset was replaced there is no Retry (asking again cannot
            // help): the footer says what does.
            return healthPreview.errorCode === 'STALE_SESSION' ? PREVIEW_STALE_BLOCK_REASON : PREVIEW_FAILED_BLOCK_REASON;
        }
        if (healthPreview.loading) return CHECKING_SET_POINTS;
        if (!data.valid) {
            const issues = attemptIssues[m.id] ?? data.validation;
            if (verdictOfIssues(issues) === 'bad') {
                const n = Math.max(1, buildCheckLines(data.kind, issues).filter(l => !l.warning).length);
                return `${n} set point${n > 1 ? 's' : ''} not valid — fix before marking complete`;
            }
            // Empty set points are counted from Rust's `required` issues (one per empty set
            // point), not from the Checks lines: a Relation model's 4 empty points collapse
            // into ONE line there.
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
            ? { phase: 'ok', outputDir: m.healthExport.outputDir, at: m.healthExport.at }
            : { phase: 'idle' });
    /** Complete, but the set points on screen differ from the ones the files were written with. */
    const filesOutOfDateFor = (m: FailureModel): boolean =>
        isModelDone(m) && !!m.healthExport && !sameSetPoints(m.healthExport.setPoints, setPointsOf(m));
    /** Complete, but its files were written before the health score moved to 1-hour
     *  averages (the export record has no scoring interval). The model STAYS Complete:
     *  the footer only says so and offers "Mark complete again", like `filesOutOfDateFor`.
     *  Nothing is written until the user presses the button. */
    const earlierScoringFor = (m: FailureModel): boolean =>
        savedResultsUseEarlierScoring(effectiveModelFor(m), gateFg, specialRecipes);

    /** "…\workspaces\<id>\output\<sensor>": the saved folder without the machine's own prefix (the full path is the tooltip). */
    const shortOutputDir = (dir: string): string => dir.replace(/^.*([\\/])(workspaces[\\/])/, '…$1$2');

    /** THE one filled button of the detail pane right now (at most ONE filled button
     *  on screen). Every other button is a ghost or a text button:
     *   - the running condition is not set / not valid -> none here (its own card has it)
     *   - Model fit:    Save changes while a draft exists · else Train sensor while a
     *                   model of this sensor needs training · else "Next: Health score"
     *                   for a trained model · a Complete model has none
     *   - Health score: Train sensor when THIS model must train again · else Mark
     *                   complete (again, when the files are out of date or were saved
     *                   with the earlier row-by-row scoring) · a Complete
     *                   model has none, unless a sibling model needs training
     *  Presentation only: it never enables, disables or hides anything. */
    const primaryActionOf = (m: FailureModel, page: WorkbenchPage, cands: readonly TrainCandidate[]): PrimaryAction => {
        if (rcStepState !== 'set') return null;
        const sensorNeedsTrain = cands.some(c => c.plan.kind === 'ready');
        if (page === 'model') {
            if (m.id in drafts) return 'save';
            if (sensorNeedsTrain) return 'train';
            // (No data for it in the loaded file: the Health score page is the same board — no next step.)
            if (isModelDone(m) || noDataOf(m)) return null;
            return healthPageBlock(m) === null && !queue.isLocked(m.id) ? 'next' : null;
        }
        if (cands.find(c => c.id === m.id)?.plan.kind === 'ready') return 'train';
        // ...and Mark complete could only fail.
        if (noDataOf(m)) return sensorNeedsTrain ? 'train' : null;
        if (!isModelDone(m) || filesOutOfDateFor(m) || earlierScoringFor(m)) return 'mark';
        return sensorNeedsTrain ? 'train' : null;
    };

    /** Footer of BOTH pages: ONE status pill + ONE
     *  sentence + at most one filled button (`primary`). (The kind tab says the status
     *  in words too — `tabDotOf`; the list and the set-point card carry a dot.)
     *  Model fit: "Save changes" (only while a draft exists) · "Next: Health score →"
     *  (NO Mark complete: a model is completed only from the Health score page).
     *  Health score: Mark complete ("Mark incomplete", a text button, once Complete;
     *  "Mark complete again" only when the files are out of date or were saved with the
     *  earlier row-by-row scoring). Going back to Model fit is page tab ① — there is no
     *  "← Model fit" button here. */
    const renderFooter = (m: FailureModel, page: WorkbenchPage, primary: PrimaryAction) => {
        // Save changes is an action: the draft's data guards apply to it.
        const saveReason = modelBlockReason(m, true);
        // The pill and what the page may show: the read gate.
        const reason = buildBlockReason(m);
        // The ONE sentence: why Save is disabled, else the gate, else — for a model
        // that still has to train — why Train will not start.
        const lineReason = orderedBlockReason(saveReason, gateBlockOf(m) ?? shownGuardBlockOf(m));
        const cat = categoryOf(m);
        const trainedFresh = isModelTrainedFresh(m);
        const stale = isModelStale(m);
        const training = trainStatus[m.id] === 'loading';
        const done = isModelDone(m);
        // A run that failed IN THIS SESSION — whether an explicit Re-train or
        // the silent auto-recompute on reopen — overrides the happy-path
        // pill/footer/Mark-complete-enabled state even though the PERSISTED
        // fields still say "fresh" (nothing is written back on failure).
        const hasSessionError = !!trainError[m.id];
        // The fit Rust held is gone: trained on paper (or Complete — `trainedFresh` is
        // only said of a model that is not), but the fit must be loaded or trained again.
        const fitGone = (trainedFresh || done) && fitGoneOf(m);
        // Results, but no row of the loaded data for it: nothing about the model changed,
        // so the pill keeps its own word ("Complete" / "Trained") and the sentence says
        // what the charts need.
        const noData = noDataOf(m);
        const noDataLine: ReactNode = noData
            ? <span data-testid="footer-no-data">{noModelDataFooter(done ? 'Complete' : 'Trained', noData.mode)}</span>
            : null;
        const pillState: 'complete' | 'trained' | 'incomplete' =
            done ? 'complete' : (trainedFresh && !hasSessionError && reason === null && (!fitGone || noData !== null)) ? 'trained' : 'incomplete';
        const pillLabel = pillState === 'complete' ? 'Complete' : pillState === 'trained' ? 'Trained' : 'Incomplete';
        const healthBlock = healthPageBlock(m);
        const markBlock = page === 'health' ? markCompleteBlock(m) : null;
        const savePhase = saveInfo[m.id]?.phase;
        const saving = savePhase === 'running';
        const outOfDate = page === 'health' && filesOutOfDateFor(m);
        // Saved before the score moved to 1-hour averages: still Complete, with a hint.
        const earlierScoring = page === 'health' && earlierScoringFor(m);
        const scoredCount = toTestPeriodsWire(effectiveRunningCondition(effectiveModelFor(m), gateFg).testPeriods).length;
        // Train queue: queued or training in the run = settings locked (Save disabled).
        const qItem = queue.isRunning ? queue.itemOf(m.id) : undefined;
        const locked = queue.isLocked(m.id);
        const hasDraft = m.id in drafts;
        // The header's Train sensor is the one place to train. This link focuses it.
        const goTrainSensor = trainSensorLink('footer-train-sensor');
        // "Trained 2026/02/09 23:50 · scored on 2 periods".
        const trainedLine: ReactNode = m.lastTrainedAt
            ? <>Trained <Stamp at={m.lastTrainedAt} />{scoredCount > 0 ? ` · scored on ${scoredCount} period${scoredCount === 1 ? '' : 's'}` : ''}</>
            : null;
        const identityLine = `${kindModelName(m.kind)}${cat ? ` · ${CATEGORY_LABELS[cat]}` : ''}`;
        // A successful save is THIS sentence (there is no "Files saved to …" banner).
        const saved = saveInfoFor(m);
        const savedLine: ReactNode = saved.phase === 'ok'
            ? <span data-testid="save-ok">Files saved <Stamp at={saved.at} /> · <span className="hs-path" data-testid="footer-saved-path" title={saved.outputDir}>{shortOutputDir(saved.outputDir)}</span></span>
            : null;

        // The fit-gone sentence of BOTH pages: "load it again" as a link, and — only for a
        // model Train sensor really trains (not Complete) — "Train sensor ↑".
        const reloadBlock = fitReloadBlock(m);
        const fitGoneLine: ReactNode = (
            <>
                {FIT_GONE_WORDS} ·{' '}
                <button
                    type="button"
                    className="tq-inline-link"
                    data-testid="footer-load-fit"
                    disabled={reloadBlock !== null}
                    title={reloadBlock ?? undefined}
                    onClick={() => reloadFit(m.id)}
                >
                    load it again
                </button>
                {!done && <>, or re-train with {goTrainSensor}</>}
            </>
        );
        // A Complete model whose load failed (not a lost fit): the same "load it again" link
        // — never "Train sensor ↑", which does not train a Complete model.
        const loadFailed = loadFailedOf(m);
        const loadFailedLine: ReactNode = (
            <>
                {LOAD_FAILED_WORDS} ·{' '}
                <button
                    type="button"
                    className="tq-inline-link"
                    data-testid="footer-load-again"
                    disabled={reloadBlock !== null}
                    title={reloadBlock ?? undefined}
                    onClick={() => reloadFit(m.id)}
                >
                    load it again
                </button>
            </>
        );
        // Why Mark complete is disabled, as the sentence shows it: the fit-gone reason gets
        // its links; the moment Rust is still checking what was typed is not
        // a reason worth replacing a Complete model's sentence for.
        const blockWhy: ReactNode = markBlock === null || markBlock === CHECKING_SET_POINTS ? null
            : markBlock === LOAD_FAILED_BLOCK_REASON ? loadFailedLine
            : markBlock === FIT_GONE_BLOCK_REASON || markBlock === FIT_GONE_BLOCK_REASON_COMPLETE ? fitGoneLine
            : ownGateText(m, markBlock);
        // The ONE sentence (first match wins).
        let line: ReactNode;
        let tone: 'plain' | 'warn' | 'bad' = 'plain';
        let lineId: 'footer-status' | 'mark-block-reason' | 'build-block-reason' | 'files-out-of-date' | 'earlier-scoring' = 'footer-status';
        if (page === 'health') {
            // Saving is said HERE only (no card on the page unless it is slow).
            if (saving) line = <><Loader2 size={11} className="pm-spin" aria-hidden="true" /> Saving the model files…</>;
            // No data for it in the loaded file: the same sentence on both pages (it is
            // also why Mark complete / Mark complete again is disabled — the button's tooltip).
            else if (noDataLine) { line = noDataLine; tone = 'warn'; }
            // Why Mark complete (again) is disabled comes before everything else: a failed
            // attempt's "Not saved" must never hide the reason that blocks the next one.
            else if (!done && markBlock !== null) { line = blockWhy ?? markBlock; tone = 'warn'; lineId = 'mark-block-reason'; }
            else if (done && outOfDate && blockWhy !== null) { line = <>Files out of date · {blockWhy}</>; tone = 'warn'; lineId = 'files-out-of-date'; }
            // (A refusal for a lost fit that was loaded again since — by itself — has
            // nothing left to "fix": only the second click is missing.)
            else if (savePhase === 'error') {
                line = (saveInfo[m.id] as { message?: string }).message === FIT_GONE_SAVE_MESSAGE
                    ? 'Not saved · the Relation model is loaded again — Mark complete again'
                    : 'Not saved · fix it, then Mark complete again';
                tone = 'bad';
            }
            else if (done && outOfDate) { line = 'Files out of date — set points changed after saving · Mark complete again to update them'; tone = 'warn'; lineId = 'files-out-of-date'; }
            // A Complete model whose fit is gone stays Complete — but the page cannot score
            // until the fit is loaded again: say that, not only "Files saved …".
            else if (done && fitGone) { line = fitGoneLine; tone = 'warn'; }
            // ...and so does one whose load failed — whether or not an earlier answer is
            // still on screen: the tab's red dot and this sentence always agree.
            else if (loadFailed) { line = loadFailedLine; tone = 'bad'; }
            // The saved files were scored row by row (written before the 1-hour averages):
            // the model stays Complete; "Mark complete again" writes them again.
            else if (done && earlierScoring) { line = EARLIER_SCORING_HINT_TEXT; tone = 'warn'; lineId = 'earlier-scoring'; }
            else if (done) line = savedLine ?? trainedLine ?? identityLine;
            else line = 'Set points valid — check the score chart, then Mark complete';
        } else if (qItem && locked) {
            line = qItem.state === 'running'
                ? <><Loader2 size={11} className="pm-spin" aria-hidden="true" /> Training now · about {formatTrainSeconds(ROUGH_TRAIN_SECONDS[m.kind])}</>
                : `Queued in the run · ${queue.queuePositionOf(m.id) === 1 ? 'next' : `#${queue.queuePositionOf(m.id)}`}`;
        } else if (lineReason) { line = customSaveBlockText(m, lineReason) ?? ownGateText(m, lineReason); tone = 'warn'; lineId = 'build-block-reason'; }
        // An unsaved draft is said here, once (the tab carries no "edited" pill).
        else if (hasDraft) line = `Unsaved changes to the ${kindModelName(m.kind)}`;
        else if (noDataLine) { line = noDataLine; tone = 'warn'; }
        // The fit is gone (for a Complete model too, and before "Training failed": a load
        // that failed is the board's reason line).
        else if (fitGone) { line = fitGoneLine; tone = 'warn'; }
        // A Complete model whose load failed: its board has the reason; the way out is the same link.
        else if (loadFailed) { line = loadFailedLine; tone = 'bad'; }
        // A Complete model with no train record whose ▾ train failed: nothing to load
        // again — the menu row that trains it is the way out (the board has the reason).
        else if (legacyTrainFailedOf(m)) { line = <>{TRAIN_FAILED_WORDS} · train it again from {trainMenuPhrase('footer-train-menu', m)}</>; tone = 'bad'; }
        else if (done) line = trainedLine ?? identityLine;
        else if (hasSessionError) { line = <>Training failed · fix the problem, then {trainSensorPhrase('footer-train-sensor', m)}</>; tone = 'bad'; }
        // Trained, but its charts could not be loaded (the board above says so): there
        // is nothing to "check" yet.
        else if (trainedFresh && healthPreview.error && !healthPreview.data && !healthPreview.loading) {
            line = healthPreview.errorCode === 'STALE_SESSION'
                ? <>{trainedLine} · the charts did not load. {TRAIN_STALE_MESSAGE}</>
                : <>{trainedLine} · the charts did not load — try again above</>;
            tone = 'bad';
        }
        else if (trainedFresh) line = <>{trainedLine} · check the charts, then set the health set points</>;
        else if (stale) { line = <>Settings or running condition changed · train again with {goTrainSensor}</>; tone = 'warn'; }
        // Also why "Next: Health score →" is disabled.
        else if (!m.lastTrainedAt) line = <>Not trained yet · {goTrainSensor}</>;
        else line = identityLine;

        const markClass = primary === 'mark' ? 'bmw-btn-ok' : 'rcx-btn';
        return (
            <div className="f4-foot wbx-foot" ref={footerRef} tabIndex={-1} data-testid="wb-footer" data-primary={primary ?? 'none'}>
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
                        onClick={() => { saveFocusRef.current = m.id; return commitModel(m); }}
                    >
                        Save changes
                    </button>
                )}
                {page === 'model' && (
                    <button
                        type="button"
                        ref={nextHealthBtnRef}
                        className={`rcx-btn${primary === 'next' ? ' rcx-btn--pri' : ''}`}
                        data-testid="next-health-score"
                        // The same door as page tab ② (and closed by the same rules). Closed while
                        // this model's fit is still being worked out (redesign §7): the Health score
                        // page reads that fit.
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
                        {(outOfDate || earlierScoring) && (
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

    /** The detail header's sensor-level Train: one primary
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
        // A model on its OWN (Custom) running condition does not wait for the workspace one.
        const usesOwnRc = (m: FailureModel): boolean => effectiveModelFor(m).runningConditionMode === 'custom';
        // No workspace running condition at all (an invalid period has its own, more specific
        // reason per model) — and a model of this sensor really waits for it.
        const rcBlocks = rcStepState === 'unset' && ready.length === 0 && cant.some(m => !usesOwnRc(m));
        // The workspace condition is not set / not valid, so its card holds the only filled
        // button — but the models this line is about run on their own condition: say that
        // nothing is blocked for them (Train sensor is a ghost then, and works).
        const ownRcNote = (list: FailureModel[]): string =>
            rcStepState !== 'set' && list.length > 0 && list.every(usesOwnRc) ? ` · ${OWN_RC_NOT_BLOCKED}` : '';
        let why: string;
        let tone: TrainReasonTone = 'neutral';
        if (queue.stale) { why = TRAIN_STALE_MESSAGE; tone = 'danger'; }
        else if (thisRunning) why = 'Training this sensor…';
        else if (inRun.length) why = `${inRun.length} model${inRun.length === 1 ? '' : 's'} of this sensor queued in the run`;
        else if (rcBlocks) { why = TRAIN_NEEDS_RUNNING_CONDITION; tone = 'warn'; }
        else if (ready.length === 0 && cant.length === 0) why = `${up.length} model${up.length === 1 ? '' : 's'} up to date — nothing to train${ownRcNote(up)}`;
        else if (ready.length === 0) {
            // A trained or Complete model that only the data guard stops keeps its charts
            // and its own footer sentence — there is no board "below" that says why, so
            // the reason is named HERE (the one place its Train is offered).
            const named = cant.find(m => {
                const guard = trainGuardBlockOf(m);
                return guard !== null && shownGuardBlockOf(m) === null && trainBlockReason(m) === guard.reason;
            });
            why = named
                ? `${cant.length === 1 ? "Can't train" : `${names(cant, ', ')} can't train`} · ${whyOf(named)}`
                : cant.some(m => m.id === activeModel?.id)
                ? "Can't train · see below"
                : `${names(cant, ', ')} can't train · see ${cant.length === 1 ? 'its tab' : 'their tabs'}`;
            tone = 'warn';
        }
        else if (cant.length) { why = `${trains(ready)}${ownRcNote(ready)} · ${names(cant, ', ')} can't train, skipped`; tone = 'warn'; }
        else if (up.length) why = `${trains(ready)}${ownRcNote(ready)} · ${names(up, ', ')} up to date, skipped`;
        else why = `${trains(ready)}${ownRcNote(ready) || ` · ≈ ${formatTrainSeconds(roughTrainSeconds(ready.map(m => m.kind)))}`}`;
        const busy = !queue.canStart;
        const title = queue.stale ? TRAIN_STALE_MESSAGE
            : queue.isRunning ? TRAIN_RUN_ACTIVE_REASON
            : rcBlocks ? TRAIN_NEEDS_RUNNING_CONDITION
            : ready.length === 0 ? (cant.length ? cantDetail : why)
            : cant.length ? cantDetail
            : undefined;
        // Menu copy: "Re-train" is only said about a model that has a train record
        // (`lastTrainedAt` — what `isModelStale` / the up-to-date rule read as "was trained").
        // Each row's state line: where the model stands ("Not trained yet", "Failed last
        // run", "Fit no longer in memory", …) or why it can't train.
        const copy = sensorTrainMenuCopy(orderedDetail.map((m, i) => ({
            kind: m.kind,
            plan: cands[i].plan,
            trainedBefore: !!m.lastTrainedAt,
            failedLastRun: !!trainError[m.id],
            fitGone: !!m.lastTrainedAt && fitGoneOf(m),
        })));
        const menu: TrainMenuItem[] = [
            // A sensor with ONE model has no "all" row: its own row says it all.
            ...(copy.all ? [{
                key: 'retrain-all',
                label: copy.all.label,
                small: copy.all.small,
                disabled: busy || ready.length + up.length === 0,
                onClick: () => { queue.start(cands, { includeUpToDate: true, source: 'sensor-all' }); },
            }] : []),
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
                menuButtonRef={trainMenuBtnRef}
                filled={filled}
                // "· n of m" only while something needs training; a plain ghost otherwise.
                label={thisRunning ? <><Loader2 size={12} className="pm-spin" aria-hidden="true" /> Training…</>
                    : ready.length > 0 ? `▶ Train sensor · ${ready.length} of ${orderedDetail.length}` : '▶ Train sensor'}
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
        const training = trainStatus[activeModel.id] === 'loading';
        // One plan per model of the sensor, computed once: the Train sensor button and
        // the one-filled-button rule both read it.
        const cands = orderedDetail.map(candidateOf);
        const primary = primaryActionOf(activeModel, page, cands);
        // Page tab ② is closed exactly when "Next: Health score →" is disabled (the same
        // two rules: `healthPageBlock`, and this model's fit still being worked out) —
        // and only while it is not the page that is open: the open page's tab is never
        // shown as closed. Its reason takes the caption's place; the "still loading /
        // training" moment has no reason text (the page body says it).
        const healthBlock = healthPageBlock(activeModel);
        const healthTabClosed = page !== 'health' && (healthBlock !== null || training);
        const healthTabWhy = healthTabClosed ? healthBlock : null;
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
                        {/* The stacked label at header size, component chip after the tag. */}
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
                    {/* No page switch in the header: the two pages are the tab row under the kind
                        tabs (v2 §3), plus the footer's "Next: Health score →". */}
                    {renderSensorTrain(cands, primary === 'train')}
                    </div>
                </div>

                {categoryWarn?.key === selectedSensorKey && (
                    <div role="status" className="f4-req-note" style={{ padding: '4px 20px 0' }}>
                        {categoryWarn.text}
                    </div>
                )}

                <div role="tablist" className="f4-tabs wb3-kindtabs">
                    {orderedDetail.map(m => {
                        const selected = m.id === activeModel.id;
                        // ONE dot in the list's colours + the status in words beside it (v2 §2).
                        // The same words are the tooltip and part of the tab's name.
                        const { dot, tone, words } = tabDotOf(m, dotStateOf(m));
                        return (
                            <button
                                key={m.id}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className={`f4-tab${selected ? ' f4-tab--on' : ''}`}
                                style={{ '--kc': KIND_COLOR[m.kind] } as CSSProperties}
                                // The state is not colour- or tooltip-only: it is part of the tab's name.
                                aria-label={`${KIND_TAB_LABEL[m.kind]}, ${words}`}
                                title={`${KIND_TAB_LABEL[m.kind]} · ${words}`}
                                onClick={() => setActiveTab(prev => ({ ...prev, [selectedSensorKey!]: m.id }))}
                            >
                                <span className={`f4-kmini model-kind-icon--${m.kind}`} aria-hidden="true">{KIND_ABBREV[m.kind]}</span>
                                <span className="f4-tab-l">{KIND_TAB_LABEL[m.kind]}</span>
                                {/* aria-hidden: the tab's own name (aria-label) already says these words. */}
                                <span className="wb3-tab-state" aria-hidden="true">
                                    <span
                                        className={`f4-sdot${dot ? ` f4-sdot--${dot}` : ''}`}
                                        data-testid={`tab-status-${m.id}`}
                                        data-dot={dot ?? 'none'}
                                        title={words}
                                    />
                                    <span
                                        className={`wb3-tab-words${tone ? ` wb3-tab-words--${tone}` : ''}`}
                                        data-testid={`tab-words-${m.id}`}
                                        data-tone={tone ?? 'plain'}
                                    >
                                        {words}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                    <span className="f4-tabs-spacer" />
                </div>
                {/* The two pages of a model: a second tab row under the kind tabs (v2 §3). The
                    numbers are an order, not progress — no ticks, and ① is always open. */}
                <nav className="wb3-pages" aria-label="Model pages" data-testid="page-tabs">
                    <button
                        type="button"
                        className={`wb3-page${page === 'model' ? ' wb3-page--on' : ''}`}
                        data-testid="page-tab-model"
                        aria-current={page === 'model' ? 'page' : undefined}
                        onClick={() => setPage(activeModel, 'model')}
                    >
                        <span className="wb3-page-n">1</span>
                        <span className="wb3-page-t">Model fit</span>
                        <span className="wb3-page-s">settings · train · check the fit</span>
                    </button>
                    {/* Closed = aria-disabled, never `disabled`: it stays focusable and its
                        reason is always readable, in place of the caption. */}
                    <button
                        type="button"
                        className={`wb3-page${page === 'health' ? ' wb3-page--on' : ''}${healthTabClosed ? ' wb3-page--off' : ''}`}
                        data-testid="page-tab-health"
                        aria-current={page === 'health' ? 'page' : undefined}
                        aria-disabled={healthTabClosed ? true : undefined}
                        title={healthTabWhy ?? undefined}
                        onClick={() => { if (!healthTabClosed) setPage(activeModel, 'health'); }}
                    >
                        <span className="wb3-page-n">2</span>
                        <span className="wb3-page-t">Health score</span>
                        {healthTabWhy !== null
                            ? <span className="wb3-page-why" data-testid="page-tab-health-why">{healthTabWhy}</span>
                            : <span className="wb3-page-s">set points · score · mark complete</span>}
                    </button>
                </nav>

                <div role="tabpanel" data-testid={`model-tab-panel-${activeModel.id}`} style={{ display: 'contents' }}>
                    {/* One scroll area for settings + banner + the page body, so the
                        footer below always stays in view however tall the charts are. */}
                    <WorkbenchScroll resetKey={`${activeModel.id}:${page}`} page={page}>
                        {page === 'model' && renderModelSettings(activeModel)}
                        {stale && (
                            <StaleBanner
                                training={training}
                                queued={queue.isRunning && queue.itemOf(activeModel.id)?.state === 'queued'}
                                cantTrain={staleCantTrainOf(activeModel)}
                                onGoTrainSensor={focusTrainSensor}
                            />
                        )}
                        {page === 'model' && saveInfo[activeModel.id]?.phase === 'error' && (
                            <SaveErrorNotice
                                message={(saveInfo[activeModel.id] as { phase: 'error'; message: string }).message}
                                onDismiss={() => dismissSaveInfo(activeModel.id)}
                            />
                        )}
                        {page === 'health' && renderRunSetPointsBanner(activeModel)}
                        {/* No data for it in the loaded file: the Health score page is the same
                            ONE board as the Model fit page (the score is computed from that data too). */}
                        {page === 'model' ? renderModelFitBody(activeModel) : activeNoData ? noDataBoard(activeModel, activeNoData) : (
                            <HealthScorePage
                                key={activeModel.id}
                                {...pagePropsFor(activeModel)}
                                setPoints={setPointsOf(activeModel)}
                                onSetPointsChange={onSpChange}
                                onSetPointsCommit={onSpCommit}
                                attemptIssues={attemptIssues[activeModel.id] ?? null}
                                save={saveInfoFor(activeModel)}
                                fitGone={fitGoneActionsOf(activeModel)}
                                fitLoading={training}
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
    const rcViewInvalid = validatePeriods(rcView.periods, datasetBounds, rcPersisted.periods).some(s => s.invalid);
    // Apply gate: an invalid train period, NO train period, an invalid scoring
    // period (a missing date, an end before its start), a train or scoring period
    // that was added / changed in this draft and lies entirely outside the loaded
    // data, or — once this draft's count is settled and it changed what is trained
    // on — no running row in its train periods. A period that is exactly as it was
    // saved never blocks (its row warns); scoring periods overlapping train time and
    // train periods overlapping a highlight never block either.
    const rcApplyBlock = runningConditionApplyBlock(rcView.periods, rcView.testPeriods, 'applying', {
        bounds: datasetBounds,
        savedPeriods: rcPersisted.periods,
        savedTestPeriods: rcPersisted.testPeriods,
        noTrainRows: rcNoRows,
        hasCondition: !rcView.noneConfirmed,
    });
    // Apply writes the DRAFT, and a typed date is in the draft as soon as it is
    // complete — so "dirty" is the whole condition, and the impact line below is on
    // screen whenever Apply is enabled. A half-typed date changes nothing (it
    // never reaches the draft): it only shows the neutral line.
    const rcApplyEnabled = rcApplyBlock === null && rcDirty;
    const rcPendingName = rcPendingDate.train ?? rcPendingDate.scoring;
    const rcTestsNotice = testsChangedNotice(allModels, gateFg);
    const rcRetrainLeft = rcRetrainIds.length > 0
        ? modelsStillNeedingTraining(rcRetrainIds, allModels, gateFg, specialRecipes ?? undefined)
        : [];
    // What applying the draft does to the models (never blocks Apply). Only
    // worked out while the modal is open on an edited draft.
    const rcImpact = rcFilterOpen && rcDirty && rcDraft
        ? runningConditionImpact(gateFg, rcDraft, { recipes: specialRecipes ?? undefined })
        : null;
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
                    rows={cardRows}
                    bounds={datasetBounds}
                    onOpen={() => setRcFilterOpen(true)}
                    testPeriods={runningConditionTestPeriods}
                    noRows={cardNoRows}
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
                {/* After Apply (session-only): the models an Apply sent back to training
                    that are still not trained again. It goes away by itself once they are. */}
                {rcRetrainLeft.length > 0 && (() => {
                    const n = retrainNoticeParts(rcRetrainLeft.length);
                    return (
                        <div className="rc-notice" role="status" data-testid="rc-retrain-notice">
                            <b>{n.headline}.</b> {n.rest}
                        </div>
                    );
                })()}
                {rcTestsNotice && (() => {
                    const n = testsChangedNoticeParts(rcTestsNotice);
                    return (
                        <div className="rc-notice" role="status" data-testid="tests-changed-notice">
                            <b>{n.headline}.</b> {n.rest}
                        </div>
                    );
                })()}

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
                                                {source ? `, taken from its ${kindModelName(source.kind)}` : ''}. Changed:{' '}
                                                {changes.map((c, i) => (
                                                    <span key={c.modelId}>
                                                        {i > 0 && ' · '}
                                                        {KIND_TAB_LABEL[c.kind]}{' '}
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
                // Edits go to a local draft; only Apply writes (see `applyRcDraft`).
                // X / backdrop / Esc go through `requestCloseRc`, which
                // `flushFocusedInput()`s first (a half-typed period date settles on
                // blur only) and then asks before discarding a dirty draft.
                // Focus goes to the first field on open and Tab stays inside
                // (`useModalFocus`); Esc is `requestCloseRc` (see the effect above).
                <div className="bmw-modal-backdrop" role="presentation" onClick={requestCloseRc}>
                    <div ref={rcDialogRef} tabIndex={-1} className="bmw-modal bmw-modal--rc" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Running condition">
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
                        <div className="rcm-scroll">
                            <RunningConditionPanel
                                configured={rcViewConfigured}
                                periods={rcView.periods}
                                onPeriodsChange={updateRunningConditionPeriods}
                                savedPeriods={runningConditionTimePeriods}
                                savedTestPeriods={runningConditionTestPeriods}
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
                                getComponent={getComponent}
                                getUnit={getUnit}
                                counts={rcCounts}
                                testPeriods={rcView.testPeriods}
                                onTestPeriodsChange={updateRunningConditionTestPeriods}
                                highlights={dashHighlights}
                                onPendingDate={onRcPendingDate}
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
                                        title={rcApplyBlock?.footer}
                                        onClick={applyRcDraft}
                                    >
                                        <Check size={12} /> Apply
                                    </button>
                                    <button type="button" data-testid="rc-cancel" className="f4-btn f4-btn--plain" onClick={closeRc}>Cancel</button>
                                    <span className="filter-panel-spacer" />
                                    {rcApplyBlock ? (
                                        // Why Apply is disabled: "Fix P2 before applying" (red),
                                        // "Add a train period" (amber), "Fix S1 before applying" (red),
                                        // "No rows to train on" (red).
                                        <span
                                            data-testid="rc-apply-block"
                                            data-kind={rcApplyBlock.kind}
                                            role="alert"
                                            className={`rc-impact ${rcApplyBlock.kind === 'no-train' ? 'rc-impact--amber' : 'rc-impact--bad'}`}
                                        >
                                            <span>{rcApplyBlock.footer}</span>
                                        </span>
                                    ) : rcImpact ? (
                                        // What applying the draft does to the models (never blocks
                                        // Apply). Apply is only ever enabled with this line on screen.
                                        // A date still half-typed is not part of the draft: one more
                                        // quiet line says so.
                                        <span data-testid="rc-impact" data-tone={rcImpact.tone} role="status" className={`rc-impact rc-impact--${rcImpact.tone}`}>
                                            <span>{rcImpact.text}</span>
                                            {rcImpact.quiet && <span data-testid="rc-impact-quiet">{rcImpact.quiet}</span>}
                                            {rcPendingName && <span data-testid="rc-pending-date">{pendingDateText(rcPendingName)}</span>}
                                        </span>
                                    ) : rcPendingName && (
                                        // Nothing edited yet but a date is half-typed: nothing of it is
                                        // in the draft, so there is no impact to show — only how to get it.
                                        <span data-testid="rc-pending-date" role="status" className="rc-impact rc-impact--grey">
                                            <span>{pendingDateText(rcPendingName)}</span>
                                        </span>
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
