import type { TimePeriod, WorkspaceSensorFilter } from '../../types';
import { validatePeriods } from '../../utils/timePeriods';
import { MONTHS_SHORT, clockText, dateText, formatDataStamp, formatStamp, parseLocal } from '../../utils/workbenchDate';
import { fmtNumText } from '../sensor/sensorInfo';

/*
 * Pure display maths for the Running Condition / Training periods UI
 * (chips, coverage bar, day counts, the "Row is used when ..." rule line).
 * Kept out of the components so the numbers are unit-testable; the visual
 * spec is the approved time-ranges.html mockup.
 */

export const DAY_MS = 86_400_000;

// The Workbench date format and the local-time parser live in `utils/workbenchDate.ts`
// since 2026-10-10 (the pure period helpers in `utils/` print dates with them too);
// re-exported here so components keep importing them from this file.
export { parseLocal, formatStamp, formatDataStamp };
const MONTHS = MONTHS_SHORT;

export interface DataBounds {
    min: string | null | undefined;
    max: string | null | undefined;
}

const isBlank = (s: string | null | undefined) => !(s ?? '').trim();
const hhmm = clockText;
const dateTxt = dateText;

/** Dataset extent as epoch ms, or null when either side is unknown. */
export function boundsMs(b: DataBounds | null | undefined): { t0: number; t1: number } | null {
    const t0 = parseLocal(b?.min);
    const t1 = parseLocal(b?.max);
    return t0 === null || t1 === null || t1 <= t0 ? null : { t0, t1 };
}

/**
 * Chip / row label: "1 Jan – 28 Feb 2025" (year once when both ends share it),
 * "1 Nov 2025 – 15 Jan 2026", "3 Nov 2025 06:00 – 19 Dec 2025 18:00" when a
 * side isn't a whole day, "Start of data – 28 Feb 2025", "1 Nov 2025 – end of
 * data", and "All data" when both sides are open.
 */
export function formatPeriod(p: TimePeriod): string {
    const sBlank = isBlank(p.start);
    const eBlank = isBlank(p.end);
    if (sBlank && eBlank) return 'All data';
    const s = parseLocal(p.start);
    const e = parseLocal(p.end);
    const whole = (sBlank || (s !== null && hhmm(s) === '00:00')) && (eBlank || (e !== null && hhmm(e) === '23:59'));
    const sy = s === null ? null : new Date(s).getFullYear();
    const ey = e === null ? null : new Date(e).getFullYear();
    const left = sBlank ? 'Start of data'
        : s === null ? p.start
        : whole ? dateTxt(s, sy !== ey) : `${dateTxt(s, true)} ${hhmm(s)}`;
    const right = eBlank ? 'end of data'
        : e === null ? p.end
        : whole ? dateTxt(e, true) : `${dateTxt(e, true)} ${hhmm(e)}`;
    return `${left} – ${right}`;
}

/**
 * Step-1 card / rule-sentence chip: "1 Jan 2026 → 31 Mar 2026". Always the year
 * on both sides; a side that is not a whole-day boundary (start 00:00 / end
 * 23:59) also gets its time. An open side reads "Start" / "End"; both open
 * reads "Whole dataset". Unparseable text is shown as typed.
 */
export function formatPeriodChip(p: TimePeriod): string {
    const sBlank = isBlank(p.start);
    const eBlank = isBlank(p.end);
    if (sBlank && eBlank) return 'Whole dataset';
    const side = (raw: string, blank: boolean, openLabel: string, wholeTime: string): string => {
        if (blank) return openLabel;
        const ms = parseLocal(raw);
        if (ms === null) return raw;
        return hhmm(ms) === wholeTime ? dateTxt(ms, true) : `${dateTxt(ms, true)} ${hhmm(ms)}`;
    };
    return `${side(p.start, sBlank, 'Start', '00:00')} → ${side(p.end, eBlank, 'End', '23:59')}`;
}

/** "1 Jun 2025" for a single bound (falls back to the raw text). */
export function formatDate(s: string | null | undefined): string {
    const ms = parseLocal(s);
    return ms === null ? (s ?? '') : dateTxt(ms, true);
}

