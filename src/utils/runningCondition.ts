import type { FailureGroupStateSlice, FailureModel, TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../types';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';
import { modelSensorKey, sensorCategory } from './modelGrouping';
import {
    firstInvalidTestPeriodNumber, fixPeriodFirstText, newPeriodId, faultSide, testPeriodsError, toScoringPeriod, validatePeriods,
    type PeriodFault,
} from './timePeriods';

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
    /** SCORING periods ("test periods" until 2026-10-10) — the time the trained
     *  model gives a health score for; never trained on, never part of the
     *  train fingerprint. */
    testPeriods: TestPeriod[];
}

/**
 * The running condition (value conditions + train / scoring periods) a model
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
 *  explicit "Use all rows"). Gate copy of the workbench redesign (2026-10-10):
 *  it names the two ways out and never says "Step 1". */
export const NO_RUNNING_CONDITION_REASON = 'Set the running condition first — a condition, or Use all rows';

/** No train period, Workspace-mode model (SPEC rule 1). */
export const NO_TRAIN_PERIOD_REASON =
    'Add a train period — models learn only from the train periods, so pick times the machine was healthy (Running condition → Edit).';
/** No train period, Custom-mode model: points to its own Model settings (SPEC rule 7). */
export const NO_TRAIN_PERIOD_REASON_CUSTOM =
    'Add a train period in Model settings → Training data (Custom) — pick times the machine was healthy.';

/**
 * Why a model cannot train, as data. `reason` is the user-facing sentence
 * `getBuildBlockReason` returns; `kind` lets a caller tell the blockers apart
 * without reading the text, and an invalid train period also says WHICH one
 * (its P-number) and what is wrong with it.
 */
export type BuildBlock =
    | { kind: 'category'; mode: 'workspace' | 'custom'; reason: string }
    | { kind: 'no-condition'; mode: 'workspace' | 'custom'; reason: string }
    | { kind: 'invalid-train'; mode: 'workspace' | 'custom'; reason: string; periodNumber: number; fault: PeriodFault; rowReason: string }
    | { kind: 'no-train'; mode: 'workspace' | 'custom'; reason: string };

/**
 * The ONE gate for Train, Mark complete and re-train, as data (see
 * `BuildBlock`), else null. Order: category -> running condition -> invalid
 * train period -> no train period. `mode` is the model's own
 * `runningConditionMode` — in 'custom' the fix is inside its Model settings
 * (`customBlockText`), in 'workspace' it is the Running-condition settings.
 *
 * Train/Test validation (SPEC rule 1, 2026-10-07): at least one TRAIN period is
 * required — the old "no period = whole dataset" default is gone. Any period
 * counts, including one left open at both ends (that is the user's explicit
 * choice of the whole time range; the Add-period button's first default).
 * Scoring periods are NOT needed to train (`markCompleteBlockReason` asks for
 * them).
 */
export function getBuildBlock(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null): BuildBlock | null {
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
    return null;
}

/** `getBuildBlock` as the first blocking reason in user-facing text, else null. */
export function getBuildBlockReason(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null): string | null {
    return getBuildBlock(model, fg, headers)?.reason ?? null;
}

/**
 * The reason line of a model whose OWN (Custom) running condition blocks it
 * (workbench redesign §5 "Custom running condition"). The fix is inside the
 * model's Model settings, so the wording depends on whether that section is
 * open:
 *   - closed: "Own running condition: P1 ends before it starts. Fix it in Model settings"
 *   - open:   "Fix P1's end above"
 * The other two blockers follow the same pattern ("Own running condition: no
 * train period. Fix it in Model settings" / "Add a train period above"; "Own
 * running condition: not set. Fix it in Model settings" / "Set a condition
 * above, or choose Use all rows"). A `category` block — and any block of a
 * Workspace-mode model — is not about the model's own condition: its plain
 * `reason` is returned.
 */
export function customBlockText(block: BuildBlock, opts: { settingsOpen: boolean }): string {
    if (block.mode !== 'custom' || block.kind === 'category') return block.reason;
    if (opts.settingsOpen) {
        if (block.kind === 'invalid-train') return `Fix P${block.periodNumber}'s ${faultSide(block.fault)} above`;
        if (block.kind === 'no-train') return 'Add a train period above';
        return 'Set a condition above, or choose Use all rows';
    }
    const what = block.kind === 'invalid-train' ? block.reason
        : block.kind === 'no-train' ? 'no train period.'
        : 'not set.';
    return `Own running condition: ${what} Fix it in Model settings`;
}

/** Collapsed Model-settings summary of a Custom-mode model's own running
 *  condition: "Custom · 1 condition · 1 train · 0 scoring" ("Custom · all rows
 *  · …" when it uses all rows). */
