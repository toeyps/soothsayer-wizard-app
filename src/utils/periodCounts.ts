import { invoke } from '@tauri-apps/api/core';
import type { TestPeriod, TimePeriod } from '../types';
import type { TrainingScopeFilter } from '../types/health';
import type { PeriodCount, PeriodCountArg, PeriodCountCondition, PeriodCounts } from '../types/periodCounts';
import { validatePeriods, validateTestPeriods, type PeriodBaseline } from './timePeriods';
import { isBelowRecommendedTrainDays, RECOMMENDED_TRAIN_DAYS, trainDaysWarning } from './trainTestValidation';
import { parseLocal } from './workbenchDate';

/* Per-period running-row counts for the Running-condition settings: the `count_period_rows` binding, request and display builders. Show days of running time and the 'nothing to train on' verdict only; never print a row count. */


/** Counts rows per period and for their union; `condition` null = every row runs, `expectedGeneration` pins the dataset. */
export function countPeriodRows(
    periods: PeriodCountArg[],
    condition: PeriodCountCondition | null,
    expectedGeneration?: number | null,
): Promise<PeriodCounts> {
    // snake_case keys: the command carries `rename_all = "snake_case"`.
    return invoke<PeriodCounts>('count_period_rows', { periods, filter: condition, expected_generation: expectedGeneration ?? null });
}

/** Whole training-scope payload, or just its condition part. */
export type CountFilterInput = TrainingScopeFilter | Pick<TrainingScopeFilter, 'value_filters' | 'combine'>;

/** Value conditions and AND/OR only (time ranges dropped, so editing a train period isn't a new request); null if none. */
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

/** Train periods to count: only those `validatePeriods` accepts; an invalid one is never sent nor part of the union. */
export function trainCountPlan(periods: readonly TimePeriod[]): PeriodCountPlan {
    return plan(periods, validatePeriods([...periods]).map(s => s.invalid));
}

/** The SCORING periods to count: the ones `validateTestPeriods` accepts. */
export function scoringCountPlan(tests: readonly TestPeriod[]): PeriodCountPlan {
    return plan(tests, validateTestPeriods([...tests]).map(s => s.invalid));
}

/** Identifies what a train count is of (valid train periods + condition); equal keys reuse a settled count. */
export function trainCountKey(trainPeriods: readonly TimePeriod[], filter: CountFilterInput | null | undefined): string {
    return JSON.stringify([countCondition(filter), trainCountPlan(trainPeriods).wire]);
}


/** State of the counts for the draft on screen (`usePeriodCounts`). */
export interface PeriodCountsState {
    /** `idle`: nothing counted. `loading`: `train`/`scoring` hold the previous draft's answer. `ok`: the draft's own answer. `error`: no numbers. */
    status: 'idle' | 'loading' | 'ok' | 'error';
    /** Answer of the call with the valid train periods (`union` = rows used for training); null if none yet. */
    train: PeriodCounts | null;
    /** Answer of the call that carried the valid SCORING periods. */
    scoring: PeriodCounts | null;
    /** Readable message of a failure, or null. */
    error: string | null;
    /** `STALE_SESSION` / `NO_DATA` / `BAD_REQUEST` when Rust said so, else null. */
    errorCode: 'STALE_SESSION' | 'NO_DATA' | 'BAD_REQUEST' | null;
}

export const PERIOD_COUNTS_IDLE: PeriodCountsState = { status: 'idle', train: null, scoring: null, error: null, errorCode: null };


const DAY_MS = 86_400_000;

/** The dataset's time range (`get_dataset_time_bounds`), as the period editors hold it. */
export interface CountBounds {
    min?: string | null;
    max?: string | null;
}

const isBlank = (s: string | null | undefined) => !(s ?? '').trim();

/** Period as [start, end] epoch ms, open ends taken from the dataset bounds; null if unknown, unparseable or reversed. */
function span(p: { start: string; end: string }, bounds: CountBounds | null | undefined): [number, number] | null {
    const s = isBlank(p.start) ? parseLocal(bounds?.min) : parseLocal(p.start);
    const e = isBlank(p.end) ? parseLocal(bounds?.max) : parseLocal(p.end);
    return s === null || e === null || e < s ? null : [s, e];
}

