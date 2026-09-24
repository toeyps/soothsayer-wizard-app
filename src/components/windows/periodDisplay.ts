import type { TimePeriod, WorkspaceSensorFilter } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { validatePeriods } from '../../utils/timePeriods';

/*
 * Pure display maths for the Running Condition / Training periods UI
 * (chips, coverage bar, day counts, the "Row is used when ..." rule line).
 * Kept out of the components so the numbers are unit-testable; the visual
 * spec is the approved time-ranges.html mockup.
 */

export const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export interface DataBounds {
    min: string | null | undefined;
    max: string | null | undefined;
}

/** Epoch ms of a `datetime-local` / ISO-ish string as LOCAL time; null if blank/unparseable. */
export function parseLocal(s: string | null | undefined): number | null {
    const t = (s ?? '').trim();
    if (!t) return null;
    const norm = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00` : t.replace(' ', 'T');
    const ms = new Date(norm).getTime();
    return Number.isNaN(ms) ? null : ms;
}

const isBlank = (s: string | null | undefined) => !(s ?? '').trim();
const hhmm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const dateTxt = (ms: number, withYear: boolean) => {
    const d = new Date(ms);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
};

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

export function conditionSymbol(op: WorkspaceSensorFilter['operation']): string {
    return op === 'greater_than' ? '>' : op === 'less_than' ? '<' : op === 'between' ? 'between' : '=';
}

/** "TAG > 12" / "TAG between 1–5" — the tag form used in the rule line. */
export function conditionText(f: WorkspaceSensorFilter, label?: (tag: string) => string): string {
    const name = label ? label(f.sensor) : f.sensor;
    return `${name} ${conditionSymbol(f.operation)} ${f.operation === 'between' ? `${f.value1}–${f.value2}` : f.value1}`;
}

export interface RuleInput {
    periods: TimePeriod[];
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    /** "No condition — use all rows" is active. */
    none: boolean;
}

export interface RuleModel {
    /** "P1", "P2" ... (row numbers of the valid periods); empty = any time. */
    periodLabels: string[];
    condMode: 'none' | 'empty' | 'list';
    conditions: string[];
    condOp: 'AND' | 'OR';
}

export function buildRuleModel(input: RuleInput): RuleModel {
    const status = validatePeriods(input.periods);
    const periodLabels = input.periods.flatMap((_, i) => (status[i].invalid ? [] : [`P${i + 1}`]));
    const conditions = input.filters.filter(f => isCompleteCondition(f)).map(f => conditionText(f));
    return {
        periodLabels,
        condMode: input.none ? 'none' : conditions.length === 0 ? 'empty' : 'list',
        conditions,
        condOp: input.combine === 'or' ? 'OR' : 'AND',
    };
}

/** Plain-text rule line, e.g. `Row is used when ( P1 OR P2 ) AND ( A > 1 AND B < 2 )`. */
export function ruleText(input: RuleInput): string {
    const m = buildRuleModel(input);
    const time = m.periodLabels.length ? m.periodLabels.join(' OR ') : 'any time';
    const cond = m.condMode === 'none' ? 'no condition (every row)'
        : m.condMode === 'empty' ? 'no condition yet'
        : m.conditions.join(` ${m.condOp} `);
    return `Row is used when ( ${time} ) AND ( ${cond} )`;
}
