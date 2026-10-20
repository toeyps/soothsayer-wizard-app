import type { HealthIssue, HealthPreview, HealthSeries } from '../../../types/health';
import { fmtNum } from './chartTheme';
import { parseTimestamps } from './healthCharts';
import { formatDataStamp } from '../periodDisplay';
import { TEST_SCORING_ISSUE_CODES } from '../../../utils/trainTestValidation';
import { scoringIssueMessage } from '../../../utils/timePeriods';

/*
 * Pure helpers of the Health score page:
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
    // Warnings are not blocking: `required` + a warning is still "Incomplete", never "Not valid".
    return verdictOfIssues(data.validation);
}

/** A warning never blocks anything (Rust's `unsafe_file_name`, ...): only
 *  error-severity issues decide the verdict. */
export const isBlockingIssue = (i: HealthIssue): boolean => i.severity !== 'warning';

export function verdictOfIssues(issues: readonly HealthIssue[]): HealthVerdict | null {
    const blocking = issues.filter(isBlockingIssue);
    if (blocking.length === 0) return null;
    return blocking.every(i => i.code === 'required') ? 'needs' : 'bad';
}

// ---------------------------------------------------------------------------
// Set-point input text
// ---------------------------------------------------------------------------

/**
 * The text an input shows for a stored set point: the value at its FULL
 * precision (rounding would re-open a stored 4e-7 as "0" while the model and
 * the exported file keep the real number).
 * `Number(formatSetPointText(x)) === x` for every finite `x`: a plain
 * decimal when that round-trips (0.0000004, not "4e-7", reads better in a box
 * a person types in), otherwise the shortest exact form JavaScript gives.
 */
export function formatSetPointText(v: number): string {
    const s = String(v);
    if (!/e/i.test(s)) return s;
    const plain = v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
    return Number(plain) === v ? plain : s;
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
    /** A warning-severity issue: shown, but it never blocks Mark complete. */
    warning?: boolean;
}

/** The four Relation-model points: ONE name per point everywhere the page names it itself
 *  (the score ruler's ticks, its red markers, the collapsed Checks line), listed in RULER
 *  order — low side first, left to right. (Rust's own sentences keep Rust's wording.) */
export const REL_POINT_LABEL: Record<string, string> = {
    residual_at_0_lower: '0 low',
    residual_at_80_lower: '80 low',
    residual_at_80_upper: '80 high',
    residual_at_0_upper: '0 high',
};
const REL_POINT_ORDER = Object.keys(REL_POINT_LABEL);

/** Rust's issues as Checks lines. Relationship: two or more `required` issues for
 *  its four points collapse into ONE line ("Enter 4 empty points: 0 low, 80 low, ...").
 *  `testNumbers` is `testPeriodsWirePlan(...).numbers` of the scoring periods that
 *  were sent (see `scoringIssueMessage`). */
export function buildCheckLines(kind: HealthPreview['kind'], issues: readonly HealthIssue[], testNumbers?: readonly number[] | null): CheckLine[] {
    const tone = (i: HealthIssue): 'need' | 'bad' => (i.code === 'required' || i.severity === 'warning' ? 'need' : 'bad');
    const lines: CheckLine[] = [];
    let collapsed = false;
    const relRequired = kind === 'relationship'
        ? issues.filter(i => i.code === 'required' && i.field in REL_POINT_LABEL)
        : [];
    issues.forEach((i, n) => {
        // "The health score could not be calculated" is about the score, not the set
        // points: the chart card shows it (in the score chart's place, or as a notice
        // above the charts), not Checks.
        if (TEST_SCORING_ISSUE_CODES.includes(i.code)) return;
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
                fix: 'Read them off the residual chart below, or type the values.',
            });
            return;
        }
        // An issue about one scoring period names it by the S-number the user sees
        // (Rust numbers the periods it RECEIVED — invalid ones are not sent).
        lines.push({ key: `${i.code}:${i.field}:${n}`, tone: tone(i), text: scoringIssueMessage(i, testNumbers), ...(i.severity === 'warning' ? { warning: true } : {}) });
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

