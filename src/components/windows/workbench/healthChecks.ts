import type { HealthSetPoints } from '../../../types';
import type { HealthIssue, HealthPreview, HealthSeries } from '../../../types/health';
import { fmtNum } from './chartTheme';
import { parseTimestamps } from './healthCharts';

/*
 * Pure helpers of the Health score page (health score phase 3b-2, 2026-10-04):
 * what the Checks card shows, which input is "required" / "error", the
 * Valid / Not valid / Incomplete verdict, whether the saved files are out of date
 * and the hover read-out.
 *
 * The RULES are Rust's (`health_score.rs::validate_*`): nothing here decides
 * whether a set point is acceptable. It only presents the `validation` list
 * `compute_health_preview` returns.
 */

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** `valid`  = Rust says the score can be calculated.
 *  `needs`  = nothing wrong yet, but some set point is still empty ("Incomplete").
 *  `bad`    = at least one entered value is rejected ("Not valid"). */
export type HealthVerdict = 'valid' | 'needs' | 'bad';

/** The verdict of a preview, or `null` when there is nothing to judge (no data,
 *  or a not-valid answer that carries no issue to explain it). */
export function healthVerdict(data: HealthPreview | null | undefined): HealthVerdict | null {
    if (!data) return null;
    if (data.valid) return 'valid';
    return verdictOfIssues(data.validation);
}

export function verdictOfIssues(issues: readonly HealthIssue[]): HealthVerdict | null {
    if (issues.length === 0) return null;
    return issues.every(i => i.code === 'required') ? 'needs' : 'bad';
}

// ---------------------------------------------------------------------------
// Checks card
// ---------------------------------------------------------------------------

export interface CheckLine {
    key: string;
    /** `need` = something is still empty (amber) - `bad` = rejected (red). */
    tone: 'need' | 'bad';
    text: string;
    /** What to do, when the message alone does not say. */
    fix?: string;
}

/** The four Relationship points, in the order they are listed. */
const REL_POINT_LABEL: Record<string, string> = {
    residual_at_80_lower: 'lower 80',
    residual_at_80_upper: 'upper 80',
    residual_at_0_lower: 'lower 0',
    residual_at_0_upper: 'upper 0',
};
const REL_POINT_ORDER = Object.keys(REL_POINT_LABEL);

/** Rust's issues as Checks lines. Relationship: two or more `required` issues for
 *  its four points collapse into ONE line ("Enter 4 empty points: lower 80, ..."). */
export function buildCheckLines(kind: HealthPreview['kind'], issues: readonly HealthIssue[]): CheckLine[] {
    const tone = (i: HealthIssue): 'need' | 'bad' => (i.code === 'required' || i.severity === 'warning' ? 'need' : 'bad');
    const lines: CheckLine[] = [];
    let collapsed = false;
    const relRequired = kind === 'relationship'
        ? issues.filter(i => i.code === 'required' && i.field in REL_POINT_LABEL)
        : [];
    issues.forEach((i, n) => {
        if (relRequired.length > 1 && relRequired.includes(i)) {
            if (collapsed) return;
            collapsed = true;
            const names = [...relRequired]
                .sort((a, b) => REL_POINT_ORDER.indexOf(a.field) - REL_POINT_ORDER.indexOf(b.field))
                .map(r => REL_POINT_LABEL[r.field]);
            lines.push({
                key: 'required-points',
                tone: 'need',
                text: `Enter ${relRequired.length} empty points: ${names.join(', ')}`,
                fix: 'Read them off the residual chart on the left, or type the values.',
            });
            return;
        }
        lines.push({ key: `${i.code}:${i.field}:${n}`, tone: tone(i), text: i.message });
    });
    return lines;
}

/** How an input should look, from the issues that name it. `required` wins over
 *  `error` only when it is the only kind present (an empty field cannot also be
 *  "wrong"). */
export type FieldState = 'required' | 'error' | null;

export function fieldState(issues: readonly HealthIssue[], ...fields: string[]): FieldState {
    const mine = issues.filter(i => fields.includes(i.field));
    if (mine.length === 0) return null;
    return mine.some(i => i.code !== 'required') ? 'error' : 'required';
}

// ---------------------------------------------------------------------------
// Saved files out of date
// ---------------------------------------------------------------------------

