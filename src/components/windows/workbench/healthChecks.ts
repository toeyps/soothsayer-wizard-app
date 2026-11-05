import type { HealthIssue, HealthPreview, HealthSeries } from '../../../types/health';
import { fmtNum } from './chartTheme';
import { parseTimestamps } from './healthCharts';
import { formatDataStamp } from '../periodDisplay';
import { TEST_SCORING_ISSUE_CODES } from '../../../utils/trainTestValidation';
import { scoringIssueMessage } from '../../../utils/timePeriods';

/* Pure helpers of the Health score page: they present the `validation` list from `compute_health_preview`; the rules are Rust's. */


/** `valid` = Rust says the score can be calculated; `needs` = a set point still empty (Incomplete); `bad` = a value rejected (Not valid). */
export type HealthVerdict = 'valid' | 'needs' | 'bad';

/** Verdict of a preview, or null when there is nothing to judge (no data, or not valid with no issue to explain). */
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


/** Input text of a stored set point at full precision (`Number(text) === v`): a plain decimal when it round-trips, else the shortest exact form. */
export function formatSetPointText(v: number): string {
    const s = String(v);
    if (!/e/i.test(s)) return s;
    const plain = v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
    return Number(plain) === v ? plain : s;
}


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

/** One name per Relation-model point wherever the page names it, in ruler order (low side first). Rust's sentences keep Rust's wording. */
export const REL_POINT_LABEL: Record<string, string> = {
    residual_at_0_lower: '0 low',
    residual_at_80_lower: '80 low',
    residual_at_80_upper: '80 high',
    residual_at_0_upper: '0 high',
};
const REL_POINT_ORDER = Object.keys(REL_POINT_LABEL);

/** Rust issues as Checks lines; 2+ `required` relationship points collapse into one line. `testNumbers` comes from `testPeriodsWirePlan`. */
export function buildCheckLines(kind: HealthPreview['kind'], issues: readonly HealthIssue[], testNumbers?: readonly number[] | null): CheckLine[] {
    const tone = (i: HealthIssue): 'need' | 'bad' => (i.code === 'required' || i.severity === 'warning' ? 'need' : 'bad');
    const lines: CheckLine[] = [];
    let collapsed = false;
    const relRequired = kind === 'relationship'
        ? issues.filter(i => i.code === 'required' && i.field in REL_POINT_LABEL)
        : [];
    issues.forEach((i, n) => {
        // 'Could not be calculated' is about the score, not the set points: the chart card shows it, not Checks.
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
        // Name a scoring-period issue by the user's S-number (Rust numbers the periods it received).
        lines.push({ key: `${i.code}:${i.field}:${n}`, tone: tone(i), text: scoringIssueMessage(i, testNumbers), ...(i.severity === 'warning' ? { warning: true } : {}) });
    });
    return lines;
}

/** How an input looks from the issues naming it; `required` wins over `error` only when it is the only kind. */
export type FieldState = 'required' | 'error' | null;

export function fieldState(issues: readonly HealthIssue[], ...fields: string[]): FieldState {
    const mine = issues.filter(i => fields.includes(i.field));
    if (mine.length === 0) return null;
    return mine.some(i => i.code !== 'required') ? 'error' : 'required';
}

/** Same kind and the same entered numbers — re-exported from the one
 *  definition in `utils/healthSetPoints.ts`. */
export { sameHealthSetPoints as sameSetPoints } from '../../../utils/healthSetPoints';


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

/** Index of the point under the pointer from an ECharts `updateAxisPointer` event; null when the event has no X value. */
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
    /** '1 h avg' (Individual), 'residual' (Relation model), null (Clustering shows no value). */
    valueLabel: '1 h avg' | 'residual' | null;
    value: number | null;
    score: number | null;
}

/** Read-out for point `idx` of the HOURLY series (one point per clock hour); null when out of range. */
export function readoutAt(hourly: HealthSeries, idx: number | null): Readout | null {
    if (idx === null || idx < 0 || idx >= hourly.timestamps.length) return null;
    const score = hourly.score ? (hourly.score[idx] ?? null) : null;
    // Hour start in the app's date format; Rust labels hours `YYYY-MM-DDTHH:00:00`, read from wall-clock parts (no time zone shift).
    const time = hourly.timestamps[idx] ? formatDataStamp(hourly.timestamps[idx]) : `row ${hourly.rows[idx] ?? idx}`;
    if (hourly.kind === 'individual') return { time, valueLabel: '1 h avg', value: hourly.value[idx] ?? null, score };
    if (hourly.kind === 'relationship') return { time, valueLabel: 'residual', value: hourly.residual[idx] ?? null, score };
    return { time, valueLabel: null, value: null, score };
}

/** The read-out as one line of text (tests and the header both use it):
 *  "2026/02/09 23:00:00 · 1 h avg 4.2 bar · score 93". */
export function readoutText(r: Readout | null, unit: string): string {
    if (!r) return '';
    // Every hourly point has running rows, so a missing score means the hour could not be scored, never 'not running'.
    if (r.score === null) return `${r.time} · no score`;
    const v = r.valueLabel && r.value !== null ? `${r.valueLabel} ${fmtNum(r.value)}${unit ? ` ${unit}` : ''} · ` : '';
    return `${r.time} · ${v}score ${Math.round(r.score)}`;
}


/** Outer-ring step is 0.5 SD; the ring must stay above 3 (Rust rejects <= 3), so '-' stops at 3.5 and an empty field starts at 4. */
export const RING_STEP = 0.5;
export const RING_QUICK = [4, 5, 6, 7] as const;
const RING_FLOOR = 3.5;

export function stepRing(current: number | null, dir: 1 | -1): number {
    if (current === null || !Number.isFinite(current)) return 4;
    const next = Math.round((current + dir * RING_STEP) * 100) / 100;
    return dir < 0 ? Math.max(RING_FLOOR, next) : next;
}
