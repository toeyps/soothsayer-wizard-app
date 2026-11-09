import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { getFgGroupColor } from '../../utils/failureGroupColor';
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../../utils/tauriEvents";
import { X, Check, ChevronRight, Lock, CircleAlert, TriangleAlert, Search, Loader2 } from "lucide-react";
import { FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata, WorkspaceSensorFilter, CategoryChange, TimePeriod, TestPeriod, TimeHighlight, FailureGroupStateSlice, FailureGroupStateChangedPayload, HealthSetPoints, HealthVerdictValue, SpecialSensorRecipe, WorkspaceState, WorkspaceMetadata, PROJECT_DETAILS_CHANGED, type ProjectDetailsChangedPayload } from "../../types";
import type { HealthIssue } from "../../types/health";
import type { RelationshipPreviewResult, ClusteringPreview } from "../../types/commands";
import { getRecentWorkspaces, loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { modelSensorKey, groupModelsBySensor, sensorCategory, setSensorCategory, type SensorModelGroup } from "../../utils/modelGrouping";
import { normalizeCategories, migratePeriods } from "../../utils/workspaceMigrations";
import { conditionChipParts } from "./periodDisplay";
import type { RunningConditionConversion } from "../../types";
import { findWorkspaceNameTwin, kindModelName, markCompleteProjectBlock, MODEL_KIND_LABEL, suggestDistinctModelName, WORKSPACE_DUPLICATE_NAME_REASON } from "../../utils/modelNames";
import { CATEGORY_BLOCK_REASON, customBlockText, customSummaryText, getBuildBlock, getBuildBlockReason, isCompleteCondition, isRunningConditionConfigured, isWorkspaceRunningConditionConfigured, effectiveRunningCondition, markCompleteBlockReason, NO_MODEL_DATA_TITLE, NO_MODEL_DATA_WORDS, NO_TRAIN_DATA_SHORT, NO_TRAIN_PERIOD_REASON_CUSTOM, NO_TRAIN_ROWS_FOOTER, noModelDataCauseText, noModelDataFooter, noModelDataMarkReason, noTrainRowsReason, runningConditionApplyBlock, seedCustomFromWorkspace, type BuildBlock, type GateOptions, type NoModelDataCause, type RunningConditionApplyBlock, type RunningConditionFg } from "../../utils/runningCondition";
import { modelsStillNeedingTraining, retrainNoticeParts, runningConditionImpact } from "../../utils/runningConditionImpact";
import { usePeriodCounts } from "../../hooks/usePeriodCounts";
import { countedNoTrainRows, countedTrainRunningDays, trainCountKey } from "../../utils/periodCounts";
import { computeTrainFingerprint, isModelTrainedFresh as trainedFreshFor } from "../../utils/trainFingerprint";
import { buildPreviewFilterPayload } from "../../utils/trainingScope";
import { applyIncompleteRule } from "../../utils/incompleteRule";
import { isModelStale as isModelStaleFor, modelDotState, modelSetPointFlag, NOT_TRAINED_BLOCK_REASON, type ModelDotState, type SetPointFlag } from "../../utils/modelStatus";
import { CLUSTERS_NEED_CRITERIA, HEALTH_DEFAULT_MAX_POINTS, relationshipLambda, testPeriodsWireFor } from "../../utils/healthRequest";
import { ensureHealthSetPoints } from "../../utils/healthSetPoints";
import { checkModelForComplete, parseHealthError } from "../../utils/completeModel";
import { commitHealthVerdict, commitSetPoints, MARK_COMPLETE_CLOSE_WAIT, persistModelComplete } from "../../utils/healthPersist";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import { useDatasetTimeBounds } from "../../hooks/useDatasetTimeBounds";
import { useHealthPreview } from "../../hooks/useHealthPreview";
import { validatePeriods, testPeriodsKey, testPeriodsError, testPeriodsWirePlan, toScoringPeriods, type PeriodDataBounds } from "../../utils/timePeriods";
import { SLOW_TEST_SCORING_TEXT, testsChangedNotice, testsChangedNoticeParts, testsChangedState } from "../../utils/trainTestValidation";
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, stiffnessLabel, snapStiffness } from "../reports/pmReportTypes";
import RunningConditionPanel, { RunningConditionPills } from "./RunningConditionPanel";
import { RunningConditionCard, type RcStepState } from "./RunningConditionCard";
import { SensorPickerModal } from "./SensorPickers";
import { SensorInline, SensorLabel, SensorSearchContext, SensorSetExtraContext, SensorSetProvider, SetPrefixLine } from "../sensor/SensorLabel";
import { PaneResizeHandle, readSavedPaneWidth } from "../PaneResizeHandle";
import { useLineCut } from "../../hooks/useNameFit";
import { NAME_TAIL_MAX, displayedName } from "../../utils/sensorNames";
import { SensorMetaContext, fmtNumText, sensorHaystack, sensorPlainLabel, sensorTitle, useLayeredSensorLookup } from "../sensor/sensorInfo";
import { useModalFocus } from "./useModalFocus";
import SubModelsModal from "./SubModelsModal";
import { createEngineQueue, useSubModelFits, type EngineQueue } from "./useSubModelFits";
import { ENGINE_STOPPED_MESSAGE, stopRunningEngine } from "./engineStop";
import ModelFitPage from "./workbench/ModelFitPage";
import { CLUSTER_COLORS as CLUSTER_PALETTE, TYPED_DECIMALS_MAX, fmtClusterBound, shortDecimals } from "./workbench/chartTheme";
import HealthScorePage from "./workbench/HealthScorePage";
import { FIT_GONE_WORDS, FitGoneBoard, LoadFailedBoard, SaveErrorNotice, StaleBanner, StateBoard, TrainSensorLink, WorkbenchScroll, type FitGoneActions, type StaleCantTrain } from "./workbench/WorkbenchShellParts";
import { buildCheckLines, healthVerdict, isBlockingIssue, sameSetPoints, verdictOfIssues, type HealthVerdict } from "./workbench/healthChecks";
import type { SaveInfo, WorkbenchPage } from "./workbench/workbenchTypes";
import { isPickerSurfaceOpen } from "../sensor/SensorPicker";
import { ExportBar, ExportModal, type ExportedLine } from "./workbench/ExportParts";
import { useWorkspaceExport, type UseWorkspaceExport } from "../../hooks/useWorkspaceExport";
import { exportReadiness } from "../../utils/exportReadiness";
import { revealExportFolder } from "../../utils/workspaceExport";
import { CloseRunDialog, CloseUnsavedDialog, LockedSettingsHeader, QueuedCard, RunSetPointsBanner, RunStrip, SensorTrainButton, sensorTrainMenuCopy, TrainAllBar, TrainAllModal, type TrainGroupInfo, type TrainMenuItem, type TrainReasonTone, type TrainRowModel } from "./workbench/TrainQueueParts";
import { useTrainQueue } from "../../hooks/useTrainQueue";
import type { TrainCandidate, TrainFixTarget, TrainOutcome } from "../../types/trainQueue";
import { classifyTrainPlan, countTrainPlans, formatTrainSeconds, isStaleTrainError, missingSettingsText, noRowsTrainError, preflightReason, REQUIRED_FIELDS_BLOCK_REASON, ROUGH_TRAIN_SECONDS, roughTrainSeconds, trainButtonsBlockedReason, TRAIN_NEEDS_RUNNING_CONDITION, TRAIN_STALE_MESSAGE } from "../../utils/trainQueue";
import { fgLabel } from '../../utils/fgLabel';
import { exitMs, fadeOutWindow, undoFadeOutWindow } from '../../motion/windowFade';

/** Delay before the "up to ~15 s" hint shows for a Relation-model preview that scores periods. */
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

/** The same boundary as plain input text (no thousands separators — an `<input>` value). */
function clusterBoundInputText(v: number): string {
    if (shortDecimals(v) <= TYPED_DECIMALS_MAX) return String(v);
    const a = Math.abs(v);
    return String(Number(a !== 0 && a < 0.001 ? v.toPrecision(3) : v.toFixed(3)));
}

// Group colour comes from getFgGroupColor (utils/failureGroupColor.ts), shared with the Dashboard and Import page.

// Same oklch values as .fg-group-color-{name} in App.css, kept as plain JS
// here rather than relied on via CSS inheritance.
const FG_ACCENT: Record<string, string> = {
    amber: 'oklch(0.78 0.14 75)',
    violet: 'oklch(0.7 0.15 310)',
    green: 'oklch(0.72 0.15 150)',
    blue: 'oklch(0.68 0.17 245)',
    slate: 'var(--text-faint)',
};

/** Models bucketed by sensor key across all Failure Groups; same identity as groupModelsBySensor. */
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

/** The sensor list pane (DESIGN_SYSTEM §4 rule 7): where its width is saved, and where it starts. */
const LIST_WIDTH_KEY = 'wizard.buildModelListWidth';
const LIST_DEFAULT_WIDTH = 300;
const NO_TAGS: string[] = [];

interface SettingsSummaryParts {
    name: string;
    /** Clustering's Y sensor ('' = not picked yet); null for the other kinds. */
    y: string | null;
    /** What never gets cut: the counts and the data scope. */
    fixed: string[];
}

/** Collapsed summary: one line while it fits; when cut, name and Y sensor shrink (Y keeps its end), counts stay whole. */
function SettingsSummary({ text, parts }: { text: string; parts: SettingsSummaryParts }) {
    const [ref, cut] = useLineCut(text);
    if (!cut) return <span ref={ref} className="bmw-sets-sum">{text}</span>;
    return (
        <span ref={ref} className="bmw-sets-sum bmw-sets-sum--parts" title={text} data-testid="settings-summary-parts">
            <span className="bmw-sum-name">{parts.name}</span>
            {parts.y !== null && (
                <span className="bmw-sum-y"><span className="bmw-sum-sep"> · </span>Y: {parts.y ? <SensorInline tag={parts.y} size="sm" muted /> : '—'}</span>
            )}
            {parts.fixed.map(p => <span key={p} className="bmw-sum-fix"><span className="bmw-sum-sep"> · </span>{p}</span>)}
        </span>
    );
}

const modelTagOf = (m: FailureModel): string => (m.kind === 'clustering' ? m.xSensor : m.targetSensor) ?? '';
/** Placeholder plan for rows the run strip / close dialog only label (they never read it). */
const LABEL_ONLY_PLAN = { kind: 'ready' } as const;

/** Kind identity colour used for the active tab underline. */
const KIND_COLOR: Record<ModelKind, string> = {
    individual: 'var(--accent-hi)',
    relationship: 'var(--warn)',
    clustering: 'var(--kind-clu)',
};

/** Unsaved edits to one model, kept per model id so kind-tab switches keep them; category is saved instantly, not here. */
interface ModelDraft {
    name: string;
    predictors: string[];
    y: string;
    criteria: string;
    ranges: { min: number | null; max: number | null }[];
    stiffness: number;
    numClusters: number;
    runningConditionMode: 'workspace' | 'custom';
    /** Custom running-condition fields; saved with the rest of the draft. */
    customFilters: WorkspaceSensorFilter[];
    customCombine: 'and' | 'or';
    customAllData: boolean;
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
    customAllData: m.customRunningConditionAllData ?? false,
    customPeriods: m.filterTimePeriods ?? [],
    customTestPeriods: m.customTestPeriods ?? [],
});

// Fixed order, not alphabetical: matches the kind toggles/badges elsewhere.
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
/** Mark complete's blocked reason (tooltip); Train sensor never trains a Complete model, so its variant omits it. */
const FIT_GONE_BLOCK_REASON = `${FIT_GONE_WORDS} · load it again, or re-train with Train sensor ↑`;
const FIT_GONE_BLOCK_REASON_COMPLETE = `${FIT_GONE_WORDS} · load it again first`;
/** Mark complete answered NOT_FITTED: it needs the fit Rust no longer holds. */
const FIT_GONE_SAVE_MESSAGE = 'The fitted Relation model is no longer in memory, so it was not marked complete. Load it again, then Mark complete.';
/** Complete model whose result could not be recomputed on open: tooltip and Mark complete block reason. */
const LOAD_FAILED_WORDS = "Couldn't load the model";
/** Tail of the "N set points not valid" reason; red for a rejected set point, amber for an empty one. */
const SET_POINTS_NOT_VALID_TAIL = ' not valid — fix before marking complete';
const LOAD_FAILED_BLOCK_REASON = `${LOAD_FAILED_WORDS} · load it again first`;
/** The gate badge (tab / list tooltip) of a model that still has to train and whose
 *  train periods hold no running row. */
const NO_ROWS_BADGE = NO_TRAIN_ROWS_FOOTER;
/** Line under Train sensor for a Custom-condition model while the workspace condition is unset or invalid (not blocked). */
const OWN_RC_NOT_BLOCKED = 'own running condition, not blocked';
/** A model with results whose training scope holds no row of the loaded data (`noDataOf`). */
interface ModelNoData { cause: NoModelDataCause; mode: 'workspace' | 'custom'; hasCondition: boolean }
/** "Load it again" while Mark complete is saving this model (it runs the engine too). */
const FIT_RELOAD_SAVING_REASON = 'Wait for the save to finish';
/** Mark complete while Rust is still answering for what was just typed (a moment). */
const CHECKING_SET_POINTS = 'Checking the set points…';
/** Mark complete while the health score could not be loaded (its red card has the Retry). */
const PREVIEW_FAILED_BLOCK_REASON = 'The health score did not load · Retry above, then Mark complete';
/** Load failed because the dataset was replaced (STALE_SESSION): asking again cannot help, so no Retry. */
const PREVIEW_STALE_BLOCK_REASON = TRAIN_STALE_MESSAGE;
/** Max clusters via the stepper only; a saved higher count is kept (clamping would change the train fingerprint). */
const MAX_CLUSTERS = 5;
const MAX_CLUSTERS_REASON = `At most ${MAX_CLUSTERS} clusters`;
/** Word for word what Export results says (`x_equals_y` in workspace_export.rs). */
const X_EQUALS_Y_REASON = 'The X and Y sensors must be different';

/** Stable empty list for `useSubModelFits` when the active model is not a Relationship. */
const NO_PREDICTORS: string[] = [];
/** Shown when a Train finds the dataset replaced since this window opened. */
const DATASET_CHANGED_MESSAGE = 'The dataset changed since this window was opened — close it and reopen Build Model from the Dashboard.';
/** Export results is writing: Train, Mark complete, set points and model settings wait. */
const EXPORT_BUSY_REASON = 'Available when the export finishes';
const SAVE_FAILED_NOTICE = 'Your last change could not be saved. Try again; if it keeps failing, check the disk and that the project file is still there.';
const SET_POINTS_UNSAVED_CLOSE_NOTICE = 'Some set points could not be saved — the window stays open so nothing is lost. Close it again to leave without them.';
const NO_PROJECT_FILE = 'The project file could not be found.';
/** A failed broadcast is not a failed save: the write has already landed. */
async function broadcastFailureGroups(payload: FailureGroupStateChangedPayload): Promise<void> {
    try {
        await emit('failure-group-state-changed', payload);
    } catch (e) {
        console.warn('Failed to broadcast failure-group state:', e);
    }
}
/** The close notice while a running export is finished first (capped like Mark complete). */
const EXPORT_CLOSE_WAIT_NOTICE = 'Finishing the export first — the window closes by itself when it is done (at most 90 s).';
/** Disabled while a training run is active: one Relation-model sidecar call at a time. */
const TRAIN_RUN_ACTIVE_REASON = 'Wait for the training run to finish';
/** A model whose Mark complete is being checked is not trained meanwhile. */
const BEING_SAVED_REASON = 'It is being checked for Mark complete';
/** The close notice when "Stop after this model and close" gave up waiting. */
const RUN_CLOSE_WAIT_NOTICE = 'This model is still training. The window closes when it finishes. Close it again to stop training and leave now.';
/** A model stopped by a close that gave up: its row says this, not "Failed". */
const ENGINE_STOPPED_ROW_NOTE = 'Stopped before it finished';
/** Kind names for this window; the UI says "Relation model", never "Relationship". */
const KIND_TAB_LABEL: Record<ModelKind, string> = MODEL_KIND_LABEL;
/** The ONE filled button of the detail pane (at most one filled button on
 *  screen) — see `primaryActionOf`. */
type PrimaryAction = 'save' | 'train' | 'mark' | null;

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

/** One model's cached preview result by kind; session-only, never persisted. */
type TrainResult =
    | { kind: 'individual'; stats: SensorStats }
    // Bounded preview Rust returns when asked to cache the fit; no set points applied.
    | { kind: 'relationship'; result: RelationshipPreviewResult }
    | { kind: 'clustering'; preview: ClusteringPreview };

interface TrainCacheEntry {
    /** Fingerprint the result was computed for; tells a current result from an old cached one. */
    fingerprint: string;
    result: TrainResult;
}

/** Call before any close/Apply: forces a blur so a pending typed date is committed (state-only closes cause no blur). */
function flushFocusedInput(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && typeof active.blur === 'function') active.blur();
}

/** One shared empty list, so a hook input does not change identity per render. */
const NO_PERIODS: TimePeriod[] = [];

/** Neutral line next to Apply while a period date is half-typed (name = row, e.g. P1/S2). */
const pendingDateText = (name: string): string => `Finish the date in ${name} to see what this changes`;

/** The workspace running-condition fields edited as one local draft; nothing is written until Apply. */
interface RcDraft {
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    periods: TimePeriod[];
    allData: boolean;
    /** The workspace SCORING periods (start → end only). */
    testPeriods: TestPeriod[];
}

/** What Build Model keeps of the project's details. */
type ProjectInfo = Pick<WorkspaceState, 'id' | 'name' | 'machine' | 'dataUtcOffsetMin'>;
const projectInfoOf = (ws: WorkspaceState): ProjectInfo =>
    ({ id: ws.id, name: ws.name, machine: ws.machine, dataUtcOffsetMin: ws.dataUtcOffsetMin });

/** True when the conversion left the workspace condition unset although an old one existed. */
function conversionMustSetAgain(c: RunningConditionConversion | null | undefined): boolean {
    if (!c || c.result !== 'needs-set') return false;
    return c.before.allRows || c.before.filters.length > 0 || !!c.before.savedStatus;
}

/** Conversion record left after a workspace Apply: Custom needs-set models still without their own condition; null if none. */
function conversionAfterWorkspaceApply(
    c: RunningConditionConversion | null | undefined,
    models: FailureModel[],
): RunningConditionConversion | null {
    if (!c) return null;
    const pending = c.customModels.filter(cm => {
        if (cm.result !== 'needs-set') return false;
        const m = models.find(x => x.id === cm.id);
        if (!m || m.runningConditionMode !== 'custom') return false;
        return !(m.customRunningConditionFilters ?? []).some(f => f.operation === 'greater_than' && isCompleteCondition(f));
    });
    if (pending.length === 0) return null;
    return {
        result: 'needs-set',
        source: null,
        before: { filters: [], combine: 'and', allRows: false, savedStatus: null },
        after: null,
        incompleteModelIds: [],
        customModels: pending,
    };
}

/** Draft vs persisted via JSON; scoring periods compare by id/start/end only (toScoringPeriods). */
function rcDraftEqual(a: RcDraft, b: RcDraft): boolean {
    return a.combine === b.combine
        && a.allData === b.allData
        && JSON.stringify(a.filters) === JSON.stringify(b.filters)
        && JSON.stringify(a.periods) === JSON.stringify(b.periods)
        && JSON.stringify(toScoringPeriods(a.testPeriods)) === JSON.stringify(toScoringPeriods(b.testPeriods));
}

