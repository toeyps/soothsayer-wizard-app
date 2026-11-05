import type { TestPeriod, TimeHighlight, TimePeriod } from '../types';
import type { HealthIssue, TestPeriodWire } from '../types/health';
import { dateText, formatBound, parseLocal } from './workbenchDate';

/** What is wrong with an invalid period (stable; the UI may key on it — e.g.
 *  which date field to mark red). */
export type PeriodFault =
    | 'start-invalid'
    | 'end-invalid'
    | 'start-missing'
    | 'end-missing'
    | 'ends-before-start'
    /** Entirely outside the data: only for a new or changed period when bounds are given; an unchanged saved one only warns (`outsideData`). */
    | 'outside-data';

/** Loaded dataset's first/last timestamp; unknown = nothing judged against the data. */
export interface PeriodDataBounds {
    min?: string | null;
    max?: string | null;
}

export interface PeriodStatus {
    /** Unparseable bound, end before start, or an open end where none is allowed. */
    invalid: boolean;
    /** Short sentence when `invalid`, naming the period ("P2 ends before it starts."); used where another sentence follows. */
    reason?: string;
    /** The one reason line under the row when `invalid`, with a hint where possible. */
    rowReason?: string;
    /** What is wrong, when `invalid`. */
    fault?: PeriodFault;
    /** Valid period reaching past the data (never blocks): amber note. Also the warning for a saved period entirely outside (`outsideData`). */
    dataNote?: string;
    /** Entirely outside the data but unchanged from the saved list: warning only. Blocks Train only when no period is inside the data (`allPeriodsOutsideData`). */
    outsideData?: boolean;
    /** Starts strictly before the previous period ends (touching is NOT overlap). */
    overlapsPrev: boolean;
}

/** The saved list a draft is judged against: same id/start/end = unchanged (outside-data only warns). Omit/null when all is new. */
export type PeriodBaseline = readonly { id: string; start: string; end: string }[] | null | undefined;

const sameBoundText = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim();

/** Is `p` exactly as it was saved (same id, start and end)? */
export function isPeriodUnchanged(p: { id: string; start: string; end: string }, baseline: PeriodBaseline): boolean {
    return !!baseline && baseline.some(b => b.id === p.id && sameBoundText(b.start, p.start) && sameBoundText(b.end, p.end));
}

export interface FilterRange {
    start: string | null;
    end: string | null;
}

const MINUTE = 60_000;

/** Epoch ms of a datetime-local/ISO-ish string as LOCAL time; null if empty/unparseable. Date-only = local midnight. */
const toMs = parseLocal;

const FAULT_WORDS: Record<PeriodFault, string> = {
    'start-invalid': 'has an invalid start date',
    'end-invalid': 'has an invalid end date',
    'start-missing': 'needs a start date',
    'end-missing': 'needs an end date',
    'ends-before-start': 'ends before it starts',
    'outside-data': 'is outside the data',
};


/** The data's time range in epoch ms, or null while it is unknown. */
function dataRangeMs(bounds: PeriodDataBounds | null | undefined): { min: number; max: number } | null {
    const min = toMs(bounds?.min);
    const max = toMs(bounds?.max);
    return min === null || max === null || max < min ? null : { min, max };
}

const startOfDay = (ms: number): number => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfDay = (ms: number): number => { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); };

/** How one period sits against the loaded data. */
export interface PeriodDataFit {
    /** No part is inside the data (open bounds run to the data's edge). */
    outside: boolean;
    /** Reaches before the first / past the last calendar day of the data (a bound on the edge day is not 'past'). */
    before: boolean;
    after: boolean;
}

/** Where a period sits against the data; null if bounds are unknown or the period is unparseable/reversed. */
export function periodDataFit(p: { start: string; end: string }, bounds: PeriodDataBounds | null | undefined): PeriodDataFit | null {
    const r = dataRangeMs(bounds);
    const iv = interval(p);
    if (!r || !iv) return null;
    if (iv.e < r.min || iv.s > r.max) return { outside: true, before: iv.e < r.min, after: iv.s > r.max };
    return {
        outside: false,
        before: Number.isFinite(iv.s) && iv.s < startOfDay(r.min),
        after: Number.isFinite(iv.e) && iv.e > endOfDay(r.max),
    };
}