const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The numbers a set-point value carries (master snapshots excluded: they are
 *  bookkeeping, not part of what the files contain). */
function pointsOf(sp: HealthSetPoints): (number | null)[] | null {
    switch (sp.kind) {
        case 'individual': return [num(sp.lower), num(sp.upper)];
        case 'relationship': return [num(sp.residualAt80Lower), num(sp.residualAt80Upper), num(sp.residualAt0Lower), num(sp.residualAt0Upper)];
        case 'clustering': return [num(sp.outerSd)];
    }
}

/** Same kind and the same entered numbers. */
export function sameSetPoints(a: HealthSetPoints | null | undefined, b: HealthSetPoints | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    if (a.kind !== b.kind) return false;
    const x = pointsOf(a);
    const y = pointsOf(b);
    return !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
}

// ---------------------------------------------------------------------------
// Hover read-out
// ---------------------------------------------------------------------------

/** Index of the point nearest to `t` (epoch ms) in an ASCENDING list. */
export function nearestIndex(ms: readonly number[], t: number): number {
    if (ms.length === 0) return -1;
    let lo = 0;
    let hi = ms.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ms[mid] < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(ms[lo - 1] - t) <= Math.abs(ms[lo] - t)) return lo - 1;
    return lo;
}

/**
 * The series index the pointer is on, from an ECharts `updateAxisPointer` event
 * (`axesInfo[].value` = epoch ms on a time axis, the category index otherwise).
 * `null` when the event carries no X value (pointer left the chart).
 */
export function hoverIndexFromAxisEvent(event: unknown, timestamps: readonly string[]): number | null {
    const info = (event as { axesInfo?: { axisDim?: string; value?: unknown }[] } | null)?.axesInfo;
    const x = info?.find(a => a.axisDim === 'x') ?? info?.[0];
    if (!x || typeof x.value !== 'number' || !Number.isFinite(x.value)) return null;
    const ms = parseTimestamps([...timestamps]);
    const idx = ms ? nearestIndex(ms, x.value) : Math.round(x.value);
    return idx >= 0 && idx < timestamps.length ? idx : null;
}

export interface Readout {
    time: string;
    /** "value" | "residual" | null (Clustering shows no raw value). */
    valueLabel: 'value' | 'residual' | null;
    value: number | null;
    score: number | null;
}

/** What the read-out shows for point `idx` of a series. `null` for an index
 *  outside it. */
export function readoutAt(series: HealthSeries, idx: number | null): Readout | null {
    if (idx === null || idx < 0 || idx >= series.timestamps.length) return null;
    const score = series.score ? (series.score[idx] ?? null) : null;
    const time = series.timestamps[idx] || `row ${series.rows[idx] ?? idx}`;
    if (series.kind === 'individual') return { time, valueLabel: 'value', value: series.value[idx] ?? null, score };
    if (series.kind === 'relationship') return { time, valueLabel: 'residual', value: series.residual[idx] ?? null, score };
    return { time, valueLabel: null, value: null, score };
}

/** The read-out as one line of text (tests and the header both use it). */
export function readoutText(r: Readout | null, unit: string): string {
    if (!r) return '';
    if (r.score === null) return `${r.time} · not running`;
    const v = r.valueLabel && r.value !== null ? `${r.valueLabel} ${fmtNum(r.value)}${unit ? ` ${unit}` : ''} · ` : '';
    return `${r.time} · ${v}score ${Math.round(r.score)}`;
}

// ---------------------------------------------------------------------------
// Stepper (Clustering outer ring)
// ---------------------------------------------------------------------------

/** Step of the outer-ring "-" / "+" buttons: half an SD. The ring must stay
 *  above 3 (Rust rejects <= 3), so "-" never goes below 3.5 and an empty field
 *  starts at 4 (the first quick button). */
export const RING_STEP = 0.5;
export const RING_QUICK = [4, 5, 6, 7] as const;
const RING_FLOOR = 3.5;

export function stepRing(current: number | null, dir: 1 | -1): number {
    if (current === null || !Number.isFinite(current)) return 4;
    const next = Math.round((current + dir * RING_STEP) * 100) / 100;
    return dir < 0 ? Math.max(RING_FLOOR, next) : next;
}
