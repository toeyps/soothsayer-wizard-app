import type { FailureGroupStateSlice, FailureModel, TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../types';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';
import { modelSensorKey, sensorCategory } from './modelGrouping';
import { newPeriodId, testPeriodsError, validatePeriods } from './timePeriods';

/** The parts of the failure-group slice these helpers read. */
export type RunningConditionFg = Partial<FailureGroupStateSlice> | null | undefined;

export interface EffectiveRunningCondition {
    mode: 'workspace' | 'custom';
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    /** User explicitly chose "No condition — use all rows". */
    noneConfirmed: boolean;
    /** TRAIN periods (required to train since 2026-10-07). */
    periods: TimePeriod[];
    /** TEST periods (Train/Test validation, 2026-10-07) — where the score is
     *  checked; never trained on, never part of the train fingerprint. */
    testPeriods: TestPeriod[];
}

/**
 * The running condition (value conditions + train/test periods) a model
 * actually uses: the workspace default in 'workspace' mode, the model's own in
 * 'custom'. Periods are always lists (`migratePeriods` turns old start/end
 * pairs into them at load; a missing list reads as `[]` — which, since the
 * Train/Test change, means "no train period yet", not "whole dataset").
 */
export function effectiveRunningCondition(model: FailureModel, fg: RunningConditionFg): EffectiveRunningCondition {
    if (model.runningConditionMode === 'custom') {
        return {
            mode: 'custom',
            filters: model.customRunningConditionFilters ?? [],
            combine: model.customRunningConditionCombine ?? 'and',
            noneConfirmed: model.customRunningConditionNoneConfirmed ?? false,
            periods: model.filterTimePeriods ?? [],
            testPeriods: model.customTestPeriods ?? [],
        };
    }
    return {
        mode: 'workspace',
        filters: fg?.runningConditionFilters ?? [],
        combine: fg?.runningConditionCombine ?? 'and',
        noneConfirmed: fg?.runningConditionNoneConfirmed ?? false,
        periods: fg?.runningConditionTimePeriods ?? [],
        testPeriods: fg?.runningConditionTestPeriods ?? [],
    };
}

/**
 * A row the training query will actually apply: sensor chosen (and present in
 * `headers` when given — Rust silently drops conditions on missing sensors),
 * `value1` filled, and `between` also needs `value2`.
 */
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

function isConfigured(filters: WorkspaceSensorFilter[], noneConfirmed: boolean, headers?: string[] | null): boolean {
    return noneConfirmed || filters.some((f) => isCompleteCondition(f, headers));
}

/** Workspace-level: >=1 complete row OR "No condition" confirmed. Time periods never count. */
export function isWorkspaceRunningConditionConfigured(fg: RunningConditionFg, headers?: string[] | null): boolean {
    return isConfigured(fg?.runningConditionFilters ?? [], fg?.runningConditionNoneConfirmed ?? false, headers);
}

/** Is this model's EFFECTIVE running condition (workspace or Custom) configured? */
export function isRunningConditionConfigured(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null): boolean {
    const eff = effectiveRunningCondition(model, fg);
    return isConfigured(eff.filters, eff.noneConfirmed, headers);
}

/** Single source for the missing-category reason (Overview footer, pill, Finish). */
export const CATEGORY_BLOCK_REASON = 'Pick a category on the sensor header.';

/** The effective running condition is not configured (no condition and no
 *  explicit "No condition — use all rows"). */
export const NO_RUNNING_CONDITION_REASON = 'Set a running condition first, or choose "No condition — use all rows".';

/** No train period, Workspace-mode model (SPEC rule 1). */
export const NO_TRAIN_PERIOD_REASON =
    'Add a train period — models learn only from the train periods, so pick times the machine was healthy (Running condition → Edit).';
/** No train period, Custom-mode model: points to its own Model settings (SPEC rule 7). */
export const NO_TRAIN_PERIOD_REASON_CUSTOM =
    'Add a train period in Model settings → Training data (Custom) — pick times the machine was healthy.';

/**
 * The ONE gate for Train, Mark complete and re-train. Returns the first
 * blocking reason as user-facing text, else null. Order: category -> running
 * condition -> invalid train period -> no train period.
 *
 * Train/Test validation (SPEC rule 1, 2026-10-07): at least one TRAIN period is
 * required — the old "no period = whole dataset" default is gone. Any period
 * counts, including one left open at both ends (that is the user's explicit
 * choice of the whole time range; the Add-period button's first default). Test
 * periods are NOT needed to train (`markCompleteBlockReason` asks for them).
 */
export function getBuildBlockReason(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null): string | null {
    const category = model.category ?? sensorCategory(fg?.models ?? [], modelSensorKey(model));
    if (category == null) return CATEGORY_BLOCK_REASON;
    if (!isRunningConditionConfigured(model, fg, headers)) {
        return NO_RUNNING_CONDITION_REASON;
    }
    const eff = effectiveRunningCondition(model, fg);
    const bad = validatePeriods(eff.periods).find((s) => s.invalid);
    if (bad) return bad.reason ?? 'Fix the training period dates.';
    if (eff.periods.length === 0) return eff.mode === 'custom' ? NO_TRAIN_PERIOD_REASON_CUSTOM : NO_TRAIN_PERIOD_REASON;
    return null;
}

/** No test period, Workspace-mode model (SPEC rule 2). */
export const NO_TEST_PERIOD_REASON = 'Add a test period before marking complete (Running condition → Edit).';
/** No test period, Custom-mode model. */
export const NO_TEST_PERIOD_REASON_CUSTOM = 'Add a test period in Model settings → Training data (Custom) before marking complete.';

/**
 * The extra Mark complete requirement of SPEC rule 2: at least one test
 * period, and every test period valid (dates + event time). Train itself does
 * NOT need a test. Call it after `getBuildBlockReason` (which it does not
 * repeat). Returns user-facing text, or null.
 */
export function markCompleteBlockReason(model: FailureModel, fg: RunningConditionFg): string | null {
    const eff = effectiveRunningCondition(model, fg);
    if (eff.testPeriods.length === 0) return eff.mode === 'custom' ? NO_TEST_PERIOD_REASON_CUSTOM : NO_TEST_PERIOD_REASON;
    const bad = testPeriodsError(eff.testPeriods);
    if (bad) return eff.mode === 'custom' ? `${bad} Fix it in Model settings → Training data (Custom).` : `${bad} Fix it in Running condition → Edit.`;
    return null;
}

/** Why the Running-condition settings modal's Apply is disabled. */
export type RunningConditionApplyBlock =
    | { kind: 'invalid-train'; reason: string }
    | { kind: 'no-train'; reason: string }
    | { kind: 'invalid-test'; reason: string };

/** Short hint shown next to the disabled Apply when there is no train period. */
export const ADD_TRAIN_PERIOD_HINT = 'Add a train period';

/**
 * Apply gate of the Running-condition settings (workspace draft, or a Custom
 * model's own lists): an invalid train period, NO train period (SPEC rule 1 —
 * hint "Add a train period"), or an invalid test period / event time (SPEC
 * rule 5) blocks it. A test period that overlaps a train period does NOT
 * (rule 3), and neither does a train period overlapping a highlight (rule 4).
 */
export function runningConditionApplyBlock(periods: TimePeriod[], testPeriods: TestPeriod[] = []): RunningConditionApplyBlock | null {
    const bad = validatePeriods(periods).find((s) => s.invalid);
    if (bad) return { kind: 'invalid-train', reason: bad.reason ?? 'Fix the invalid training period first.' };
    if (periods.length === 0) return { kind: 'no-train', reason: ADD_TRAIN_PERIOD_HINT };
    const badTest = testPeriodsError(testPeriods);
    if (badTest) return { kind: 'invalid-test', reason: badTest };
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
    periods: TimePeriod[];
    testPeriods: TestPeriod[];
}

export interface CustomSeedResult {
    /** Only the lists that were empty AND had something to copy. */
    patch: {
        customFilters?: WorkspaceSensorFilter[];
        customCombine?: 'and' | 'or';
        customPeriods?: TimePeriod[];
        customTestPeriods?: TestPeriod[];
    };
    /** How many of each were copied (for the "Copied … from Workspace" note). */
    copied: { conditions: number; periods: number; tests: number };
}

const newFilterId = () => `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The switch-to-Custom seed (SPEC rule 7), extended with test periods: each of
 * the model's own lists (conditions, train periods, test periods) is copied
 * from the workspace ONCE — only when it is still empty, so switching
 * Workspace → Custom → Workspace → Custom never overwrites the model's own
 * edits. Copies get fresh ids. Pure: the caller stages `patch` into its draft.
 */
export function seedCustomFromWorkspace(
    current: CustomSeedCurrent,
    workspace: CustomSeedWorkspace,
    ids: { period?: () => string; filter?: () => string } = {},
): CustomSeedResult {
    const periodId = ids.period ?? newPeriodId;
    const filterId = ids.filter ?? newFilterId;
    const patch: CustomSeedResult['patch'] = {};
    const copied = { conditions: 0, periods: 0, tests: 0 };
    if (current.customFilters.length === 0 && workspace.filters.length > 0) {
        copied.conditions = workspace.filters.length;
        patch.customFilters = workspace.filters.map(f => ({ ...f, id: filterId() }));
        patch.customCombine = workspace.combine;
    }
    if (current.customPeriods.length === 0 && workspace.periods.length > 0) {
        copied.periods = workspace.periods.length;
        patch.customPeriods = workspace.periods.map(p => ({ ...p, id: periodId() }));
    }
    if (current.customTestPeriods.length === 0 && workspace.testPeriods.length > 0) {
        copied.tests = workspace.testPeriods.length;
        patch.customTestPeriods = workspace.testPeriods.map(t => ({ ...t, id: periodId() }));
    }
    return { patch, copied };
}