/** Whole calendar days one period spans (open ends run to dataset bounds); null if unknowable or reversed. */
export function periodCalendarDays(p: { start: string; end: string }, bounds?: CountBounds | null): number | null {
    const sp = span(p, bounds);
    return sp ? Math.round((sp[1] - sp[0]) / DAY_MS) : null;
}

/** Whole calendar days in the union of periods, clamped to the dataset range; `invalid` ones skipped; null if none countable. */
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

/** Running days for display: whole from 10 d up, one decimal below so a short dataset doesn't read '0 d'. */
export function runningDaysText(days: number): string {
    if (!Number.isFinite(days) || days <= 0) return '0';
    if (days >= 10) return String(Math.round(days));
    const r = Math.round(days * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

const sameBound = (a: string | null | undefined, b: string | null | undefined) => ((a ?? '').trim() || null) === ((b ?? '').trim() || null);

/** Running days of the train union; null unless counts are the request's own and the dataset has a sample interval. */
export function countedTrainRunningDays(state: PeriodCountsState): number | null {
    return state.status === 'ok' && state.train && state.train.interval_secs != null
        ? state.train.union.running_days
        : null;
}

/** True when no running row is left to train on (`union.running_rows === 0`). Not when a fully open train period meets undated rows: those are trained on, so the count isn't the whole truth. */
function zeroTrainRows(train: PeriodCounts | null): boolean {
    if (!train || train.union.running_rows !== 0) return false;
    const fullyOpen = train.periods.some(c => c.valid && isBlank(c.start) && isBlank(c.end));
    return !(fullyOpen && train.total_rows > train.union.rows_in_period);
}

/** Settled counts show no running train row: nothing to train on (disables Apply/Save, blocks Train via `noTrainRows`). */
export function countedNoTrainRows(state: PeriodCountsState): boolean {
    return state.status === 'ok' && zeroTrainRows(state.train);
}

/** The quiet amber note of ONE period whose count is settled at zero running
 *  rows: "no running rows in P2". */
export function noRunningRowsNote(name: string): string {
    return `no running rows in ${name}`;
}

/** Count of one period, found by its bounds so it survives list edits; null if not counted. */
export function countFor(counts: PeriodCounts | null | undefined, period: { start: string; end: string }): PeriodCount | null {
    if (!counts) return null;
    return counts.periods.find(c => c.valid && sameBound(c.start, period.start) && sameBound(c.end, period.end)) ?? null;
}


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
    /** Count is settled and holds no running row: the row's amber note (`noRunningRowsNote`). */
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

/** One model per train period row (P1, P2 …). `invalid` is the editor's own verdict; default: the plain date rules. */
export function trainRowModels(periods: readonly TimePeriod[], bounds: CountBounds | null | undefined, state: PeriodCountsState, invalid?: readonly boolean[]): PeriodRowModel[] {
    const bad = invalid ?? validatePeriods([...periods]).map(s => s.invalid);
    return periods.map((p, i) => rowModel(`P${i + 1}`, i + 1, p, !!bad[i], bounds, state.train, state.status === 'loading', state.status === 'ok'));
}

/** One model per SCORING period row, in list order (S1, S2 …). `invalid` as in `trainRowModels`. */
export function scoringRowModels(tests: readonly TestPeriod[], bounds: CountBounds | null | undefined, state: PeriodCountsState, invalid?: readonly boolean[]): PeriodRowModel[] {
    const bad = invalid ?? validateTestPeriods([...tests]).map(s => s.invalid);
    return tests.map((t, i) => rowModel(`S${i + 1}`, i + 1, t, !!bad[i], bounds, state.scoring, state.status === 'loading', state.status === 'ok'));
}


/** Where the train count stands for the draft, and whether the 'nothing to train on' verdict may be read. Never printed. */
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
    /** Settled count with no running train row: red 'nothing to train on', Apply/Save off. Never while loading, stale or failed. */
    noRows: boolean;
    /** The parts joined with " · " — the whole caption as one line. */
    text: string;
}

export const CAPTION_RECOMMENDED_TEXT = `≥ ${RECOMMENDED_TRAIN_DAYS} d recommended`;

/** Caption under the Running-condition timeline: days from the dates, running time from Rust's counts, never a row count. Unconfigured condition: count ignored (`no-condition`); a new/changed period fully outside the data is `fix`. */
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

    // Kept while a new answer is in flight (`rows.stale`); unknown under two dated rows, where Rust's days are 0, not a fact.
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