/** Singleton Build Model window (label `build-model`): sensor list plus per-model Model fit / Health score pages. Writes failureGroupState read-modify-write and broadcasts failure-group-state-changed. */
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
    // Workspace train periods; at least one is required (empty is not the whole dataset). Custom mode uses filterTimePeriods.
    const [runningConditionTimePeriods, setRunningConditionTimePeriods] = useState<TimePeriod[]>([]);
    // Workspace-default scoring periods; at least one is needed before Mark complete. Custom mode uses customTestPeriods.
    const [runningConditionTestPeriods, setRunningConditionTestPeriods] = useState<TestPeriod[]>([]);
    // Dashboard time highlights; only feed the train-period overlap warning. Re-read on hydration and when settings open.
    const [dashHighlights, setDashHighlights] = useState<TimeHighlight[]>([]);
    // Special-sensor recipes, one array per read so signatures are computed once; a changed formula makes models stale.
    const [specialRecipes, setSpecialRecipes] = useState<SpecialSensorRecipe[] | null>(null);
    const [rcFilterOpen, setRcFilterOpen] = useState(false);
    // Modal edits this draft; null = nothing edited, modal shows persisted values. Cleared on close.
    // Also a ref: a date blur commits right before the Apply click.
    const [rcDraft, setRcDraftState] = useState<RcDraft | null>(null);
    const rcDraftRef = useRef<RcDraft | null>(null);
    // Row name per list of a half-typed period date; only drives the "Finish the date" line, never enables Apply or gets written.
    const [rcPendingDate, setRcPendingDate] = useState<{ train: string | null; scoring: string | null }>({ train: null, scoring: null });
    const onRcPendingDate = useCallback((list: 'train' | 'scoring', name: string | null) => {
        setRcPendingDate(prev => (prev[list] === name ? prev : { ...prev, [list]: name }));
    }, []);
    // Inline "Discard changes?" row, shown instead of closing when X/backdrop
    // is used with an unapplied draft.
    const [rcDiscardPrompt, setRcDiscardPrompt] = useState(false);
    // Models an Apply sent back to training this session; session-only.
    const [rcRetrainIds, setRcRetrainIds] = useState<string[]>([]);
    // Refs for applyRcDraft, a stable callback defined before gateFg and the recipes.
    const gateFgRef = useRef<RunningConditionFg>(null);
    const specialRecipesRef = useRef<SpecialSensorRecipe[] | null>(null);
    // The Running-condition dialog element (focus on open, Tab kept inside).
    const rcDialogRef = useRef<HTMLDivElement>(null);
    // Mirrors runningConditionAllData: train and Health score use every row of the periods, with no value filter.
    const [runningConditionAllData, setRunningConditionAllData] = useState(false);
    // Project details as on disk; re-read whenever any window saves them.
    const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
    const projectSeq = useRef(0);
    // Project details dialog data; the other projects load before it opens so Save always has the duplicate check.
    const [projectDetails, setProjectDetails] = useState<{ ws: ProjectInfo; others: WorkspaceMetadata[] } | null>(null);
    // The one-time running-condition conversion (`failureGroupState.runningConditionConversion`).
    const [rcConversion, setRcConversion] = useState<RunningConditionConversion | null>(null);
    // Workspace id the panel last auto-opened for: auto-open once per hydration, not on every broadcast.
    const rcAutoOpenedFor = useRef<string | null>(null);
    const [loading, setLoading] = useState(true);

    const [leftGroupBy, setLeftGroupBy] = useState<LeftGroupBy>('fg');
    const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [listWidth, setListWidth] = useState(() => readSavedPaneWidth(LIST_WIDTH_KEY, LIST_DEFAULT_WIDTH));
    /** Sensor shown in the detail pane (a modelSensorKey). */
    const [selectedSensorKey, setSelectedSensorKey] = useState<string | null>(null);
    /** Which model (kind tab) is active per sensor. */
    const [activeTab, setActiveTab] = useState<Record<string, string>>({});
    /** "Model settings" collapse override per model id — absent = auto
     *  (open while incomplete, else collapsed). */
    const [settingsOpenOverride, setSettingsOpenOverride] = useState<Record<string, boolean>>({});

    /** Session-only cache of the last preview per model id; never persisted. */
    const [trainResults, setTrainResults] = useState<Record<string, TrainCacheEntry>>({});
    /** Key present = a preview run is in flight (explicit or silent); a finished run lands in trainResults. */
    const [trainStatus, setTrainStatus] = useState<Record<string, 'loading'>>({});
    const [trainError, setTrainError] = useState<Record<string, string>>({});
    /** Silent loads that got no rows: id -> noRowsLoadKey (fingerprint + generation); not asked again for the same scope and data. */
    const [noRowsLoads, setNoRowsLoads] = useState<Record<string, string>>({});
    /** Page per model id; Health score is never shown for a stale or untrained model (pageOf falls back to Model fit). */
    const [pageByModel, setPageByModel] = useState<Record<string, WorkbenchPage>>({});
    /** Rust dataset generation this window opened on; sent as expectedGeneration so an old window gets STALE_SESSION. */
    const [generation, setGeneration] = useState<number | undefined>(undefined);
    // Loaded data's time range; null (unknown) from the render the window is re-pointed until the new dataset's answer lands.
    const { bounds: datasetBounds } = useDatasetTimeBounds(workspaceId === null ? null : `${workspaceId}|${generation ?? ''}`);
    /** Bumped after every Train so useHealthPreview refetches (a re-train re-fills Rust's fit cache). */
    const [healthRevision, setHealthRevision] = useState(0);
    /** "Compare predictors" (Sub-models) modal of the active Relationship model. */
    const [compareOpen, setCompareOpen] = useState(false);
    // Never leave the comparison open pointed at a model the user has since
    // navigated away from (switching sensor or kind tab).
    useEffect(() => { setCompareOpen(false); }, [selectedSensorKey, activeTab]);

    /** Draft set points per model id (draft ?? persisted), committed on blur/Enter, page or model leave and window close. */
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
    // The last validate verdict is persisted on the model (healthVerdict), not window state.
    /** Every Mark complete run in flight, so a window close can wait for it (pendingSaveRef holds only one slot). */
    const markRunsRef = useRef<Set<Promise<unknown>>>(new Set());
    /** The user was told the close is waiting too long for a running save; the next
     *  close attempt does not wait for it again. */
    const closeWaitGivenUpRef = useRef(false);
    const [closeNotice, setCloseNotice] = useState<string | null>(null);
    const [saveFailed, setSaveFailed] = useState(false);
    /** The running Export results (its `start` promise), so a window close can wait for it. */
    const exportRunRef = useRef<Promise<unknown> | null>(null);
    /** Cancels the running export (a close that gave up waiting). */
    const exportCancelRef = useRef<(() => Promise<void>) | null>(null);

    // Queue runs one model at a time via trainForQueue; the ref exists because the hook is called before that is defined.
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
    /** Engine calls in progress: the queue below (Train, a silent load, Compare) and health previews. */
    const engineCallsRef = useRef(0);
    const [onEngine] = useState<EngineQueue>(() => {
        const inTurn = createEngineQueue();
        return <T,>(fn: () => Promise<T>) => {
            engineCallsRef.current++;
            return inTurn(fn).finally(() => { engineCallsRef.current--; });
        };
    });
    /** The header's Train sensor button (every "Train sensor ↑" link focuses it). */
    const trainSensorBtnRef = useRef<HTMLButtonElement>(null);
    /** The ▾ of Train sensor: the "Marked complete" board points at its menu. */
    const trainMenuBtnRef = useRef<HTMLButtonElement>(null);
    /** The notice line at the bottom of the detail pane — set only while it is on screen. */
    const noticeRef = useRef<HTMLDivElement>(null);
    /** Open page tab; focus moves here when the focused Save changes unmounts. */
    const activePageTabRef = useRef<HTMLButtonElement>(null);
    /** Id of the model whose "Save changes" was pressed (see the effect on `drafts`). */
    const saveFocusRef = useRef<string | null>(null);
    /** The Dashboard said this workspace is closing (`workspace-closing`): close without any question. */
    const closeBypassRef = useRef(false);
    /** "Stop after this model and close" gave up waiting: the next close skips the run dialog. */
    const runWaitGaveUpRef = useRef(false);
    /** After that give-up the window still closes when the run ends, unless a new close got there first. */
    const closeAfterRunRef = useRef(false);
    /** Window.close() was called: its `close-requested` pass lets the window go. */
    const leavingRef = useRef(false);
    /** The close-with-unsaved-edits dialog is open. */
    const [unsavedAsk, setUnsavedAsk] = useState(false);
    const unsavedAskRef = useRef(false);
    unsavedAskRef.current = unsavedAsk;
    /** "Stop after this model and close" is already waiting (double-click guard). */
    const stopClosingRef = useRef(false);
    /** Mirror of `closeAsk` for the once-registered `workspace-closing` listener. */
    const closeAskRef = useRef(false);
    closeAskRef.current = closeAsk;
    /** Relationship models whose Rust fit is gone (NOT_FITTED); planned as ready again until a train succeeds. */
    const [notFittedIds, setNotFittedIds] = useState<ReadonlySet<string>>(() => new Set());
    /** `id::fingerprint` already re-fitted automatically after a NOT_FITTED (once each). */
    const refitTriedRef = useRef<Set<string>>(new Set());
    /** Models whose "Load it again" is under way (double-click guard). */
    const fitReloadingRef = useRef<Set<string>>(new Set());
    /** Models whose first-open set-point snapshot was already written (once per model). */
    const setPointsSeededRef = useRef<Set<string>>(new Set());

    /** Unsaved edits, keyed by model id. */
    const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
    const draftsRef = useRef(drafts);
    draftsRef.current = drafts;
    /** One-time category notice, stored in failureGroupState.categoryNormalisationNotice so any window's write keeps it. */
    const [categoryNotice, setCategoryNotice] = useState<CategoryChange[] | null>(null);
    const [categoryWarn, setCategoryWarn] = useState<{ key: string; text: string } | null>(null);
    /** "Copied N periods and M conditions" note per model id; session-only, shown once per switch to Custom. */
    const [seedNoteFor, setSeedNoteFor] = useState<Record<string, { periods: number; conditions: number; tests: number } | null>>({});
    /** Criteria-sensor stats for the cluster slider with the key they were fetched for; used only while the key matches. */
    const [criteriaStatsEntry, setCriteriaStatsEntry] = useState<{ key: string; stats: SensorStats } | null>(null);
    /** The stats request failed, for that key: the slider says so and offers Try again. */
    const [criteriaStatsFailure, setCriteriaStatsFailure] = useState<{ key: string; message: string } | null>(null);
    const [criteriaStatsTry, setCriteriaStatsTry] = useState(0);
    /** Boundary being typed (idx = between cluster idx+1 and idx+2); initial = text on focus, so no change commits nothing. */
    const [boundaryEdit, setBoundaryEdit] = useState<{ modelId: string; idx: number; text: string; initial: string; error: string | null } | null>(null);
    /** Exact text typed per boundary, shown while the stored value equals it; session only. */
    const [typedBoundaryText, setTypedBoundaryText] = useState<Record<string, { value: number; text: string }>>({});

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    // Every sensor label / picker in this window resolves through this lookup.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);
    const getComponent = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.component ?? '', [sensorMetaMap]);
    // Raw description only; labels come from sensorLookup.
    const getDesc = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description ?? '', [sensorMetaMap]);
    // Unit text for the Running condition chips / value fields ("kW", "BAR"...).
    const getUnit = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.unit ?? '', [sensorMetaMap]);
    // "description (tag)", or the bare tag when there is no description.
    const sensorLabel = useCallback((tag: string) => {
        const desc = sensorMetaMap.get(normalizeSensorTag(tag))?.description;
        return desc ? `${desc} (${tag})` : tag;
    }, [sensorMetaMap]);

    // Model's own name unless it equals the target tag; else description (tag); Clustering uses Y, falling back to X.
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

    // Current workspace and a counter so a slow, superseded load drops its result.
    const workspaceIdRef = useRef<string | null>(null);
    const loadSeq = useRef(0);
    /** Counts broadcasts: a slice read from disk before the latest one is older than what is on screen. */
    const fgBroadcastSeq = useRef(0);
    const recipeSeq = useRef(0);

    // Latest in-flight updateWorkspaceData write from any persist path; the close handlers await it.
    const pendingSaveRef = useRef<Promise<void> | null>(null);
    const trackPending = useCallback((p: Promise<void>): Promise<void> => {
        // What a close waits for never rejects; the caller still sees the failure.
        const settled: Promise<void> = p.catch(() => {}).then(() => {
            if (pendingSaveRef.current === settled) pendingSaveRef.current = null;
        });
        pendingSaveRef.current = settled;
        return p;
    }, []);
    /** A tracked write that answers whether it reached the disk, and says so on screen when not. */
    const savedOk = useCallback((p: Promise<void>): Promise<boolean> => {
        const ws = workspaceIdRef.current;
        return trackPending(p).then(
            () => {
                if (workspaceIdRef.current === ws && Object.keys(spDraftsRef.current).length === 0) setSaveFailed(false);
                return true;
            },
            (e) => {
                console.error('Could not save to the project file:', e);
                if (workspaceIdRef.current === ws) setSaveFailed(true);
                return false;
            },
        );
    }, [trackPending]);
    // Mirrors the whole slice into local state — used by every path that
    // receives a fresh copy (hydration, broadcasts, our own writes).
    const applyFg = useCallback((fg: FailureGroupStateSlice | undefined | null) => {
        setAllGroups(fg?.groups ?? []);
        setAllModels(fg?.models ?? []);
        setRunningConditionFilters(fg?.runningConditionFilters ?? []);
        setRunningConditionCombine(fg?.runningConditionCombine ?? 'and');
        setRunningConditionTimePeriods(fg?.runningConditionTimePeriods ?? []);
        setRunningConditionTestPeriods(fg?.runningConditionTestPeriods ?? []);
        setRunningConditionAllData(fg?.runningConditionAllData ?? false);
        setRcConversion(fg?.runningConditionConversion ?? null);
        setCategoryNotice(fg?.categoryNormalisationNotice ?? null);
    }, []);

    /** Adopts what this window's write put on disk, recipes included, so freshness is judged against them. Older in-flight recipe reads are dropped (recipeSeq). */
    const applyWritten = useCallback((ws: WorkspaceState | null | undefined) => {
        if (!ws?.failureGroupState) return;
        applyFg(ws.failureGroupState);
        recipeSeq.current++;
        setSpecialRecipes(ws.specialSensorRecipes ?? null);
    }, [applyFg]);

    /** Re-reads Dashboard time highlights from disk; a failure keeps the last list. */
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

    /** Persists set-point drafts not yet on disk (only healthSetPoints, tracked in pendingSaveRef). A draft is dropped once written unless a newer one was typed. */
    const spInflightRef = useRef<{ drafts: Record<string, HealthSetPoints>; promise: Promise<void> } | null>(null);
    /** Set points failed to save and the user was told: the next close leaves without them. */
    const leaveUnsavedRef = useRef(false);
    const commitSetPointDrafts = useCallback((): Promise<void> => {
        const ws = workspaceIdRef.current;
        const drafts = spDraftsRef.current;
        const ids = Object.keys(drafts);
        if (!ws || ids.length === 0) return Promise.resolve();
        // Several triggers can fire for one edit; drafts already being written are not written again.
        const inflight = spInflightRef.current;
        if (inflight && ids.every(id => inflight.drafts[id] === drafts[id])) return inflight.promise;
        const entry: { drafts: Record<string, HealthSetPoints>; promise: Promise<void> | null } = { drafts, promise: null };
        const promise: Promise<void> = trackPending((async () => {
            try {
                for (const id of ids) {
                    const sp = drafts[id];
                    const next = await commitSetPoints(ws, id, sp, 'build-model');
                    if (!next) throw new Error(NO_PROJECT_FILE);
                    // The window may have been re-pointed; remaining drafts are still written to ws, only this window's own state is skipped.
                    if (workspaceIdRef.current !== ws) continue;
                    applyWritten(next);
                    if (spDraftsRef.current[id] === sp) {
                        const rest = { ...spDraftsRef.current };
                        delete rest[id];
                        writeSpDrafts(rest);
                    }
                }
                if (workspaceIdRef.current === ws) {
                    setSaveFailed(false);
                    leaveUnsavedRef.current = false;
                }
            } catch (e) {
                // Not saved: what is not written stays as a draft and goes again on the next commit.
                console.error('Could not save set points:', e);
                if (workspaceIdRef.current === ws) setSaveFailed(true);
            } finally {
                if (spInflightRef.current === entry) spInflightRef.current = null;
            }
        })());
        entry.promise = promise;
        spInflightRef.current = entry as { drafts: Record<string, HealthSetPoints>; promise: Promise<void> };
        return promise;
    }, [trackPending, applyWritten, writeSpDrafts]);

    /** Awaits this window's pending write and any running Mark complete; an unblurred set-point draft is committed first. */
    const flushAllPending = useCallback(async (): Promise<boolean> => {
        if (!leaveUnsavedRef.current) void commitSetPointDrafts();
        // Wait for a running Mark complete so it ends saved or refused; gives up once after a timeout (hung sidecar).
        if (markRunsRef.current.size > 0 && !closeWaitGivenUpRef.current) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finished = Promise.allSettled([...markRunsRef.current]).then(() => true);
            const gaveUp = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), MARK_COMPLETE_CLOSE_WAIT.ms); });
            const ok = await Promise.race([finished, gaveUp]);
            if (timer) clearTimeout(timer);
            if (!ok) {
                closeWaitGivenUpRef.current = true;
                setCloseNotice('Still checking a model for Mark complete — the window stays open so nothing is lost. Close it again to leave without waiting.');
                return false;
            }
        }
        if (pendingSaveRef.current) await pendingSaveRef.current;
        if (!leaveUnsavedRef.current && !closeBypassRef.current && Object.keys(spDraftsRef.current).length > 0) {
            leaveUnsavedRef.current = true;
            setCloseNotice(SET_POINTS_UNSAVED_CLOSE_NOTICE);
            return false;
        }
        return true;
    }, [commitSetPointDrafts]);

    /** Finishes a running Export results before closing; after MARK_COMPLETE_CLOSE_WAIT it is cancelled and the close continues. */
    const waitForExportBeforeClose = useCallback(async (): Promise<void> => {
        const run = exportRunRef.current;
        if (!run) return;
        setCloseNotice(EXPORT_CLOSE_WAIT_NOTICE);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = run.then(() => true, () => true);
        const gaveUp = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), MARK_COMPLETE_CLOSE_WAIT.ms); });
        const ok = await Promise.race([finished, gaveUp]);
        if (timer) clearTimeout(timer);
        if (!ok) await exportCancelRef.current?.();
        setCloseNotice(null);
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
        setSeedNoteFor(prev => {
            const ids = new Set(allModels.map(m => m.id));
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
    }, [allModels]);

    // Drop cached and in-flight previews of models that no longer exist.
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

    // Keep the selected sensor one that still has a model; else pick the first.
    useEffect(() => {
        const keys = allSensorGroups(allModels).map(sg => sg.key);
        setSelectedSensorKey(prev => (prev !== null && keys.includes(prev)) ? prev : (keys[0] ?? null));
    }, [allModels]);

    useEffect(() => {
        const offData = subscribe<BuildModelData>('build-model-data', async (event) => {
            const d = event.payload;
            // Re-pointed at another workspace: drop everything of the old one, including half-edited forms.
            const switched = workspaceIdRef.current !== null && workspaceIdRef.current !== d.workspaceId;
            // An unblurred set point of the old workspace is written there first; its id and drafts are captured before the ref moves.
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
                // Keyed by model id, which two workspaces can share: reset so the new workspace does not inherit the old division key.
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
                setRunningConditionAllData(false);
                setRcConversion(null);
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
                // Not reset: an old workspace's Mark complete still saves into its own workspace, and a close must wait for it.
                closeWaitGivenUpRef.current = false;
                // A `workspace-closing` for the old workspace set the bypass; the new
                // workspace's runs must ask before closing again.
                closeBypassRef.current = false;
                stopClosingRef.current = false;
                setCloseNotice(null);
                setSaveFailed(false);
                leaveUnsavedRef.current = false;
                // The run belonged to the old workspace; an in-flight train's result is ignored.
                queueReset();
                setNotFittedIds(new Set());
                refitTriedRef.current = new Set();
                fitReloadingRef.current = new Set();
                setTrainAllView(null);
                setIncludeUpToDate(false);
                setCloseAsk(false);
                setUnsavedAsk(false);
                runWaitGaveUpRef.current = false;
                closeAfterRunRef.current = false;
                leavingRef.current = false;
                // Never left showing the old project's, should the new one fail to load.
                setProjectInfo(null);
                setSpecialRecipes(null);
            }
            // Dataset bounds follow by themselves: keyed on workspace + generation, unknown until the new answer lands.
            setGeneration(d.metadata?.generation);
            setAllSensors(d.sensorHeaders);
            setSensorMetadata(d.sensorMetadata);
            const seq = ++loadSeq.current;
            const fgAtRead = fgBroadcastSeq.current;
            try {
                const ws = await loadWorkspaceData(d.workspaceId);
                // Only a newer load supersedes this one; a broadcast meanwhile is newer than the slice, not than the rest of this read.
                if (seq !== loadSeq.current || workspaceIdRef.current !== d.workspaceId) return;
                setDashHighlights(ws?.timeHighlights ?? []);
                projectSeq.current++;
                setProjectInfo(ws ? projectInfoOf(ws) : null);
                recipeSeq.current++;
                setSpecialRecipes(ws?.specialSensorRecipes ?? null);
                // Cleanup written back only if it changed something: categories (with a stored notice) and old time ranges to periods.
                const periodsMigrated = ws ? migratePeriods(ws, { dropLegacyKeys: true }) : ws;
                const periodsChanged = periodsMigrated !== ws;
                const migrated = periodsMigrated ? normalizeCategories(periodsMigrated) : periodsMigrated;
                if (fgAtRead === fgBroadcastSeq.current) applyFg(migrated?.failureGroupState);
                if (migrated && rcAutoOpenedFor.current !== d.workspaceId) {
                    rcAutoOpenedFor.current = d.workspaceId;
                    const headers = d.sensorHeaders.length ? d.sensorHeaders : null;
                    // An old project that must set its condition again shows the "Set it again" card instead of the modal.
                    const mustSetAgain = conversionMustSetAgain(migrated.failureGroupState?.runningConditionConversion);
                    if (!mustSetAgain && !isWorkspaceRunningConditionConfigured(migrated.failureGroupState, headers)) setRcFilterOpen(true);
                }
                if (periodsChanged || (migrated !== ws && migrated?.failureGroupState?.categoryNormalisationNotice?.length)) {
                    await trackPending((async () => {
                        const written = await updateWorkspaceData(d.workspaceId, prev => normalizeCategories(migratePeriods(prev, { dropLegacyKeys: true })));
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

        // Other windows' failureGroupState broadcasts; ignore other workspaces (events are global) and this window's own echo.
        const offChanged = subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
            if (event.payload.workspaceId !== workspaceIdRef.current) return;
            if (event.payload.origin === 'build-model') return;
            // A load already in flight read an older slice than this.
            fgBroadcastSeq.current++;
            applyFg(event.payload);
            // On recipesChanged re-read recipes from disk (never in the payload); other broadcasts cost no read.
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

    // A Project details save in any window re-reads name/machine/time zone; other workspaces' or id-less payloads are dropped.
    const reloadProjectInfo = useCallback((ws: string) => {
        const seq = ++projectSeq.current;
        loadWorkspaceData(ws)
            .then(data => {
                if (seq !== projectSeq.current || workspaceIdRef.current !== ws) return;
                setProjectInfo(data ? projectInfoOf(data) : null);
            })
            .catch(() => { /* keep the last details */ });
    }, []);
    useEffect(() => subscribe<ProjectDetailsChangedPayload>(PROJECT_DETAILS_CHANGED, (event) => {
        const ws = event.payload?.workspaceId;
        if (!ws || ws !== workspaceIdRef.current) return;
        reloadProjectInfo(ws);
    }), [reloadProjectInfo]);
    /** Opens Project details (the export checklist's Fix); reads the recent list first, then the project. */
    const openProjectDetails = useCallback(async () => {
        const ws = workspaceIdRef.current;
        if (!ws) return;
        let others: WorkspaceMetadata[] = [];
        try { others = await getRecentWorkspaces(); } catch { /* list unavailable: no duplicate check */ }
        let data: WorkspaceState | null = null;
        try { data = await loadWorkspaceData(ws); } catch { /* the project could not be read */ }
        if (!data || workspaceIdRef.current !== ws) return;
        setProjectDetails({ ws: projectInfoOf(data), others });
    }, []);

    // Resolves true when the write reached disk; tracked via trackPending so a window close can await it.
    const persist = useCallback((
        updater: (models: FailureModel[], groups: FailureGroup[]) => { models: FailureModel[]; groups: FailureGroup[] },
    ): Promise<boolean> => {
        if (!workspaceId) return Promise.resolve(false);
        return savedOk((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => {
                const groups = prev.failureGroupState?.groups ?? [];
                const models = prev.failureGroupState?.models ?? [];
                const result = updater(models, groups);
                // Spread-merge keeps other slice fields; a Complete model whose training inputs changed goes Incomplete in the same write.
                return applyIncompleteRule(prev, withFailureGroupState(prev, { groups: result.groups, models: result.models }));
            });
            if (!next) throw new Error(NO_PROJECT_FILE);
            // Re-pointed meanwhile: the write landed in its own workspace; touch nothing here.
            if (workspaceIdRef.current !== workspaceId) return;
            if (next?.failureGroupState) {
                applyWritten(next);
                await broadcastFailureGroups({ ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyWritten, savedOk]);

    // The only path that changes the workspace running condition (edited from the modal); one function for all sub-fields.
    const persistRunningCondition = useCallback((patch: {
        filters?: WorkspaceSensorFilter[];
        combine?: 'and' | 'or';
        periods?: TimePeriod[];
        allData?: boolean;
        testPeriods?: TestPeriod[];
    }): Promise<boolean> => {
        if (!workspaceId) return Promise.resolve(false);
        return savedOk((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => {
                const applied = withFailureGroupState(prev, {
                    ...(patch.filters !== undefined ? { runningConditionFilters: patch.filters } : {}),
                    ...(patch.combine !== undefined ? { runningConditionCombine: patch.combine } : {}),
                    ...(patch.periods !== undefined ? { runningConditionTimePeriods: patch.periods } : {}),
                    ...(patch.allData !== undefined ? { runningConditionAllData: patch.allData } : {}),
                    // Scoring periods are written as id/start/end only (toScoringPeriods).
                    ...(patch.testPeriods !== undefined ? { runningConditionTestPeriods: toScoringPeriods(patch.testPeriods) } : {}),
                });
                // A changed condition settles the workspace part of the one-time conversion notice in this same write.
                const conditionChanged = patch.filters !== undefined
                    && JSON.stringify(patch.filters) !== JSON.stringify(prev.failureGroupState?.runningConditionFilters ?? []);
                // A changed workspace condition sets Complete Workspace-mode models Incomplete, via applyIncompleteRule.
                // Only the workspace part of the conversion is settled; a Custom model still needing its own condition keeps its line.
                return applyIncompleteRule(prev, conditionChanged
                    ? withFailureGroupState(applied, {
                        runningConditionConversion: conversionAfterWorkspaceApply(
                            prev.failureGroupState?.runningConditionConversion, prev.failureGroupState?.models ?? []),
                    })
                    : applied);
            });
            if (!next) throw new Error(NO_PROJECT_FILE);
            // Re-pointed meanwhile (as in persist): never put the old workspace's slice into this state or broadcast it.
            if (workspaceIdRef.current !== workspaceId) return;
            if (next?.failureGroupState) {
                applyWritten(next);
                await broadcastFailureGroups({ ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyWritten, savedOk]);

    // The modal edits a local draft; nothing is written or broadcast until Apply (one persistRunningCondition call).
    // A broadcast while open does not clobber a dirty draft; Apply is last-writer-wins.
    const rcPersisted: RcDraft = {
        filters: runningConditionFilters,
        combine: runningConditionCombine,
        periods: runningConditionTimePeriods,
        allData: runningConditionAllData,
        testPeriods: runningConditionTestPeriods,
    };
    const rcPersistedRef = useRef<RcDraft>(rcPersisted);
    rcPersistedRef.current = rcPersisted;
    /** Gate state from the last render: dataset bounds and, for exactly this draft, whether the settled row count is zero and the draft changed training; applyRcDraft re-checks with it. */
    const rcGateRef = useRef<{ draft: RcDraft | null; bounds: PeriodDataBounds | null; noTrainRows: boolean }>({ draft: null, bounds: null, noTrainRows: false });
    /** The condition line blocks Apply (half-filled, or a set condition removed), as of the last render. */
    const rcCondBlockRef = useRef(false);
    /** Applies a patch to the draft and updates the ref synchronously, so a blur-commit right before the Apply click is not missed. */
    const patchRcDraft = useCallback((patch: Partial<RcDraft> | ((base: RcDraft) => Partial<RcDraft>)) => {
        const base = rcDraftRef.current ?? rcPersistedRef.current;
        const next: RcDraft = { ...base, ...(typeof patch === 'function' ? patch(base) : patch) };
        rcDraftRef.current = next;
        setRcDraftState(next);
        // Editing again means "keep editing" — drop a pending discard prompt.
        setRcDiscardPrompt(false);
    }, []);

    /** Sets THE condition ("Machine is running when <sensor> is above <value>"). */
    const setRunningConditionLine = useCallback(({ sensor, value }: { sensor: string; value: string }) => {
        patchRcDraft(base => ({
            filters: [{ id: base.filters[0]?.id ?? `rcf-${Date.now()}`, sensor, operation: 'greater_than' as const, value1: value, value2: '' }],
            // With one condition AND/OR no longer matters: combine stays as it was, so retyping the saved value is not an edit.
            // Editing the line keeps "Use all data".
        }));
    }, [patchRcDraft]);
    /** "Only when running" / "Use all data" — which rows Train and the Health score use. */
    const setRunningConditionUseAllData = useCallback((allData: boolean) => {
        patchRcDraft({ allData });
    }, [patchRcDraft]);

    // The editor hands up a typed date once complete, and the sorted list on blur/Enter/a discrete action.
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

    /** X/backdrop click: a dirty draft is not dropped silently; the footer asks "Discard changes?". */
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

    const applyRcDraft = useCallback(async () => {
        // The click may land before the date field's blur; force it so the ref has the commit.
        flushFocusedInput();
        const d = rcDraftRef.current;
        if (!d || rcDraftEqual(d, rcPersistedRef.current)) {
            closeRc();
            return;
        }
        // A half-filled condition line, or removing a condition that was set, keeps
        // the modal open (the footer says why).
        if (rcCondBlockRef.current) return;
        // Keeps the modal open (footer says why): bad or missing train period, bad scoring period, a changed period outside the data,
        // or zero running rows for a draft that changed training (counted for that draft only). An unchanged saved period only warns.
        const gate = rcGateRef.current;
        if (runningConditionApplyBlock(d.periods, d.testPeriods, 'applying', {
            bounds: gate.bounds,
            savedPeriods: rcPersistedRef.current.periods,
            savedTestPeriods: rcPersistedRef.current.testPeriods,
            noTrainRows: gate.draft === d && gate.noTrainRows,
            hasCondition: !d.allData,
        }) !== null) return;
        // Models this Apply sends back to training (same as the impact line), kept for the notice; earlier ones stay listed.
        const retrain = runningConditionImpact(gateFgRef.current, d, { recipes: specialRecipesRef.current ?? undefined }).retrainIds;
        // Modal and draft stay until the write lands: a failed save keeps the draft for a retry.
        await trackPending((async () => {
            if (!(await persistRunningCondition({ filters: d.filters, combine: d.combine, periods: d.periods, allData: d.allData, testPeriods: d.testPeriods }))) return;
            if (retrain.length > 0) setRcRetrainIds(prev => [...new Set([...prev, ...retrain])]);
            closeRc();
        })());
    }, [closeRc, persistRunningCondition, trackPending]);

    // Drafts are per model id so tab switches keep edits; category is per sensor and saved instantly (changeCategory).
    const draftOf = (m: FailureModel): ModelDraft => drafts[m.id] ?? draftFromModel(m);
    /** Raw draft write (no side effects) — the cluster auto-divide effect uses this. */
    const writeDraft = (m: FailureModel, patch: Partial<ModelDraft>) =>
        setDrafts(prev => ({ ...prev, [m.id]: { ...(prev[m.id] ?? draftFromModel(m)), ...patch } }));
    /** A user edit in Model settings; also pins the section open, so fixing the last missing item does not collapse it. */
    const patchDraft = (m: FailureModel, patch: Partial<ModelDraft>) => {
        writeDraft(m, patch);
        setSettingsOpenOverride(prev => (m.id in prev ? prev : { ...prev, [m.id]: true }));
    };

    /** Category of the model's sensor across every FG (never per model). */
    const categoryOf = (m: FailureModel): ModelCategory | null => sensorCategory(allModels, modelSensorKey(m));

    // Running-condition gate: getBuildBlockReason is the one source; every Train/Mark complete path asks it, Save does not.
    const gateFg: RunningConditionFg = {
        models: allModels, runningConditionFilters, runningConditionCombine,
        runningConditionTimePeriods, runningConditionAllData, runningConditionTestPeriods,
    };
    gateFgRef.current = gateFg;
    specialRecipesRef.current = specialRecipes;
    const gateHeaders = allSensors.length ? allSensors : null;
    const rcConfigured = isWorkspaceRunningConditionConfigured(gateFg, gateHeaders);

    // Data guards block actions only (Train, Apply, Save changes), never reads or existing results; a period outside the data
    // is invalid when new/changed in a draft, a warning as saved. Counts come from Rust count_period_rows (usePeriodCounts).
    const persistedCountFilter = useMemo(
        () => buildPreviewFilterPayload(
            { filters: runningConditionFilters, combine: runningConditionCombine, allData: runningConditionAllData, periods: runningConditionTimePeriods },
            gateHeaders,
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [runningConditionFilters, runningConditionCombine, runningConditionAllData, runningConditionTimePeriods, allSensors],
    );
    // A broken persisted train period (plain date rules); a saved period outside the data is only a card warning.
    const persistedPeriodsInvalid = validatePeriods(runningConditionTimePeriods).some(st => st.invalid);
    const cardCounts = usePeriodCounts({
        // No train period = nothing is trained on (rule 1): no whole-dataset count.
        enabled: !loading && rcConfigured && !persistedPeriodsInvalid && runningConditionTimePeriods.length > 0,
        workspaceId,
        trainPeriods: runningConditionTimePeriods,
        // The card reads no scoring count: no second call.
        scoringPeriods: NO_PERIODS,
        filter: persistedCountFilter,
        expectedGeneration: generation,
        // The persisted condition changes in whole steps (Apply, another window's
        // write), never per keystroke: nothing to wait for.
        debounceMs: 0,
    });
    /** The persisted workspace condition is counted with no running row in its train periods: no Workspace-mode model can train. */
    const cardNoRows = countedNoTrainRows(cardCounts);
    /** What a Custom model's own training scope is, as the count sees it
     *  (`trainCountKey`): its train periods + its condition. */
    const customCountKeyOf = (d: ModelDraft): string => trainCountKey(
        d.customPeriods,
        buildPreviewFilterPayload({ filters: d.customFilters, combine: d.customCombine, allData: d.customAllData, periods: d.customPeriods }, gateHeaders),
    );
    /** Training scope the active Custom model's settled count found no running row for, else null; set after its counts hook. */
    let customNoRowsKey: string | null = null;
    /** This Custom model's scope is known to hold no running row: it is the active model or shares the counted scope. An uncounted scope is stopped by the engine's answer (noRowsTrainError). */
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
    // Judge the draft-merged model (effectiveModelFor) so a pending Custom edit is seen by the gate.
    // gateBlockOf/gateReasonOf serve read paths; trainGateBlockOf adds the data guards, for Train only.
    const gateBlockOf = (m: FailureModel): BuildBlock | null => getBuildBlock(effectiveModelFor(m), gateFg, gateHeaders);
    const gateReasonOf = (m: FailureModel): string | null => gateBlockOf(m)?.reason ?? null;
    const trainGateBlockOf = (m: FailureModel): BuildBlock | null => getBuildBlock(effectiveModelFor(m), gateFg, gateHeaders, trainGuardOptsOf(m));
    /** Gate part needing no row count; it decides auto-opening Model settings, so it must not depend on counts. */
    const trainGuardBlockOf = (m: FailureModel): BuildBlock | null => {
        const block = trainGateBlockOf(m);
        return block !== null && block.kind === 'no-rows' ? block : null;
    };
    /** Data guard as shown on a model: only while it still has to train; trained/Complete models show the noDataOf board. */
    const shownGuardBlockOf = (m: FailureModel): BuildBlock | null =>
        isModelDone(m) || isModelTrainedFresh(m) ? null : trainGuardBlockOf(m);
    /** Gate part needing no row count; it decides auto-opening Model settings, so it must not depend on counts. */
    const countFreeGateReasonOf = (m: FailureModel): string | null =>
        gateReasonOf(m) ?? (isModelDone(m) || isModelTrainedFresh(m)
            ? null
            : getBuildBlockReason(effectiveModelFor(m), gateFg, gateHeaders, { bounds: datasetBounds }));
    /** Custom model with neither condition nor train period hears about the condition first; else own reason, then the gate's. */
    const orderedBlockReason = (own: string | null, gate: BuildBlock | null): string | null =>
        own === NO_TRAIN_PERIOD_REASON_CUSTOM && gate?.kind === 'no-condition' ? gate.reason : own ?? gate?.reason ?? null;
    /** Gate reason in the model's own wording: a Custom model's condition is fixed in Model settings. Other text is unchanged. */
    const ownGateText = (m: FailureModel, text: string | null): string | null => {
        if (text === null) return null;
        const block = trainGateBlockOf(m);
        if (!block || block.mode !== 'custom' || block.kind === 'category' || block.reason !== text) return text;
        return customBlockText(block, { settingsOpen: isSettingsOpen(m) });
    };
    /** Block reason shown away from the form: name the missing setting instead of "fill in the fields above". */
    const awayFromFormText = (m: FailureModel, text: string | null): string | null =>
        text === REQUIRED_FIELDS_BLOCK_REASON ? missingSettingsText(missingItems(m)) : ownGateText(m, text);
    // Draft-merged model, like the gate, so badge and sentence agree.
    const needsCondition = (m: FailureModel): boolean => !isRunningConditionConfigured(effectiveModelFor(m), gateFg, gateHeaders);
    /** Badge text for a model the gate blocks, else null; hover text is the reason. */
    const gateBadge = (m: FailureModel): string | null => {
        const block = gateBlockOf(m) ?? shownGuardBlockOf(m);
        if (block === null) return null;
        if (needsCondition(m)) return m.status ? LEGACY_BADGE : 'Needs condition';
        if (categoryOf(m) === null) return 'Needs category';
        if (block.kind === 'no-rows') return block.cause === 'outside-data' ? NO_TRAIN_DATA_SHORT : NO_ROWS_BADGE;
        return effectiveRunningCondition(effectiveModelFor(m), gateFg).periods.length === 0 ? 'Needs train period' : 'Fix periods';
    };

    /** Other workspace model using the draft's name. Only an edited name is gated; a saved twin blocks Mark complete. */
    const nameConflictOf = (m: FailureModel): FailureModel | null => {
        const d = drafts[m.id];
        if (!d || d.name.trim() === (m.name ?? '').trim()) return null;
        return findWorkspaceNameTwin(allModels, m, d.name);
    };
    /** "DESCRIPTION · TAG" (the tag alone without a description) for plain-text reasons. */
    const plainSensorLabel = (tag: string): string => sensorPlainLabel(sensorLookup(tag));

    /** Custom lists as saved, what the draft is judged against. Periods copied from the workspace (matched by dates, copies get new ids) count too, so a saved out-of-data one only warns. */
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
    /** Training scope as saved (trainCountKey); a draft with the same scope did not change what is trained. */
    const savedScopeKeyOf = (m: FailureModel): string =>
        m.runningConditionMode === 'custom'
            ? customCountKeyOf(draftFromModel(m))
            : trainCountKey(runningConditionTimePeriods, persistedCountFilter);
    /** What blocks Save in a Custom model's own lists, same as workspace Apply; data=true adds the data guards. New or changed periods outside the data and zero rows block; unchanged saved ones never do. */
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
            hasCondition: !d.customAllData,
        });
    };
    /** Save/Train reason; train-side blocks reuse the gate's sentences so the wording matches everywhere. */
    const customSaveReason = (m: FailureModel, block: RunningConditionApplyBlock): string =>
        block.kind === 'no-train' ? NO_TRAIN_PERIOD_REASON_CUSTOM
            : block.kind === 'no-rows' ? noTrainRowsReason('custom', !draftOf(m).customAllData)
            : block.reason;

    const clusteringSameXY = (m: FailureModel, d: ModelDraft): boolean =>
        m.kind === 'clustering' && !!d.y.trim() && d.y.trim() === (m.xSensor ?? '').trim();
    /** Why Save is disabled, or null; data=true only where saving or training is the action. */
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
        if (clusteringSameXY(m, d)) return X_EQUALS_Y_REASON;
        // A Custom model's own periods save with Save changes; whatever blocks the workspace Apply blocks this too.
        const own = customSaveBlockOf(m, data);
        if (own) return customSaveReason(m, own);
        return nameConflictOf(m) ? WORKSPACE_DUPLICATE_NAME_REASON : null;
    };

    /** Notice words when the Custom model's own lists block Save (workspace footer wording); null otherwise or with no draft. */
    const customSaveBlockText = (m: FailureModel, reason: string | null): string | null => {
        if (reason === null || !(m.id in drafts)) return null;
        const own = customSaveBlockOf(m, true);
        return own && reason === customSaveReason(m, own) ? own.footer : null;
    };

    /** Read gate: Save's plain rules, then the gate, no data guards. Decides charts, Health score page, preview, Mark complete. */
    const buildBlockReason = (m: FailureModel): string | null => orderedBlockReason(modelBlockReason(m), gateBlockOf(m));
    /** The action gate: why Train cannot run (read gate plus data guards); asked only where Train is offered or started. */
    const trainBlockReason = (m: FailureModel): string | null => orderedBlockReason(modelBlockReason(m, true), trainGateBlockOf(m));

    /** What is missing in this model's own settings (not the running condition); drives the auto-expand and the "N to fix" pill. */
    const missingItems = (m: FailureModel): string[] => {
        const d = draftOf(m);
        const items: string[] = [];
        if (categoryOf(m) === null) items.push('Pick a category');
        if (!d.name.trim()) items.push('Model name is required');
        if (m.kind === 'relationship' && d.predictors.length === 0) items.push('Add at least 1 predictor');
        if (m.kind === 'clustering') {
            if (!d.y) items.push('Pick a Y sensor');
            if (clusteringSameXY(m, d)) items.push(X_EQUALS_Y_REASON);
            if (d.criteria && !d.ranges.every(r => r.min !== null && r.max !== null)) items.push('Fill in the cluster ranges');
            if (!d.criteria && d.numClusters > 1) items.push(CLUSTERS_NEED_CRITERIA);
        }
        if (d.runningConditionMode === 'custom') {
            // A new/changed scoring period outside the data counts; one as saved is not "to fix".
            const badTest = testPeriodsError(d.customTestPeriods, datasetBounds, savedCustomListsOf(m).tests);
            if (badTest) items.push(badTest);
        }
        if (nameConflictOf(m)) items.push('Fix the duplicate model name');
        return items;
    };

    /** Collapsed "Model settings" one-line summary: name · predictors/Y ·
     *  stiffness/clusters · data scope. */
    const settingsSummaryParts = (m: FailureModel, d: ModelDraft): SettingsSummaryParts => {
        const parts: string[] = [];
        if (m.kind === 'relationship') parts.push(d.predictors.length ? `${d.predictors.length} predictor${d.predictors.length === 1 ? '' : 's'}` : 'no predictors');
        if (m.kind === 'relationship') parts.push(stiffnessLabel(d.stiffness));
        else if (m.kind === 'clustering') parts.push(`${d.numClusters} clusters`);
        else parts.push('1σ + 3σ');
        // Custom has its own conditions/periods, so the summary shows what is configured.
        if (d.runningConditionMode === 'custom') {
            parts.push(customSummaryText({
                allData: d.customAllData,
                // Only a complete "sensor > value" line counts (a half-filled one is not set).
                conditions: d.customFilters.filter(f => f.operation === 'greater_than' && isCompleteCondition(f, gateHeaders)).length,
                trainPeriods: d.customPeriods.length,
                scoringPeriods: d.customTestPeriods.length,
            }));
        } else {
            parts.push('Workspace data');
        }
        return { name: d.name.trim() || 'Untitled', y: m.kind === 'clustering' ? d.y : null, fixed: parts };
    };
    const settingsSummaryLine = (m: FailureModel, d: ModelDraft): string => {
        const { name, y, fixed } = settingsSummaryParts(m, d);
        return [name, ...(y === null ? [] : [`Y: ${y ? sensorLabel(y) : '—'}`]), ...fixed].join(' · ');
    };

    /** Fields a draft writes on Save; trainForQueue merges the same fields without waiting for a write. */
    const draftFields = (m: FailureModel, d: ModelDraft): Partial<FailureModel> => {
        const base: Partial<FailureModel> = {
            name: d.name.trim(),
            runningConditionMode: d.runningConditionMode,
            customRunningConditionFilters: d.customFilters,
            customRunningConditionCombine: d.customCombine,
            // Written only once it means something, so saving an untouched model
            // does not add the key (its bytes stay the same).
            ...(d.customAllData || m.customRunningConditionAllData !== undefined ? { customRunningConditionAllData: d.customAllData } : {}),
            filterTimePeriods: d.customPeriods,
            // Written as id / start / end only.
            customTestPeriods: toScoringPeriods(d.customTestPeriods),
        };
        if (m.kind === 'individual') return base;
        if (m.kind === 'relationship') return { ...base, predictorSensors: d.predictors, relStiffness: d.stiffness };
        return { ...base, ySensor: d.y, criteriaSensor: d.criteria, clusterRanges: d.criteria ? d.ranges : [], numClusters: d.numClusters };
    };

    const commitModel = async (m: FailureModel): Promise<boolean> => {
        // Saving is an action: the draft's data guards apply.
        if (modelBlockReason(m, true) !== null) return false;
        const d = draftOf(m);
        const fields = draftFields(m, d);
        // Tracked whole, so a close waiting for it sees the draft already gone.
        const run = (async () => {
            const ok = await persist((models, groups) => ({
                groups,
                models: models.map(x => x.id === m.id ? { ...x, ...fields } : x),
            }));
            if (!ok) return false;
            // Edited while the write was running: that newer draft stays.
            const without = (all: Record<string, ModelDraft>) => {
                if (all[m.id] !== d) return all;
                const rest = { ...all };
                delete rest[m.id];
                return rest;
            };
            draftsRef.current = without(draftsRef.current);
            setDrafts(without);
            return true;
        })();
        void trackPending(run.then(() => undefined));
        return run;
    };

    /** Workspace/Custom switch: stages draft fields until Save changes; the seed check reads the current draft. */
    const switchRunningConditionMode = (m: FailureModel, mode: 'workspace' | 'custom') => {
        if (mode === 'workspace') {
            patchDraft(m, { runningConditionMode: 'workspace' });
            setSeedNoteFor(prev => (m.id in prev ? { ...prev, [m.id]: null } : prev));
            return;
        }
        const d = draftOf(m);
        // Each own list (conditions, train periods, scoring periods) is copied from the workspace once, only while empty.
        const { patch: seed, copied } = seedCustomFromWorkspace(
            { customFilters: d.customFilters, customPeriods: d.customPeriods, customTestPeriods: d.customTestPeriods },
            { filters: runningConditionFilters, combine: runningConditionCombine, allData: runningConditionAllData, periods: runningConditionTimePeriods, testPeriods: runningConditionTestPeriods },
        );
        patchDraft(m, { runningConditionMode: 'custom', ...seed });
        if (copied.conditions > 0 || copied.periods > 0 || copied.tests > 0) {
            setSeedNoteFor(prev => ({ ...prev, [m.id]: copied }));
        }
    };

    /** Writes immediately: a chart view choice, not a model parameter, so it skips the draft/Save flow. */
    const changeScatterX = (modelId: string, xSensor: string) => {
        void persist((models, groups) => ({
            groups,
            models: models.map(x => x.id === modelId ? { ...x, scatterXSensor: xSensor } : x),
        }));
    };

    /** Writes every model of the sensor in every failure group; saves instantly. */
    const changeCategory = async (key: string, cat: ModelCategory) => {
        if (sensorCategory(allModels, key) === cat) return;
        const groupNos = [...new Set(allModels.filter(m => modelSensorKey(m) === key).flatMap(m => m.groupNos))].sort((a, b) => a - b);
        if (!(await persist((models, groups) => ({ groups, models: setSensorCategory(models, key, cat) })))) return;
        setCategoryWarn(groupNos.length > 1
            ? { key, text: `Category applies to this sensor in every failure group: ${groupNos.map(n => n === 0 ? 'Not in Group' : `FG-${n}`).join(', ')}.` }
            : null);
    };

    const dismissCategoryNotice = (): Promise<boolean> => {
        if (!workspaceId) return Promise.resolve(false);
        return savedOk((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => withFailureGroupState(prev, { categoryNormalisationNotice: null }));
            if (workspaceIdRef.current !== workspaceId) return;
            if (next?.failureGroupState) {
                applyWritten(next);
                await broadcastFailureGroups({ ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    };

    /** Model that Train/staleness checks judge now: persisted merged with the pending draft, as trainForQueue commits. A fingerprinted draft change makes results stale at once; trainedFingerprint is written only by trainForQueue/executeTrain. */
    const effectiveModelFor = (m: FailureModel): FailureModel =>
        m.id in drafts ? { ...m, ...draftFields(m, draftOf(m)) } : m;

    /** Trained: a run exists, its fingerprint matches current inputs, and the model is not Complete (utils/trainFingerprint.ts). */
    const isModelTrainedFresh = (m: FailureModel): boolean =>
        !m.status && trainedFreshFor(effectiveModelFor(m), gateFg, specialRecipes);
    /** Trained earlier, but its inputs (or effective running condition) changed since. */
    // Not gated on status: a Complete model with changed inputs is stale too (read side, for old data and pending drafts).
    const isModelStale = (m: FailureModel): boolean => isModelStaleFor(effectiveModelFor(m), gateFg, specialRecipes);
    /** Complete AND still up to date — what every "Complete" display reads
     *  (never `m.status` alone). */
    const isModelDone = (m: FailureModel): boolean => m.status && !isModelStale(m);

    // Complete is set only through runMarkComplete; going back to Incomplete just writes status:false.
    const markModelIncomplete = (modelId: string) => {
        void persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: false } : m),
        }));
    };

    /** A Custom-mode model whose OWN running condition is what blocks it: the fix is inside Model settings. */
    const customFixInside = (m: FailureModel): boolean =>
        draftOf(m).runningConditionMode === 'custom' && categoryOf(m) !== null && countFreeGateReasonOf(m) !== null;
    /** Settings open on screen: auto when the fix is inside; the user's override wins; queued/training shows the locked header. */
    const isSettingsOpen = (m: FailureModel): boolean =>
        !queue.isLocked(m.id) && (settingsOpenOverride[m.id] ?? (missingItems(m).length > 0 || customFixInside(m)));
    /** Everything wrong with this model's settings plus the gate reason (not the category one, missingItems has it). Feeds the "N items to fix" list, each with a take-me-there action. */
    const incompleteItems = (m: FailureModel): { text: string; onClick: () => void }[] => {
        const items = missingItems(m).map(text => ({
            text,
            onClick: () => setSettingsOpenOverride(prev => ({ ...prev, [m.id]: true })),
        }));
        // The gate — and, for a model that still has to train, "nothing to train on".
        const gr = gateReasonOf(m) ?? shownGuardBlockOf(m)?.reason ?? null;
        // Category reason is skipped (missingItems has it). Custom: the condition editor is in Model settings, so the link goes there.
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
    /** Model with results whose training scope has no row in the loaded data, else null. Display only, nothing written. Not while loading, after another failed run, or while the gate blocks; from trainGuardBlockOf, else noRowsLoads. */
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
    /** Runs one model's preview on the exact inputs in merged. persistMeta=true (explicit Train) saves lastTrainedAt/trainedFingerprint. persistMeta=false is a silent, session-only recompute. Returns an outcome for the train queue and sets trainError. */
    const executeTrain = async (merged: FailureModel, fingerprint: string, opts: { persistMeta: boolean }): Promise<TrainOutcome> => {
        const id = merged.id;
        // Re-pointing mid-Train: write nothing back if the workspace changed (applyFg would replace the current state).
        const capturedWorkspaceId = workspaceIdRef.current;
        setTrainStatus(prev => ({ ...prev, [id]: 'loading' }));
        setTrainError(prev => {
            if (!(id in prev)) return prev;
            const rest = { ...prev };
            delete rest[id];
            return rest;
        });
        try {
            // Train commands carry no generation: a replaced dataset would be trained on silently.
            // Check before and after (get_session_generation; unavailable = no check).
            if (await datasetChangedSinceOpen()) throw new Error(DATASET_CHANGED_MESSAGE);
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true };
            const eff = effectiveRunningCondition(merged, gateFg);
            const filter = buildPreviewFilterPayload(eff, gateHeaders);
            let result: TrainResult;
            if (merged.kind === 'individual') {
                const stats = await invoke<SensorStats>('compute_sensor_stats', { sensor: merged.targetSensor, filter });
                result = { kind: 'individual', stats };
            } else if (merged.kind === 'relationship') {
                // Rust keeps the full fit under this key and ignores filter for it,
                // so the key must change with scope/predictors/target/stiffness (the fingerprint does).
                const cacheKey = `${merged.id}::${fingerprint}`;
                const trainTestPeriods = testPeriodsWireFor(merged, gateFg);
                const r = await invoke<RelationshipPreviewResult>('preview_relationship_model', {
                    predictors: merged.predictorSensors,
                    target: merged.targetSensor,
                    lambda: merged.relStiffness,
                    filter,
                    cache_key: cacheKey,
                    max_points: HEALTH_DEFAULT_MAX_POINTS,
                    // Active scoring periods (start/end only) ride along so one sidecar run also predicts their rows (no second ~15 s run).
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
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true };
            if (await datasetChangedSinceOpen()) throw new Error(DATASET_CHANGED_MESSAGE);
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true };
            setTrainResults(prev => ({ ...prev, [id]: { fingerprint, result } }));
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            forgetNoRowsLoad(id);
            // The fit is now in Rust's cache: refetch the health preview even if the request is identical (open model only).
            if (activeModelIdRef.current === id) setHealthRevision(r => r + 1);
            // Rust holds the fit again, so no longer "fit gone"; a later NOT_FITTED answer marks it again.
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
                const metaSaved = await persist((models, groups) => ({
                    groups,
                    // status:false: a (re-)train lands in Incomplete/Trained, never straight in Complete. A new fit drops the old healthVerdict.
                    models: models.map(x => {
                        if (x.id !== id) return x;
                        const { healthVerdict: dropped, ...rest } = x;
                        void dropped;
                        return { ...rest, status: false, lastTrainedAt: new Date().toISOString(), trainedFingerprint: fingerprint };
                    }),
                }));
                if (!metaSaved) throw new Error(SAVE_FAILED_NOTICE);
            }
            return { ok: true };
        } catch (e) {
            if (workspaceIdRef.current !== capturedWorkspaceId) return { ok: false, abandoned: true };
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            const raw = e instanceof Error ? e.message : String(e);
            // Stopped by a close that gave up: nothing is wrong with this model.
            if (raw === ENGINE_STOPPED_MESSAGE) return { ok: false, skip: ENGINE_STOPPED_ROW_NOTE };
            // The bundled Relation model engine is too old: show the app's own wording.
            const parsed = parseHealthError(e);
            // The engine found nothing to train on (uncounted scope or no value in the train periods): show the named reason, not raw text.
            const noRows = parsed.code === 'SIDECAR_OUTDATED' ? null : noRowsTrainError(raw, merged.runningConditionMode === 'custom');
            const message = parsed.code === 'STALE_SESSION'
                ? TRAIN_STALE_MESSAGE
                : parsed.code === 'SIDECAR_OUTDATED' ? parsed.message : noRows ?? raw;
            if (noRows !== null && !opts.persistMeta) {
                // A silent load with no rows is not a failed train: remember it for this scope and dataset for the "No data" board (noDataOf).
                setNoRowsLoads(prev => ({ ...prev, [id]: noRowsLoadKey(fingerprint) }));
                return { ok: false, error: message };
            }
            forgetNoRowsLoad(id);
            setTrainError(prev => ({ ...prev, [id]: message }));
            // Either "this data is not ours any more" signal stops a run.
            const stale = message === DATASET_CHANGED_MESSAGE || parsed.code === 'STALE_SESSION' || isStaleTrainError(message);
            return stale ? { ok: false, error: message, stale: true } : { ok: false, error: message };
        }
    };

    /** Forget a model's Mark complete outcome (its refusal banner was dismissed, or the user moved on with a new action). */
    const dismissSaveInfo = (modelId: string) => setSaveInfo(prev => {
        if (!(modelId in prev) || prev[modelId].phase === 'running') return prev;
        const rest = { ...prev };
        delete rest[modelId];
        return rest;
    });
    /** The one per-model train, called by the queue one model at a time (one Rust session, one sidecar). Looks the model up fresh (deleted or changed: skipped); commits a pending draft first, else trains the persisted model. */
    const trainForQueue = async (id: string): Promise<TrainOutcome> => {
        // Captured BEFORE any await: a re-point while waiting abandons this model.
        const ws = workspaceIdRef.current;
        // A silent load or Compare may still be running: wait, never two engine calls at once.
        await onEngine(async () => undefined);
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
        if (hasDraft && !(await commitModel(m))) return { ok: false, skip: SAVE_FAILED_NOTICE };
        if (workspaceIdRef.current !== ws) return { ok: false, abandoned: true };
        return onEngine(() => executeTrain(merged, computeTrainFingerprint(merged, gateFg), { persistMeta: true }));
    };
    queueTrainRef.current = trainForQueue;

    /** Plan for a run now (classifyTrainPlan); a failed run this session = ready again. */
    const candidateOf = (m: FailureModel): TrainCandidate => ({
        id: m.id,
        kind: m.kind,
        // Mark complete is running for this model (a Relation model re-runs the sidecar): skipped.
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
        // Blocked by settings or condition: disable the link with the reason. Read gate, since loading is not a train.
        return awayFromFormText(m, buildBlockReason(m));
    };
    /** Silent re-fit like the window's automatic one (persistMeta:false), asked by the user once that try is used up. Writes nothing; a Complete model stays Complete. A failed load returns to the board with trainError. */
    const reloadFit = (id: string) => {
        const m = allModels.find(x => x.id === id);
        if (!m || fitReloadBlock(m) !== null) return;
        if (trainStatus[id] === 'loading' || fitReloadingRef.current.has(id)) return;
        // Only a model that is trained and still current has a fit to load again.
        const fp = computeTrainFingerprint(m, gateFg);
        if (!m.lastTrainedAt || m.trainedFingerprint !== fp) return;
        const ws = workspaceIdRef.current;
        fitReloadingRef.current.add(id);
        // A training run started meanwhile waits for it (`trainForQueue`).
        void onEngine(async (): Promise<TrainOutcome> => {
            try {
                if (workspaceIdRef.current !== ws || queueRef.current.isRunningNow()) return { ok: false, abandoned: true };
                const out = await executeTrain(m, fp, { persistMeta: false });
                // Loaded: should this fit be lost again later, it is re-fitted automatically once more.
                if (out.ok) for (const k of [...refitTriedRef.current]) if (k.startsWith(`${id}::`)) refitTriedRef.current.delete(k);
                // Mark complete refused only for a gone fit: its red card and "Not saved" clear on "Load it again"; other refusals stay.
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
        });
    };


    /** Persisted set points brought up to date: the empty shape for the kind and, for Individual, the master L/H snapshot. Derived so the first render shows it; never overwrites user values; no snapshot while loading. */
    const persistedSetPointsOf = (m: FailureModel): HealthSetPoints =>
        ensureHealthSetPoints(m, loading ? undefined : (sensorMetadata ?? [])).healthSetPoints as HealthSetPoints;
    /** What the Health score page shows and previews: the draft being typed, else the persisted ones. */
    const setPointsOf = (m: FailureModel): HealthSetPoints => spDrafts[m.id] ?? persistedSetPointsOf(m);

    /** Every set-point edit: updates the draft at once; commit also persists (discrete actions). A saved change makes a Complete model Incomplete (central rule) but never stale. */
    const changeSetPoints = (m: FailureModel, next: HealthSetPoints, commit?: boolean) => {
        writeSpDrafts({ ...spDraftsRef.current, [m.id]: next });
        // Clear the refusal and the "not saved" outcome: they described the previous values and would hide the real block reason.
        setAttemptIssues(prev => (prev[m.id] ? { ...prev, [m.id]: null } : prev));
        dismissSaveInfo(m.id);
        if (commit) void commitSetPointDrafts();
    };

    /** The only way a model becomes Complete: checkModelForComplete (validates set points, writes no files), then persistModelComplete (status:true + set points in one write, gate and freshness re-checked on disk). Returns null or the reason; never throws. */
    const runMarkComplete = async (m: FailureModel): Promise<string | null> => {
        const fg: RunningConditionFg = gateFg;
        const model = effectiveModelFor(m);
        const ws = workspaceIdRef.current;
        if (!ws) return 'No workspace is open.';
        if (completeRunningRef.current.has(m.id)) return 'Mark complete is already being checked.';
        const id = m.id;
        // The run can outlive this workspace: the save always goes to ws; window state is touched only while it still describes ws.
        const stillHere = (): boolean => workspaceIdRef.current === ws;
        const fail = (message: string, issues: HealthIssue[] | null = null): string => {
            if (!stillHere()) return message; // re-pointed: nothing on screen is about this model any more
            setSaveInfo(prev => ({ ...prev, [id]: { phase: 'error', message } }));
            if (issues) setAttemptIssues(prev => ({ ...prev, [id]: issues }));
            return message;
        };
        // A category on the sensor, and a name no other model of the project uses.
        const projectBlock = markCompleteProjectBlock(allModels, model, categoryOf(m), plainSensorLabel);
        if (projectBlock !== null) return fail(projectBlock);
        // Write nothing for a model not allowed to be Complete: gate and trained-and-fresh (re-checked on disk by persistModelComplete).
        // Data guards do not block Mark complete.
        const notAllowed = getBuildBlockReason(model, fg, gateHeaders)
            // At least one valid scoring period.
            ?? markCompleteBlockReason(model, fg)
            ?? (trainedFreshFor(model, fg, specialRecipes) ? null : (isModelStaleFor(model, fg, specialRecipes) ? 'Settings changed — re-train first.' : NOT_TRAINED_BLOCK_REASON));
        if (notAllowed !== null) return fail(notAllowed);
        if (queueRef.current.isRunningNow()) return fail(TRAIN_RUN_ACTIVE_REASON);
        // Unsaved Model-settings edits are saved first, like Train: the save re-checks scoring periods and fingerprint against disk,
        // so an unsaved draft would be refused on every retry. An invalid draft stops here.
        const hasDraft = m.id in drafts;
        if (hasDraft) {
            const draftBlock = modelBlockReason(m, true);
            if (draftBlock !== null) return fail(awayFromFormText(m, draftBlock) ?? draftBlock);
        }
        completeRunningRef.current.add(m.id);
        setSaveInfo(prev => ({ ...prev, [id]: { phase: 'running' } }));
        setAttemptIssues(prev => ({ ...prev, [id]: null }));
        // Click-time fingerprint, scoring periods and set points: the save is refused if the model on disk no longer matches.
        const race = {
            fingerprint: computeTrainFingerprint(model, fg),
            setPointsBefore: m.healthSetPoints,
            testsKey: testPeriodsKey(effectiveRunningCondition(model, fg).testPeriods),
        };
        const exec = async (): Promise<string | null> => {
            try {
                if (hasDraft && !(await commitModel(m))) return fail(SAVE_FAILED_NOTICE);
                const sp = setPointsOf(m);
                const res = await checkModelForComplete({
                    model,
                    fg,
                    headers: gateHeaders,
                    setPoints: sp,
                    expectedGeneration: generation,
                });
                // The save below always goes into `ws` (the id captured at click time),
                // never into whatever this window points at now.
                if (!res.ok) {
                    if (res.reason === 'validation') return fail('Some set points are not valid — fix them in Checks first.', res.issues);
                    if (res.code === 'NOT_FITTED') {
                        // The page still shows a valid preview, so Mark complete would fail the same on every click:
                        // mark the fit gone and ask the preview again (NOT_FITTED, then one silent reload or "Load it again").
                        if (stillHere()) {
                            setNotFittedIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
                            setHealthRevision(r => r + 1);
                        }
                        return fail(FIT_GONE_SAVE_MESSAGE);
                    }
                    if (res.code === 'STALE_SESSION') return fail('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
                    return fail(res.error ?? 'The model could not be marked complete.');
                }
                const persisted: { reason: string | null } = { reason: null };
                await trackPending((async () => {
                    const r = await persistModelComplete(ws, id, res.setPoints, gateHeaders, 'build-model', race);
                    persisted.reason = r.reason;
                    if (stillHere()) applyWritten(r.next);
                })());
                if (persisted.reason !== null) return fail(`The model was not marked complete: ${persisted.reason}`);
                // Re-pointed meanwhile: the old workspace's Complete is on disk and broadcast; leave this window's state alone.
                if (!stillHere()) return null;
                // What was typed is now what is on disk.
                if (spDraftsRef.current[id] !== undefined && sameSetPoints(spDraftsRef.current[id], res.setPoints)) {
                    const rest = { ...spDraftsRef.current };
                    delete rest[id];
                    writeSpDrafts(rest);
                }
                setSaveInfo(prev => { const rest = { ...prev }; delete rest[id]; return rest; });
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

    /** A close was refused here: a main window waiting on this one stays open. */
    const tellCloseKept = useCallback(() => {
        const id = workspaceIdRef.current;
        if (!id) return;
        Promise.resolve(emit('build-model-close-kept', { workspaceId: id })).catch(() => { /* best effort */ });
    }, []);
    /** Tells a waiting main window this webview is alive. */
    const tellCloseSeen = useCallback(() => {
        const id = workspaceIdRef.current;
        if (!id) return;
        Promise.resolve(emit('build-model-close-ack', { workspaceId: id })).catch(() => { /* best effort */ });
    }, []);
    /** Leaving with an engine call active: nobody would read its answer, and it would hold the next run's turn. */
    const stopEngineIfBusy = useCallback(async () => {
        const running = queueRef.current.isRunningNow();
        if (!running && engineCallsRef.current === 0 && markRunsRef.current.size === 0) return;
        if (running) queueRef.current.stopAfterCurrent('close');
        await stopRunningEngine();
    }, []);
    /** Window.close() re-enters onCloseRequested; leavingRef lets it pass so nothing asks or waits twice. */
    const leaveWindow = useCallback(async () => {
        await stopEngineIfBusy();
        leavingRef.current = true;
        try {
            await fadeOutWindow();
            await getCurrentWindow().close();
        } catch {
            undoFadeOutWindow();
            leavingRef.current = false;
            tellCloseKept();
        }
    }, [stopEngineIfBusy, tellCloseKept]);
    /** Model settings or Running condition edits that closing would drop (none when the workspace is closing from the Dashboard). */
    const unsavedEditsAtClose = useCallback((): boolean => {
        if (closeBypassRef.current) return false;
        const rc = rcDraftRef.current;
        return Object.keys(draftsRef.current).length > 0 || (!!rc && !rcDraftEqual(rc, rcPersistedRef.current));
    }, []);
    /** The close: flushFocusedInput first (a half-typed period date settles only on blur), wait for a running export, flush pending writes (a running Mark complete is waited on, capped), then leave. */
    const closeNow = async () => {
        closeAfterRunRef.current = false;
        flushFocusedInput();
        await waitForExportBeforeClose();
        // `false` = a running save did not finish in time: the window stays open (notice shown).
        if (!(await flushAllPending())) { tellCloseKept(); return; }
        await leaveWindow();
    };
    const closeNowRef = useRef(closeNow);
    closeNowRef.current = closeNow;
    /** A training run is active and nothing allows closing past it: ask first. */
    const mustAskBeforeClose = useCallback((): boolean => queueRef.current.isRunningNow() && !closeBypassRef.current && !runWaitGaveUpRef.current, []);
    /** Past the run dialog: ask about unsaved edits, or close. */
    const closeOrAskUnsaved = async () => {
        flushSync(flushFocusedInput);
        // A Save in flight decides whether its edit is still unsaved.
        if (pendingSaveRef.current) await pendingSaveRef.current;
        if (unsavedEditsAtClose()) { setUnsavedAsk(true); return; }
        await closeNow();
    };
    const closeOrAskUnsavedRef = useRef(closeOrAskUnsaved);
    closeOrAskUnsavedRef.current = closeOrAskUnsaved;
    const handleClose = async () => {
        // In-window dialog, "Keep training" is the default.
        if (mustAskBeforeClose()) { setCloseAsk(true); return; }
        await closeOrAskUnsaved();
    };
    /** "Stop after this model and close": the run ends after the model in training, then the usual close. Past the cap the model keeps training with a notice; only the next close stops the engine. */
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
                runWaitGaveUpRef.current = true;
                closeAfterRunRef.current = true;
                void idle.then(() => {
                    // Only for this run: the next Train asks before closing again.
                    runWaitGaveUpRef.current = false;
                    if (!closeAfterRunRef.current) return;
                    setCloseNotice(null);
                    void closeOrAskUnsavedRef.current();
                });
                setCloseNotice(RUN_CLOSE_WAIT_NOTICE);
                tellCloseKept();
                return;
            }
            await closeOrAskUnsaved();
        } finally {
            stopClosingRef.current = false;
        }
    };

    // A native close (X, Alt+F4, OS) bypasses handleClose: intercept it for a running Train, a write in flight or unsaved edits.
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const win = getCurrentWindow();
        Promise.resolve(win.onCloseRequested(async (event) => {
            tellCloseSeen();
            if (leavingRef.current) return;
            // "Stop after this model and close" is waiting: it decides, no second question.
            if (stopClosingRef.current && !closeBypassRef.current) {
                event.preventDefault();
                return;
            }
            // A training run is active: keep the window and ask, unless the workspace is closing or an earlier "stop and close" gave up.
            if (mustAskBeforeClose()) {
                event.preventDefault();
                setCloseAsk(true);
                return;
            }
            flushSync(flushFocusedInput);
            // A Save in flight decides whether its edit is still unsaved.
            const saving = pendingSaveRef.current;
            if (saving) {
                event.preventDefault();
                await saving;
            }
            if (unsavedEditsAtClose()) {
                event.preventDefault();
                setUnsavedAsk(true);
                return;
            }
            closeAfterRunRef.current = false;
            // A set-point draft typed but never blurred is a pending write too.
            if (!leaveUnsavedRef.current) void commitSetPointDrafts();
            const pending = pendingSaveRef.current;
            // A running Mark complete counts as pending too, and so does a running Export results.
            if (!saving && !pending && markRunsRef.current.size === 0 && !exportRunRef.current) {
                // Nothing pending: held only for the fade-out (none under reduced motion), then leaveWindow closes it.
                if (exitMs() > 0) { event.preventDefault(); await leaveWindow(); return; }
                await stopEngineIfBusy();
                return;
            }
            event.preventDefault();
            await waitForExportBeforeClose();
            if (!(await flushAllPending())) { tellCloseKept(); return; }
            await leaveWindow();
        })).then(fn => { if (disposed) fn(); else unlisten = fn; });
        return () => { disposed = true; if (unlisten) unlisten(); };
    }, [flushAllPending, commitSetPointDrafts, waitForExportBeforeClose, leaveWindow, mustAskBeforeClose, unsavedEditsAtClose, stopEngineIfBusy, tellCloseKept, tellCloseSeen]);

    // The Dashboard is closing this window (Back to Import / another project): drop the run and close without asking.
    // Scoped to this workspace and dataset so a late copy cannot close a re-pointed window.
    const generationRef = useRef<number | undefined>(undefined);
    generationRef.current = generation;
    useEffect(() => {
        const off = subscribe<{ workspaceId?: string; generation?: number }>('workspace-closing', (event) => {
            if (!workspaceIdRef.current || event.payload?.workspaceId !== workspaceIdRef.current) return;
            const g = event.payload?.generation;
            if (typeof g === 'number' && generationRef.current !== undefined && g !== generationRef.current) return;
            const wasHeld = queueRef.current.isRunningNow() || closeAskRef.current || unsavedAskRef.current;
            closeBypassRef.current = true;
            closeAfterRunRef.current = false;
            queueReset();
            setCloseAsk(false);
            setUnsavedAsk(false);
            // A close that already arrived was held by the dialog: close now.
            if (wasHeld) void closeNowRef.current();
        });
        return () => off();
    }, [queueReset]);

    // Computed above the loading guard: every hook must run on every render, so none can sit after an early return.
    const sensorGroupsAll = allSensorGroups(allModels);
    const fullSensorMap = new Map(sensorGroupsAll.map(sg => [sg.key, sg]));
    const detailModels = selectedSensorKey !== null ? (fullSensorMap.get(selectedSensorKey)?.models ?? []) : [];
    const orderedDetail = KIND_ORDER.flatMap(k => detailModels.filter(m => m.kind === k));
    const activeModel = orderedDetail.find(m => m.id === activeTab[selectedSensorKey ?? '']) ?? orderedDetail[0];
    /** The model on screen, for code that finishes after an await (`executeTrain`). */
    const activeModelIdRef = useRef<string | null>(null);
    activeModelIdRef.current = activeModel?.id ?? null;

    // Auto-recompute on reopen: a Trained-and-fresh or Complete model silently re-runs the preview if none is cached for its fingerprint.
    // persistMeta:false, never touches status, not during a run; skips a model known to have no rows (noDataOf).

    // One useHealthPreview call feeds both pages, with the draft-merged model (as Train does):
    // an unsaved training-input edit idles it while old data stays under the "Out of date" overlay.
    const activeEffective = activeModel ? effectiveModelFor(activeModel) : null;

    /** Health score page only for a trained, up-to-date model (it reads the fit); otherwise the stored choice is ignored, not erased. */
    const pageOf = (m: FailureModel): WorkbenchPage => {
        const want = pageByModel[m.id] ?? 'model';
        return want === 'health' && (isModelStale(m) || !m.lastTrainedAt) ? 'model' : want;
    };

    // activeCustomDraft keeps one identity per draft/saved model, so the hook's inputs do not change on unrelated renders.
    const activeDraftEntry = activeModel ? drafts[activeModel.id] : undefined;
    const activeCustomDraft = useMemo(
        () => (activeModel ? (activeDraftEntry ?? draftFromModel(activeModel)) : null),
        [activeModel, activeDraftEntry],
    );
    const activeIsCustom = !!activeModel && activeCustomDraft?.runningConditionMode === 'custom';
    // Model settings (and a Custom panel) are drawn on the Model fit page only; Health score must not count or re-read for them.
    const activeOnFitPage = !!activeModel && pageOf(activeModel) === 'model';
    const customPanelOpen = activeIsCustom && activeOnFitPage && isSettingsOpen(activeModel);
    // With the panel closed, the train running time still feeds the "below the recommended train time" note and the zero-rows guard:
    // asked only while the model could train, train periods only, one call.
    const activeCustomCanTrain = !!activeEffective && activeEffective.runningConditionMode === 'custom'
        && getBuildBlockReason(activeEffective, gateFg, gateHeaders, { bounds: datasetBounds }) === null;
    const customCountsWanted = activeIsCustom && activeOnFitPage && (customPanelOpen || activeCustomCanTrain);
    const customCountFilter = useMemo(
        () => (activeCustomDraft && activeCustomDraft.runningConditionMode === 'custom'
            ? buildPreviewFilterPayload(
                { filters: activeCustomDraft.customFilters, combine: activeCustomDraft.customCombine, allData: activeCustomDraft.customAllData, periods: activeCustomDraft.customPeriods },
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
    // Zero-rows guard of the active Custom model: condition configured, count settled, no row left.
    // Remembered as the counted scope so a sibling Custom model on the same scope reads the same answer.
    customNoRowsKey = activeModel && activeEffective && activeCustomDraft && activeIsCustom
        && isRunningConditionConfigured(activeEffective, gateFg, gateHeaders)
        && countedNoTrainRows(customCounts)
        ? customCountKeyOf(activeCustomDraft) : null;

    /** Results but no row in the loaded data (noDataOf): no engine call, nothing written; both pages show the "No data" board. */
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
        // No row in the training scope (no train period inside the data, zero count, or the engine already said so): a load would only fail.
        // The board says why. An unsettled count is attempted; the engine's "no rows" leads to the same board.
        if (activeGuardHolds || noRowsLoads[activeModel.id] === noRowsLoadKey(fp)) return;
        // A training run owns the sidecar; the effect re-runs when the run ends (queue.isRunning is a dependency).
        if (queue.isRunning) return;
        // Another engine call may be running: this one takes its turn, shown as loading until then.
        const model = activeModel;
        const ws = workspaceIdRef.current;
        setTrainStatus(prev => ({ ...prev, [model.id]: 'loading' }));
        void onEngine(async () => {
            if (workspaceIdRef.current !== ws) return;
            // Moved on while waiting: opening the model again (or the run's end) asks again.
            if (activeModelIdRef.current !== model.id || queueRef.current.isRunningNow()) {
                setTrainStatus(prev => {
                    const rest = { ...prev };
                    delete rest[model.id];
                    return rest;
                });
                return;
            }
            await executeTrain(model, fp, { persistMeta: false });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, activeModel?.trainedFingerprint, activeModel?.lastTrainedAt, activeModel?.status, activeModel?.category, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionAllData, queue.isRunning, activeModel ? trainResults[activeModel.id]?.fingerprint : undefined, activeGuardHolds, activeNoData !== null]);

    const activeFingerprint = activeEffective ? computeTrainFingerprint(activeEffective, gateFg) : null;
    const activeStale = activeEffective ? isModelStaleFor(activeEffective, gateFg, specialRecipes) : false;
    const activeTrainEntry = activeModel ? trainResults[activeModel.id] : undefined;
    const activeFitKey = activeEffective
        && activeEffective.kind === 'relationship'
        && activeEffective.scatterXSensor
        && activeEffective.predictorSensors.includes(activeEffective.scatterXSensor)
        ? activeEffective.scatterXSensor : undefined;
    // Preview only for a trained, current model with nothing blocking it and no failed last run.
    // A Relationship preview also needs its fit in Rust's cache, filled by the run under THIS fingerprint (else NOT_FITTED).
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
        // Draft set points (else persisted) drive charts, score and validation (debounced ~250 ms); not in the train fingerprint.
        setPoints: activeModel ? setPointsOf(activeModel) : null,
        enabled: healthReady,
        xPredictor: activeFitKey,
        expectedGeneration: generation,
        revision: healthRevision,
        inFlightRef: engineCallsRef,
    });
    // NOT_FITTED (fit evicted from Rust's cache, e.g. in a long Train all): forget the session result so the auto-recompute re-fits
    // once per model and fingerprint when no run is active; plan it ready meanwhile.
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
    // Any Relation-model preview may run the sidecar (it predicts the training hours too); the delay skips fast cached previews.
    const scoringTestsNow = !!activeEffective && activeEffective.kind === 'relationship' && healthPreview.loading;
    const slowScoring = useDelayedFlag(scoringTestsNow, SLOW_SCORING_HINT_DELAY_MS);

    // Last validate verdict for the active model; a stale model's data does not count.
    // Drives the step bar live; tab pills and dots read the persisted copy (healthVerdict), written by the effect below.
    const activeVerdict: HealthVerdict | null = activeModel && !activeStale ? healthVerdict(healthPreview.data) : null;
    const verdictToPersist: HealthVerdictValue | null = activeVerdict === 'valid' ? 'valid' : activeVerdict === 'needs' ? 'incomplete' : activeVerdict === 'bad' ? 'invalid' : null;
    const activeHasDraft = !!activeModel && activeModel.id in spDrafts;
    useEffect(() => {
        const ws = workspaceIdRef.current;
        if (!ws || loading || !activeModel || !verdictToPersist || activeModel.healthVerdict === verdictToPersist) return;
        // Persist a verdict only for SAVED set points: settled (not loading/failed), no unsaved draft,
        // and the preview's set points equal disk (an unseeded Individual previews its master prefill).
        if (!healthReady || healthPreview.loading || healthPreview.error || activeHasDraft) return;
        if (!sameSetPoints(activeModel.healthSetPoints, persistedSetPointsOf(activeModel))) return;
        void savedOk((async () => {
            const next = await commitHealthVerdict(ws, activeModel.id, verdictToPersist, 'build-model');
            if (workspaceIdRef.current === ws) applyWritten(next);
        })());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, activeModel?.id, activeModel?.healthVerdict, activeModel?.healthSetPoints, verdictToPersist, healthReady, healthPreview.loading, healthPreview.error, activeHasDraft]);

    // First open of an Individual Health score page: write the master L/H snapshot (and prefill) once so it never follows master data.
    // Only if ensureHealthSetPoints changes something, never over user values or a draft.
    useEffect(() => {
        if (loading || !activeModel || activeModel.kind !== 'individual') return;
        if (pageByModel[activeModel.id] !== 'health' || !activeModel.lastTrainedAt) return;
        // No data in the loaded file: its page is the "No data" board; write nothing.
        if (activeNoData !== null) return;
        if (setPointsSeededRef.current.has(activeModel.id) || spDraftsRef.current[activeModel.id]) return;
        const ensured = ensureHealthSetPoints(activeModel, sensorMetadata ?? []);
        if (ensured === activeModel || !ensured.healthSetPoints) return;
        setPointsSeededRef.current.add(activeModel.id);
        writeSpDrafts({ ...spDraftsRef.current, [activeModel.id]: ensured.healthSetPoints });
        void commitSetPointDrafts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, activeModel, pageByModel, sensorMetadata, activeNoData !== null]);

    // Leaving the page or the model (page switch, another sensor or kind tab): persist what was typed. No draft = nothing happens.
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
        // Workspace and dataset too: another project can hold the same model id and scope.
        resetKey: `${workspaceId ?? ''}|${generation ?? ''}|${activeModel?.id ?? ''}|${subLambda}|${JSON.stringify(subFilter)}`,
        serialize: onEngine,
    });
    const openCompare = () => {
        setCompareOpen(true);
        if (!activeEffective || activeEffective.kind !== 'relationship' || activeEffective.predictorSensors.length === 0) return;
        if ((!subModelFits.subModels || subModelFits.stale) && !subModelFits.loading) void subModelFits.run();
    };

    // Fetches compute_sensor_stats for the criteria sensor so the slider spans its real range; draft-aware via effectiveModelFor.
    // criteriaFilterKey folds everything that changes the filter payload into one string.
    const criteriaSensorForActive = (activeModel && activeModel.kind === 'clustering') ? draftOf(activeModel).criteria : '';
    const criteriaFilterKey = useMemo(() => {
        if (!activeModel || activeModel.kind !== 'clustering' || !criteriaSensorForActive) return '';
        const merged = effectiveModelFor(activeModel);
        const eff = effectiveRunningCondition(merged, gateFg);
        return JSON.stringify(buildPreviewFilterPayload(eff, gateHeaders));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, drafts, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionAllData, gateHeaders]);
    // Stats count only for the model + criteria sensor + filter they were fetched for, so auto-divide never divides B over A's [min, max].
    // The workspace id is in the key: another workspace can share model ids and criteria.
    const criteriaStatsKey = (activeModel && activeModel.kind === 'clustering' && criteriaSensorForActive)
        ? `${workspaceId ?? ''}::${activeModel.id}::${criteriaSensorForActive}::${criteriaFilterKey}`
        : '';
    const criteriaStats: SensorStats | null = (criteriaStatsEntry && criteriaStatsEntry.key === criteriaStatsKey)
        ? criteriaStatsEntry.stats
        : null;
    const criteriaStatsError = criteriaStatsFailure?.key === criteriaStatsKey ? criteriaStatsFailure.message : null;
    useEffect(() => {
        // One shared state: reset before the early return and the new fetch, so a switch never shows the previous model's [min, max].
        setCriteriaStatsEntry(null);
        setCriteriaStatsFailure(null);
        if (!activeModel || activeModel.kind !== 'clustering' || !criteriaSensorForActive) {
            return;
        }
        let cancelled = false;
        const key = criteriaStatsKey;
        const filter = criteriaFilterKey ? JSON.parse(criteriaFilterKey) : null;
        invoke<SensorStats>('compute_sensor_stats', { sensor: criteriaSensorForActive, filter })
            .then(s => { if (!cancelled) setCriteriaStatsEntry({ key, stats: s }); })
            .catch(e => { if (!cancelled) setCriteriaStatsFailure({ key, message: e instanceof Error ? e.message : String(e) }); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, criteriaSensorForActive, criteriaFilterKey, criteriaStatsKey, criteriaStatsTry]);

    // Divides clusterRanges equally over the criteria sensor's real [min, max] when it or the cluster count changes.
    // Keeps ranges.length = numClusters. Anchored on the persisted pair: no phantom draft on open, a saved custom split is never overwritten.
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
        // Empty ranges from a pending division still need the real division even if key and length look settled (model switch and back).
        const pendingInDraft = (drafts[activeModel.id]?.ranges ?? []).some(r => r.min === null || r.max === null);
        // `drafts` is read fresh on each run but is not a dependency: the stats landing is the trigger.
        if (!keyChanged && !lengthMismatch && !pendingInDraft) return;
        if (!criteriaStats) {
            // Division is pending until stats arrive: for 2+ clusters the draft gets empty ranges, so Save and Train are blocked.
            // A persisted placeholder would be the saved key and block the real division. One cluster is never blocked: Rust ignores its cluster_ranges.
            if (numClustersForActive > 1) {
                const current = draftOf(activeModel).ranges;
                if (current.length === numClustersForActive && current.every(r => r.min === null && r.max === null)) return;
                writeDraft(activeModel, { ranges: Array.from({ length: numClustersForActive }, () => ({ min: null, max: null })) });
                return;
            }
            // 1 cluster: only a length mismatch can't wait (no valid range set to show).
            if (!lengthMismatch) return;
        }
        // Only a division over the real [min, max] settles the key; a 0-100 placeholder fix made before stats is re-divided when they land.
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

    // A boundary being typed does not survive a model switch: a valid one was committed by blur, an invalid one is dropped.
    useEffect(() => { setBoundaryEdit(null); }, [activeModel?.id]);

    // The card's and the active Custom model's counts are asked further up; the gate reads them.
    const draftCountFilter = useMemo(
        () => buildPreviewFilterPayload(
            rcDraft ?? { filters: runningConditionFilters, combine: runningConditionCombine, allData: runningConditionAllData, periods: runningConditionTimePeriods },
            gateHeaders,
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [rcDraft, runningConditionFilters, runningConditionCombine, runningConditionAllData, runningConditionTimePeriods, allSensors],
    );
    // The modal's draft (what Apply would commit); the lists are the draft's own stable arrays.
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
    // Modal zero-rows guard: count settled, condition set, no running row, and the draft changed training (periods or condition).
    // A draft that left the saved scope untouched is not blocked by a zero already there; Train is.
    const rcCountView = rcDraft ?? rcPersisted;
    const rcNoRows = rcFilterOpen
        && isWorkspaceRunningConditionConfigured(
            { runningConditionFilters: rcCountView.filters, runningConditionAllData: rcCountView.allData },
            gateHeaders,
        )
        && countedNoTrainRows(rcCounts)
        && trainCountKey(rcCountPeriods, draftCountFilter) !== trainCountKey(runningConditionTimePeriods, persistedCountFilter);
    rcGateRef.current = { draft: rcDraft, bounds: datasetBounds, noTrainRows: rcNoRows };

    // Re-read Dashboard highlights when the settings open or a Custom panel shows (its overlap line reads them); one cheap read.
    useEffect(() => {
        if (rcFilterOpen || customPanelOpen) void refreshHighlights();
    }, [rcFilterOpen, customPanelOpen, refreshHighlights]);

    // Keyboard focus of the modal: the first field on open, Tab kept inside.
    useModalFocus(rcDialogRef, rcFilterOpen && !unsavedAsk, '[data-testid="rc-panel"]');

    // Esc closes the modal through the dirty-draft guard. Capture phase, ignored while a nested sensor picker is open:
    // the picker closes itself on Esc and React may unmount it first, so one Esc would close both.
    useEffect(() => {
        if (!rcFilterOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            if (isPickerSurfaceOpen() || unsavedAskRef.current) return;
            requestCloseRc();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [rcFilterOpen, requestCloseRc]);

    // A run updates the window ~3 times per model; RunStrip and ModelFitPage are memoised, so their props must keep identity:
    // labels come from a memo over allModels, callbacks forward to actionsRef refreshed each render.
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
    // The focused Save changes disappears once saved: move focus to the open page tab, else the notice line, never <body>.
    useEffect(() => {
        const id = saveFocusRef.current;
        if (!id) return;
        saveFocusRef.current = null;
        if (id in drafts) return; // not saved (or edited again): the button is still there
        const active = document.activeElement;
        if (active && active !== document.body) return; // the focus is somewhere real
        (activePageTabRef.current ?? noticeRef.current)?.focus();
    }, [drafts]);

    const exportOrder = sensorGroupsAll.flatMap(sg => KIND_ORDER.flatMap(k => sg.models.filter(m => m.kind === k))).map(m => m.id);
    const workspaceExport = useWorkspaceExport(workspaceId, {
        metadata: sensorMetadata,
        headers: allSensors.length ? allSensors : null,
        recipes: specialRecipes,
        order: exportOrder,
        expectedGeneration: generation,
    });
    const exporting = workspaceExport.phase === 'running';
    exportCancelRef.current = workspaceExport.cancel;
    const [exportOpen, setExportOpen] = useState(false);
    /** "N models exported · Open folder" line: stays until a model's status changes or the window is re-pointed. */
    const [exportedLine, setExportedLine] = useState<ExportedLine | null>(null);
    /** The models' statuses when the last export finished. */
    const exportedSigRef = useRef<string | null>(null);
    const exportStatusSig = allModels.map(m => `${m.id}:${m.status ? 1 : 0}`).join(',');
    const exportStatusSigRef = useRef(exportStatusSig);
    exportStatusSigRef.current = exportStatusSig;
    useEffect(() => {
        setExportedLine(null);
        exportedSigRef.current = null;
        setExportOpen(false);
    }, [workspaceId]);
    const exportResult = workspaceExport.result;
    const exportHidden = workspaceExport.hidden;
    const exportShow = workspaceExport.show;
    useEffect(() => {
        if (workspaceExport.phase !== 'done' || !exportResult) return;
        setExportedLine({ models: exportResult.models, folder: exportResult.folder, at: new Date() });
        exportedSigRef.current = exportStatusSigRef.current;
        // Finished while hidden: the bar says it; the dialog is not reopened.
        if (exportHidden) { setExportOpen(false); exportShow(); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaceExport.phase, exportResult]);
    useEffect(() => {
        if (exportedSigRef.current !== null && exportedSigRef.current !== exportStatusSig) {
            exportedSigRef.current = null;
            setExportedLine(null);
        }
    }, [exportStatusSig]);
    /** `start`, registered so a window close waits for it. */
    const exportStart = workspaceExport.start;
    const startExport = useCallback<UseWorkspaceExport['start']>((destDir, at) => {
        const run = exportStart(destDir, at);
        exportRunRef.current = run;
        void run.finally(() => { if (exportRunRef.current === run) exportRunRef.current = null; });
        return run;
    }, [exportStart]);
    /** Which call the hook's phase answers (dry-run plan or write); a failed plan keeps the dialog's checklist with an inline line. */
    const [exportStep, setExportStep] = useState<'plan' | 'write'>('plan');
    const exportPlanRaw = workspaceExport.plan;
    const planExport = useCallback<UseWorkspaceExport['plan']>(() => {
        setExportStep('plan');
        return exportPlanRaw();
    }, [exportPlanRaw]);
    const writeExport = useCallback<UseWorkspaceExport['start']>((destDir, at) => {
        setExportStep('write');
        return startExport(destDir, at);
    }, [startExport]);
    const exportPlanFailed = workspaceExport.phase === 'failed' && exportStep === 'plan';

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
    }

    // Step-1 card, lock message and Train buttons read the persisted condition (a saved period outside the data only warns).
    const rcStepState: RcStepState = !rcConfigured ? 'unset' : persistedPeriodsInvalid ? 'invalid' : 'set';

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModelsCount = allModels.length;
    const completeModelsCount = allModels.filter(isModelDone).length;

    /** Status for the left-list dot / tab pill; a failed run this session overrides an otherwise trained model. */
    const dotStateOf = (m: FailureModel): ModelDotState => {
        const st = modelDotState(effectiveModelFor(m), gateFg, gateHeaders, specialRecipes);
        // A model that still has to train with nothing to train on reads "needs fixing"; display only, status untouched.
        // A trained or Complete model keeps its own state.
        if ((st === 'none' || st === 'stale') && trainGuardBlockOf(m) !== null) return 'blocked';
        return st === 'trained' && trainError[m.id] ? 'stale' : st;
    };

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
    /** Why both Train buttons are disabled. A missing workspace condition blocks only if no model can train (Custom ones can). */
    const trainAllReason = exporting ? EXPORT_BUSY_REASON : trainButtonsBlockedReason({
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
    const keepTraining = () => { setCloseAsk(false); tellCloseKept(); };
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
    /** Relation-model fit gone: NOT_FITTED seen this session and not fitted since; Train sensor/Train all plan it ready (candidateOf). Not while being fitted. On screen: the live answer, else the window's own mark; other models are found out only when opened. */
    const fitGoneOf = (m: FailureModel): boolean =>
        trainStatus[m.id] !== 'loading'
        && (activeModel?.id === m.id
            ? healthPreview.notFitted || (notFittedIds.has(m.id) && !healthPreview.data)
            : notFittedIds.has(m.id));
    /** What the "Fit no longer in memory" board offers: "Load it again" always, "Train sensor" only for a model it trains (a Complete model is up to date for it, so that link would do nothing). */
    const fitGoneActionsOf = (m: FailureModel): FitGoneActions => ({
        onReload: onReloadFit,
        reloadDisabledReason: fitReloadBlock(m) ?? undefined,
        onGoTrainSensor: isModelDone(m) ? undefined : focusTrainSensor,
        // A load (or a train) of it that failed since.
        error: trainError[m.id] ?? null,
        // The window's own knowledge that the fit is gone: the live answer is lost once the tab is left and reopened after a failed load.
        gone: fitGoneOf(m),
    });
    /** A Complete model whose last load/train failed, fit not reported gone: Train sensor never trains it, so offer "Load it again" (silent). A non-Complete model keeps "Training failed · Train sensor ↑". */
    /* Only a model WITH a train record has something to load again (reloadFit returns for one without). */
    const loadFailedOf = (m: FailureModel): boolean =>
        !!trainError[m.id] && trainStatus[m.id] !== 'loading' && isModelDone(m) && !!m.lastTrainedAt && !fitGoneOf(m);
    /** A Complete model with no train record whose ▾ menu train failed: nothing to load again; the way out is the ▾ row that trains it. */
    const legacyTrainFailedOf = (m: FailureModel): boolean =>
        !!trainError[m.id] && trainStatus[m.id] !== 'loading' && isModelDone(m) && !m.lastTrainedAt;
    /** The words of a failed run on the tab / list dot. */
    const failedWordsOf = (m: FailureModel): string =>
        !isModelDone(m) ? TRAIN_FAILED_WORDS
            : m.lastTrainedAt ? `Complete · ${LOAD_FAILED_WORDS}`
            : `Complete · ${TRAIN_FAILED_WORDS}`;
    /** Why Train sensor would not train this out-of-date model now (so the stale banner says so instead of offering a dead link): the data is not this window's, the model cannot train, or a run is active. */
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

    // "Needs setup" red dot: the gate, or (if it still has to train) nothing to train on; never a trained or Complete model's guard.
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

    // One left-list row per sensor per bucket; a sensor in several Failure Groups shows under each, all selecting the same detail pane.
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
                    {keyTag ? <SensorLabel tag={keyTag} wrap="always" /> : <div className="f4-sr-title">{title}</div>}
                </div>
                <div className="f4-kinds">
                    {ordered.map(m => {
                        // Dot from modelDotState (draft-aware): green = complete; yellow = needs input (set points or re-train, incl. changed Complete);
                        // red = needs fixing (the gate blocks it); none = never trained.
                        const st = dotStateOf(m);
                        // A trained model whose saved set points Rust rejected reads red ("Fix set point"); same persisted verdict as the Dashboard dot.
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

    /** The sensor a list row names ('' = a model with no sensor yet). */
    const listRowTag = (sg: SensorModelGroup): string => (sg.models[0] ? modelTagOf(sg.models[0]) : '');
    // Search hits are marked only in a project with long names (a match may sit in a cut-off head); short names keep plain rows.
    const listHasLongNames = sensorGroupsAll.some(sg => displayedName(sensorLookup(listRowTag(sg))).length > NAME_TAIL_MAX);
    const renderLeftList = () => {
        if (leftGroupBy === 'fg') {
            const fgSection = (no: number, name: string) => {
                const rows = groupModelsBySensor(allModels, no);
                const visible = rows.filter(sg => matchesSearch(sg) && matchesSidebarFilter(sg));
                return (
                    <div key={no}>
                        <div className="bmw-list-grp"><i style={{ background: FG_ACCENT[getFgGroupColor(no)] }} />{fgLabel(no, name)}</div>
                        {rows.length === 0 ? (
                            <div className="bmw-srow-empty">No models yet</div>
                        ) : visible.length === 0 ? (
                            <div className="bmw-srow-empty">No sensors match</div>
                        ) : (
                            <SensorSetProvider tags={rows.map(listRowTag)} drop>
                                <SetPrefixLine className="bmw-list-prefix" testid="list-group-prefix" />
                                {visible.map(sg => renderSensorListRow(sg, `fg:${no}`))}
                            </SensorSetProvider>
                        )}
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
                        : (
                            <SensorSetProvider tags={rows.map(listRowTag)} drop>
                                <SetPrefixLine className="bmw-list-prefix" testid="list-group-prefix" />
                                {visible.map(sg => renderSensorListRow(sg, `component:${comp}`))}
                            </SensorSetProvider>
                        )}
                </div>
            );
        });
    };


    /** Cluster-range slider: CLUSTER_PALETTE segments over the criteria sensor's [min, max] (criteriaStats), N-1 draggable boundaries, value pills. startSplitDrag re-reads draftOf(m).ranges on every mousemove (a drag outlives any render). Active model only, so criteriaStats fits. */
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
        if (!criteriaStats && criteriaStatsError !== null) {
            return (
                <div className="pm-cluster-slider pm-cluster-slider--empty" role="alert" data-testid="cluster-slider-failed">
                    <span>Could not read the range of {sensorLabel(d.criteria)}: {criteriaStatsError}</span>
                    {' '}<button type="button" className="rcx-btn rcx-btn--sm" data-testid="cluster-slider-retry" onClick={() => setCriteriaStatsTry(n => n + 1)}>Try again</button>
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
        /** Typed boundary idx (between cluster idx+1 and idx+2): Enter/blur commits, Esc reverts. It must lie strictly between its neighbours and inside the criteria sensor's [min, max], else an inline error and no commit. */
        const commitBoundary = (idx: number) => {
            if (!edit || edit.idx !== idx) return;
            const text = edit.text.trim();
            if (text === edit.initial.trim()) { setBoundaryEdit(null); return; }
            // A comma is only a thousands separator ("1,234.5"); "33,6" would silently become 336 if stripped, so refuse it.
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
                    <span className="pm-cluster-slider-sensor"><SensorInline tag={d.criteria} size="sm" muted /></span>
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
                {/* Value pills: each inner boundary is typeable (the next pill's lower bound mirrors it); the outer bounds are read-only. */}
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
            {/* Model settings: one three-column grid for all kinds; row 1 is Model name, the kind's setting, Training data. */}
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

            {/* Row 1 middle: Boundary (Individual), Stiffness (Relation model) or Clusters (Clustering). .bmw-sets-kind is display: contents; DOM order is screen order, so Tab follows the reading order. */}
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

            {/* Row 2 on: the kind's sensors; wide fields (predictors, cluster ranges) take a full row (.f4-fld--grow). Individual has none. */}
            <div className="bmw-sets-kind">
            {m.kind === 'relationship' && (
                <div className="f4-fld f4-fld--grow">
                    <span className="f4-lbl">Predictor sensors (≥ 1)</span>
                    {/* Predictors as chips (× removes one) plus a dashed "Add…" that opens the multi modal; the target is excluded. */}
                    {/* The card's target counts in the chips' set, so no chip reads like the sensor printed above it. */}
                    <SensorSetExtraContext.Provider value={m.targetSensor ? [m.targetSensor] : NO_TAGS}>
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
                    </SensorSetExtraContext.Provider>
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
                            invalid={!d.y || clusteringSameXY(m, d)}
                        />
                        {!d.y && <div className="f4-req-note">Required</div>}
                        {clusteringSameXY(m, d) && <div className="f4-req-note" data-testid="y-equals-x">{X_EQUALS_Y_REASON}</div>}
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Criteria sensor (optional)</span>
                        <SensorPickerModal
                            sensors={allSensors}
                            getComponent={getComponent}
                            single
                            allowNone
                            value={d.criteria}
                            // A cleared criteria sensor means one cluster (Rust rejects 2+ without it): the count drops to 1 in the same draft edit.
                            // Ranges are dropped on Save (draftFields).
                            onSelect={criteria => patchDraft(m, criteria ? { criteria } : { criteria: '', numClusters: 1 })}
                            noun="criteria sensor"
                            placeholder="None"
                        />
                    </div>
                    {/* Always shown: renderClusterRangeSlider covers every empty state itself. */}
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

            {/* A Custom model's own running condition: the workspace panel bound to its draft (saved with Save changes), full-width (.rc-custom). */}
            {d.runningConditionMode === 'custom' && (
                <div className="rc-custom" data-testid="custom-rc-editor">
                    {seedNoteFor[m.id] && (
                        <div data-testid="pm-seed-note" className="rcx-line rc-seed">
                            <span>
                                Copied <b>{seedNoteFor[m.id]!.periods} train period{seedNoteFor[m.id]!.periods === 1 ? '' : 's'}</b>, <b>{seedNoteFor[m.id]!.tests} scoring period{seedNoteFor[m.id]!.tests === 1 ? '' : 's'}</b>{seedNoteFor[m.id]!.conditions > 0 ? ' and the running condition' : ''} from Workspace. Edits here affect only this model.
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
                        condition={d.customFilters[0]}
                        allData={d.customAllData}
                        onAllDataChange={allData => patchDraft(m, { customAllData: allData })}
                        onConditionChange={({ sensor, value }) => patchDraft(m, {
                            customFilters: [{ id: d.customFilters[0]?.id ?? `rcf-${m.id}`, sensor, operation: 'greater_than', value1: value, value2: '' }],
                        })}
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
                    {isOpen ? <span className="bmw-sets-sp" /> : <SettingsSummary text={settingsSummaryLine(m, d)} parts={settingsSummaryParts(m, d)} />}
                    {missing.length > 0 && <span data-testid="settings-to-fix" className="f4-pill f4-pill--warn">{missing.length} to fix</span>}
                </button>
                {isOpen && (
                    // A fieldset so disabled reaches every field while Export results is writing (the notice line says why).
                    <fieldset
                        data-testid="add-model-form"
                        className="bmw-sets-body"
                        disabled={exporting}
                        title={exporting ? EXPORT_BUSY_REASON : undefined}
                    >
                        {renderModelSettingsFields(m, d)}
                    </fieldset>
                )}
            </div>
        );
    };

    /** "Fix set point"/"Set points needed" for a TRAINED model: the persisted verdict (modelSetPointFlag, same as the Dashboard dot), except the model on screen follows its live verdict once Rust has answered for what is typed. */
    const setPointFlagOf = (m: FailureModel, st: ModelDotState): SetPointFlag => {
        if (st !== 'trained') return null;
        if (activeModel && m.id === activeModel.id && activeVerdict !== null) {
            return activeVerdict === 'bad' ? 'fix' : activeVerdict === 'needs' ? 'needed' : null;
        }
        return modelSetPointFlag(effectiveModelFor(m), gateFg, gateHeaders, st, specialRecipes);
    };

    /** One rule for a kind tab's dot, words and tooltip: modelDotState refined by set-point verdict, gate badge, and a failed run. dot = colour; words = status with every suffix, uncut; tone = words' colour (plain "Trained" stays grey); flag = what page tab ② reads too. */
    const tabDotOf = (m: FailureModel, st: ModelDotState): { dot: TabDot; tone: TabDot; words: string; flag: SetPointFlag } => {
        // Unsaved Model-settings edits are said for EVERY tab of the sensor, not only the open one.
        const tail = m.id in drafts ? ' · unsaved changes' : '';
        const toneOf = (dot: TabDot, plain = false): TabDot => (plain ? null : dot);
        if (trainError[m.id]) return { dot: 'bad', tone: 'bad', words: `${failedWordsOf(m)}${tail}`, flag: null };
        const badge = gateBadge(m);
        // Results but no row in the loaded data: keep the model's own dot and words, plus why there are no charts.
        if (noDataOf(m)) {
            const flag = setPointFlagOf(m, st);
            const own = flag === 'fix' ? 'Fix set point' : flag === 'needed' ? 'Set points needed' : TAB_WORDS[st];
            const dot = flag === 'fix' ? 'bad' : DOT_CLASS[st];
            return { dot, tone: toneOf(dot, own === TAB_WORDS.trained), words: `${own} · ${NO_MODEL_DATA_WORDS}${tail}`, flag };
        }
        // A trained model whose fit is gone needs training again (amber, like "Re-train needed").
        if (badge === null && fitGoneOf(m) && (st === 'trained' || st === 'complete')) {
            return { dot: DOT_CLASS[st], tone: toneOf(DOT_CLASS[st]), words: `${st === 'complete' ? 'Complete · ' : ''}${FIT_GONE_WORDS}${tail}`, flag: null };
        }
        const setPointFlag = setPointFlagOf(m, st);
        // A gate badge replaces the set-point words: no set-point flag is said then.
        const flag = badge === null ? setPointFlag : null;
        const words = badge ?? (flag === 'fix' ? 'Fix set point' : flag === 'needed' ? 'Set points needed' : TAB_WORDS[st]);
        const dot = setPointFlag === 'fix' ? 'bad' : DOT_CLASS[st];
        return { dot, tone: toneOf(dot, words === TAB_WORDS.trained), words: `${words}${tail}`, flag };
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
    /** Why the Health score page (and the "Health set points" / "Complete" steps) cannot be opened right now, or null. */
    const healthPageBlock = (m: FailureModel): string | null =>
        isModelStale(m) ? 'Re-train first'
            : !m.lastTrainedAt ? 'Train the model first'
            : buildBlockReason(m) !== null ? 'Fix the settings first'
            // The last run this session failed, so the numbers on screen are untrustworthy; a Complete model's way back is "Load it again".
            : trainError[m.id] ? (isModelDone(m) ? 'Load the model again first' : 'Re-train first')
            : null;

    /** "Train sensor ↑": the text link every sentence uses to point at the one place to train (focuses the header's Train sensor button). */
    const trainSensorLink = (testId: string) => <TrainSensorLink testId={testId} onClick={focusTrainSensor} />;
    /** "Train sensor ▾": opens the menu; the only place that trains an up-to-date (Complete) model, via its "<Kind> only" row. */
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
    /** "the Train sensor ▾ menu" in a sentence; while nothing can start from it, plain text says when or why not (a link would do nothing). */
    const trainMenuPhrase = (testId: string, m?: FailureModel): ReactNode => {
        const why = queue.stale ? 'not available: the data in this window is out of date'
            : queue.isRunning ? 'when the training run finishes'
            // The menu row for this model is disabled (and the sensor's ▾ itself when nothing can train): no link to it either.
            : m && trainBlockReason(m) !== null ? "not available: it can't be trained yet"
            : null;
        return why === null
            ? <>the {trainMenuLink(testId)} menu</>
            : <>the Train sensor ▾ menu <span data-testid={`${testId}-blocked`}>({why})</span></>;
    };
    /** "Train sensor ↑" in a sentence about one model: the link, or plain text saying why it would not train. Never a link that does nothing. */
    const trainSensorPhrase = (testId: string, m: FailureModel): ReactNode => {
        const cant = staleCantTrainOf(m);
        if (!cant) return trainSensorLink(testId);
        const why = cant.kind === 'stale' ? 'not available: the data in this window is out of date'
            : cant.kind === 'run' ? 'when the training run finishes'
            : "it can't train yet";
        return <>Train sensor ↑ <span data-testid={`${testId}-blocked`} title={cant.text}>({why})</span></>;
    };
    /** The one board for a model with results but no row in the loaded data (noDataOf), on both pages: the cause plus one fix link. The link goes to the workspace condition or the model's own Model settings. Never "Load it again"/"Train sensor": neither can work. */
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
    /** The one board shape for every chart-less state: title, one sentence, optional mono line. Actions are text links, never buttons. */
    const board = (testId: string, tone: 'plain' | 'bad' | 'run', title: ReactNode, text?: ReactNode, detail?: ReactNode) => (
        <div className="bmw-stage">
            <StateBoard testId={testId} tone={tone} title={title} text={text} detail={detail} />
        </div>
    );
    /** Model fit body, a state machine ending in ModelFitPage's charts: Complete without train record -> placeholder; bad config/gate -> "N items to fix"; running -> progress; never trained; stale -> "Out of date" charts; fit gone -> "Fit no longer in memory" board; else charts. */
    const renderModelFitBody = (m: FailureModel) => {
        // Read gate plus, for a never-trained model, "nothing to train on" (its board explains Train's refusal). A model with results keeps them.
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
            // Complete is up to date for Train sensor, which never trains it: only the ▾ menu's "<Kind> only" row does, so the board points there.
            // A model that cannot train gets its reason instead; a failed ▾ train with no train record turns the board red.
            const failed = legacyTrainFailedOf(m) ? trainError[m.id] : undefined;
            // The menu row is also disabled by the data guards, so those are a reason here, never a link to the row.
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
            // A model that follows the workspace condition is locked until it is set/fixed: say so first, with a link into the settings.
            // A Custom model is unaffected and keeps the plain list.
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
            // "Training" only for a model in the run; a trained model whose result is being worked out again is "Loading", no time estimate.
            return qItem?.state === 'running'
                ? board('results-loading', 'run', `Training the ${kindModelName(m.kind)} · about ${formatTrainSeconds(ROUGH_TRAIN_SECONDS[m.kind])}`,
                    'Its settings are locked until it finishes. The charts appear here when it is done.')
                : board('results-loading', 'run', `Loading the ${kindModelName(m.kind)}…`, 'The charts appear here when it is ready.');
        }
        // Results but no row of the loaded data: say that before any "fit gone"/"couldn't load" board, whose links could not work here.
        const noData = noDataOf(m);
        if (noData) return noDataBoard(m, noData);
        const err = trainError[m.id];
        // Fit gone: ONE board whatever came after; a failed load is its reason line, never the "Training failed" board
        // (its "Train sensor ↑" cannot train a Complete model).
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
            // Train sensor would be a dead end for a Complete model; the ways out are "Load it again" (silent) and the ▾ row that trains it.
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
                        // Only while that row can train it; a model that cannot train gets no pointer to a disabled menu.
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
            // Only the charts failed, the trained model is fine: a link asks again, except after the dataset was replaced (it cannot help).
            return board('results-health-error', 'bad', "Couldn't load the charts",
                healthPreview.errorCode === 'STALE_SESSION'
                    ? 'The trained model is kept, but its charts can only be loaded from the data it was trained on.'
                    : <>The trained model is kept — <button type="button" className="tq-inline-link" data-testid="board-retry-charts" onClick={healthPreview.retry}>Try again</button>.</>,
                healthPreview.error);
        }
        if (!healthPreview.data) {
            // Trained-and-fresh per the persisted fields, but no first result has landed this session yet.
            return board('results-loading', 'run', `Loading the ${kindModelName(m.kind)}…`,
                slowScoring ? <span data-testid="slow-test-scoring">{SLOW_TEST_SCORING_TEXT}</span> : 'The charts appear here when it is ready.');
        }
        return (
            <div data-testid="results-chart">
                <ModelFitPage {...props} data={healthPreview.data} onXPredictorChange={onFitX} onCompare={onCompare} compareDisabledReason={queue.isRunning ? TRAIN_RUN_ACTIVE_REASON : undefined} trainDaysEstimate={trainDaysEstimateFor(m)} />
            </div>
        );
    };

    /** Train running days as Rust counted them (count_period_rows): the card's count for Workspace mode, the active model's own for Custom. Same figure as the caption; feeds the amber "below the recommended train time" note until the health preview's own figure exists. */
    const trainDaysEstimateFor = (m: FailureModel): number | null => {
        if (effectiveModelFor(m).runningConditionMode === 'custom') {
            return activeModel?.id === m.id ? countedTrainRunningDays(customCounts) : null;
        }
        return countedTrainRunningDays(cardCounts);
    };

    /** Why Mark complete is not possible now (the first blocking reason), or null. Only the active model has a health preview; Rust's validation is the source of "set points not valid". */
    const markCompleteBlock = (m: FailureModel): string | null => {
        // Export results is writing: nothing about a model changes meanwhile.
        if (exporting) return EXPORT_BUSY_REASON;
        // A category on the sensor and a model name no other model uses (the export writes it as the display name).
        const projectBlock = markCompleteProjectBlock(allModels, m, categoryOf(m), plainSensorLabel);
        if (projectBlock !== null) return projectBlock;
        // A training run owns the sidecar: wait for the run.
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
        // Loading or training again: nothing may be saved from an earlier answer still on screen.
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
            // It failed: the red card has the reason and Retry; after the dataset was replaced there is no Retry.
            return healthPreview.errorCode === 'STALE_SESSION' ? PREVIEW_STALE_BLOCK_REASON : PREVIEW_FAILED_BLOCK_REASON;
        }
        if (healthPreview.loading) return CHECKING_SET_POINTS;
        if (!data.valid) {
            const issues = attemptIssues[m.id] ?? data.validation;
            if (verdictOfIssues(issues) === 'bad') {
                const n = Math.max(1, buildCheckLines(data.kind, issues).filter(l => !l.warning).length);
                return `${n} set point${n > 1 ? 's' : ''}${SET_POINTS_NOT_VALID_TAIL}`;
            }
            // Count Rust's `required` issues (one per empty point); the Checks lines merge a Relation model's 4 empty points.
            const empty = Math.max(1, issues.filter(i => isBlockingIssue(i) && i.code === 'required').length);
            return `${empty} set point${empty > 1 ? 's' : ''} still empty`;
        }
        return null;
    };

    /** What the Health score page says about Mark complete: running, failed, or nothing (it writes no files). */
    const saveInfoFor = (m: FailureModel): SaveInfo => {
        return saveInfo[m.id] ?? { phase: 'idle' };
    };

    /** The one filled button of the detail pane (presentation only); none while the running condition is unset/invalid. Model fit: Save changes with a draft, else Train sensor. Health score: Train sensor, else Mark complete until Complete. */
    const primaryActionOf = (m: FailureModel, page: WorkbenchPage, cands: readonly TrainCandidate[]): PrimaryAction => {
        if (rcStepState !== 'set') return null;
        const sensorNeedsTrain = cands.some(c => c.plan.kind === 'ready');
        if (page === 'model') {
            if (m.id in drafts) return 'save';
            return sensorNeedsTrain ? 'train' : null;
        }
        if (cands.find(c => c.id === m.id)?.plan.kind === 'ready') return 'train';
        // No row in the loaded data: Mark complete could only fail.
        if (noDataOf(m)) return sensorNeedsTrain ? 'train' : null;
        if (!isModelDone(m)) return 'mark';
        return sensorNeedsTrain ? 'train' : null;
    };

    /** State parts: header `actions` (Save changes on Model fit with a draft; Mark complete / Mark incomplete on Health score) and `notice`, a one-line bottom message shown only while something needs fixing or waiting. */
    const renderStateParts = (m: FailureModel, page: WorkbenchPage, primary: PrimaryAction): { notice: ReactNode; actions: ReactNode } => {
        // Save changes is an action: the draft's data guards apply to it.
        const saveReason = modelBlockReason(m, true);
        // The ONE sentence: why Save is disabled, else the gate, else — for a model
        // that still has to train — why Train will not start.
        const lineReason = orderedBlockReason(saveReason, gateBlockOf(m) ?? shownGuardBlockOf(m));
        const trainedFresh = isModelTrainedFresh(m);
        const stale = isModelStale(m);
        const done = isModelDone(m);
        // A run that failed this session overrides the happy-path notice and Mark complete: persisted fields still say fresh.
        const hasSessionError = !!trainError[m.id];
        // Fit gone: trained (or Complete) but the fit must be loaded or trained again; trainedFresh is only said of a non-Complete model.
        const fitGone = (trainedFresh || done) && fitGoneOf(m);
        // Results but no row of the loaded data: the tab keeps its own word; the sentence says what the charts need.
        const noData = noDataOf(m);
        const noDataLine: ReactNode = noData
            ? <span data-testid="footer-no-data">{noModelDataFooter(done ? 'Complete' : 'Trained', noData.mode)}</span>
            : null;
        const markBlock = page === 'health' ? markCompleteBlock(m) : null;
        const savePhase = saveInfo[m.id]?.phase;
        const saving = savePhase === 'running';
        // Train queue: queued or training in the run = settings locked (Save disabled).
        const qItem = queue.isRunning ? queue.itemOf(m.id) : undefined;
        const locked = queue.isLocked(m.id);
        const hasDraft = m.id in drafts;
        // The header's Train sensor is the one place to train. This link focuses it.
        const goTrainSensor = trainSensorLink('footer-train-sensor');

        // Fit-gone sentence: a "load it again" link, plus "Train sensor ↑" only for a model Train sensor can train (not Complete).
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
        // Complete model whose load failed (not a lost fit): the same "load it again" link, never "Train sensor ↑".
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
        // Why Mark complete is disabled, as a sentence: the fit-gone reasons get links; a name twin names the other model's sensor.
        const twin = findWorkspaceNameTwin(allModels, m, m.name ?? '');
        const twinLine: ReactNode = twin ? (
            <span data-testid="name-twin-reason">
                Model name “{(m.name ?? '').trim()}” is also used by the {kindModelName(twin.kind)} of <SensorInline tag={modelTagOf(twin)} /> — rename one in Model settings
            </span>
        ) : null;
        const blockWhy: ReactNode = markBlock === null || markBlock === CHECKING_SET_POINTS ? null
            : twinLine && markBlock.startsWith('Model name “') ? twinLine
            : markBlock === LOAD_FAILED_BLOCK_REASON ? loadFailedLine
            : markBlock === FIT_GONE_BLOCK_REASON || markBlock === FIT_GONE_BLOCK_REASON_COMPLETE ? fitGoneLine
            : ownGateText(m, markBlock);
        // The ONE sentence of the notice line (first match wins) — or null: nothing to
        // fix or wait for, so no line.
        let line: ReactNode = null;
        let tone: 'plain' | 'warn' | 'bad' | 'ok' = 'plain';
        let lineId: 'footer-status' | 'mark-block-reason' | 'build-block-reason' = 'footer-status';
        if (exporting) {
            line = <><Loader2 size={11} className="pm-spin" aria-hidden="true" /> Exporting results · Train sensor, Mark complete and set points are available when the export finishes</>;
        } else if (page === 'health') {
            // Checking is said HERE only (no card on the page unless it is slow).
            if (saving) line = <><Loader2 size={11} className="pm-spin" aria-hidden="true" /> Checking the set points…</>;
            // No data in the loaded file: the same sentence on both pages (also why Mark complete is disabled, as tooltip).
            else if (noDataLine) { line = noDataLine; tone = 'warn'; }
            // Why Mark complete is disabled comes first, so a failed attempt's "Not marked complete" cannot hide it.
            // Not while Rust is still checking typed values: a line per keystroke would make the page jump.
            else if (!done && markBlock !== null && markBlock !== CHECKING_SET_POINTS) { line = blockWhy ?? markBlock; tone = 'warn'; lineId = 'mark-block-reason'; }
            // A refusal for a lost fit that was loaded again since has nothing left to fix; only the second click is missing.
            else if (savePhase === 'error') {
                line = (saveInfo[m.id] as { message?: string }).message === FIT_GONE_SAVE_MESSAGE
                    ? 'Not marked complete · the Relation model is loaded again — Mark complete'
                    : 'Not marked complete · fix it, then Mark complete';
                tone = 'bad';
            }
            // A Complete model whose fit is gone stays Complete, but the page cannot score until it is loaded again: say that.
            else if (done && fitGone) { line = fitGoneLine; tone = 'warn'; }
            // Same for a failed load, whether or not an earlier answer is on screen: the tab's red dot and this sentence agree.
            else if (loadFailed) { line = loadFailedLine; tone = 'bad'; }
            // A Model-settings draft is waiting on the other page.
            else if (hasDraft) line = 'Unsaved changes in Model settings';
            // (Complete, or valid set points waiting for Mark complete: nothing to fix or
            // wait for — no line.)
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
        // Complete model with no train record whose ▾ train failed: train again from the menu; the board has the reason.
        else if (legacyTrainFailedOf(m)) { line = <>{TRAIN_FAILED_WORDS} · train it again from {trainMenuPhrase('footer-train-menu', m)}</>; tone = 'bad'; }
        else if (done) line = null;
        else if (hasSessionError) { line = <>Training failed · fix the problem, then {trainSensorPhrase('footer-train-sensor', m)}</>; tone = 'bad'; }
        // Trained, but its charts could not be loaded (the board above says so): there
        // is nothing to "check" yet.
        else if (trainedFresh && healthPreview.error && !healthPreview.data && !healthPreview.loading) {
            line = healthPreview.errorCode === 'STALE_SESSION'
                ? <>Trained · the charts did not load. {TRAIN_STALE_MESSAGE}</>
                : <>Trained · the charts did not load — try again above</>;
            tone = 'bad';
        }
        // (Trained and up to date: the charts are on screen, the next step is page tab ②
        // and its "set points needed" cue — no line.)
        else if (trainedFresh) line = null;
        else if (stale) { line = <>Settings or running condition changed · train again with {goTrainSensor}</>; tone = 'warn'; }
        // Never trained: its board and page tab ② say why, so no line here.

        // A REJECTED set point is an error (red), an empty one a warning (amber): the
        // notice has the strength of the ruler above it.
        const spRejected = markBlock !== null && markBlock.endsWith(SET_POINTS_NOT_VALID_TAIL);
        if (lineId === 'mark-block-reason' && spRejected) tone = 'bad';

        const markClass = primary === 'mark' ? 'bmw-btn-ok' : 'rcx-btn';
        const notice = line === null ? null : (
            <div className={`wb3-notice wb3-notice--${tone}`} role="status" ref={noticeRef} tabIndex={-1} data-testid="wb-notice" data-tone={tone}>
                <span
                    data-testid={lineId}
                    data-tone={tone}
                    className={`f4-foot-reason wbx-reason${tone === 'warn' ? ' f4-foot-reason--block' : tone === 'bad' ? ' f4-foot-reason--bad' : ''}`}
                >
                    {(tone === 'warn' || tone === 'bad') && <CircleAlert size={12} aria-hidden="true" />}
                    {line}
                </span>
            </div>
        );
        const saveShown = page === 'model' && hasDraft;
        const saveDisabled = saveReason !== null || locked || exporting;
        const saveTitle = exporting ? EXPORT_BUSY_REASON : locked ? 'Settings are locked while this model is in the run' : saveReason ?? undefined;
        // A Mark complete button is on screen (a Complete model has "Mark incomplete").
        const markShown = page === 'health' && !done;
        // Why a state button is disabled, in one short line under it; Mark complete's is hidden while saving (the notice says that).
        const stateWhy: { text: string; tone: TrainReasonTone } | null =
            saveShown && saveDisabled && saveTitle ? { text: saveTitle, tone: locked ? 'neutral' : 'warn' }
            : markShown && !saving && markBlock !== null
                ? { text: markBlock, tone: spRejected ? 'danger' : markBlock === CHECKING_SET_POINTS ? 'neutral' : 'warn' }
            : null;
        const whyLine = stateWhy && <div className={`tq-why tq-why--${stateWhy.tone}`} data-testid="state-why">{stateWhy.text}</div>;
        // Each button that can be disabled is a column with its reason under it, never under a neighbour that works.
        const actions = (
            <div className="wb3-actions" data-testid="wb-actions" data-primary={primary ?? 'none'}>
                {saveShown && (
                    <div className="wb3-act">
                        <button
                            type="button"
                            className={primary === 'save' ? 'f4-btn-save' : 'rcx-btn'}
                            data-testid="save-changes"
                            disabled={saveDisabled}
                            title={saveTitle}
                            onClick={() => { saveFocusRef.current = m.id; return commitModel(m); }}
                        >
                            Save changes
                        </button>
                        {whyLine}
                    </div>
                )}
                {page === 'health' && (
                    <div className="wb3-act">
                        <div className="wb3-act-row">
                            {done ? (
                                <>
                                    <button type="button" className="f4-btn f4-btn--plain f4-btn--small" data-testid="mark-incomplete" disabled={saving || exporting} title={exporting ? EXPORT_BUSY_REASON : undefined} onClick={() => markModelIncomplete(m.id)}>
                                        Mark incomplete
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    className={markClass}
                                    data-testid="mark-complete"
                                    disabled={markBlock !== null || saving}
                                    title={markBlock ?? 'Check the set points and mark it complete'}
                                    aria-busy={saving || undefined}
                                    onClick={() => { void runMarkComplete(m); }}
                                >
                                    {saving ? <><Loader2 size={12} className="pm-spin" aria-hidden="true" /> Checking…</> : '✓ Mark complete'}
                                </button>
                            )}
                        </div>
                        {whyLine}
                    </div>
                )}
            </div>
        );
        return { notice, actions };
    };

    /** Sensor-level Train in the detail header: trains every model of the sensor that needs it (I -> R -> C, up-to-date skipped). A ▾ menu (sensorTrainMenuCopy) and one line say what it will do; filled only as the primary action. */
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
        // No workspace running condition, and a model of this sensor waits for it (an invalid period has its own per-model reason).
        const rcBlocks = rcStepState === 'unset' && ready.length === 0 && cant.some(m => !usesOwnRc(m));
        // Workspace condition unset/invalid, but these models use their own: say nothing is blocked for them (Train sensor works).
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
            // Stopped only by the data guard, a trained or Complete model has no board saying why: name the reason here.
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
        const busy = !queue.canStart || exporting;
        const title = exporting ? EXPORT_BUSY_REASON
            : queue.stale ? TRAIN_STALE_MESSAGE
            : queue.isRunning ? TRAIN_RUN_ACTIVE_REASON
            : rcBlocks ? TRAIN_NEEDS_RUNNING_CONDITION
            : ready.length === 0 ? (cant.length ? cantDetail : why)
            : cant.length ? cantDetail
            : undefined;
        // "Re-train" is said only for a model with a train record (lastTrainedAt).
        // Each row's state line: where the model stands ("Not trained yet", "Failed last run", ...) or why it cannot train.
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
        // Page tab ② is closed by healthPageBlock or while this model's fit is being worked out; never shown closed on the open page.
        // Its reason replaces the caption; loading/training has no reason text (the page body says it).
        const healthBlock = healthPageBlock(activeModel);
        const healthTabClosed = page !== 'health' && (healthBlock !== null || training);
        const healthTabWhy = healthTabClosed ? healthBlock : null;
        // Tab ②'s next-step cue: trained and fresh (tab open) but set points missing/not valid, same flag as the kind tab dot.
        // A Complete model has none; a closed tab keeps its reason.
        const healthCue: SetPointFlag = healthTabClosed ? null : tabDotOf(activeModel, dotStateOf(activeModel)).flag;
        const healthCueWords = healthCue === 'fix' ? 'fix set point' : healthCue === 'needed' ? 'set points needed' : null;
        const parts = renderStateParts(activeModel, page, primary);
        return (
            <>
                {/* Header by function: identity on the left (label, unit, tag, component, FG chips, category switch); actions only on the right. */}
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
                    <div style={{ minWidth: 0 }} data-testid="detail-identity">
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
                                        <span>{fgLabel(no, g?.name)}</span>
                                    </span>
                                );
                            })}
                            <span className="wb3-meta-sep" aria-hidden="true" />
                            {/* Performance / Condition: set once for the sensor, saved as before (`changeCategory`). */}
                            <div
                                role="group"
                                aria-label="Category"
                                className={`f4-catseg wb3-catseg${category ? '' : ' f4-catseg--unset'}`}
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
                                            disabled={exporting}
                                            title={exporting ? EXPORT_BUSY_REASON : undefined}
                                            onClick={() => changeCategory(selectedSensorKey!, c)}
                                        >
                                            {CATEGORY_LABELS[c]}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                    {/* Actions only: Train sensor (ghost unless training is next) and the state buttons, at most one filled (primaryActionOf). */}
                    <div className="wbx-dh-ctl" data-testid="detail-controls">
                        {renderSensorTrain(cands, primary === 'train')}
                        {parts.actions}
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
                        // One dot in the list's colours plus the status in words; the same words are the tooltip and part of the tab's name.
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
                {/* The two pages of a model: a second tab row under the kind tabs. Numbers are an order, not progress; ① is always open. */}
                <nav className="wb3-pages" aria-label="Model pages" data-testid="page-tabs">
                    <button
                        type="button"
                        ref={page === 'model' ? activePageTabRef : undefined}
                        className={`wb3-page${page === 'model' ? ' wb3-page--on' : ''}`}
                        data-testid="page-tab-model"
                        aria-current={page === 'model' ? 'page' : undefined}
                        onClick={() => setPage(activeModel, 'model')}
                    >
                        <span className="wb3-page-n">1</span>
                        <span className="wb3-page-t">Model fit</span>
                        <span className="wb3-page-s">settings · train · check the fit</span>
                    </button>
                    {/* Closed = aria-disabled, never `disabled`: it stays focusable and its reason is always readable in place of the caption. */}
                    <button
                        type="button"
                        ref={page === 'health' ? activePageTabRef : undefined}
                        className={`wb3-page${page === 'health' ? ' wb3-page--on' : ''}${healthTabClosed ? ' wb3-page--off' : ''}`}
                        data-testid="page-tab-health"
                        aria-current={page === 'health' ? 'page' : undefined}
                        aria-disabled={healthTabClosed ? true : undefined}
                        // The cue is not colour-only: it is part of the tab's name.
                        aria-label={healthCueWords ? `Health score, ${healthCueWords}` : undefined}
                        title={healthTabWhy ?? undefined}
                        onClick={() => { if (!healthTabClosed) setPage(activeModel, 'health'); }}
                    >
                        <span className="wb3-page-n">2</span>
                        <span className="wb3-page-t">Health score</span>
                        {healthCue !== null && (
                            <span
                                className={`f4-sdot f4-sdot--${healthCue === 'fix' ? 'bad' : 'need'}`}
                                data-testid="page-tab-health-dot"
                                data-tone={healthCue === 'fix' ? 'bad' : 'need'}
                                aria-hidden="true"
                            />
                        )}
                        {healthTabWhy !== null
                            ? <span className="wb3-page-why" data-testid="page-tab-health-why">{healthTabWhy}</span>
                            : healthCueWords !== null
                                ? <span className={`wb3-page-s wb3-page-s--${healthCue === 'fix' ? 'bad' : 'need'}`} data-testid="page-tab-health-cue">{healthCueWords}</span>
                                : <span className="wb3-page-s">set points · score · mark complete</span>}
                    </button>
                </nav>

                <div role="tabpanel" data-testid={`model-tab-panel-${activeModel.id}`} style={{ display: 'contents' }}>
                    {/* One scroll area for settings, banner and page body, so the notice line below stays in view. */}
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
                        {/* No data in the loaded file: Health score shows the same one board as Model fit (the score uses that data too). */}
                        <div key={`${activeModel.id}:${page}`} className="bmw-pagebody m-swap">
                        {page === 'model' ? renderModelFitBody(activeModel) : activeNoData ? noDataBoard(activeModel, activeNoData) : (
                            <HealthScorePage
                                key={activeModel.id}
                                {...pagePropsFor(activeModel)}
                                setPoints={setPointsOf(activeModel)}
                                onSetPointsChange={onSpChange}
                                onSetPointsCommit={onSpCommit}
                                setPointsDisabledReason={exporting ? EXPORT_BUSY_REASON : null}
                                attemptIssues={attemptIssues[activeModel.id] ?? null}
                                save={saveInfoFor(activeModel)}
                                fitGone={fitGoneActionsOf(activeModel)}
                                fitLoading={training}
                                onRetryPreview={healthPreview.retry}
                                onRetryTestScoring={healthPreview.retryTestScoring}
                                testsChanged={testsChangedState(activeModel, gateFg)}
                            />
                        )}
                        </div>
                    </WorkbenchScroll>
                    {parts.notice}
                </div>
            </>
        );
    };


    // The modal's own view: its draft once edited, else persisted; the card, gate and models stay on persisted state.
    const rcView = rcDraft ?? rcPersisted;
    const rcDirty = rcDraft !== null && !rcDraftEqual(rcDraft, rcPersisted);
    const rcViewInvalid = validatePeriods(rcView.periods, datasetBounds, rcPersisted.periods).some(s => s.invalid);
    // Apply gate: invalid/missing train period, invalid scoring period, a new/changed period outside the data, or no running row
    // (once the count is settled and training changed). A period as saved, or overlaps with train time or highlights, never blocks.
    const rcApplyBlock = runningConditionApplyBlock(rcView.periods, rcView.testPeriods, 'applying', {
        bounds: datasetBounds,
        savedPeriods: rcPersisted.periods,
        savedTestPeriods: rcPersisted.testPeriods,
        noTrainRows: rcNoRows,
        hasCondition: !rcView.allData,
    });
    // A complete typed date is already in the draft, so dirty is the whole condition; a half-typed date only shows the neutral line.
    // The one condition is required: Apply waits for a half-filled line and never removes a set condition. Applying periods while it was never set is allowed.
    const rcDraftCond = rcView.filters[0];
    const rcDraftSet = isWorkspaceRunningConditionConfigured({ runningConditionFilters: rcView.filters, runningConditionAllData: rcView.allData }, gateHeaders);
    const rcWasSet = isWorkspaceRunningConditionConfigured({ runningConditionFilters: rcPersisted.filters, runningConditionAllData: rcPersisted.allData }, gateHeaders);
    const rcCondWhy = rcDraftSet ? null
        : (rcWasSet || (rcDraftCond && (rcDraftCond.sensor || (rcDraftCond.value1 ?? '').trim())))
            ? 'Set “Machine is running when … is above …” before applying' : null;
    rcCondBlockRef.current = rcCondWhy !== null;
    const rcApplyEnabled = rcApplyBlock === null && rcDirty && rcCondWhy === null;
    const rcStillUnset = rcApplyEnabled && !rcDraftSet ? 'The running condition is still not set — models can’t train yet' : null;
    const rcPendingName = rcPendingDate.train ?? rcPendingDate.scoring;
    const rcTestsNotice = testsChangedNotice(allModels, gateFg);
    const rcRetrainLeft = rcRetrainIds.length > 0
        ? modelsStillNeedingTraining(rcRetrainIds, allModels, gateFg, specialRecipes ?? undefined)
        : [];
    // What applying the draft does to the models (never blocks Apply). Only
    // worked out while the modal is open on an edited draft.
    const rcImpact = rcFilterOpen && rcDraft && !rcDraftEqual(rcDraft, rcPersisted)
        ? runningConditionImpact(gateFg, rcDraft, { recipes: specialRecipes ?? undefined })
        : null;
    const rcViewConfigured = isWorkspaceRunningConditionConfigured(
        { runningConditionFilters: rcView.filters, runningConditionAllData: rcView.allData },
        gateHeaders,
    );

    // The window's own view of the workspace (kept in step by writes and broadcasts); the dialog's dry run reads the disk itself.
    const exportWorkspace = {
        id: workspaceId ?? '',
        name: projectInfo?.name ?? '',
        machine: projectInfo?.machine,
        dataUtcOffsetMin: projectInfo?.dataUtcOffsetMin,
        specialSensorRecipes: specialRecipes ?? undefined,
        failureGroupState: {
            ...gateFg,
            groups: allGroups,
        },
    } as WorkspaceState;
    const readiness = exportReadiness({
        workspace: exportWorkspace,
        metadata: sensorMetadata,
        headers: gateHeaders,
        recipes: specialRecipes,
        noData: allModels.filter(m => noDataOf(m) !== null).map(m => m.id),
        loadFailed: allModels.filter(loadFailedOf).map(m => m.id),
        order: runOrder.map(m => m.id),
        labelOf: tag => sensorPlainLabel(sensorLookup(tag)),
    });
    // At most one filled button on screen: Export is filled only when every model is Complete, no draft is open and the condition is set.
    const exportFilled = readiness.counts.allReady && rcStepState === 'set' && Object.keys(drafts).length === 0;
    // What Export writes comes from the disk, so a pending edit would not be in it.
    const exportUnsavedWhy = Object.keys(drafts).length > 0 ? 'Save the changes in Model settings first'
        : Object.keys(spDrafts).length > 0 ? 'Set points are not saved yet'
        : null;
    const exportApi: UseWorkspaceExport = { ...workspaceExport, plan: planExport, start: writeExport };
    /** Opens the Export dialog. plan = ask Rust for the dry run (a fresh look at disk), only when the checklist is all ready and nothing is unsaved; otherwise just the checklist ("Show which"). */
    const openExport = (plan: boolean) => {
        workspaceExport.show();
        setExportOpen(true);
        if (plan && !exporting && readiness.counts.allReady && exportUnsavedWhy === null) void planExport();
    };

    // Sensor names in sans (SensorInline), numbers + units in mono.
    const condText = (f: WorkspaceSensorFilter) => (
        <span className="rc1-cond"><SensorInline tag={f.sensor} size="sm" /> <span className="rc1-mono">{conditionChipParts(f, getDesc, getUnit).rest}</span></span>
    );
    const numUnit = (tag: string, value: string) => <span className="rc1-mono">{fmtNumText(value)}{getUnit(tag) ? ` ${getUnit(tag)}` : ''}</span>;
    const rcBefore = (c: RunningConditionConversion) => {
        const b = c.before;
        if (b.allRows) return <><b>Use all rows</b> (idle and shutdown time included)</>;
        return (
            <>
                {b.filters.filter(f => isCompleteCondition(f)).map((f, i) => (
                    <span key={f.id}>{i > 0 && <span className="rc1-join">{b.combine.toUpperCase()}</span>}{condText(f)} </span>
                ))}
                {b.savedStatus && <>and, for the export only, Machine is running when <span className="rc1-cond"><SensorInline tag={b.savedStatus.sensor} size="sm" /></span> is above {numUnit(b.savedStatus.sensor, b.savedStatus.stopAtOrBelow)}</>}
            </>
        );
    };
    const modelNames = (ids: string[]) => ids.map(id => allModels.find(m => m.id === id)?.name).filter(Boolean).join(' · ');
    const dismissConversion = () => {
        if (!workspaceId) return;
        setRcConversion(null);
        void savedOk((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => withFailureGroupState(prev, { runningConditionConversion: null }));
            if (workspaceIdRef.current !== workspaceId) return;
            if (next?.failureGroupState) {
                applyWritten(next);
                await broadcastFailureGroups({ ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    };
    const nIncomplete = rcConversion?.incompleteModelIds.length ?? 0;
    // Nothing to keep: the Not-set card says why ("Set it again"), in two sentences.
    const rcNeedsSetWhy = conversionMustSetAgain(rcConversion) && rcConversion && (
        <>
            This project used {rcBefore(rcConversion)}, which is gone — pick the sensor that shows the machine is running, and the value above which it runs.
            {nIncomplete > 0 && <> Its {nIncomplete} Complete model{nIncomplete === 1 ? ' is' : 's are'} Incomplete until {nIncomplete === 1 ? 'it is' : 'they are'} trained again with it.</>}
        </>
    );
    const ownConverted = rcConversion?.customModels.filter(c => c.result === 'converted') ?? [];
    const ownNeedsSet = rcConversion?.customModels.filter(c => c.result === 'needs-set') ?? [];
    const after = rcConversion?.after ?? null;
    const showNow = rcConversion?.result === 'converted' && after !== null;
    const showConversion = !!rcConversion && (showNow || rcConversion.customModels.length > 0);
    const rcConversionNotice = showConversion && rcConversion && (
        <div role="status" data-testid="rc-conversion-notice" className="f4-notice rc1-notice">
            <span className="f4-notice-ico"><TriangleAlert size={16} aria-hidden="true" /></span>
            <div className="rc1-notice-body">
                <div className="f4-notice-title">Running condition is now one condition</div>
                <div className="rc1-grid">
                    {showNow && after && (
                        <>
                            <span className="rc1-k">Before</span>
                            <span>{rcBefore(rcConversion)}</span>
                            <span className="rc1-k">Now</span>
                            <span>
                                Machine is running when <span className="rc1-cond"><SensorInline tag={after.sensor} size="sm" /></span> is above {numUnit(after.sensor, after.value)}
                                <span className="rc1-src"> — {rcConversion.source === 'saved-status' ? 'taken from the export’s running status line' : 'the first “above” condition was kept'}.</span>
                            </span>
                        </>
                    )}
                    {showNow && nIncomplete > 0 && (
                        <>
                            <span className="rc1-k">Models</span>
                            <span>
                                <b>{nIncomplete} Complete model{nIncomplete === 1 ? ' is' : 's are'} Incomplete again</b> — {nIncomplete === 1 ? 'it trains' : 'they train'} on different rows now: {modelNames(rcConversion.incompleteModelIds)}. Train again, then Mark complete. Set points are kept.
                            </span>
                        </>
                    )}
                    {rcConversion.customModels.length > 0 && (
                        <>
                            <span className="rc1-k">Own condition</span>
                            <span>
                                {ownConverted.length > 0 && <>Converted the same way: {modelNames(ownConverted.map(c => c.id))}. </>}
                                {ownNeedsSet.length > 0 && <span className="rcx-line--warn">Set again in Model settings → Training data: <b>{modelNames(ownNeedsSet.map(c => c.id))}</b> — it had no “above” condition.</span>}
                            </span>
                        </>
                    )}
                </div>
            </div>
            <div className="rc1-acts">
                {showNow && <button type="button" className="rc1-link" data-testid="rc-conversion-check" onClick={() => setRcFilterOpen(true)}>Check it</button>}
                <button type="button" className="rc1-dismiss" data-testid="rc-conversion-dismiss" onClick={dismissConversion}>Got it</button>
            </div>
        </div>
    );

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="flex flex-col h-screen overflow-hidden" data-project-name={projectInfo?.name ?? undefined} style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Build Model
                </h2>
                <button onClick={handleClose} className="scatter-regl-btn scatter-regl-btn-icon" title="Close">
                    <X size={14} />
                </button>
            </div>

            {saveFailed && (
                <div className="wb2-stale" role="alert" data-testid="save-failed-notice" style={{ margin: '8px 16px 0', position: 'relative', zIndex: 2000 }}>
                    <span>{SAVE_FAILED_NOTICE}</span>
                    <span className="wb2-sp" />
                    <button type="button" className="rcx-btn rcx-btn--sm" onClick={() => setSaveFailed(false)}>Dismiss</button>
                </div>
            )}

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
                    headers={gateHeaders}
                    getDesc={getDesc}
                    getUnit={getUnit}
                    bounds={datasetBounds}
                    onOpen={() => setRcFilterOpen(true)}
                    testPeriods={runningConditionTestPeriods}
                    noRows={cardNoRows}
                    why={rcNeedsSetWhy && !rcConfigured ? rcNeedsSetWhy : undefined}
                    allData={runningConditionAllData}
                />
                {rcConversionNotice}
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
                {/* Models an Apply sent back to training and still untrained (session-only); disappears once they are. */}
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

                {categoryNotice && categoryNotice.length > 0 && (() => {
                    // One entry per sensor; the "taken from" model is the first unchanged one in Individual -> Relationship -> Clustering order.
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

                {/* Hidden list: no aside, so the detail pane must be the only column (a leftover "0 1fr" template would trap it in 0px). */}
                <div className={`bmw-wb${sidebarCollapsed ? ' bmw-wb--nolist' : ''}`} style={{ gridTemplateColumns: sidebarCollapsed ? 'minmax(0,1fr)' : `${listWidth}px minmax(0,1fr)` }}>
                    {!sidebarCollapsed && (
                        <PaneResizeHandle
                            width={listWidth}
                            defaultWidth={LIST_DEFAULT_WIDTH}
                            onChange={setListWidth}
                            storageKey={LIST_WIDTH_KEY}
                            label="Resize the sensor list"
                            controls="build-model-sensor-list"
                            testid="list-resize"
                        />
                    )}
                    {!sidebarCollapsed && (
                        <aside className="bmw-side" id="build-model-sensor-list">
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
                            <div className="bmw-list"><SensorSearchContext.Provider value={listHasLongNames ? searchQuery : ''}>{renderLeftList()}</SensorSearchContext.Provider></div>
                            <div className="bmw-leg" data-testid="status-legend">
                                <span><i style={{ background: 'var(--warn)' }} />Needs input / re-train</span>
                                <span><i style={{ background: 'var(--danger)' }} />Fix</span>
                                <span><i style={{ background: 'var(--ok)' }} />Complete</span>
                            </div>
                        </aside>
                    )}
                    <section key={selectedSensorKey ?? 'none'} className="bmw-detail m-swap">{renderDetailPane()}</section>
                </div>
                {/* Export results: the window's bottom bar, under the list AND the detail pane. */}
                <ExportBar
                    counts={readiness.counts}
                    phase={exportPlanFailed ? 'idle' : workspaceExport.phase}
                    progress={workspaceExport.progress}
                    exported={exportedLine}
                    filled={exportFilled}
                    blockedWhy={queue.isRunning ? TRAIN_RUN_ACTIVE_REASON : null}
                    unsavedWhy={exportUnsavedWhy}
                    onExport={() => openExport(true)}
                    onShowWhich={() => openExport(true)}
                    onShowRun={() => openExport(false)}
                    onOpenFolder={() => { if (exportedLine) void revealExportFolder(exportedLine.folder).catch(e => console.warn('Open folder failed', e)); }}
                />
            </div>

            {rcFilterOpen && (
                // Edits go to a local draft; only Apply writes. X/backdrop/Esc go through requestCloseRc (flush the focused input, then ask before discarding a dirty draft).
                // Focus goes to the first field on open and Tab stays inside (useModalFocus).
                <div className="bmw-modal-backdrop" role="presentation" onClick={requestCloseRc}>
                    <div ref={rcDialogRef} tabIndex={-1} className="bmw-modal bmw-modal--rc" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Running condition">
                        <div className="bmw-modal-head rcm-head">
                            <div className="rcm-head-t">
                                <h2>Running condition</h2>
                                <div className="rcm-sub">Default for every model · a model can use its own on its settings (Custom)</div>
                            </div>
                            <RunningConditionPills
                                configured={rcViewConfigured}
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
                                condition={rcView.filters[0]}
                                onConditionChange={setRunningConditionLine}
                                allData={rcView.allData}
                                onAllDataChange={setRunningConditionUseAllData}
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
                                        title={rcApplyBlock?.footer ?? rcCondWhy ?? undefined}
                                        onClick={applyRcDraft}
                                    >
                                        <Check size={12} /> Apply
                                    </button>
                                    <button type="button" data-testid="rc-cancel" className="f4-btn f4-btn--plain" onClick={closeRc}>Cancel</button>
                                    <span className="filter-panel-spacer" />
                                    {!rcApplyBlock && (rcCondWhy ?? rcStillUnset) ? (
                                        <span data-testid="rc-condition-why" role="alert" className="rc-impact rc-impact--amber">
                                            <span>{rcCondWhy ?? rcStillUnset}</span>
                                        </span>
                                    ) : rcApplyBlock ? (
                                        // Why Apply is disabled: red for a bad period or no rows to train on, amber for a missing train period.
                                        <span
                                            data-testid="rc-apply-block"
                                            data-kind={rcApplyBlock.kind}
                                            role="alert"
                                            className={`rc-impact ${rcApplyBlock.kind === 'no-train' ? 'rc-impact--amber' : 'rc-impact--bad'}`}
                                        >
                                            <span>{rcApplyBlock.footer}</span>
                                        </span>
                                    ) : rcImpact ? (
                                        // What applying does to the models (never blocks Apply); Apply is enabled only with this line shown.
                                        <span data-testid="rc-impact" data-tone={rcImpact.tone} role="status" className={`rc-impact rc-impact--${rcImpact.tone}`}>
                                            <span>{rcImpact.text}</span>
                                            {rcImpact.quiet && <span data-testid="rc-impact-quiet">{rcImpact.quiet}</span>}
                                            {rcPendingName && <span data-testid="rc-pending-date">{pendingDateText(rcPendingName)}</span>}
                                        </span>
                                    ) : rcPendingName && (
                                        // Nothing edited yet but a date is half-typed: it is not in the draft, so no impact to show, only how to get it.
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

            {exportOpen && workspaceId && (
                <ExportModal
                    readiness={readiness}
                    groups={trainGroups}
                    projectName={projectInfo?.name ?? ''}
                    machineTag={projectInfo?.machine?.tag ?? ''}
                    exp={exportApi}
                    planFailed={exportPlanFailed}
                    stacked={projectDetails !== null}
                    unitOf={getUnit}
                    onClose={() => setExportOpen(false)}
                    onOpenModel={id => {
                        setExportOpen(false);
                        const m = allModels.find(x => x.id === id);
                        focusModel(id, m && isModelTrainedFresh(m) ? 'health' : 'model');
                    }}
                    onOpenProjectDetails={() => { void openProjectDetails(); }}
                    onOpenRunningCondition={() => { setExportOpen(false); setRcFilterOpen(true); }}
                    sensors={allSensors}
                    getComponent={getComponent}
                    onSaveRunningStatus={async (sensor, value) => {
                        const ok = await persistRunningCondition({
                            filters: [{ id: runningConditionFilters[0]?.id ?? `rcf-${Date.now()}`, sensor, operation: 'greater_than', value1: value, value2: '' }],
                        });
                        if (!ok) throw new Error(SAVE_FAILED_NOTICE);
                    }}
                />
            )}
            {/* After the Export dialog, so it sits on top of it (Esc closes only this one). */}
            {projectDetails && (
                <ProjectDetailsModal
                    workspace={projectDetails.ws}
                    existing={projectDetails.others}
                    onSaved={p => {
                        if (p.workspaceId !== workspaceIdRef.current) return;
                        reloadProjectInfo(p.workspaceId);
                        // The dry run's machine_info / folder name follow the new details.
                        if (exportOpen && !exporting) void workspaceExport.plan();
                    }}
                    onClose={() => setProjectDetails(null)}
                />
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
                    onClose={() => { setCloseAsk(false); void closeOrAskUnsaved(); }}
                />
            )}
            {unsavedAsk && (
                <CloseUnsavedDialog
                    models={allModels.filter(m => m.id in drafts).map(modelDisplayLabel)}
                    runningCondition={!!rcDraft && !rcDraftEqual(rcDraft, rcPersisted)}
                    onKeep={() => { setUnsavedAsk(false); tellCloseKept(); }}
                    onDiscard={() => { setUnsavedAsk(false); void closeNow(); }}
                />
            )}

            {/* Compare predictors: the Sub-models comparison (one fit per cumulative predictor subset) of the active Relationship model. */}
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
