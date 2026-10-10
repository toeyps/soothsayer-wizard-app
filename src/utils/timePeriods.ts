import type { TestPeriod, TimeHighlight, TimePeriod } from '../types';
import type { HealthIssue, TestPeriodWire } from '../types/health';
import { formatBound, parseLocal } from './workbenchDate';

/** What is wrong with an invalid period (stable; the UI may key on it — e.g.
 *  which date field to mark red). */
export type PeriodFault =
    | 'start-invalid'
    | 'end-invalid'
    | 'start-missing'
    | 'end-missing'
    | 'ends-before-start';

export interface PeriodStatus {
    /** Unparseable bound, end before start, or an open end where none is allowed. */
    invalid: boolean;
    /** Short sentence when `invalid`, naming the period by its list number:
     *  "P2 ends before it starts." Used by the gates and wherever the reason is
     *  followed by another sentence ("… Fix it in Model settings"). */
    reason?: string;
    /** The ONE reason line under the period's own row when `invalid` (no full
     *  stop, and a hint what to do where there is one): "P2 ends before it
     *  starts — pick an end after 11 May 2026", "P2 needs a start date". */
    rowReason?: string;
    /** What is wrong, when `invalid`. */
    fault?: PeriodFault;
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
const toMs = parseLocal;

const FAULT_WORDS: Record<PeriodFault, string> = {
    'start-invalid': 'has an invalid start date',
    'end-invalid': 'has an invalid end date',
    'start-missing': 'needs a start date',
    'end-missing': 'needs an end date',
    'ends-before-start': 'ends before it starts',
};

/**
 * The two texts of one invalid period. `name` is the period as the user sees
 * it — "P2" (train period, by list position) or "S1" (scoring period) — never
 * "Period 2". `reason` is the short sentence ("P2 ends before it starts.");
 * `rowReason` the one line under the row, with what to do when that is known
 * ("P2 ends before it starts — pick an end after 11 May 2026"; the date is the
 * period's own start in the Workbench date format).
 */
export function periodReasonTexts(name: string, fault: PeriodFault, start?: string | null): { reason: string; rowReason: string } {
    const core = `${name} ${FAULT_WORDS[fault]}`;
    const after = fault === 'ends-before-start' ? formatBound(start, 'start') : '';
    return { reason: `${core}.`, rowReason: after ? `${core} — pick an end after ${after}` : core };
}

/** The date field a fault is about (for "Fix P1's end above" and for marking
 *  the field red). */
export function faultSide(fault: PeriodFault): 'start' | 'end' {
    return fault === 'start-invalid' || fault === 'start-missing' ? 'start' : 'end';
}

/** Footer line of the Running-condition settings while a period is invalid:
 *  "Fix P2 before applying" (`action` = "saving" for a model's own Custom
 *  lists, which are saved with Save changes). */
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

/**
 * Per-period validity + overlap with the previous period (list order — call on
 * a sorted list). Open ends ('') are valid only on the first period's start
 * and the last period's end. Reasons name a train period "P1", "P2" … by its
 * list position (workbench redesign 2026-10: never "Period 1").
 */
export function validatePeriods(list: TimePeriod[]): PeriodStatus[] {
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
        const texts = fault ? periodReasonTexts(`P${i + 1}`, fault, p.start) : undefined;

        let overlapsPrev = false;
        if (!fault && i > 0 && !statusInvalidAt(list, parsed, i - 1)) {
            const prevEnd = parsed[i - 1].e;
            const prevOpenEnd = !(list[i - 1].end ?? '').trim();
            const curStart = s; // null = open start
            if (prevOpenEnd || curStart === null) overlapsPrev = true;
            else if (prevEnd !== null && curStart < prevEnd) overlapsPrev = true;
        }
        return { invalid: !!fault, reason: texts?.reason, rowReason: texts?.rowReason, fault, overlapsPrev };
    });
}

/** 1-based list number of the first invalid train period (its P-number), or null. */
export function firstInvalidPeriodNumber(list: TimePeriod[]): number | null {
    const i = validatePeriods(list).findIndex(s => s.invalid);
    return i < 0 ? null : i + 1;
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
// Train periods vs scoring periods. `runningConditionTimePeriods` / a model's
// `filterTimePeriods` are the TRAIN periods; `TestPeriod`s are the SCORING
// periods — "just score it" (user decision 2026-10-09, SPEC
// docs/design/handoff/workbench-redesign/README.md §2): start → end only, the
// trained model gives a health score for that time. They were called "test
// periods" until 2026-10-10 and the identifiers below keep that name (as do
// the storage keys and the `test_periods` wire key) so nothing about the
// workspace format changes; the user-facing words are "scoring period" and the
// numbers are S1, S2 … by list position. Everything below is pure and works on
// `datetime-local` strings read as LOCAL time (like `toMs`).
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/**
 * A scoring period as it is WRITTEN: `id`, `start`, `end` and nothing else.
 *
 * A workspace saved before 2026-10-10 may carry `label` / `eventTime` /
 * `fromHighlight` on its periods. They stay readable (the type allows them) but
 * nothing may write them any more, and a spread (`{ ...t, start }`) would carry
 * them along silently — so every place that BUILDS or COPIES a period (the
 * editor's add / edit, `seedCustomFromWorkspace`) goes through this instead.
 * A period that is never touched keeps whatever is on disk (no migration).
 */
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
    /** The one reason line under the row when `invalid` (see
     *  `PeriodStatus.rowReason`): "S2 ends before it starts — pick an end
     *  after 11 May 2026". */
    rowReason?: string;
    /** What is wrong, when `invalid`. */
    fault?: PeriodFault;
}

