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
    /** User explicitly chose "No condition — use all rows". */
    noneConfirmed: boolean;
    /** TRAIN periods (required to train). */
    periods: TimePeriod[];
    /** SCORING periods — the time the trained
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
 *  explicit "Use all rows"). The copy names the two ways out and never says
 *  "Step 1". */
export const NO_RUNNING_CONDITION_REASON = 'Set the running condition first — a condition, or Use all rows';

/** No train period, Workspace-mode model. */
export const NO_TRAIN_PERIOD_REASON =
    'Add a train period — models learn only from the train periods, so pick times the machine was healthy (Running condition → Edit).';
/** No train period, Custom-mode model: points to its own Model settings. */
export const NO_TRAIN_PERIOD_REASON_CUSTOM =
    'Add a train period in Model settings → Training data (Custom) — pick times the machine was healthy.';

/**
 * The "no data to train on" guards: stop a train that has no data at the UI
 * instead of letting the engine fail, and warn at once
 * when a period is chosen beyond the data — NOT take away results that exist.
 *
 * What a caller may know about the LOADED DATA, beyond the saved condition
 * itself. Everything is optional and only ever ADDS a block, and only an ACTION
 * may pass it (Train; Apply / Save changes for a draft). The READ paths — a
 * trained model's charts, its Health score page, Mark complete, the dots, the
 * Dashboard — call the gate WITHOUT it and get only the plain rules.
 * Nothing here is persisted: it never changes a model's `status`,
 * fingerprint or `healthVerdict`.
 */
export interface GateOptions {
    /** The loaded dataset's time range (`get_dataset_time_bounds`), known for
     *  the CURRENT dataset generation only — unknown = nothing is judged.
     *  `getBuildBlock`: NO train period inside it blocks Train.
     *  `runningConditionApplyBlock`: a period that is new / changed in the draft
     *  and lies entirely outside it is invalid. */
    bounds?: PeriodDataBounds | null;
    /** The row count of the running condition this gate is about is SETTLED and
     *  its train periods together hold no running row (`countedNoTrainRows`). */
    noTrainRows?: boolean;
    /** `runningConditionApplyBlock` only: the SAVED lists the draft is judged
     *  against. A period unchanged from them never blocks (it warns). */
    savedPeriods?: PeriodBaseline;
    savedTestPeriods?: PeriodBaseline;
}

/** The red line of the Running-condition settings (workspace modal and a Custom
 *  model's own panel) when the counted train periods hold no running row. With
 *  "Use all rows" there is no condition to relax (`hasCondition: false`). */
export function noTrainRowsText(hasCondition = true): string {
    return `No rows match — nothing to train on. Widen a train period${hasCondition ? ' or relax the condition' : ''}.`;
}
/** `noTrainRowsText()` of a running condition that has a condition. */
export const NO_TRAIN_ROWS_TEXT = noTrainRowsText(true);
/** ...and the footer next to the disabled Apply / Save changes. */
export const NO_TRAIN_ROWS_FOOTER = 'No rows to train on';
/** The same state as the reason a model cannot train: where the fix is depends
 *  on whose running condition it is (the workspace's, or the model's own). */
export function noTrainRowsReason(mode: 'workspace' | 'custom', hasCondition = true): string {
    const what = `No rows match — nothing to train on. Widen a train period${hasCondition ? ' or relax the condition' : ''}`;
    return mode === 'custom' ? `${what} in Model settings → Training data (Custom).` : `${what} (Running condition → Edit).`;
}
/** `noTrainRowsReason('workspace')` / `('custom')` of a running condition that has a condition. */
export const NO_TRAIN_ROWS_REASON = noTrainRowsReason('workspace', true);
export const NO_TRAIN_ROWS_REASON_CUSTOM = noTrainRowsReason('custom', true);

/** Start of the reason of a model none of whose train periods is inside the data. */
export const NO_TRAIN_DATA_WORDS = 'No train period is inside the data';
/** "No train period is inside the data (2025/01/01 00:00 – 2025/12/31 23:50) — nothing to
 *  train on. Move a train period inside the data (Running condition → Edit)." */
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

/**
 * A model that HAS results (trained and up to date, or Complete) whose training
 * scope holds no row of the LOADED data: its charts are computed
 * from the loaded data, so they cannot be drawn — but nothing about the model
 * changed. The window says exactly that (one board, the model's own status
 * words), never "Couldn't load" / "Training failed".
 *   - `outside-data` — none of its train periods is inside the data;
 *   - `zero-rows`    — the settled count of its training scope is zero;
 *   - `engine`       — the count was not known yet and the engine answered
 *                      "no rows" to the silent load (`noRowsTrainError`).
 */
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
/** The footer's sentence, after the status pill: "Complete · no rows for it in the
 *  loaded file — fix the running condition to see its charts". */