/** "2025/01/01 00:00 – 2025/12/31 23:50": the data's range in the app's date
 *  format, date and time on both sides. */
export function dataRangeText(bounds: PeriodDataBounds | null | undefined): string {
    return `${formatBound(bounds?.min)} – ${formatBound(bounds?.max)}`;
}

/** Texts for a period entirely outside the data (`reason` ends with a full stop). */
export function outsideDataTexts(name: string, bounds: PeriodDataBounds | null | undefined): { reason: string; rowReason: string } {
    const core = `${name} ${FAULT_WORDS['outside-data']} (${dataRangeText(bounds)})`;
    return { reason: `${core}.`, rowReason: core };
}

/** Amber warning for a saved, untouched period entirely outside the data. */
export function savedOutsideDataNote(name: string, kind: 'train' | 'scoring', bounds: PeriodDataBounds | null | undefined): string {
    return kind === 'train'
        ? `${name} ${FAULT_WORDS['outside-data']} (${dataRangeText(bounds)}) — it is not used`
        : `${name} ${FAULT_WORDS['outside-data']} — nothing is scored there`;
}

/** True when periods exist and every one lies outside the known data range (the case that blocks Train); false if any is unreadable. */
export function allPeriodsOutsideData(list: readonly { start: string; end: string }[], bounds: PeriodDataBounds | null | undefined): boolean {
    return list.length > 0 && list.every(p => periodDataFit(p, bounds)?.outside === true);
}

/** Warnings for saved periods entirely outside the data; empty while the range is unknown. Periods with date faults are not listed. */
export function savedOutsideDataNotes(train: TimePeriod[], tests: TestPeriod[], bounds: PeriodDataBounds | null | undefined): string[] {
    const out: string[] = [];
    validatePeriods(train, bounds, train).forEach(s => { if (s.outsideData && s.dataNote) out.push(s.dataNote); });
    validateTestPeriods(tests, bounds, tests).forEach(s => { if (s.outsideData && s.dataNote) out.push(s.dataNote); });
    return out;
}

/** Amber note for a period only partly inside the data, or null; the edge is a date because 'past' is judged by calendar day. */
export function partlyOutsideNote(fit: PeriodDataFit, bounds: PeriodDataBounds | null | undefined): string | null {
    const r = dataRangeMs(bounds);
    if (!r || fit.outside || (!fit.before && !fit.after)) return null;
    const what = fit.before && fit.after ? `data runs ${dateText(r.min)} – ${dateText(r.max)}`
        : fit.after ? `data ends ${dateText(r.max)}`
        : `data starts ${dateText(r.min)}`;
    return `Only the part inside the data is used (${what})`;
}

/** Texts of one invalid period; `name` is 'P2' (train) or 'S1' (scoring). `rowReason` adds what to do when known. */
export function periodReasonTexts(name: string, fault: PeriodFault, start?: string | null): { reason: string; rowReason: string } {
    const core = `${name} ${FAULT_WORDS[fault]}`;
    const after = fault === 'ends-before-start' ? formatBound(start) : '';
    return { reason: `${core}.`, rowReason: after ? `${core} — pick an end after ${after}` : core };
}

/** The date field a fault is about (for "Fix P1's end above" and for marking
 *  the field red). */
export function faultSide(fault: PeriodFault): 'start' | 'end' {
    return fault === 'start-invalid' || fault === 'start-missing' ? 'start' : 'end';
}

/** Whether this date field is part of the fault; 'outside-data' marks both. */
export function faultOnSide(fault: PeriodFault, side: 'start' | 'end'): boolean {
    return fault === 'outside-data' || faultSide(fault) === side;
}

