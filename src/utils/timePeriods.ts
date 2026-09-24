import type { TimePeriod } from '../types';

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

/** Chip text: dates only when the range is whole days (00:00 → 23:59), else
 *  date + time. Open ends read "Start of data" / "End of data". */
export function periodChipLabel(p: TimePeriod): string {
    const fmtPart = (s: string, isEnd: boolean, wholeDay: boolean): string => {
        if (!(s ?? '').trim()) return isEnd ? 'End of data' : 'Start of data';
        const norm = s.trim().replace(' ', 'T');
        const [date, time = ''] = norm.split('T');
        return wholeDay || !time ? date : `${date} ${time.slice(0, 5)}`;
    };
    const startTime = (p.start ?? '').trim().replace(' ', 'T').split('T')[1]?.slice(0, 5);
    const endTime = (p.end ?? '').trim().replace(' ', 'T').split('T')[1]?.slice(0, 5);
    const startOk = !(p.start ?? '').trim() || !startTime || startTime === '00:00';
    const endOk = !(p.end ?? '').trim() || !endTime || endTime === '23:59';
    const whole = startOk && endOk;
    return `${fmtPart(p.start, false, whole)} – ${fmtPart(p.end, true, whole)}`;
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