export function customSummaryText(own: { noneConfirmed: boolean; conditions: number; trainPeriods: number; scoringPeriods: number }): string {
    const cond = own.noneConfirmed ? 'all rows' : `${own.conditions} condition${own.conditions === 1 ? '' : 's'}`;
    return `Custom · ${cond} · ${own.trainPeriods} train · ${own.scoringPeriods} scoring`;
}

/** Empty state of the Train periods section (Running-condition settings and a
 *  model's own Custom panel). */
export const NO_TRAIN_PERIOD_EMPTY_TEXT = 'No train period yet — add at least one';

/** The quiet grey note of the Scoring periods section while it is empty. It
 *  never blocks: `action` is what the surrounding form does — "apply" in the
 *  Running-condition settings, "save" in a model's own Custom panel. */
export function noScoringPeriodNote(action: 'apply' | 'save' = 'apply'): string {
    return `No scoring period yet — you can train and ${action} now; Mark complete needs at least one.`;
}

/** Last line of a model's own Custom panel. */
export const CUSTOM_PANEL_FOOTNOTE = 'Only this model · the workspace default is untouched · saved with Save changes';

/** No scoring period, Workspace-mode model. */
export const NO_TEST_PERIOD_REASON = 'Add a scoring period before marking complete (Running condition → Edit).';
/** No scoring period, Custom-mode model. */
export const NO_TEST_PERIOD_REASON_CUSTOM = 'Add a scoring period in Model settings → Training data (Custom) before marking complete.';

/**
 * The extra Mark complete requirement: at least one scoring period, and every
 * scoring period valid (start and end dates). Train itself does NOT need one.
 * Call it after `getBuildBlockReason` (which it does not repeat). Returns
 * user-facing text, or null.
 */
export function markCompleteBlockReason(model: FailureModel, fg: RunningConditionFg): string | null {
    const eff = effectiveRunningCondition(model, fg);
    if (eff.testPeriods.length === 0) return eff.mode === 'custom' ? NO_TEST_PERIOD_REASON_CUSTOM : NO_TEST_PERIOD_REASON;
    const bad = testPeriodsError(eff.testPeriods);
    if (bad) return eff.mode === 'custom' ? `${bad} Fix it in Model settings → Training data (Custom).` : `${bad} Fix it in Running condition → Edit.`;
    return null;
}

/**
 * Why the Running-condition settings modal's Apply is disabled.
 *  - `reason`: the short sentence about the period ("P2 ends before it starts.").
 *  - `footer`: the red line next to the disabled button — "Fix P2 before
 *    applying" / "Add a train period" / "Fix S1 before applying".
 *  - `periodNumber`: the P-number (`invalid-train`) or S-number
 *    (`invalid-test`) of the first invalid period.
 */
export type RunningConditionApplyBlock =
    | { kind: 'invalid-train'; reason: string; footer: string; periodNumber: number }
    | { kind: 'no-train'; reason: string; footer: string }
    | { kind: 'invalid-test'; reason: string; footer: string; periodNumber: number };

/** Short hint shown next to the disabled Apply when there is no train period. */
export const ADD_TRAIN_PERIOD_HINT = 'Add a train period';

/**
 * Apply gate of the Running-condition settings (workspace draft, or a Custom
 * model's own lists): an invalid train period, NO train period (SPEC rule 1 —
 * hint "Add a train period"), or an invalid scoring period (a missing /
 * unparseable date, or an end before its start) blocks it. A scoring period
 * that overlaps a train period does NOT, neither does having NO scoring period
 * (only Mark complete needs one), and neither does a train period overlapping
 * a highlight (rule 4).
 *
 * `action` only changes the footer wording: "applying" for the settings modal,
 * "saving" for a model's own Custom lists (saved with Save changes).
 */
export function runningConditionApplyBlock(
    periods: TimePeriod[],
    testPeriods: TestPeriod[] = [],
    action: 'applying' | 'saving' = 'applying',
): RunningConditionApplyBlock | null {
    const status = validatePeriods(periods);
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
    const n = firstInvalidTestPeriodNumber(testPeriods);
    if (n !== null) {
        return {
            kind: 'invalid-test',
            reason: testPeriodsError(testPeriods) ?? 'Fix the scoring periods.',
            footer: fixPeriodFirstText(`S${n}`, action),
            periodNumber: n,
        };
    }
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
 * The switch-to-Custom seed (SPEC rule 7), extended with scoring periods: each
 * of the model's own lists (conditions, train periods, scoring periods) is
 * copied from the workspace ONCE — only when it is still empty, so switching
 * Workspace → Custom → Workspace → Custom never overwrites the model's own
 * edits. Copies get fresh ids. A copied scoring period is start / end only
 * (`toScoringPeriod`): the legacy label / event time of a workspace saved
 * before 2026-10-10 is never written into a model's own list. Pure: the caller
 * stages `patch` into its draft.
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
        patch.customTestPeriods = workspace.testPeriods.map(t => toScoringPeriod({ ...t, id: periodId() }));
    }
    return { patch, copied };
}