/**
 * Per-scoring-period validity. DECISION (2026-10-07, kept): unlike train
 * periods, a scoring period needs BOTH a start and an end — its day count and
 * "% of running time below 80" are only meaningful on a closed range. Scoring
 * periods may overlap each other and train periods (never invalid for that).
 * The reason text names the period by its number ("S2 needs an end date.").
 */
export function validateTestPeriods(list: TestPeriod[]): TestPeriodStatus[] {
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
        if (!fault) return { invalid: false, reason: undefined };
        return { invalid: true, ...periodReasonTexts(`S${n}`, fault, t.start), fault };
    });
}

/** 1-based list number of the first invalid scoring period (its S-number), or null. */
export function firstInvalidTestPeriodNumber(list: TestPeriod[]): number | null {
    const i = validateTestPeriods(list).findIndex(s => s.invalid);
    return i < 0 ? null : i + 1;
}

/** First problem in a scoring-period list, or null. */
export function testPeriodsError(list: TestPeriod[]): string | null {
    for (const st of validateTestPeriods(list)) {
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

/** Wire shape for `test_periods` — start / end only (invalid periods are
 *  dropped, `''` → null; a legacy label / event time is never sent) together
 *  with the S-number of every entry sent. Results come back with the 1-based
 *  WIRE `index`; `testNumberFor` maps that back to the S-number the editor and
 *  the running-condition chips show (they number the full list, invalid
 *  periods included). */
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

/**
 * The S-number to show for a scoring result. `numbers` is
 * `testPeriodsWirePlan(...).numbers` of the list that was sent; `wireIndex` is
 * the result's 1-based `index` (its position in the `test_periods` sent) and
 * `position` its 0-based position in the results. Looks the S-number up by the
 * wire index, then by position; with no mapping at all (or none covering it)
 * the result's position is the number (S1, S2 … in result order).
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

/** `test_period_<n>_start` / `test_period_<n>_end` — the `field` of an issue
 *  Rust raises about one scoring period (`health_validation.rs`). */
const TEST_PERIOD_FIELD_RE = /^test_period_(\d+)_(start|end)$/;

/** Which scoring period an issue from Rust is about. */
export interface ScoringIssueTarget {
    /** 1-based position in the `test_periods` that were SENT (Rust's `<n>`). */
    wireIndex: number;
    /** The S-number the user sees: the period's position in the FULL list. */
    number: number;
    side: 'start' | 'end';
}

/**
 * Maps the `field` of a Rust issue about a scoring period back to the period
 * the user sees. Rust numbers by position in the list it RECEIVED, and invalid
 * periods are dropped before sending (`testPeriodsWirePlan`), so with the list
 * [S1 invalid, S2] an issue on `test_period_1_end` is about **S2**. `numbers`
 * is `testPeriodsWirePlan(...).numbers` of the list that was sent; without it
 * (or when it does not cover the index) the wire position is the number.
 * `null` for any other field (`lower`, `test_periods`, …).
 */
export function scoringIssueTarget(field: string | null | undefined, numbers?: readonly number[] | null): ScoringIssueTarget | null {
    const m = TEST_PERIOD_FIELD_RE.exec((field ?? '').trim());
    if (!m) return null;
    const wireIndex = Number(m[1]);
    if (!Number.isInteger(wireIndex) || wireIndex < 1) return null;
    return { wireIndex, number: testNumberFor(numbers, wireIndex, wireIndex - 1), side: m[2] as 'start' | 'end' };
}

/**
 * The text to SHOW for an issue: Rust's own `message`, with the wire number of
 * a scoring period ("Scoring period S1 ends before it starts.") replaced by
 * the S-number of the list the user sees ("Scoring period S2 …"). Every other
 * issue's message is returned unchanged.
 */
export function scoringIssueMessage(issue: Pick<HealthIssue, 'field' | 'message'>, numbers?: readonly number[] | null): string {
    const target = scoringIssueTarget(issue.field, numbers);
    if (!target || target.number === target.wireIndex) return issue.message;
    return issue.message.replace(new RegExp(`\\bS${target.wireIndex}\\b`, 'g'), `S${target.number}`);
}

/**
 * What of a scoring-period list can change its RESULTS: each period's start and
 * end, in list order — nothing else. Used to detect a "scoring periods only"
 * change (`applyIncompleteRule`) and an edit during an export
 * (`persistModelComplete`).
 *
 * The id and the legacy `label` / `eventTime` / `fromHighlight` keys of a
 * workspace saved before 2026-10-10 are deliberately NOT part of it: Rust
 * ignores them, so they cannot change a result — and it means a period that
 * loses those keys when it passes through an edit (`toScoringPeriod`) is NOT
 * read as a change, so a Complete model of an old workspace is never sent back
 * to "Mark complete again" by the upgrade.
 */
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

/** Do two periods share any time? Open ends are unbounded; bounds are
 *  inclusive (touching counts); an unparseable period never overlaps. */
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

/**
 * CALENDAR days of `test` that are also inside a train period (train periods
 * merged first, so overlapping train periods are not counted twice), rounded
 * to whole days; 0 when none. Information only (never blocks).
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

/** The one quiet note on a scoring-period row / result tile that includes
 *  train time. `index` is 0-based (S1 = 0). */
export function testIncludesTrainNote(index: number, days: number): string {
    return `S${index + 1} includes ${days} d of train running time — results include rows the model was trained on`;
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