export function noModelDataFooter(status: 'Complete' | 'Trained', mode: 'workspace' | 'custom'): string {
    return `${status} · no rows for it in the loaded file — fix ${mode === 'custom' ? 'its own running condition in Model settings' : 'the running condition'} to see its charts`;
}
/** Why Mark complete (again) is disabled then: the export could only fail. */
export function noModelDataMarkReason(mode: 'workspace' | 'custom'): string {
    return `${NO_MODEL_DATA_TITLE} — fix ${mode === 'custom' ? 'its own running condition in Model settings' : 'the running condition (Running condition → Edit)'} first`;
}

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
    | { kind: 'no-train'; mode: 'workspace' | 'custom'; reason: string }
    /** Truly nothing to train on (only with `GateOptions`, i.e. only for an
     *  ACTION): `outside-data` = no train period is inside the loaded data
     *  (`periodNumber` names it when there is just one), `zero-rows` = the
     *  settled count of the training scope holds no running row
     *  (`hasCondition: false` = "Use all rows" — there is no condition to relax). */
    | { kind: 'no-rows'; mode: 'workspace' | 'custom'; reason: string; cause: 'outside-data' | 'zero-rows'; periodNumber?: number; hasCondition: boolean };

/**
 * The ONE gate for Train, Mark complete and re-train, as data (see
 * `BuildBlock`), else null. Order: category -> running condition -> invalid
 * train period -> no train period. `mode` is the model's own
 * `runningConditionMode` — in 'custom' the fix is inside its Model settings
 * (`customBlockText`), in 'workspace' it is the Running-condition settings.
 *
 * At least one TRAIN period is required — no period does not mean "whole
 * dataset". Any period
 * counts, including one left open at both ends (that is the user's explicit
 * choice of the whole time range; the Add-period button's first default).
 * Scoring periods are NOT needed to train (`markCompleteBlockReason` asks for
 * them).
 *
 * `opts` (see `GateOptions` — pass it ONLY where Train is the
 * action; never for a read path): after everything above, `no-rows` when there
 * is truly nothing to train on — NO train period is inside the loaded data
 * (`bounds`), or the settled count of the training scope is zero
 * (`noTrainRows`). One train period outside the data next to one inside it
 * blocks nothing: it is simply not used (the card and its row warn).
 */
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
    const hasCondition = !eff.noneConfirmed;
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
 * above, or choose Use all rows"; "Own running condition: no rows to train on.
 * Fix it in Model settings" / "Above: widen a train period or relax the
 * condition"; "Own running condition: no train period is inside the data. Fix
 * it in Model settings" / "Above: move P1 inside the data range"). A `category`
 * block — and any block of a
 * Workspace-mode model — is not about the model's own condition: its plain
 * `reason` is returned.
 */
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
        return 'Set a condition above, or choose Use all rows';
    }
    const what = block.kind === 'invalid-train' ? block.reason
        : block.kind === 'no-train' ? 'no train period.'
        : block.kind === 'no-rows' ? (block.cause === 'outside-data' ? 'no train period is inside the data.' : 'no rows to train on.')
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
 * user-facing text, or null. (Deliberately NOT judged against the loaded data's
 * time range: a saved scoring period outside the data is a warning on its row
 * and on the card, and Mark complete's own rule is unchanged.)
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
    | { kind: 'invalid-test'; reason: string; footer: string; periodNumber: number }
    /** The counted train periods hold no running row (`GateOptions.noTrainRows`):
     *  `reason` is the red line of the panel, `footer` "No rows to train on". */
    | { kind: 'no-rows'; reason: string; footer: string };


/** Short hint shown next to the disabled Apply when there is no train period. */
export const ADD_TRAIN_PERIOD_HINT = 'Add a train period';

/**
 * Apply gate of the Running-condition settings (workspace draft, or a Custom
 * model's own lists): an invalid train period, NO train period (hint "Add a
 * train period"), or an invalid scoring period (a missing /
 * unparseable date, or an end before its start) blocks it. A scoring period
 * that overlaps a train period does NOT, neither does having NO scoring period
 * (only Mark complete needs one), and neither does a train period overlapping
 * a highlight.
 *
 * `action` only changes the footer wording: "applying" for the settings modal,
 * "saving" for a model's own Custom lists (saved with Save changes).
 *
 * `opts` (see `GateOptions`): with the dataset bounds a train or
 * scoring period that is NEW or was CHANGED in this draft (against
 * `savedPeriods` / `savedTestPeriods`) and lies ENTIRELY outside the loaded
 * data is invalid like any other ("Fix P1 before applying"); a period that is
 * unchanged from the saved state never blocks — it only warns on its row. With
 * `noTrainRows` — the count of this very draft is settled and its train periods
 * hold no running row — the last block is `no-rows` ("No rows to train on"; the
 * caller passes it only when the draft changed what is trained on). A count
 * that is loading, stale or failed never blocks.
 * `hasCondition: false` = "Use all rows": the no-rows line does not say "relax
 * the condition".
 */
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
 * The switch-to-Custom seed: each
 * of the model's own lists (conditions, train periods, scoring periods) is
 * copied from the workspace ONCE — only when it is still empty, so switching
 * Workspace → Custom → Workspace → Custom never overwrites the model's own
 * edits. Copies get fresh ids. A copied scoring period is start / end only
 * (`toScoringPeriod`): the legacy label / event time of an old workspace file
 * is never written into a model's own list. Pure: the caller
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
