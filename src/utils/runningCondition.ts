import type { FailureGroupStateSlice, FailureModel, TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../types';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';
import { modelSensorKey, sensorCategory } from './modelGrouping';
import {
    allPeriodsOutsideData, dataRangeText, firstInvalidTestPeriodNumber, fixPeriodFirstText, newPeriodId, faultSide, testPeriodsError,
    toScoringPeriod, validatePeriods,
    type PeriodBaseline, type PeriodDataBounds, type PeriodFault,
} from './timePeriods';

/** The parts of the failure-group slice these helpers read. */
export type RunningConditionFg = Partial<FailureGroupStateSlice> | null | undefined;

export interface EffectiveRunningCondition {
    mode: 'workspace' | 'custom';
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    /** 'Use all data': every row of the periods trains and scores; no condition needed. The export still asks for running status. */
    allData: boolean;
    /** TRAIN periods (required to train). */
    periods: TimePeriod[];
    /** Scoring periods: time the trained model gives a score for; never trained on, not in the train fingerprint. */
    testPeriods: TestPeriod[];
}

/** The running condition a model uses: the workspace's, or its own in 'custom' mode. A missing period list reads as [] (no train period yet), not the whole dataset. */
export function effectiveRunningCondition(model: FailureModel, fg: RunningConditionFg): EffectiveRunningCondition {
    if (model.runningConditionMode === 'custom') {
        return {
            mode: 'custom',
            filters: model.customRunningConditionFilters ?? [],
            combine: model.customRunningConditionCombine ?? 'and',
            allData: model.customRunningConditionAllData ?? false,
            periods: model.filterTimePeriods ?? [],
            testPeriods: model.customTestPeriods ?? [],
        };
    }
    return {
        mode: 'workspace',
        filters: fg?.runningConditionFilters ?? [],
        combine: fg?.runningConditionCombine ?? 'and',
        allData: fg?.runningConditionAllData ?? false,
        periods: fg?.runningConditionTimePeriods ?? [],
        testPeriods: fg?.runningConditionTestPeriods ?? [],
    };
}

/** A row the training query applies: sensor set (and in `headers` when given, since Rust silently drops unknown sensors), `value1` filled, and `between` also needs `value2`. */
export function isCompleteCondition(f: WorkspaceSensorFilter, headers?: string[] | null): boolean {
    if (!f.sensor || !f.sensor.trim()) return false;
    if (headers) {
        const key = normalizeSensorTag(f.sensor);
        if (!headers.some((h) => normalizeSensorTag(h) === key)) return false;
    }
    if (!(f.value1 ?? '').trim()) return false;
    if (f.operation === 'between' && !(f.value2 ?? '').trim()) return false;
    return true;
}

/** Has a complete 'sensor > value' row. */
function hasAboveCondition(filters: WorkspaceSensorFilter[], headers?: string[] | null): boolean {
    return filters.some((f) => f.operation === 'greater_than' && isCompleteCondition(f, headers));
}

/** Workspace condition is set: 'Use all data', or its one complete 'sensor > value' row. Time periods never count. */
export function isWorkspaceRunningConditionConfigured(fg: RunningConditionFg, headers?: string[] | null): boolean {
    return !!fg?.runningConditionAllData || hasAboveCondition(fg?.runningConditionFilters ?? [], headers);
}

/** Is this model's EFFECTIVE running condition (workspace or Custom) configured? */
export function isRunningConditionConfigured(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null): boolean {
    const eff = effectiveRunningCondition(model, fg);
    return eff.allData || hasAboveCondition(eff.filters, headers);
}

/** Single source for the missing-category reason. */
export const CATEGORY_BLOCK_REASON = 'Pick a category on the sensor header.';

/** The effective running condition (its one "sensor > value" line) is not set.
 *  The copy never says "Step 1". */
export const NO_RUNNING_CONDITION_REASON = 'Set the running condition first — the sensor that shows the machine is running, and the value above which it runs';

/** No train period, Workspace-mode model. */
export const NO_TRAIN_PERIOD_REASON =
    'Add a train period — models learn only from the train periods, so pick times the machine was healthy (Running condition → Edit).';
/** No train period, Custom-mode model: points to its own Model settings. */
export const NO_TRAIN_PERIOD_REASON_CUSTOM =
    'Add a train period in Model settings → Training data (Custom) — pick times the machine was healthy.';

/** The 'no data to train on' guards stop Train in the UI and warn when a period lies beyond the data. Nothing is persisted. `GateOptions` is loaded-data knowledge that only an ACTION (Train, Apply/Save) may pass; read paths call the gate without it. */
export interface GateOptions {
    /** Loaded dataset's time range, current generation only; unknown = nothing judged. Train: no train period inside it blocks. Apply: a new/changed period entirely outside it is invalid. */
    bounds?: PeriodDataBounds | null;
    /** Row count for this condition is settled and its train periods hold no running row (`countedNoTrainRows`). */
    noTrainRows?: boolean;
    /** Apply only: the saved lists the draft is judged against; an unchanged period never blocks (it warns). */
    savedPeriods?: PeriodBaseline;
    savedTestPeriods?: PeriodBaseline;
}

/** Red line when counted train periods hold no running row; `hasCondition: false` = 'Use all data'. */
export function noTrainRowsText(hasCondition = true): string {
    return `No rows match — nothing to train on. Widen a train period${hasCondition ? ' or relax the condition' : ''}.`;
}
/** `noTrainRowsText()` of a running condition that has a condition. */
export const NO_TRAIN_ROWS_TEXT = noTrainRowsText(true);
/** ...and the footer next to the disabled Apply / Save changes. */
export const NO_TRAIN_ROWS_FOOTER = 'No rows to train on';
/** Same state as the reason a model can't train; where to fix it depends on whose condition (workspace or the model's own). */
export function noTrainRowsReason(mode: 'workspace' | 'custom', hasCondition = true): string {
    const what = `No rows match — nothing to train on. Widen a train period${hasCondition ? ' or relax the condition' : ''}`;
    return mode === 'custom' ? `${what} in Model settings → Training data (Custom).` : `${what} (Running condition → Edit).`;
}

/** Start of the reason of a model none of whose train periods is inside the data. */
export const NO_TRAIN_DATA_WORDS = 'No train period is inside the data';
export function noTrainDataReason(mode: 'workspace' | 'custom', bounds: PeriodDataBounds | null | undefined): string {
    const what = `${NO_TRAIN_DATA_WORDS} (${dataRangeText(bounds)}) — nothing to train on. Move a train period inside the data`;
    return mode === 'custom' ? `${what} in Model settings → Training data (Custom).` : `${what} (Running condition → Edit).`;
}
/** The short form for a list row / a badge. */
export const NO_TRAIN_DATA_SHORT = 'No train period inside the data';

/** What kind of "nothing to train on" a reason is (the preflight list keys on it), or null. */
export function noTrainDataKindOf(reason: string): { cause: 'outside-data' | 'zero-rows'; mode: 'workspace' | 'custom' } | null {
    const mode = /\(Running condition → Edit\)\.$/.test(reason) ? 'workspace' : 'custom';
    if (reason.startsWith(NO_TRAIN_DATA_WORDS)) return { cause: 'outside-data', mode };
    if (reason.startsWith('No rows match — nothing to train on.')) return { cause: 'zero-rows', mode };
    return null;
}

/** Results exist but the training scope holds no row of the loaded data: say so, never 'Couldn't load'/'Training failed'. `outside-data`: no train period in the data; `zero-rows`: settled count 0; `engine`: count unknown, engine said 'no rows'. */
export type NoModelDataCause = 'outside-data' | 'zero-rows' | 'engine';
/** The board's title. */
export const NO_MODEL_DATA_TITLE = 'No data for this model in the loaded file';
/** After the status words in a dot's tooltip: "Complete · no data in the loaded file". */
export const NO_MODEL_DATA_WORDS = 'no data in the loaded file';
/** The board's one sentence: the cause, as the guard found it. */
export function noModelDataCauseText(cause: NoModelDataCause, bounds: PeriodDataBounds | null | undefined, hasCondition = true): string {
    if (cause === 'outside-data') return `None of its train periods is inside the data (${dataRangeText(bounds)}).`;
    if (cause === 'engine') return 'No row inside its train periods passes the running condition with values for this model.';
    return hasCondition ? 'No row passes the running condition in its train periods.' : 'Its train periods hold no row of the data.';
}
/** Footer sentence after the status pill when the model has no rows in the loaded file. */
export function noModelDataFooter(status: 'Complete' | 'Trained', mode: 'workspace' | 'custom'): string {
    return `${status} · no rows for it in the loaded file — fix ${mode === 'custom' ? 'its own running condition in Model settings' : 'the running condition'} to see its charts`;
}
/** Why Mark complete is disabled then. */
export function noModelDataMarkReason(mode: 'workspace' | 'custom'): string {
    return `${NO_MODEL_DATA_TITLE} — fix ${mode === 'custom' ? 'its own running condition in Model settings' : 'the running condition (Running condition → Edit)'} first`;
}

/** Why a model can't train: `reason` is the user text, `kind` the blocker; an invalid train period adds its P-number and fault. */
export type BuildBlock =
    | { kind: 'category'; mode: 'workspace' | 'custom'; reason: string }
    | { kind: 'no-condition'; mode: 'workspace' | 'custom'; reason: string }
    | { kind: 'invalid-train'; mode: 'workspace' | 'custom'; reason: string; periodNumber: number; fault: PeriodFault; rowReason: string }
    | { kind: 'no-train'; mode: 'workspace' | 'custom'; reason: string }
    /** Nothing to train on (only with `GateOptions`, i.e. an ACTION): `outside-data` = no train period in the data; `zero-rows` = settled count is zero (`hasCondition` false on 'Use all data'). */
    | { kind: 'no-rows'; mode: 'workspace' | 'custom'; reason: string; cause: 'outside-data' | 'zero-rows'; periodNumber?: number; hasCondition: boolean };

/** The ONE gate for Train, Mark complete and re-train, else null. Order: category, condition, invalid period, no train period. At least one TRAIN period is required (none is not the whole dataset; an open-ended one counts); scoring periods aren't. */
export function getBuildBlock(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null, opts?: GateOptions | null): BuildBlock | null {
    const eff = effectiveRunningCondition(model, fg);
    const mode = eff.mode;
    const category = model.category ?? sensorCategory(fg?.models ?? [], modelSensorKey(model));
    if (category == null) return { kind: 'category', mode, reason: CATEGORY_BLOCK_REASON };
    if (!isRunningConditionConfigured(model, fg, headers)) {
        return { kind: 'no-condition', mode, reason: NO_RUNNING_CONDITION_REASON };
    }
    const status = validatePeriods(eff.periods);
    const i = status.findIndex((s) => s.invalid);
    if (i >= 0) {
        const bad = status[i];
        const reason = bad.reason ?? 'Fix the training period dates.';
        return {
            kind: 'invalid-train', mode, reason, periodNumber: i + 1,
            fault: bad.fault ?? 'ends-before-start',
            rowReason: bad.rowReason ?? reason.replace(/\.$/, ''),
        };
    }
    if (eff.periods.length === 0) {
        return { kind: 'no-train', mode, reason: mode === 'custom' ? NO_TRAIN_PERIOD_REASON_CUSTOM : NO_TRAIN_PERIOD_REASON };
    }
    // On "Use all data" no condition picks the rows: nothing to relax.
    const hasCondition = !eff.allData;
    if (opts?.bounds && allPeriodsOutsideData(eff.periods, opts.bounds)) {
        return {
            kind: 'no-rows', mode, cause: 'outside-data', hasCondition,
            reason: noTrainDataReason(mode, opts.bounds),
            ...(eff.periods.length === 1 ? { periodNumber: 1 } : {}),
        };
    }
    if (opts?.noTrainRows) {
        return { kind: 'no-rows', mode, cause: 'zero-rows', hasCondition, reason: noTrainRowsReason(mode, hasCondition) };
    }
    return null;
}

/** `getBuildBlock` as the first blocking reason in user-facing text, else null. */
export function getBuildBlockReason(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null, opts?: GateOptions | null): string | null {
    return getBuildBlock(model, fg, headers, opts)?.reason ?? null;
}

/** Reason line for a model whose OWN (Custom) condition blocks it; wording depends on whether Model settings is open. Category and Workspace-mode blocks return the plain `reason`. */
export function customBlockText(block: BuildBlock, opts: { settingsOpen: boolean }): string {
    if (block.mode !== 'custom' || block.kind === 'category') return block.reason;
    if (opts.settingsOpen) {
        if (block.kind === 'invalid-train') {
            return block.fault === 'outside-data'
                ? `Above: move P${block.periodNumber} inside the data range`
                : `Fix P${block.periodNumber}'s ${faultSide(block.fault)} above`;
        }
        if (block.kind === 'no-train') return 'Add a train period above';
        if (block.kind === 'no-rows') {
            if (block.cause === 'outside-data') return `Above: move ${block.periodNumber ? `P${block.periodNumber}` : 'a train period'} inside the data range`;
            return `Above: widen a train period${block.hasCondition ? ' or relax the condition' : ''}`;
        }
        return 'Pick the sensor and the value under “When the machine is running” above';
    }
    const what = block.kind === 'invalid-train' ? block.reason
        : block.kind === 'no-train' ? 'no train period.'
        : block.kind === 'no-rows' ? (block.cause === 'outside-data' ? 'no train period is inside the data.' : 'no rows to train on.')
        : 'not set.';
    return `Own running condition: ${what} Fix it in Model settings`;
}

/** Collapsed Model-settings summary of a Custom model, e.g. 'Custom · own running condition · 1 train · 0 scoring'. */
export function customSummaryText(own: { allData: boolean; conditions: number; trainPeriods: number; scoringPeriods: number }): string {
    const cond = own.allData ? 'all data' : own.conditions > 0 ? 'own running condition' : 'running condition not set';
    return `Custom · ${cond} · ${own.trainPeriods} train · ${own.scoringPeriods} scoring`;
}

/** Empty state of the Train periods section (Running-condition settings and a
 *  model's own Custom panel). */
export const NO_TRAIN_PERIOD_EMPTY_TEXT = 'No train period yet — add at least one';

/** Grey note while Scoring periods is empty; never blocks. `action`: 'apply' in settings, 'save' in a Custom panel. */
export function noScoringPeriodNote(action: 'apply' | 'save' = 'apply'): string {
    return `No scoring period yet — you can train and ${action} now; Mark complete needs at least one.`;
}

/** Last line of a model's own Custom panel. */
export const CUSTOM_PANEL_FOOTNOTE = 'Only this model · the workspace default is untouched · saved with Save changes';

/** No scoring period, Workspace-mode model. */
export const NO_TEST_PERIOD_REASON = 'Add a scoring period before marking complete (Running condition → Edit).';
/** No scoring period, Custom-mode model. */
export const NO_TEST_PERIOD_REASON_CUSTOM = 'Add a scoring period in Model settings → Training data (Custom) before marking complete.';

/** Extra Mark complete requirement: at least one scoring period, all valid. Call after `getBuildBlockReason`. Not judged against the data range (outside-data only warns). */
export function markCompleteBlockReason(model: FailureModel, fg: RunningConditionFg): string | null {
    const eff = effectiveRunningCondition(model, fg);
    if (eff.testPeriods.length === 0) return eff.mode === 'custom' ? NO_TEST_PERIOD_REASON_CUSTOM : NO_TEST_PERIOD_REASON;
    const bad = testPeriodsError(eff.testPeriods);
    if (bad) return eff.mode === 'custom' ? `${bad} Fix it in Model settings → Training data (Custom).` : `${bad} Fix it in Running condition → Edit.`;
    return null;
}

/** Why Apply is disabled. `reason`: short sentence; `footer`: red line beside the button; `periodNumber`: P- or S-number of the first invalid period. */
export type RunningConditionApplyBlock =
    | { kind: 'invalid-train'; reason: string; footer: string; periodNumber: number }
    | { kind: 'no-train'; reason: string; footer: string }
    | { kind: 'invalid-test'; reason: string; footer: string; periodNumber: number }
    /** Counted train periods hold no running row (`noTrainRows`): `reason` is the panel's red line, `footer` 'No rows to train on'. */
    | { kind: 'no-rows'; reason: string; footer: string };


/** Short hint shown next to the disabled Apply when there is no train period. */
export const ADD_TRAIN_PERIOD_HINT = 'Add a train period';

/** Apply gate (workspace draft or Custom lists): blocked by an invalid or missing train period, or an invalid scoring period. Overlaps, no scoring period and unsettled counts never block; `noTrainRows` adds `no-rows`. */
export function runningConditionApplyBlock(
    periods: TimePeriod[],
    testPeriods: TestPeriod[] = [],
    action: 'applying' | 'saving' = 'applying',
    opts?: (GateOptions & { hasCondition?: boolean }) | null,
): RunningConditionApplyBlock | null {
    const bounds = opts?.bounds;
    const status = validatePeriods(periods, bounds, opts?.savedPeriods);
    const i = status.findIndex((s) => s.invalid);
    if (i >= 0) {
        return {
            kind: 'invalid-train',
            reason: status[i].reason ?? 'Fix the invalid training period first.',
            footer: fixPeriodFirstText(`P${i + 1}`, action),
            periodNumber: i + 1,
        };
    }
    if (periods.length === 0) return { kind: 'no-train', reason: ADD_TRAIN_PERIOD_HINT, footer: ADD_TRAIN_PERIOD_HINT };
    const n = firstInvalidTestPeriodNumber(testPeriods, bounds, opts?.savedTestPeriods);
    if (n !== null) {
        return {
            kind: 'invalid-test',
            reason: testPeriodsError(testPeriods, bounds, opts?.savedTestPeriods) ?? 'Fix the scoring periods.',
            footer: fixPeriodFirstText(`S${n}`, action),
            periodNumber: n,
        };
    }
    if (opts?.noTrainRows) return { kind: 'no-rows', reason: noTrainRowsText(opts.hasCondition !== false), footer: NO_TRAIN_ROWS_FOOTER };
    return null;
}

/** What `seedCustomFromWorkspace` reads from the model's current (draft) Custom lists. */
export interface CustomSeedCurrent {
    customFilters: WorkspaceSensorFilter[];
    customPeriods: TimePeriod[];
    customTestPeriods: TestPeriod[];
}

/** The workspace defaults copied into a model that switches to Custom. */
export interface CustomSeedWorkspace {
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    /** The workspace's "Use all data" — copied along with the condition. */
    allData?: boolean;
    periods: TimePeriod[];
    testPeriods: TestPeriod[];
}

export interface CustomSeedResult {
    /** Only the lists that were empty AND had something to copy. */
    patch: {
        customFilters?: WorkspaceSensorFilter[];
        customCombine?: 'and' | 'or';
        customAllData?: boolean;
        customPeriods?: TimePeriod[];
        customTestPeriods?: TestPeriod[];
    };
    /** How many of each were copied (for the "Copied … from Workspace" note). */
    copied: { conditions: number; periods: number; tests: number };
}

const newFilterId = () => `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Seeds Custom from the workspace: each own list is copied ONCE, only while empty, so toggling never overwrites edits. Copies get fresh ids; scoring copies are start/end only. Pure: the caller stages `patch`. */
export function seedCustomFromWorkspace(
    current: CustomSeedCurrent,
    workspace: CustomSeedWorkspace,
    ids: { period?: () => string; filter?: () => string } = {},
): CustomSeedResult {
    const periodId = ids.period ?? newPeriodId;
    const filterId = ids.filter ?? newFilterId;
    const patch: CustomSeedResult['patch'] = {};
    const copied = { conditions: 0, periods: 0, tests: 0 };
    if (current.customFilters.length === 0) {
        if (workspace.filters.length > 0) {
            copied.conditions = workspace.filters.length;
            patch.customFilters = workspace.filters.map(f => ({ ...f, id: filterId() }));
            patch.customCombine = workspace.combine;
        }
        // On "Use all data" the line is usually empty: the choice itself is what is copied.
        if (workspace.allData) {
            patch.customAllData = true;
            copied.conditions = Math.max(copied.conditions, 1);
        }
    }
    if (current.customPeriods.length === 0 && workspace.periods.length > 0) {
        copied.periods = workspace.periods.length;
        patch.customPeriods = workspace.periods.map(p => ({ ...p, id: periodId() }));
    }
    if (current.customTestPeriods.length === 0 && workspace.testPeriods.length > 0) {
        copied.tests = workspace.testPeriods.length;
        patch.customTestPeriods = workspace.testPeriods.map(t => toScoringPeriod({ ...t, id: periodId() }));
    }
    return { patch, copied };
}