/** Same kind and the same entered numbers — re-exported from the one
 *  definition in `utils/healthSetPoints.ts`. */
export { sameHealthSetPoints as sameSetPoints } from '../../../utils/healthSetPoints';

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

/** Epoch ms of a series' timestamps, parsed once per array (the pointer asks on every move). */
const PARSED_STAMPS = new WeakMap<readonly string[], number[] | null>();
function parsedStamps(timestamps: readonly string[]): number[] | null {
    let ms = PARSED_STAMPS.get(timestamps);
    if (ms === undefined) {
        ms = parseTimestamps([...timestamps]);
        PARSED_STAMPS.set(timestamps, ms);
    }
    return ms;
}

/**
 * The index of the point the pointer is on, from an ECharts `updateAxisPointer`
 * event (`axesInfo[].value` = epoch ms on a time axis, the category index
 * otherwise). On the Health score page `timestamps` are the hour starts of
 * `HealthPreview.hourly`. `null` when the event carries no X value (pointer left
 * the chart).
 */
export function hoverIndexFromAxisEvent(event: unknown, timestamps: readonly string[]): number | null {
    const info = (event as { axesInfo?: { axisDim?: string; value?: unknown }[] } | null)?.axesInfo;
    const x = info?.find(a => a.axisDim === 'x') ?? info?.[0];
    if (!x || typeof x.value !== 'number' || !Number.isFinite(x.value)) return null;
    const ms = parsedStamps(timestamps);
    const idx = ms ? nearestIndex(ms, x.value) : Math.round(x.value);
    return idx >= 0 && idx < timestamps.length ? idx : null;
}

export interface Readout {
    /** The START of the hour, in the app's date format ("2026/02/09 23:00:00"). */
    time: string;
    /** "1 h avg" (Individual: the hour's mean value) | "residual" (Relation model:
     *  the hour's residual) | null (Clustering shows no value). */
    valueLabel: '1 h avg' | 'residual' | null;
    value: number | null;
    score: number | null;
}

/**
 * What the read-out shows for point `idx` of the HOURLY series
 * (`HealthPreview.hourly`: one point per clock hour, every value the mean of the
 * hour's running rows). `null` for an index outside it.
 */
export function readoutAt(hourly: HealthSeries, idx: number | null): Readout | null {
    if (idx === null || idx < 0 || idx >= hourly.timestamps.length) return null;
    const score = hourly.score ? (hourly.score[idx] ?? null) : null;
    // The hour's START in the app's one date format ("2026/02/09 23:00:00" — a data
    // row's time, always with seconds). Rust labels an hour `2026-02-09T23:00:00`
    // whatever the CSV's own timestamp text looks like; `formatDataStamp` reads that
    // form from the text's own wall-clock parts (never shifted to another time zone).
    const time = hourly.timestamps[idx] ? formatDataStamp(hourly.timestamps[idx]) : `row ${hourly.rows[idx] ?? idx}`;
    if (hourly.kind === 'individual') return { time, valueLabel: '1 h avg', value: hourly.value[idx] ?? null, score };
    if (hourly.kind === 'relationship') return { time, valueLabel: 'residual', value: hourly.residual[idx] ?? null, score };
    return { time, valueLabel: null, value: null, score };
}

/** The read-out as one line of text (tests and the header both use it):
 *  "2026/02/09 23:00:00 · 1 h avg 4.2 bar · score 93". */
export function readoutText(r: Readout | null, unit: string): string {
    if (!r) return '';
    // Every hourly point had running rows (an hour without any has no point), so a missing
    // score means the hour could not be scored (rows in more than one cluster, no prediction,
    // set points not valid) — never "not running".
    if (r.score === null) return `${r.time} · no score`;
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