/** Whole days a period spans (open ends resolve to the dataset bounds); null if unknowable or reversed. */
export function periodDays(p: TimePeriod, bounds: DataBounds | null | undefined): number | null {
    const b = boundsMs(bounds);
    const s = isBlank(p.start) ? b?.t0 ?? null : parseLocal(p.start);
    const e = isBlank(p.end) ? b?.t1 ?? null : parseLocal(p.end);
    if (s === null || e === null || e < s) return null;
    return Math.round((e - s) / DAY_MS);
}

/** Days the later period overlaps the earlier one (>= 1), or null if unknowable. */
export function overlapDays(prev: TimePeriod, cur: TimePeriod, bounds: DataBounds | null | undefined): number | null {
    const b = boundsMs(bounds);
    const prevEnd = isBlank(prev.end) ? b?.t1 ?? null : parseLocal(prev.end);
    const curStart = isBlank(cur.start) ? b?.t0 ?? null : parseLocal(cur.start);
    const curEnd = isBlank(cur.end) ? b?.t1 ?? null : parseLocal(cur.end);
    if (prevEnd === null || curStart === null || curEnd === null) return null;
    return Math.max(1, Math.round((Math.min(prevEnd, curEnd) - curStart) / DAY_MS));
}

export interface CoverageSegment {
    leftPct: number;
    widthPct: number;
    kind: 'ok' | 'bad' | 'ovl';
    label: string;
}

export interface Coverage {
    totalDays: number;
    /** Days of the dataset inside at least one valid period (overlap counted once). */
    usedDays: number;
    /** True when no period is set (everything is used). */
    unlimited: boolean;
    segments: CoverageSegment[];
    axisLeft: string;
    axisRight: string;
}

/**
 * Coverage of the dataset by the periods: used days (union of valid periods,
 * clamped to the dataset, open ends run to the edge) and one drawable segment
 * per period. Null when the dataset bounds are unknown (no bar is drawn).
 */
export function computeCoverage(periods: TimePeriod[], bounds: DataBounds | null | undefined): Coverage | null {
    const b = boundsMs(bounds);
    if (!b) return null;
    const { t0, t1 } = b;
    const W = t1 - t0;
    const totalDays = Math.round(W / DAY_MS);
    const axisLeft = `${MONTHS[new Date(t0).getMonth()]} ${new Date(t0).getFullYear()}`;
    const axisRight = `${MONTHS[new Date(t1).getMonth()]} ${new Date(t1).getFullYear()}`;
    if (periods.length === 0) {
        return { totalDays, usedDays: totalDays, unlimited: true, axisLeft, axisRight,
            segments: [{ leftPct: 0, widthPct: 100, kind: 'ok', label: 'All data' }] };
    }
    const status = validatePeriods(periods);
    const ivs: [number, number][] = [];
    const segments: CoverageSegment[] = [];
    periods.forEach((p, i) => {
        const s = isBlank(p.start) ? t0 : parseLocal(p.start);
        const e = isBlank(p.end) ? t1 : parseLocal(p.end);
        if (s === null || e === null) return; // unparseable: nothing to draw or count
        const reversed = e < s;
        const a = Math.max(t0, Math.min(s, e));
        const z = Math.min(t1, Math.max(s, e));
        if (z > a || !reversed) {
            segments.push({
                leftPct: Math.max(0, Math.min(100, ((a - t0) / W) * 100)),
                widthPct: Math.max(0.6, Math.min(100, ((z - a) / W) * 100)),
                kind: reversed ? 'bad' : status[i]?.overlapsPrev ? 'ovl' : 'ok',
                label: formatPeriod(p),
            });
        }
        if (!status[i]?.invalid) ivs.push([Math.max(t0, s), Math.min(t1, e)]);
    });
    ivs.sort((x, y) => x[0] - y[0]);
    let total = 0;
    let cs: number | null = null;
    let ce = 0;
    for (const [s, e] of ivs) {
        if (e <= s) continue;
        if (cs === null) { cs = s; ce = e; } else if (s <= ce) { ce = Math.max(ce, e); } else { total += ce - cs; cs = s; ce = e; }
    }
    if (cs !== null) total += ce - cs;
    return { totalDays, usedDays: Math.round(total / DAY_MS), unlimited: false, segments, axisLeft, axisRight };
}