/** Footer line while a period is invalid; `action` 'saving' is for a model's Custom lists. */
export function fixPeriodFirstText(name: string, action: 'applying' | 'saving' = 'applying'): string {
    return `Fix ${name} before ${action}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function fmt(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let idCounter = 0;
export function newPeriodId(): string {
    idCounter += 1;
    return `p-${Date.now().toString(36)}-${idCounter}`;
}

/** Per-period validity and overlap with the previous one (call on a sorted list); open ends only on the first start / last end. With `bounds`+`baseline`: entirely outside the data = invalid if new/changed, warning if unchanged; partly outside gets `dataNote`. */
export function validatePeriods(list: TimePeriod[], bounds?: PeriodDataBounds | null, baseline?: PeriodBaseline): PeriodStatus[] {
    const parsed = list.map((p) => ({ s: toMs(p.start), e: toMs(p.end) }));
    return list.map((p, i) => {
        const { s, e } = parsed[i];
        const startBlank = !(p.start ?? '').trim();
        const endBlank = !(p.end ?? '').trim();
        let fault: PeriodFault | undefined;
        if (!startBlank && s === null) fault = 'start-invalid';
        else if (!endBlank && e === null) fault = 'end-invalid';
        else if (startBlank && i !== 0) fault = 'start-missing';
        else if (endBlank && i !== list.length - 1) fault = 'end-missing';
        else if (s !== null && e !== null && e < s) fault = 'ends-before-start';
        const fit = fault ? null : periodDataFit(p, bounds);
        // Entirely outside the data: a fault only for a period that is new /
        // changed in this draft; a saved, untouched one only warns.
        const savedOutside = !!fit?.outside && isPeriodUnchanged(p, baseline);
        if (fit?.outside && !savedOutside) fault = 'outside-data';
        const texts = !fault ? undefined
            : fault === 'outside-data' ? outsideDataTexts(`P${i + 1}`, bounds)
            : periodReasonTexts(`P${i + 1}`, fault, p.start);
        const dataNote = fault || !fit ? undefined
            : savedOutside ? savedOutsideDataNote(`P${i + 1}`, 'train', bounds)
            : partlyOutsideNote(fit, bounds) ?? undefined;

        let overlapsPrev = false;
        if (!fault && i > 0 && !statusInvalidAt(list, parsed, i - 1)) {
            const prevEnd = parsed[i - 1].e;
            const prevOpenEnd = !(list[i - 1].end ?? '').trim();
            const curStart = s; // null = open start
            if (prevOpenEnd || curStart === null) overlapsPrev = true;
            else if (prevEnd !== null && curStart < prevEnd) overlapsPrev = true;
        }
        return {
            invalid: !!fault, reason: texts?.reason, rowReason: texts?.rowReason, fault, dataNote,
            ...(savedOutside ? { outsideData: true } : {}),
            overlapsPrev,
        };
    });
}

/** Is the previous period unparseable/reversed (skips overlap reports against it). */
function statusInvalidAt(list: TimePeriod[], parsed: { s: number | null; e: number | null }[], i: number): boolean {
    const p = list[i];
    const { s, e } = parsed[i];
    if ((p.start ?? '').trim() && s === null) return true;
    if ((p.end ?? '').trim() && e === null) return true;
    return s !== null && e !== null && e < s;
}

/** Sorted copy: open start first, then by start; unparseable starts last. Stable. */
export function sortPeriods(list: TimePeriod[]): TimePeriod[] {
    const rank = (p: TimePeriod): number => {
        if (!(p.start ?? '').trim()) return -Infinity;
        const ms = toMs(p.start);
        return ms === null ? Infinity : ms;
    };
    return list
        .map((p, i) => ({ p, i, r: rank(p) }))
        .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r < b.r ? -1 : 1))
        .map((x) => x.p);
}

/** One period covering both (earliest start, latest end; an open end stays open).
 *  Keeps `a`'s id. */
export function mergeOverlapping(a: TimePeriod, b: TimePeriod): TimePeriod {
    const aS = !(a.start ?? '').trim() ? null : toMs(a.start);
    const bS = !(b.start ?? '').trim() ? null : toMs(b.start);
    const aE = !(a.end ?? '').trim() ? null : toMs(a.end);
    const bE = !(b.end ?? '').trim() ? null : toMs(b.end);
    const start = aS === null || bS === null ? '' : aS <= bS ? a.start : b.start;
    const end = aE === null || bE === null ? '' : aE >= bE ? a.end : b.end;
    return { id: a.id, start, end };
}

/** Default for 'Add period': starts the day after the last end at 00:00, ends 23:59 on that month's last day, clamped to `datasetMax`. Empty list = one open period; null when the last end is open or invalid, or the start passes `datasetMax`. */
export function nextDefaultPeriod(list: TimePeriod[], datasetMax?: string | null): TimePeriod | null {
    if (list.length === 0) return { id: newPeriodId(), start: '', end: '' };
    const last = list[list.length - 1];
    const lastEnd = toMs(last.end);
    if (lastEnd === null) return null;
    const d = new Date(lastEnd);
    const startD = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0);
    let endMs = new Date(startD.getFullYear(), startD.getMonth() + 1, 0, 23, 59).getTime();
    const max = datasetMax ? toMs(datasetMax) : null;
    if (max !== null) {
        if (startD.getTime() > max) return null;
        if (endMs > max) endMs = max;
    }
    return { id: newPeriodId(), start: fmt(startD.getTime()), end: fmt(endMs) };
}

/** True when the valid periods span all of `bounds` (gaps up to a minute count as continuous). An empty list is NOT covered. */
export function isRangeFullyCovered(list: TimePeriod[], bounds: { min: string; max: string } | null | undefined): boolean {
    if (!bounds) return false;
    const min = toMs(bounds.min);
    const max = toMs(bounds.max);
    if (min === null || max === null) return false;
    const status = validatePeriods(sortPeriods(list));
    const ivs = sortPeriods(list)
        .filter((_, i) => !status[i].invalid)
        .map((p) => ({
            s: (p.start ?? '').trim() ? (toMs(p.start) as number) : -Infinity,
            e: (p.end ?? '').trim() ? (toMs(p.end) as number) : Infinity,
        }));
    if (ivs.length === 0) return false;
    let coveredTo = -Infinity;
    for (const iv of ivs) {
        if (coveredTo === -Infinity) {
            if (iv.s > min) return false;
            coveredTo = iv.e;
        } else if (iv.s <= coveredTo + MINUTE) {
            coveredTo = Math.max(coveredTo, iv.e);
        } else {
            break;
        }
        if (coveredTo >= max) return true;
    }
    return coveredTo >= max;
}

/** Wire shape for `timestamp_ranges`: invalid periods dropped, `''` -> null. An empty result is ambiguous: check `validatePeriods` before sending `[]`. */
export function toFilterRanges(list: TimePeriod[]): FilterRange[] {
    const status = validatePeriods(list);
    return list
        .filter((_, i) => !status[i].invalid)
        .map((p) => ({
            start: (p.start ?? '').trim() ? p.start : null,
            end: (p.end ?? '').trim() ? p.end : null,
        }));
}

// Train vs scoring periods; identifiers keep 'test' names for storage/wire compatibility. Pure; datetime-local strings are LOCAL time.

const DAY = 86_400_000;

/** A scoring period as WRITTEN: id/start/end only. Build or copy through this so a spread doesn't carry extra keys; untouched periods keep what is on disk. */
export function toScoringPeriod(t: Pick<TestPeriod, 'id' | 'start' | 'end'>): TestPeriod {
    return { id: t.id, start: t.start ?? '', end: t.end ?? '' };
}

/** `toScoringPeriod` for a whole list (a missing list reads as `[]`). */
export function toScoringPeriods(list: readonly TestPeriod[] | null | undefined): TestPeriod[] {
    return (list ?? []).map(toScoringPeriod);
}

/** Validity of one scoring period (list order = S1, S2 …). */
export interface TestPeriodStatus {
    /** Start/end missing or unparseable, or end before start. Blocks Apply. */
    invalid: boolean;
    /** Short sentence when `invalid`: "S2 ends before it starts." */
    reason?: string;
    /** The one reason line under the row when `invalid`. */
    rowReason?: string;
    /** What is wrong, when `invalid`. */
    fault?: PeriodFault;
    /** Valid but partly inside the data, or (with `outsideData`) a saved period entirely outside. */
    dataNote?: string;
    /** Entirely outside the data but unchanged: warning only. */
    outsideData?: boolean;
}

/** Per-scoring-period validity; needs BOTH start and end, overlaps allowed. `bounds`/`baseline` as in `validatePeriods`. */
export function validateTestPeriods(list: TestPeriod[], bounds?: PeriodDataBounds | null, baseline?: PeriodBaseline): TestPeriodStatus[] {
    return list.map((t, i) => {
        const n = i + 1;
        const startBlank = !(t.start ?? '').trim();
        const endBlank = !(t.end ?? '').trim();
        const s = toMs(t.start);
        const e = toMs(t.end);
        let fault: PeriodFault | undefined;
        if (startBlank) fault = 'start-missing';
        else if (endBlank) fault = 'end-missing';
        else if (s === null) fault = 'start-invalid';
        else if (e === null) fault = 'end-invalid';
        else if (e < s) fault = 'ends-before-start';
        const fit = fault ? null : periodDataFit(t, bounds);
        if (fit?.outside) {
            if (isPeriodUnchanged(t, baseline)) {
                return { invalid: false, reason: undefined, dataNote: savedOutsideDataNote(`S${n}`, 'scoring', bounds), outsideData: true };
            }
            return { invalid: true, ...outsideDataTexts(`S${n}`, bounds), fault: 'outside-data' };
        }
        if (!fault) return { invalid: false, reason: undefined, dataNote: (fit && partlyOutsideNote(fit, bounds)) ?? undefined };
        return { invalid: true, ...periodReasonTexts(`S${n}`, fault, t.start), fault };
    });
}

/** 1-based list number of the first invalid scoring period (its S-number), or null. */
export function firstInvalidTestPeriodNumber(list: TestPeriod[], bounds?: PeriodDataBounds | null, baseline?: PeriodBaseline): number | null {
    const i = validateTestPeriods(list, bounds, baseline).findIndex(s => s.invalid);
    return i < 0 ? null : i + 1;
}

/** First problem in a scoring-period list, or null. */
export function testPeriodsError(list: TestPeriod[], bounds?: PeriodDataBounds | null, baseline?: PeriodBaseline): string | null {
    for (const st of validateTestPeriods(list, bounds, baseline)) {
        if (st.invalid) return st.reason ?? 'Fix the scoring periods.';
    }
    return null;
}

/** `test_periods` wire list plus, for each entry, the S-number (1-based
 *  POSITION in the full list) of the period it came from. */
export interface TestPeriodsWirePlan {
    wire: TestPeriodWire[];
    /** `numbers[k]` = S-number of `wire[k]` — e.g. `[2]` for a list whose S1 is
     *  invalid (dropped) and S2 valid. */
    numbers: number[];
}

/** Wire shape for `test_periods`: start/end only, invalid dropped, `''` -> null, plus the S-number of each entry. `testNumberFor` maps the 1-based wire `index` back. */
export function testPeriodsWirePlan(list: TestPeriod[]): TestPeriodsWirePlan {
    const status = validateTestPeriods(list);
    const wire: TestPeriodWire[] = [];
    const numbers: number[] = [];
    list.forEach((t, i) => {
        if (status[i].invalid) return;
        wire.push({
            start: (t.start ?? '').trim() ? t.start : null,
            end: (t.end ?? '').trim() ? t.end : null,
        });
        numbers.push(i + 1);
    });
    return { wire, numbers };
}

/** Wire shape for `test_periods` — `testPeriodsWirePlan(list).wire`. */
export function toTestPeriodsWire(list: TestPeriod[]): TestPeriodWire[] {
    return testPeriodsWirePlan(list).wire;
}

/** S-number for a scoring result: `numbers` by wire index, then by position; with no mapping, position + 1. */
export function testNumberFor(
    numbers: readonly number[] | null | undefined,
    wireIndex: number | null | undefined,
    position: number,
): number {
    const valid = (n: number | undefined): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
    if (numbers && typeof wireIndex === 'number' && valid(numbers[wireIndex - 1])) return numbers[wireIndex - 1];
    if (numbers && valid(numbers[position])) return numbers[position];
    return position + 1;
}

/** Field of a Rust issue about one scoring period (`health_validation.rs`). */
const TEST_PERIOD_FIELD_RE = /^test_period_(\d+)_(start|end)$/;

/** Which scoring period an issue from Rust is about. */
export interface ScoringIssueTarget {
    /** 1-based position in the `test_periods` that were SENT (Rust's `<n>`). */
    wireIndex: number;
    /** The S-number the user sees: the period's position in the FULL list. */
    number: number;
    side: 'start' | 'end';
}

/** Maps a Rust issue field to the period the user sees. Rust numbers by position in the list it RECEIVED (invalid ones dropped), so wire 1 may be S2. `numbers` comes from `testPeriodsWirePlan`; null for other fields. */
export function scoringIssueTarget(field: string | null | undefined, numbers?: readonly number[] | null): ScoringIssueTarget | null {
    const m = TEST_PERIOD_FIELD_RE.exec((field ?? '').trim());
    if (!m) return null;
    const wireIndex = Number(m[1]);
    if (!Number.isInteger(wireIndex) || wireIndex < 1) return null;
    return { wireIndex, number: testNumberFor(numbers, wireIndex, wireIndex - 1), side: m[2] as 'start' | 'end' };
}

/** Issue text to show: Rust's message with the wire S-number replaced by the user's S-number. */
export function scoringIssueMessage(issue: Pick<HealthIssue, 'field' | 'message'>, numbers?: readonly number[] | null): string {
    const target = scoringIssueTarget(issue.field, numbers);
    if (!target || target.number === target.wireIndex) return issue.message;
    return issue.message.replace(new RegExp(`\\bS${target.wireIndex}\\b`, 'g'), `S${target.number}`);
}

/** Key of what can change results: each period's start/end in order. Ids and any other keys are excluded on purpose. */
export function testPeriodsKey(list: TestPeriod[] | null | undefined): string {
    return JSON.stringify((list ?? []).map(t => ({
        start: t.start ?? '',
        end: t.end ?? '',
    })));
}

type Interval = { s: number; e: number };

/** A period as an interval; open ends are unbounded; null when a set bound is
 *  unparseable or the period is reversed. */
function interval(p: { start: string; end: string }): Interval | null {
    const sBlank = !(p.start ?? '').trim();
    const eBlank = !(p.end ?? '').trim();
    const s = sBlank ? -Infinity : toMs(p.start);
    const e = eBlank ? Infinity : toMs(p.end);
    if (s === null || e === null || e < s) return null;
    return { s, e };
}

/** Do two periods share time? Bounds inclusive (touching counts); open ends unbounded; unparseable never overlaps. */
export function periodsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
    const x = interval(a);
    const y = interval(b);
    if (!x || !y) return false;
    return x.s <= y.e && y.s <= x.e;
}

/** Per scoring period, the 1-based numbers of the train periods it overlaps (P1 …). */
export function testTrainOverlaps(train: TimePeriod[], tests: TimePeriod[]): number[][] {
    return tests.map(t => train.flatMap((p, j) => (periodsOverlap(p, t) ? [j + 1] : [])));
}

/** Calendar days of `test` inside train periods (merged first, no double count), rounded; 0 when none. Open train ends clipped to `bounds`. Info only; `TestPeriodResult.train_days` (running days) is better once Rust answers. */
export function trainOverlapDays(train: TimePeriod[], test: TimePeriod, bounds?: { min: string; max: string } | null): number {
    const t = interval(test);
    if (!t || !Number.isFinite(t.s) || !Number.isFinite(t.e)) return 0;
    const bMin = bounds ? toMs(bounds.min) : null;
    const bMax = bounds ? toMs(bounds.max) : null;
    const pieces: Interval[] = [];
    for (const p of train) {
        const iv = interval(p);
        if (!iv) continue;
        const s = Math.max(t.s, iv.s, bMin ?? -Infinity);
        const e = Math.min(t.e, iv.e, bMax ?? Infinity);
        if (e > s) pieces.push({ s, e });
    }
    pieces.sort((a, b) => a.s - b.s);
    let ms = 0;
    let cur: Interval | null = null;
    for (const p of pieces) {
        if (cur && p.s <= cur.e) cur.e = Math.max(cur.e, p.e);
        else {
            if (cur) ms += cur.e - cur.s;
            cur = { ...p };
        }
    }
    if (cur) ms += cur.e - cur.s;
    return Math.round(ms / DAY);
}

/** Quiet note for a scoring period that includes train time; `index` is 0-based, `days` is raw running time. */
export function testIncludesTrainNote(index: number, days: number): string {
    return `S${index + 1} includes ${days} d of train running time — results include hours the model was trained on`;
}

/** One train period that overlaps an enabled Dashboard time highlight. */
export interface TrainHighlightOverlap {
    /** 0-based index into the train list (P1 = 0). */
    periodIndex: number;
    highlight: TimeHighlight;
}

/** Highlight range in order (start > end is swapped, like `timeHighlights.ts`); null if unparseable. */
function highlightRange(h: TimeHighlight): { start: string; end: string } | null {
    const a = toMs(h.start);
    const b = toMs(h.end);
    if (a === null || b === null) return null;
    return a <= b ? { start: h.start, end: h.end } : { start: h.end, end: h.start };
}

/** Train periods overlapping a Dashboard highlight (amber warning only). Disabled/unparseable highlights are ignored. */
export function trainHighlightOverlaps(train: TimePeriod[], highlights: TimeHighlight[]): TrainHighlightOverlap[] {
    const out: TrainHighlightOverlap[] = [];
    train.forEach((p, periodIndex) => {
        for (const h of highlights) {
            if (h.enabled === false) continue;
            const r = highlightRange(h);
            if (r && periodsOverlap(p, r)) out.push({ periodIndex, highlight: h });
        }
    });
    return out;
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

/** Splits every train period overlapping `range` so none lies inside it: the before-part ends the last whole minute before, the after-part starts the first whole minute after. Touching counts as overlap; a fully covered period disappears; the first piece keeps the id; the list is returned sorted. */
export function removeRangeFromPeriods(train: TimePeriod[], range: { start: string; end: string }): TimePeriod[] {
    const r = interval(range);
    if (!r) return train;
    const out: TimePeriod[] = [];
    for (const p of train) {
        const iv = interval(p);
        if (!iv || !(iv.s <= r.e && r.s <= iv.e)) {
            out.push(p);
            continue;
        }
        const pieces: TimePeriod[] = [];
        if (Number.isFinite(r.s) && iv.s < r.s) {
            const endMs = floorMinute(r.s - 1);
            if (endMs >= iv.s) pieces.push({ ...p, end: fmt(endMs) });
        }
        if (Number.isFinite(r.e) && iv.e > r.e) {
            const startMs = floorMinute(r.e) + MINUTE;
            if (startMs <= iv.e) pieces.push({ ...p, id: pieces.length ? newPeriodId() : p.id, start: fmt(startMs) });
        }
        out.push(...pieces);
    }
    return sortPeriods(out);
}

/** `removeRangeFromPeriods` for a Dashboard highlight (no-op for an
 *  unparseable one). */
export function removeHighlightOverlap(train: TimePeriod[], highlight: TimeHighlight): TimePeriod[] {
    const r = highlightRange(highlight);
    return r ? removeRangeFromPeriods(train, r) : train;
}
