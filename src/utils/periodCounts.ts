import { invoke } from '@tauri-apps/api/core';
import type { TestPeriod, TimePeriod } from '../types';
import type { TrainingScopeFilter } from '../types/health';
import type { PeriodCount, PeriodCountArg, PeriodCountCondition, PeriodCounts } from '../types/periodCounts';
import { validatePeriods, validateTestPeriods } from './timePeriods';
import { isBelowRecommendedTrainDays, RECOMMENDED_TRAIN_DAYS, trainDaysWarning } from './trainTestValidation';
import { parseLocal } from './workbenchDate';

/*
 * Per-period running-row counts for the Running-condition settings (workbench
 * redesign SPEC §5): the binding of the Rust command `count_period_rows`, the
 * request builders, and the pure builders of what the modal prints from the
 * answer — the one caption under the timeline
 *
 *   117 d train (about 100 d running time) · 59 d scoring ·
 *   14,391 of 25,880 rows (56%) used for training · ≥ 30 d recommended
 *
 * and one quiet line per period row ("P1 · 81 d · 69 d running").
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

/** "25%" / "<1%" / "0%" / "—" for used-of-total (the running-condition line's
 *  own rounding, so the modal and the line behind it agree). */
export function percentText(used: number | null | undefined, total: number | null | undefined): string {
    if (typeof used !== 'number' || typeof total !== 'number' || !(total > 0)) return '—';
    if (used <= 0) return '0%';
    const pct = (used / total) * 100;
    return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/** Running-time days for display: whole days from 10 d up ("69"), one decimal
 *  below that ("2.5", "0.3") so a short dataset does not read "0 d". */
export function runningDaysText(days: number): string {
    if (!Number.isFinite(days) || days <= 0) return '0';
    if (days >= 10) return String(Math.round(days));
    const r = Math.round(days * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

const rowsText = (n: number) => n.toLocaleString('en-US');

const sameBound = (a: string | null | undefined, b: string | null | undefined) => ((a ?? '').trim() || null) === ((b ?? '').trim() || null);

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
    /** "P1 · 81 d · 69 d running" / "P1 · 81 d" / "P1 · —". */
    text: string;
}

function rowModel(name: string, number: number, period: { start: string; end: string }, invalid: boolean,
    bounds: CountBounds | null | undefined, counts: PeriodCounts | null, stale: boolean): PeriodRowModel {
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
        text: [name, daysText, runningText].filter(Boolean).join(' · '),
    };
}

/** One model per TRAIN period row, in list order (P1, P2 …). */
export function trainRowModels(periods: readonly TimePeriod[], bounds: CountBounds | null | undefined, state: PeriodCountsState): PeriodRowModel[] {
    const status = validatePeriods([...periods]);
    return periods.map((p, i) => rowModel(`P${i + 1}`, i + 1, p, status[i].invalid, bounds, state.train, state.status === 'loading'));
}

/** One model per SCORING period row, in list order (S1, S2 …). */
export function scoringRowModels(tests: readonly TestPeriod[], bounds: CountBounds | null | undefined, state: PeriodCountsState): PeriodRowModel[] {
    const status = validateTestPeriods([...tests]);
    return tests.map((t, i) => rowModel(`S${i + 1}`, i + 1, t, status[i].invalid, bounds, state.scoring, state.status === 'loading'));
}

// ---------------------------------------------------------------------------
// The caption under the timeline
// ---------------------------------------------------------------------------

/** The "rows used for training" part of the caption. ONE source for both
 *  numbers: the train call's `union.running_rows` of its `total_rows`. */
export type CaptionRows =
    | { kind: 'no-train' }
    /** A train period is invalid: no total until it is fixed. */
    | { kind: 'fix' }
    | { kind: 'loading' }
    | { kind: 'error' }
    /** Nothing is being counted (the hook is disabled). */
    | { kind: 'idle' }
    | { kind: 'counted'; used: number; total: number; percent: string; stale: boolean };

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
    /** "14,391 of 25,880 rows (56%) used for training" / "add a train period to
     *  count the rows" / "fix the period to count the rows" / "Counting rows…" /
     *  "Couldn't count the rows right now". */
    rowsText: string;
    /** "≥ 30 d recommended"; null with no train period. */
    recommendedText: string | null;
    /** The counted train running time is below the recommendation (amber — never a block). */
    belowRecommended: boolean;
    /** The amber sentence for it ("Only 12 d of train running time — …"), or null. */
    warning: string | null;
    /** The parts joined with " · " — the whole caption as one line. */
    text: string;
}

