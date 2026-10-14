import { invoke } from '@tauri-apps/api/core';
import type { TestPeriod, TimePeriod } from '../types';
import type { TrainingScopeFilter } from '../types/health';
import type { PeriodCount, PeriodCountArg, PeriodCountCondition, PeriodCounts } from '../types/periodCounts';
import { validatePeriods, validateTestPeriods, type PeriodBaseline } from './timePeriods';
import { isBelowRecommendedTrainDays, RECOMMENDED_TRAIN_DAYS, trainDaysWarning } from './trainTestValidation';
import { parseLocal } from './workbenchDate';

/*
 * Per-period running-row counts for the Running-condition settings: the
 * binding of the Rust command `count_period_rows`, the
 * request builders, and the pure builders of what the modal prints from the
 * answer — the one caption under the timeline
 *
 *   117 d train (about 100 d running time) · 59 d scoring · ≥ 30 d recommended
 *
 * and one quiet line per period row ("P1 · 81 d · 69 d running").
 *
 * The counts are read as DAYS of running time and as the "nothing to train on"
 * verdict only. NO number of data rows is ever printed (user decision
 * 2026-10-14: the Build Model window never says how many rows are used — do not
 * add a "N of M rows (x%)" sentence, a "Counting rows…" text or a percentage back).
 *
 * The React side (debounce, stale-answer guard, the two calls) is
 * `usePeriodCounts` in `src/hooks/usePeriodCounts.ts`.
 */

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * `count_period_rows`: for each period the dataset rows inside it and how many
 * of them pass the running condition, plus the union over the call's valid
 * periods. `condition` null = no condition (every row in a period is running).
 * `expectedGeneration` pins the dataset this window was opened on — another
 * dataset answers `STALE_SESSION: …`.
 */
export function countPeriodRows(
    periods: PeriodCountArg[],
    condition: PeriodCountCondition | null,
    expectedGeneration?: number | null,
): Promise<PeriodCounts> {
    // snake_case keys: the command carries `rename_all = "snake_case"`.
    return invoke<PeriodCounts>('count_period_rows', { periods, filter: condition, expected_generation: expectedGeneration ?? null });
}

/** What the count takes as "the running condition": the whole training-scope
 *  payload (`buildPreviewFilterPayload`), or just its condition part. */
export type CountFilterInput = TrainingScopeFilter | Pick<TrainingScopeFilter, 'value_filters' | 'combine'>;

/**
 * The part of a training-scope filter the count reads: its value conditions and
 * AND/OR. Pass what `buildPreviewFilterPayload(draft, headers)` returns — its
 * time ranges are dropped here (Rust ignores them, and leaving them in would
 * make an edit of a TRAIN period look like a new request for the SCORING
 * periods). `null` when there is no condition at all.
 */
export function countCondition(filter: CountFilterInput | null | undefined): PeriodCountCondition | null {
    if (!filter || !Array.isArray(filter.value_filters) || filter.value_filters.length === 0) return null;
    return { value_filters: filter.value_filters, combine: filter.combine === 'or' ? 'or' : 'and' };
}

/** The periods of one call, plus where each came from in the list the user sees. */
export interface PeriodCountPlan {
    wire: PeriodCountArg[];
    /** `positions[k]` = 0-based index, in the FULL list, of `wire[k]`. */
    positions: number[];
}

const toArg = (p: { start: string; end: string }): PeriodCountArg => ({
    start: (p.start ?? '').trim() ? p.start.trim() : null,
    end: (p.end ?? '').trim() ? p.end.trim() : null,
});

function plan<T extends { start: string; end: string }>(list: readonly T[], invalid: boolean[]): PeriodCountPlan {
    const wire: PeriodCountArg[] = [];
    const positions: number[] = [];
    list.forEach((p, i) => {
        if (invalid[i]) return;
        wire.push(toArg(p));
        positions.push(i);
    });
    return { wire, positions };
}

/** The TRAIN periods to count: the ones `validatePeriods` accepts (an invalid
 *  period is never sent — its row shows the reason instead of a count, and it
 *  must not be part of the union). */
export function trainCountPlan(periods: readonly TimePeriod[]): PeriodCountPlan {
    return plan(periods, validatePeriods([...periods]).map(s => s.invalid));
}

