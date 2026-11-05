import type { TimePeriod, WorkspaceSensorFilter } from '../../types';
import { validatePeriods } from '../../utils/timePeriods';
import { formatYearMonth } from '../../utils/dateFormat';
import { dateText, formatDataStamp, formatStamp, parseLocal } from '../../utils/workbenchDate';
import { fmtNumText } from '../sensor/sensorInfo';

/* Pure display maths for the Running Condition / Training periods UI (chips, coverage bar, day counts, rule line). */

export const DAY_MS = 86_400_000;

// Date helpers live in `utils/workbenchDate.ts` and print in `utils/dateFormat.ts`; re-exported so components import from here.
export { parseLocal, formatStamp, formatDataStamp };

export interface DataBounds {
    min: string | null | undefined;
    max: string | null | undefined;
}

const isBlank = (s: string | null | undefined) => !(s ?? '').trim();

/** True when a `datetime-local` value is a complete date. `''` means a segment is missing; a year below 1000 is still being typed ('0002-…'). */
export function isCompleteDateInput(v: string | null | undefined): boolean {
    const t = (v ?? '').trim();
    const m = /^(\d{4,6})-\d{2}-\d{2}T\d{2}:\d{2}/.exec(t);
    return !!m && Number(m[1]) >= 1000 && parseLocal(t) !== null;
}

/** Settles a date field on blur/Enter: an unparseable or cleared value returns to the committed date (if set). */
export function settleDateInput(typed: string, committed: string | null | undefined): string {
    const saved = committed ?? '';
    if (typed === saved || parseLocal(typed) !== null) return typed;
    return saved.trim() ? saved : typed;
}

/** One typed bound as '2025/11/03 06:00' (always date + time); non-dates shown as typed. */
function boundText(raw: string): string {
    const ms = parseLocal(raw);
    return ms === null ? raw : formatStamp(ms);
}

/** Dataset extent as epoch ms, or null when either side is unknown. */
export function boundsMs(b: DataBounds | null | undefined): { t0: number; t1: number } | null {
    const t0 = parseLocal(b?.min);
    const t1 = parseLocal(b?.max);
    return t0 === null || t1 === null || t1 <= t0 ? null : { t0, t1 };
}

/** Chip/row label '2025/01/01 00:00 – 2025/02/28 23:59'; an open side keeps its words, 'All data' when both are open. */
export function formatPeriod(p: TimePeriod): string {
    const sBlank = isBlank(p.start);
    const eBlank = isBlank(p.end);
    if (sBlank && eBlank) return 'All data';
    return `${sBlank ? 'Start of data' : boundText(p.start)} – ${eBlank ? 'end of data' : boundText(p.end)}`;
}

/** Step-1 card/rule chip '2026/01/01 00:00 → 2026/03/31 23:59'. An open side reads 'Start'/'End'; both open 'Whole dataset'. */
export function formatPeriodChip(p: TimePeriod): string {
    const sBlank = isBlank(p.start);
    const eBlank = isBlank(p.end);
    if (sBlank && eBlank) return 'Whole dataset';
    return `${sBlank ? 'Start' : boundText(p.start)} → ${eBlank ? 'End' : boundText(p.end)}`;
}

/** "2025/06/01" for a single bound — the date alone (falls back to the raw text). */
export function formatDate(s: string | null | undefined): string {
    const ms = parseLocal(s);
    return ms === null ? (s ?? '') : dateText(ms);
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
    /** The dataset's first / last month, "2025/01" — the ends of the strip. */
    axisLeft: string;
    axisRight: string;
}

/** Dataset coverage by the periods: used days (union of valid periods) and one segment per period; null when bounds are unknown. */
export function computeCoverage(periods: TimePeriod[], bounds: DataBounds | null | undefined): Coverage | null {
    const b = boundsMs(bounds);
    if (!b) return null;
    const { t0, t1 } = b;
    const W = t1 - t0;
    const totalDays = Math.round(W / DAY_MS);
    const axisLeft = formatYearMonth(new Date(t0));
    const axisRight = formatYearMonth(new Date(t1));
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
    /** "S2 · 2026/03/01 00:00 – 2026/03/14 23:59" (the segment's tooltip). */
    label: string;
}

/** Scoring periods on the timeline: a segment per parseable period and the dataset days inside any; null if bounds are unknown. */
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

/** Condition chip for the Step-1 card and rule sentence; `label`/`unit` resolve a tag to its description/unit (optional). */
export function conditionChipParts(
    f: WorkspaceSensorFilter,
    label?: (tag: string) => string,
    unit?: (tag: string) => string,
): ConditionChipParts {
    const u = (unit ? unit(f.sensor) : '').trim();
    // Display numbers use the one en-US formatter (thousands separators).
    const value = f.operation === 'between' ? `${fmtNumText(f.value1)}–${fmtNumText(f.value2)}` : fmtNumText(f.value1);
    return {
        name: (label ? label(f.sensor) : '') || f.sensor,
        rest: `${conditionSymbol(f.operation)} ${value}${u ? ` ${u}` : ''}`,
    };
}