export interface TestCoverageSegment {
    leftPct: number;
    widthPct: number;
    /** "S2 · 1 Mar 2026 → 14 Mar 2026" (the segment's tooltip). */
    label: string;
}

/**
 * Scoring periods on the dataset timeline: one segment per scoring period with
 * a parseable range (clamped to the dataset; open ends run to the edge) and
 * the days of the dataset inside at least one of them (overlap counted once).
 * Null when the dataset bounds are unknown. Only start / end are read — a
 * legacy label on an old workspace's period changes nothing here.
 */
export function computeTestCoverage(tests: TimePeriod[], bounds: DataBounds | null | undefined): { usedDays: number; segments: TestCoverageSegment[] } | null {
    const b = boundsMs(bounds);
    if (!b) return null;
    const { t0, t1 } = b;
    const W = t1 - t0;
    const ivs: [number, number][] = [];
    const segments: TestCoverageSegment[] = [];
    tests.forEach((t, i) => {
        const s = isBlank(t.start) ? t0 : parseLocal(t.start);
        const e = isBlank(t.end) ? t1 : parseLocal(t.end);
        if (s === null || e === null || e < s) return;
        const a = Math.max(t0, s);
        const z = Math.min(t1, e);
        if (z < a) return;
        segments.push({
            leftPct: ((a - t0) / W) * 100,
            widthPct: Math.max(0.6, ((z - a) / W) * 100),
            label: `S${i + 1} · ${formatPeriod(t)}`,
        });
        ivs.push([a, z]);
    });
    ivs.sort((x, y) => x[0] - y[0]);
    let total = 0;
    let cs: number | null = null;
    let ce = 0;
    for (const [s, e] of ivs) {
        if (cs === null) { cs = s; ce = e; } else if (s <= ce) { ce = Math.max(ce, e); } else { total += ce - cs; cs = s; ce = e; }
    }
    if (cs !== null) total += ce - cs;
    return { usedDays: Math.round(total / DAY_MS), segments };
}

/** Estimated RUNNING days of the train rows from a row count: the dataset's
 *  span x the share of its rows that are used (rows are close to evenly spaced
 *  in time). Null when anything is unknown. Used for the amber "below the
 *  recommended train time" note before Rust's exact `test_validation.train.days`
 *  exists (e.g. the Running condition modal's draft). */
export function estimateRunningDays(used: number | null | undefined, total: number | null | undefined, bounds: DataBounds | null | undefined): number | null {
    const b = boundsMs(bounds);
    if (!b || typeof used !== 'number' || typeof total !== 'number' || !(total > 0)) return null;
    return ((b.t1 - b.t0) / DAY_MS) * Math.min(1, Math.max(0, used / total));
}

export function conditionSymbol(op: WorkspaceSensorFilter['operation']): string {
    return op === 'greater_than' ? '>' : op === 'less_than' ? '<' : op === 'between' ? 'between' : '=';
}

/** "TAG > 12" / "TAG between 1–5" — the tag form used in the rule line. */
export function conditionText(f: WorkspaceSensorFilter, label?: (tag: string) => string): string {
    const name = label ? label(f.sensor) : f.sensor;
    return `${name} ${conditionSymbol(f.operation)} ${f.operation === 'between' ? `${f.value1}–${f.value2}` : f.value1}`;
}

export interface ConditionChipParts {
    /** Sensor name (description, else the tag). */
    name: string;
    /** "> 4000 kW" / "between 1–5 kW" — everything after the name. */
    rest: string;
}

/** Condition chip for the Step-1 card and the rule sentence. `label` / `unit`
 *  resolve a tag to its description / unit (both optional). */
export function conditionChipParts(
    f: WorkspaceSensorFilter,
    label?: (tag: string) => string,
    unit?: (tag: string) => string,
): ConditionChipParts {
    const u = (unit ? unit(f.sensor) : '').trim();
    // Customer item 3: display numbers use the one en-US formatter (thousands separators).
    const value = f.operation === 'between' ? `${fmtNumText(f.value1)}–${fmtNumText(f.value2)}` : fmtNumText(f.value1);
    return {
        name: (label ? label(f.sensor) : '') || f.sensor,
        rest: `${conditionSymbol(f.operation)} ${value}${u ? ` ${u}` : ''}`,
    };
}