export const CAPTION_RECOMMENDED_TEXT = `≥ ${RECOMMENDED_TRAIN_DAYS} d recommended`;

/**
 * The ONE caption under the Running-condition timeline, from the draft's
 * periods (calendar days, from the dates) and the counts (running time and
 * rows, from Rust):
 *
 *   117 d train (about 100 d running time) · 59 d scoring ·
 *   14,391 of 25,880 rows (56%) used for training · ≥ 30 d recommended
 *
 * With no train period: "no train period · no scoring time · add a train
 * period to count the rows".
 */
export function runningConditionCaption(input: {
    trainPeriods: readonly TimePeriod[];
    scoringPeriods: readonly TestPeriod[];
    bounds?: CountBounds | null;
    counts: PeriodCountsState;
}): RunningConditionCaption {
    const { trainPeriods, scoringPeriods, bounds, counts } = input;
    const trainInvalid = validatePeriods([...trainPeriods]).map(s => s.invalid);
    const scoringInvalid = validateTestPeriods([...scoringPeriods]).map(s => s.invalid);
    const noTrain = trainPeriods.length === 0;
    const anyTrainInvalid = trainInvalid.some(Boolean);

    const trainCalendarDays = noTrain ? null : unionCalendarDays(trainPeriods, trainInvalid, bounds);
    const scoringCalendarDays = unionCalendarDays(scoringPeriods, scoringInvalid, bounds);

    let rows: CaptionRows;
    if (noTrain) rows = { kind: 'no-train' };
    else if (anyTrainInvalid) rows = { kind: 'fix' };
    else if (counts.status === 'error') rows = { kind: 'error' };
    else if (counts.train && (counts.status === 'ok' || counts.status === 'loading')) {
        const used = counts.train.union.running_rows;
        const total = counts.train.total_rows;
        rows = { kind: 'counted', used, total, percent: percentText(used, total), stale: counts.status === 'loading' };
    } else rows = { kind: counts.status === 'loading' ? 'loading' : 'idle' };

    // Running time comes with the row count (kept, like it, while a new answer is
    // on its way — `rows.stale` says so). Unknown when the dataset has no sample
    // interval (fewer than two dated rows): Rust's days are 0 then, not a fact.
    const trainRunningDays = rows.kind === 'counted' && counts.train?.interval_secs != null
        ? counts.train.union.running_days : null;

    const trainText = noTrain ? 'no train period'
        : `${trainCalendarDays === null ? '—' : trainCalendarDays} d train${trainRunningDays !== null ? ` (about ${runningDaysText(trainRunningDays)} d running time)` : ''}`;
    const scoringText = scoringCalendarDays === null ? 'no scoring time' : `${scoringCalendarDays} d scoring`;
    const rowsLine = rows.kind === 'no-train' ? 'add a train period to count the rows'
        : rows.kind === 'fix' ? 'fix the period to count the rows'
        : rows.kind === 'loading' ? 'Counting rows…'
        : rows.kind === 'error' ? "Couldn't count the rows right now"
        : rows.kind === 'counted' ? `${rowsText(rows.used)} of ${rowsText(rows.total)} rows (${rows.percent}) used for training`
        : '';
    const recommendedText = noTrain ? null : CAPTION_RECOMMENDED_TEXT;
    return {
        noTrain, trainCalendarDays, trainRunningDays, scoringCalendarDays, rows,
        trainText, scoringText, rowsText: rowsLine, recommendedText,
        belowRecommended: isBelowRecommendedTrainDays(trainRunningDays),
        warning: trainDaysWarning(trainRunningDays),
        text: [trainText, scoringText, rowsLine, recommendedText].filter(Boolean).join(' · '),
    };
}
