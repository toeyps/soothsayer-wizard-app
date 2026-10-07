import type { TestPeriod, TimeHighlight, TimePeriod } from '../types';
import type { TestPeriodWire } from '../types/health';

export interface PeriodStatus {
    /** Unparseable bound, end before start, or an open end where none is allowed. */
    invalid: boolean;
    /** User-facing reason when `invalid`. */
    reason?: string;
    /** Starts strictly before the previous period ends (touching is NOT overlap). */
    overlapsPrev: boolean;
}

export interface FilterRange {
    start: string | null;
    end: string | null;
}

const MINUTE = 60_000;

/** Epoch ms of a `datetime-local` / ISO-ish string as LOCAL time; null if empty
 *  or unparseable. Date-only strings are read as local midnight. */
function toMs(s: string): number | null {
    const t = (s ?? '').trim();
    if (!t) return null;
    const norm = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00` : t.replace(' ', 'T');
    const ms = new Date(norm).getTime();
    return Number.isNaN(ms) ? null : ms;
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

/**
 * Per-period validity + overlap with the previous period (list order — call on
 * a sorted list). Open ends ('') are valid only on the first period's start
 * and the last period's end.
 */
export function validatePeriods(list: TimePeriod[]): PeriodStatus[] {
    const parsed = list.map((p) => ({ s: toMs(p.start), e: toMs(p.end) }));
    return list.map((p, i) => {
        const { s, e } = parsed[i];
        const startBlank = !(p.start ?? '').trim();
        const endBlank = !(p.end ?? '').trim();
        let reason: string | undefined;
        if (!startBlank && s === null) reason = `Period ${i + 1} has an invalid start date.`;
        else if (!endBlank && e === null) reason = `Period ${i + 1} has an invalid end date.`;
        else if (startBlank && i !== 0) reason = `Period ${i + 1} needs a start date.`;
        else if (endBlank && i !== list.length - 1) reason = `Period ${i + 1} needs an end date.`;
        else if (s !== null && e !== null && e < s) reason = `Period ${i + 1} ends before it starts.`;

        let overlapsPrev = false;
        if (!reason && i > 0 && !statusInvalidAt(list, parsed, i - 1)) {
            const prevEnd = parsed[i - 1].e;
            const prevOpenEnd = !(list[i - 1].end ?? '').trim();
            const curStart = s; // null = open start
            if (prevOpenEnd || curStart === null) overlapsPrev = true;
            else if (prevEnd !== null && curStart < prevEnd) overlapsPrev = true;
        }
        return { invalid: !!reason, reason, overlapsPrev };
    });
}

/** Cheap "is the previous period itself unparseable / reversed" check used to
 *  skip overlap reporting against a period that is already flagged. */
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

/**
 * Default for the "Add period" button: starts the day after the last period's
 * end (00:00) and runs to 23:59 on the last day of that month, clamped to
 * `datasetMax`. Empty list → one fully open period. Returns null when nothing
 * sensible can be added (last period is open-ended, its end is invalid, or the
 * new start would be past `datasetMax`).
 */
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

/** True when the valid periods together span all of `bounds` (gaps of up to a
 *  minute count as continuous, so 23:59 → next-day 00:00 is contiguous). An
 *  empty list is NOT "covered" (it means "no time gate"). */
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

/** Wire shape for `timestamp_ranges`: invalid periods are dropped, `''` → null.
 *  NOTE: an empty result is ambiguous ("no periods" vs "none valid") — callers
 *  must check `validatePeriods` themselves before sending `[]`. */
export function toFilterRanges(list: TimePeriod[]): FilterRange[] {
    const status = validatePeriods(list);
    return list
        .filter((_, i) => !status[i].invalid)
        .map((p) => ({
            start: (p.start ?? '').trim() ? p.start : null,
            end: (p.end ?? '').trim() ? p.end : null,
        }));
}

// ---------------------------------------------------------------------------
// Train/Test validation (2026-10-07, SPEC "Train/Test model validation").
// `runningConditionTimePeriods` / a model's `filterTimePeriods` are the TRAIN
// periods; `TestPeriod`s are where the score is checked. Everything below is
// pure and works on `datetime-local` strings read as LOCAL time (like `toMs`).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/** Validity of one test period (list order = T1, T2 …). */
export interface TestPeriodStatus {
    /** Start/end missing or unparseable, or end before start. Blocks Apply. */
    invalid: boolean;
    reason?: string;
    /** The event time is set but unparseable or outside the period. Blocks Apply. */
    eventInvalid: boolean;
    eventReason?: string;
}

/**
 * Event time of a test period (SPEC rule 5): optional, only read for a Known
 * problem; when set it must parse and lie INSIDE the period (bounds inclusive).
 * Returns the user-facing reason, or null when fine. `n` is the 1-based number
 * used in the text ("T2").
 */
export function eventTimeError(t: TestPeriod, n = 1): string | null {
    if (t.label !== 'problem') return null;
    const raw = (t.eventTime ?? '').trim();
    if (!raw) return null;
    const ev = toMs(raw);
    if (ev === null) return `T${n} has an invalid event time.`;
    const s = toMs(t.start);
    const e = toMs(t.end);
    if ((s !== null && ev < s) || (e !== null && ev > e)) return `The event time must be inside T${n}.`;
    return null;
}

/**
 * Per-test-period validity. DECISION (2026-10-07): unlike train periods, a test
 * period needs BOTH a start and an end — its day count, "% of running time
 * below 80" and the event lead time are only meaningful on a closed range, and
 * both ways of adding one (Add test period, From Highlights) produce closed
 * ranges. Test periods may overlap each other and train periods (never invalid
 * for that).
 */
export function validateTestPeriods(list: TestPeriod[]): TestPeriodStatus[] {
    return list.map((t, i) => {
        const n = i + 1;
        const startBlank = !(t.start ?? '').trim();
        const endBlank = !(t.end ?? '').trim();
        const s = toMs(t.start);
        const e = toMs(t.end);
        let reason: string | undefined;
        if (startBlank) reason = `T${n} needs a start date.`;
        else if (endBlank) reason = `T${n} needs an end date.`;
        else if (s === null) reason = `T${n} has an invalid start date.`;
        else if (e === null) reason = `T${n} has an invalid end date.`;
        else if (e < s) reason = `T${n} ends before it starts.`;
        const eventReason = eventTimeError(t, n) ?? undefined;
        return { invalid: !!reason, reason, eventInvalid: !!eventReason, eventReason };
    });
}

/** First problem in a test-period list (a period first, then its event time), or null. */
export function testPeriodsError(list: TestPeriod[]): string | null {
    for (const st of validateTestPeriods(list)) {
        if (st.invalid) return st.reason ?? 'Fix the test periods.';
        if (st.eventInvalid) return st.eventReason ?? 'Fix the event time.';
    }
    return null;
}

/** `test_periods` wire list plus, for each entry, the T-number (1-based
 *  POSITION in the full list) of the period it came from. */
export interface TestPeriodsWirePlan {
    wire: TestPeriodWire[];
    /** `numbers[k]` = T-number of `wire[k]` — e.g. `[2]` for a list whose T1 is
     *  invalid (dropped) and T2 valid. */
    numbers: number[];
}

/** Wire shape for `test_periods` (invalid periods are dropped, `''` → null,
 *  `event_time` only for a Known problem with a valid event time) together with
 *  the T-number of every entry sent. Results come back with the 1-based WIRE
 *  `index`; `testNumberFor` maps that back to the T-number the editor and the
 *  Step-1 chips show (they number the full list, invalid periods included). */
export function testPeriodsWirePlan(list: TestPeriod[]): TestPeriodsWirePlan {
    const status = validateTestPeriods(list);
    const wire: TestPeriodWire[] = [];
    const numbers: number[] = [];
    list.forEach((t, i) => {
        if (status[i].invalid) return;
        const ev = (t.eventTime ?? '').trim();
        wire.push({
            start: (t.start ?? '').trim() ? t.start : null,
            end: (t.end ?? '').trim() ? t.end : null,
            label: t.label,
            event_time: t.label === 'problem' && ev && !status[i].eventInvalid ? ev : null,
        });
        numbers.push(i + 1);
    });
    return { wire, numbers };
}

/** Wire shape for `test_periods` — `testPeriodsWirePlan(list).wire`. */
export function toTestPeriodsWire(list: TestPeriod[]): TestPeriodWire[] {
    return testPeriodsWirePlan(list).wire;
}

/**
 * The T-number to show for a test result. `numbers` is
 * `testPeriodsWirePlan(...).numbers` of the list that was sent; `wireIndex` is
 * the result's 1-based `index` (its position in the `test_periods` sent) and
 * `position` its 0-based position in the results. Looks the T-number up by the
 * wire index, then by position; with no mapping at all (or none covering it)
 * the result's position is the number (T1, T2 … in result order).
 */
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

/** What of a test-period list can change its RESULTS (no id, no
 *  `fromHighlight`; the event time only counts for a Known problem). Used to
 *  detect a "tests only" change (`applyIncompleteRule`) and export races. */
export function testPeriodsKey(list: TestPeriod[] | null | undefined): string {
    return JSON.stringify((list ?? []).map(t => ({
        start: t.start ?? '',
        end: t.end ?? '',
        label: t.label,
        eventTime: t.label === 'problem' ? (t.eventTime ?? '').trim() : '',
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

/** Do two periods share any time? Open ends are unbounded; bounds are
 *  inclusive (touching counts); an unparseable period never overlaps. */
export function periodsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
    const x = interval(a);
    const y = interval(b);
    if (!x || !y) return false;
    return x.s <= y.e && y.s <= x.e;
}

/** Per test period, the 1-based numbers of the train periods it overlaps (P1 …). */
export function testTrainOverlaps(train: TimePeriod[], tests: TimePeriod[]): number[][] {
    return tests.map(t => train.flatMap((p, j) => (periodsOverlap(p, t) ? [j + 1] : [])));
}

/**
 * CALENDAR days of `test` that are also inside a train period (train periods
 * merged first, so overlapping train periods are not counted twice), rounded
 * to whole days; 0 when none. Information only (SPEC rule 3 — never blocks).
 * Open train ends are clipped to `bounds` when given. Before a preview exists
 * the UI uses this; once Rust answered, `TestPeriodResult.train_days`
 * (RUNNING days) is the better number.
 */
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

/** The neutral note on a test row / table row / result tile that includes
 *  train time (SPEC rule 3). `index` is 0-based (T1 = 0). */
export function testIncludesTrainNote(index: number, days: number): string {
    return `T${index + 1} includes ${days} d of train running time — results include rows the model was trained on`;
}

/** One train period that overlaps an enabled Dashboard time highlight. */
export interface TrainHighlightOverlap {
    /** 0-based index into the train list (P1 = 0). */
    periodIndex: number;
    highlight: TimeHighlight;
}

/** A highlight's time range in order (one saved with start > end is read the
 *  other way round, like `timeHighlights.ts`); null when unparseable. */
function highlightRange(h: TimeHighlight): { start: string; end: string } | null {
    const a = toMs(h.start);
    const b = toMs(h.end);
    if (a === null || b === null) return null;
    return a <= b ? { start: h.start, end: h.end } : { start: h.end, end: h.start };
}

/**
 * Train periods that overlap a Dashboard highlight (SPEC rule 4 — an amber
 * warning only, never a block). Disabled / unparseable highlights are ignored.
 */
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

/**
 * "Remove the overlap" (SPEC rule 4): every train period that overlaps
 * `range` is split so none of it lies inside `range` — the part before ends on
 * the last whole minute before the range starts, the part after starts on the
 * first whole minute after it ends (minute resolution, like the period inputs;
 * bounds are inclusive, so merely touching would still count as overlap). A
 * period entirely inside the range disappears. The first piece keeps the
 * original `id`; a second piece gets a new one. Periods that do not overlap
 * (or are invalid) are kept unchanged. Returns the list sorted (`sortPeriods`).
 */
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