/** The SCORING periods to count: the ones `validateTestPeriods` accepts. */
export function scoringCountPlan(tests: readonly TestPeriod[]): PeriodCountPlan {
    return plan(tests, validateTestPeriods([...tests]).map(s => s.invalid));
}

/**
 * What a TRAIN count is a count OF: the valid train periods and the running
 * condition, as one string. Two running conditions with the same key get the
 * same answer from `count_period_rows` — so a settled count of one may be read
 * for the other without asking again (two Custom models of one sensor on the
 * same own condition), and "the training scope changed" is `key !== key`.
 */
export function trainCountKey(trainPeriods: readonly TimePeriod[], filter: CountFilterInput | null | undefined): string {
    return JSON.stringify([countCondition(filter), trainCountPlan(trainPeriods).wire]);
}

// ---------------------------------------------------------------------------
// What the hook hands to the builders
// ---------------------------------------------------------------------------

/** State of the counts for the draft on screen (`usePeriodCounts`). */
export interface PeriodCountsState {
    /** `idle`: nothing is being counted (modal closed). `loading`: the draft
     *  changed and its counts are not in yet — `train` / `scoring` still hold
     *  the PREVIOUS answer so nothing flickers. `ok`: they are the draft's own.
     *  `error`: the count failed; no numbers. */
    status: 'idle' | 'loading' | 'ok' | 'error';
    /** Answer of the call that carried the valid TRAIN periods (`union` = the
     *  rows used for training); `null` when there is none (yet). */
    train: PeriodCounts | null;
    /** Answer of the call that carried the valid SCORING periods. */
    scoring: PeriodCounts | null;
    /** Readable message of a failure, or null. */
    error: string | null;
    /** `STALE_SESSION` / `NO_DATA` / `BAD_REQUEST` when Rust said so, else null. */
    errorCode: 'STALE_SESSION' | 'NO_DATA' | 'BAD_REQUEST' | null;
}

export const PERIOD_COUNTS_IDLE: PeriodCountsState = { status: 'idle', train: null, scoring: null, error: null, errorCode: null };

// ---------------------------------------------------------------------------
// Pure display maths
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The dataset's time range (`get_dataset_time_bounds`), as the period editors hold it. */
export interface CountBounds {
    min?: string | null;
    max?: string | null;
}

const isBlank = (s: string | null | undefined) => !(s ?? '').trim();

/** A period as [start, end] in epoch ms; an open end resolves to the dataset
 *  bound. null when a bound is unknown, unparseable or the period is reversed. */
function span(p: { start: string; end: string }, bounds: CountBounds | null | undefined): [number, number] | null {
    const s = isBlank(p.start) ? parseLocal(bounds?.min) : parseLocal(p.start);
    const e = isBlank(p.end) ? parseLocal(bounds?.max) : parseLocal(p.end);
    return s === null || e === null || e < s ? null : [s, e];
}

/** Whole CALENDAR days one period spans (open ends run to the dataset bounds);
 *  null when unknowable or reversed. The same number `periodDays` in
 *  `periodDisplay.ts` gives. */
export function periodCalendarDays(p: { start: string; end: string }, bounds?: CountBounds | null): number | null {
    const sp = span(p, bounds);
    return sp ? Math.round((sp[1] - sp[0]) / DAY_MS) : null;
}

/**
 * Whole calendar days covered by AT LEAST ONE of the periods (overlapping
 * periods are not counted twice), clamped to the dataset's range when it is
 * known. Periods flagged in `invalid` are left out. null when nothing can be
 * measured (no countable period).
 */
export function unionCalendarDays(
    periods: readonly { start: string; end: string }[],
    invalid: readonly boolean[],
    bounds?: CountBounds | null,
): number | null {
    const lo = parseLocal(bounds?.min);
    const hi = parseLocal(bounds?.max);
    const ivs: [number, number][] = [];
    periods.forEach((p, i) => {
        if (invalid[i]) return;
        const sp = span(p, bounds);
        if (!sp) return;
        const s = lo === null ? sp[0] : Math.max(lo, sp[0]);
        const e = hi === null ? sp[1] : Math.min(hi, sp[1]);
        if (e >= s) ivs.push([s, e]);
    });
    if (ivs.length === 0) return null;
    ivs.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [cs, ce] = ivs[0];
    for (const [s, e] of ivs.slice(1)) {
        if (s <= ce) ce = Math.max(ce, e);
        else { total += ce - cs; cs = s; ce = e; }
    }
    total += ce - cs;
    return Math.round(total / DAY_MS);
}

/** Running-time days for display: whole days from 10 d up ("69"), one decimal
 *  below that ("2.5", "0.3") so a short dataset does not read "0 d". */
export function runningDaysText(days: number): string {
    if (!Number.isFinite(days) || days <= 0) return '0';
    if (days >= 10) return String(Math.round(days));
    const r = Math.round(days * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

const sameBound = (a: string | null | undefined, b: string | null | undefined) => ((a ?? '').trim() || null) === ((b ?? '').trim() || null);

/**
 * Running-time days of the rows used for TRAINING, as counted (the train call's
 * union) — the figure the caption prints as "about N d running time" and the
 * amber "below the recommended train time" note reads. `null` unless the counts
 * are the request's own (`status: 'ok'`) and the dataset has a sample interval
 * (fewer than two dated rows: Rust's days are 0 then, not a fact).
 */
export function countedTrainRunningDays(state: PeriodCountsState): number | null {
    return state.status === 'ok' && state.train && state.train.interval_secs != null
        ? state.train.union.running_days
        : null;
}

/**
 * Does an answer of the TRAIN call say "no row is left to train on"?
 *
 * `union.running_rows === 0` — with ONE exception. A row WITHOUT a readable
 * timestamp is in no period for the count ("even a fully open period leaves
 * them out", `period_counts.rs`), but a train period left open at BOTH ends
 * means "no time limit" when training (`buildPreviewFilterPayload` sends no
 * time filter then), so those undated rows ARE trained on. With a fully open
 * period and undated rows in the dataset the count is therefore not the whole
 * truth, and it must never be read as "nothing to train on".
 */
function zeroTrainRows(train: PeriodCounts | null): boolean {
    if (!train || train.union.running_rows !== 0) return false;
    const fullyOpen = train.periods.some(c => c.valid && isBlank(c.start) && isBlank(c.end));
    return !(fullyOpen && train.total_rows > train.union.rows_in_period);
}

/**
 * The counts are the request's own (`status: 'ok'` — never while loading, stale
 * or failed) and the train periods TOGETHER hold no running row: nothing to
 * train on (`zeroTrainRows`). The Running-condition settings disable Apply /
 * Save changes on it and the gate blocks Train (`GateOptions.noTrainRows`).
 * False when no train period was counted at all.
 */
export function countedNoTrainRows(state: PeriodCountsState): boolean {
    return state.status === 'ok' && zeroTrainRows(state.train);
}

/** The quiet amber note of ONE period whose count is settled at zero running
 *  rows: "no running rows in P2". */
export function noRunningRowsNote(name: string): string {
    return `no running rows in ${name}`;
}

/** The count of one period inside an answer, found by its own bounds (so a
 *  period keeps its numbers when another one is added, removed or re-ordered
 *  while the new answer is on its way). null when it was not counted. */
export function countFor(counts: PeriodCounts | null | undefined, period: { start: string; end: string }): PeriodCount | null {
    if (!counts) return null;
    return counts.periods.find(c => c.valid && sameBound(c.start, period.start) && sameBound(c.end, period.end)) ?? null;
}

// ---------------------------------------------------------------------------
// One period row: "P1 · 81 d · 69 d running"
// ---------------------------------------------------------------------------

export interface PeriodRowModel {
    /** "P1" (train) / "S1" (scoring) — the list position. */
    name: string;
    number: number;
    /** The period is invalid: no day count (its reason line says why). */
    invalid: boolean;
    /** Calendar days from its dates; null when invalid / unknowable. */
    calendarDays: number | null;
    /** Running-time days from Rust; null while not counted. */
    runningDays: number | null;
    runningRows: number | null;
    rowsInPeriod: number | null;
    /** "81 d", or "—". */
    daysText: string;
    /** "69 d running", or null while there is no count. */
    runningText: string | null;
    /** The numbers are being counted again (dim them). */
    stale: boolean;
    /** Its count is SETTLED (the request's own answer) and it holds no running
     *  row — the row's quiet amber note (`noRunningRowsNote`). */
    noRunningRows: boolean;
    /** "P1 · 81 d · 69 d running" / "P1 · 81 d" / "P1 · —". */
    text: string;
}

function rowModel(name: string, number: number, period: { start: string; end: string }, invalid: boolean,
    bounds: CountBounds | null | undefined, counts: PeriodCounts | null, stale: boolean, settled: boolean): PeriodRowModel {
    const calendarDays = invalid ? null : periodCalendarDays(period, bounds);
    const c = invalid ? null : countFor(counts, period);
    const daysText = calendarDays === null ? '—' : `${calendarDays} d`;
    const runningText = c ? `${runningDaysText(c.running_days)} d running` : null;
    return {
        name, number, invalid, calendarDays,
        runningDays: c ? c.running_days : null,
        runningRows: c ? c.running_rows : null,
        rowsInPeriod: c ? c.rows_in_period : null,
        daysText, runningText,
        stale: !!c && stale,
        noRunningRows: !!c && settled && c.running_rows === 0,
        text: [name, daysText, runningText].filter(Boolean).join(' · '),
    };
}

/** One model per TRAIN period row, in list order (P1, P2 …). `invalid` — the
 *  editor's own per-row verdict (it also judges the rows against the loaded
 *  data's range); default: the plain date rules. */
export function trainRowModels(periods: readonly TimePeriod[], bounds: CountBounds | null | undefined, state: PeriodCountsState, invalid?: readonly boolean[]): PeriodRowModel[] {
    const bad = invalid ?? validatePeriods([...periods]).map(s => s.invalid);
    return periods.map((p, i) => rowModel(`P${i + 1}`, i + 1, p, !!bad[i], bounds, state.train, state.status === 'loading', state.status === 'ok'));
}

/** One model per SCORING period row, in list order (S1, S2 …). `invalid` as in `trainRowModels`. */
export function scoringRowModels(tests: readonly TestPeriod[], bounds: CountBounds | null | undefined, state: PeriodCountsState, invalid?: readonly boolean[]): PeriodRowModel[] {
    const bad = invalid ?? validateTestPeriods([...tests]).map(s => s.invalid);
    return tests.map((t, i) => rowModel(`S${i + 1}`, i + 1, t, !!bad[i], bounds, state.scoring, state.status === 'loading', state.status === 'ok'));
}

// ---------------------------------------------------------------------------
// The caption under the timeline
// ---------------------------------------------------------------------------

/** Where the count of the TRAIN periods stands for the draft on screen. It is
 *  never printed (no row numbers anywhere): it says whether the running time is
 *  known and whether the "nothing to train on" verdict may be read. */
export type CaptionRows =
    | { kind: 'no-train' }
    /** A train period is invalid: no total until it is fixed. */
    | { kind: 'fix' }
    /** "Only when running" is chosen but no condition is complete yet: counting
     *  now would count EVERY row (no condition is sent). */
    | { kind: 'no-condition' }
    | { kind: 'loading' }
    | { kind: 'error' }
    /** Nothing is being counted (the hook is disabled). */
    | { kind: 'idle' }
    /** Counted. `stale`: the answer is the PREVIOUS draft's (a new one is on its way). */
    | { kind: 'counted'; stale: boolean };

export interface RunningConditionCaption {
    /** No train period at all. */
    noTrain: boolean;
    /** Calendar days covered by the valid train periods; null when unknown. */
    trainCalendarDays: number | null;
    /** Running-time days of the rows used for training (Rust's own figure);
     *  null until counted. */
    trainRunningDays: number | null;
    /** Calendar days covered by the valid scoring periods; null when there is none. */
    scoringCalendarDays: number | null;
    rows: CaptionRows;
    /** "117 d train (about 100 d running time)" / "117 d train" / "no train period". */
    trainText: string;
    /** "59 d scoring" / "no scoring time". */
    scoringText: string;
    /** "≥ 30 d recommended"; null with no train period. */
    recommendedText: string | null;
    /** The counted train running time is below the recommendation (amber — never a block). */
    belowRecommended: boolean;
    /** The amber sentence for it ("Only 12 d of train running time — …"), or null. */
    warning: string | null;
    /** The count shown is SETTLED and the train periods together hold no running
     *  row: the red "No rows match — nothing to train on" line, and Apply / Save
     *  changes are disabled. Never while the count is loading, stale or failed. */
    noRows: boolean;
    /** The parts joined with " · " — the whole caption as one line. */
    text: string;
}

export const CAPTION_RECOMMENDED_TEXT = `≥ ${RECOMMENDED_TRAIN_DAYS} d recommended`;

/**
 * The ONE caption under the Running-condition timeline, from the draft's
 * periods (calendar days, from the dates) and the counts (running time, from
 * Rust):
 *
 *   117 d train (about 100 d running time) · 59 d scoring · ≥ 30 d recommended
 *
 * With no train period: "no train period · no scoring time". It never says how
 * many rows are used (see the note at the top of this file).
 *
 * `configured: false` = the running condition is still "Required" ("Only when
 * running" with no complete condition). The count Rust gives then is of every
 * row in the train periods (an incomplete condition is not sent), so it is not
 * read: no running time is printed and there is no verdict (`rows.kind:
 * 'no-condition'`).
 *
 * A period that is new / changed in the draft and lies entirely outside the
 * loaded data (`bounds`, judged against `savedTrain` / `savedScoring` — see
 * `validatePeriods`) is invalid like any other (`rows.kind: 'fix'`: no running
 * time until it is fixed). A SAVED period outside the data is not: it is counted.
 */
export function runningConditionCaption(input: {
    trainPeriods: readonly TimePeriod[];
    scoringPeriods: readonly TestPeriod[];
    bounds?: CountBounds | null;
    counts: PeriodCountsState;
    /** Default `true`. */
    configured?: boolean;
    /** The SAVED lists the draft is judged against (`PeriodBaseline`). */
    savedTrain?: PeriodBaseline;
    savedScoring?: PeriodBaseline;
}): RunningConditionCaption {
    const { trainPeriods, scoringPeriods, bounds, counts } = input;
    const configured = input.configured !== false;
    const trainInvalid = validatePeriods([...trainPeriods], bounds, input.savedTrain).map(s => s.invalid);
    const scoringInvalid = validateTestPeriods([...scoringPeriods], bounds, input.savedScoring).map(s => s.invalid);
    const noTrain = trainPeriods.length === 0;
    const anyTrainInvalid = trainInvalid.some(Boolean);

    const trainCalendarDays = noTrain ? null : unionCalendarDays(trainPeriods, trainInvalid, bounds);
    const scoringCalendarDays = unionCalendarDays(scoringPeriods, scoringInvalid, bounds);

    let rows: CaptionRows;
    if (noTrain) rows = { kind: 'no-train' };
    else if (anyTrainInvalid) rows = { kind: 'fix' };
    else if (!configured) rows = { kind: 'no-condition' };
    else if (counts.status === 'error') rows = { kind: 'error' };
    else if (counts.train && (counts.status === 'ok' || counts.status === 'loading')) {
        rows = { kind: 'counted', stale: counts.status === 'loading' };
    } else rows = { kind: counts.status === 'loading' ? 'loading' : 'idle' };

    // Running time comes with the count (kept while a new answer is on its way —
    // `rows.stale` says so). Unknown when the dataset has no sample
    // interval (fewer than two dated rows): Rust's days are 0 then, not a fact.
    const trainRunningDays = rows.kind === 'counted' && counts.train?.interval_secs != null
        ? counts.train.union.running_days : null;

    const trainText = noTrain ? 'no train period'
        : `${trainCalendarDays === null ? '—' : trainCalendarDays} d train${trainRunningDays !== null ? ` (about ${runningDaysText(trainRunningDays)} d running time)` : ''}`;
    const scoringText = scoringCalendarDays === null ? 'no scoring time' : `${scoringCalendarDays} d scoring`;
    const recommendedText = noTrain ? null : CAPTION_RECOMMENDED_TEXT;
    return {
        noTrain, trainCalendarDays, trainRunningDays, scoringCalendarDays, rows,
        trainText, scoringText, recommendedText,
        belowRecommended: isBelowRecommendedTrainDays(trainRunningDays),
        warning: trainDaysWarning(trainRunningDays),
        noRows: rows.kind === 'counted' && !rows.stale && zeroTrainRows(counts.train),
        text: [trainText, scoringText, recommendedText].filter(Boolean).join(' · '),
    };
}
