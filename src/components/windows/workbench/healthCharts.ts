import type {
    ClusterStat,
    HealthClusterScatter,
    HealthFitScatter,
    HealthHistogram,
    IndividualSeries,
    IndividualStats,
    RelationshipSeries,
    ValidationResult,
} from '../../../types/health';
import { testNumberFor } from '../../../utils/timePeriods';
import type { SensorInfo } from '../../sensor/sensorInfo';
import { parseLocal } from '../periodDisplay';
import { CHART, CHART_MONO, CLUSTER_COLORS, FONT, axisValueFormatter, fmtAxisValue, fmtNum } from './chartTheme';

/*
 * Pure ECharts option builders for the Build Model Workbench's health charts
 * (health score phase 3b-1, 2026-10-04). Every function takes ONLY the bounded
 * payload `compute_health_preview` returns (`HealthPreview.series` / `.stats` /
 * `.histogram` / `.fit_scatter` / `.cluster_scatter`) — never a full row array —
 * and returns a plain option object, so they are unit-testable without ECharts.
 *
 * The generic building blocks (`buildTimeSeriesOption`, `ellipseSeries`) are
 * exported so the Health score page (3b-2) can draw the same charts with the
 * extra set-point lines / score colouring on top instead of re-implementing
 * the axes: pass more `hLines`, more `bands`, or append to `series`.
 *
 * How a Workbench chart reads (workbench-redesign SPEC §3, DESIGN_SYSTEM §4
 * "Time scopes on charts" / "Quiet charts"):
 *   - train / scoring periods are NAMED in a thin strip above the plot (plain
 *     coloured mono text, two lanes) and are only a faint fill inside it;
 *   - reference lines (±1SD, ±3SD, ±2RMSE, 80) are labelled OUTSIDE the plot on
 *     its right edge, so they need no legend row under the chart. A DATA line is
 *     never named on the plot — ECharts does not move an end label with its line
 *     through a zoom — so a chart with two of them (Target vs predicted) keeps a
 *     two-item colour key on its card;
 *   - only the score-100 band is filled; ±3SD is a dashed line;
 *   - the user's own set points are the strongest lines (`HLine.inside`).
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Cursor of `readDigits` (module-level, so the scan allocates nothing per stamp). */
let scanAt = 0;
/** Reads `min`..`max` digits of `s` at `scanAt`; -1 when there are fewer. */
function readDigits(s: string, min: number, max: number): number {
    let v = 0;
    let n = 0;
    while (n < max && scanAt < s.length) {
        const c = s.charCodeAt(scanAt) - 48;
        if (c < 0 || c > 9) break;
        v = v * 10 + c;
        scanAt++;
        n++;
    }
    return n >= min ? v : -1;
}

/** The local day (y × 10000 + month × 100 + day) `dayOffsetMs` belongs to. */
let offsetDay = NaN;
/** What to add to `Date.UTC(fields)` for the epoch ms of those LOCAL fields on
 *  `offsetDay`; NaN on a day the PC's clock changes (DST) — then `Date` decides
 *  per stamp. */
let dayOffsetMs = 0;

/** Epoch ms of local wall-clock fields — `new Date(y, mo - 1, d, h, mi, s, ms)`
 *  without building a `Date` per stamp: the PC's UTC offset is looked up once per
 *  calendar day (consecutive rows share it) and the rest is arithmetic. */
function localFieldsMs(y: number, mo: number, d: number, h: number, mi: number, sec: number, milli: number): number {
    const day = y * 10000 + mo * 100 + d;
    if (day !== offsetDay) {
        const a = new Date(y, mo - 1, d, 0, 0, 0, 0).getTimezoneOffset();
        const b = new Date(y, mo - 1, d, 23, 59, 59, 999).getTimezoneOffset();
        offsetDay = day;
        dayOffsetMs = a === b ? a * 60_000 : NaN;
    }
    return Number.isNaN(dayOffsetMs)
        ? new Date(y, mo - 1, d, h, mi, sec, milli).getTime()
        : Date.UTC(y, mo - 1, d, h, mi, sec, milli) + dayOffsetMs;
}

/**
 * Epoch ms of a CSV stamp read as its OWN wall clock — the same reading as
 * `formatDataStamp` (`periodDisplay.ts`), which prints the read-outs beside these
 * charts: `YYYY-MM-DD[ T]HH:MM[:SS[.fff]]` with an optional `Z` / `+07:00`, whose
 * offset is IGNORED. "2026-02-09T23:50:00+07:00" sits at 23:50 on the axis of a
 * PC in any time zone (`new Date(text)` would move it by the difference between
 * the file's zone and the PC's). NaN for any other shape: the caller falls back.
 * A hand-written scan — no regex, no substring, no `Date` per stamp — so reading
 * a series costs less than the `new Date(text)` per point it replaces.
 */
export function wallClockMs(s: string): number {
    const n = s.length;
    scanAt = 0;
    while (scanAt < n && s.charCodeAt(scanAt) <= 32) scanAt++;
    const y = readDigits(s, 4, 4);
    let c = s.charCodeAt(scanAt);
    if (y < 0 || (c !== 45 && c !== 47)) return NaN; // "-" or "/"
    scanAt++;
    const mo = readDigits(s, 1, 2);
    c = s.charCodeAt(scanAt);
    if (mo < 1 || mo > 12 || (c !== 45 && c !== 47)) return NaN;
    scanAt++;
    const d = readDigits(s, 1, 2);
    if (d < 1 || d > 31) return NaN;
    let h = 0;
    let mi = 0;
    let sec = 0;
    let milli = 0;
    c = s.charCodeAt(scanAt);
    if (c === 84 || c === 116 || c === 32) { // "T" / "t" / a space, then the time
        const needsTime = c !== 32;
        scanAt++;
        while (scanAt < n && s.charCodeAt(scanAt) === 32) scanAt++;
        const at = scanAt;
        h = readDigits(s, 1, 2);
        if (h < 0 || s.charCodeAt(scanAt) !== 58) {
            // No "HH:" here: only blanks or a zone followed the date.
            if (needsTime) return NaN;
            h = 0;
            scanAt = at;
        } else {
            scanAt++; // ":"
            mi = readDigits(s, 2, 2);
            if (h > 23 || mi < 0 || mi > 59) return NaN;
            if (s.charCodeAt(scanAt) === 58) {
                scanAt++;
                sec = readDigits(s, 2, 2);
                if (sec < 0 || sec > 59) return NaN;
                c = s.charCodeAt(scanAt);
                if (c === 46 || c === 44) { // "." or ",": a fraction of a second
                    scanAt++;
                    const from = scanAt;
                    let unit = 100;
                    for (; scanAt < n; scanAt++) {
                        const f = s.charCodeAt(scanAt) - 48;
                        if (f < 0 || f > 9) break;
                        milli += f * unit;
                        unit /= 10;
                    }
                    if (scanAt === from) return NaN;
                    milli = Math.floor(milli);
                }
            }
        }
    }
    while (scanAt < n && s.charCodeAt(scanAt) <= 32) scanAt++;
    if (scanAt < n) {
        // An explicit zone — "Z", "+07", "+0700", "+07:00": read past it, never applied.
        c = s.charCodeAt(scanAt);
        if (c === 90 || c === 122) {
            scanAt++;
        } else if (c === 43 || c === 45) {
            scanAt++;
            if (readDigits(s, 2, 2) < 0) return NaN;
            if (s.charCodeAt(scanAt) === 58) scanAt++;
            const at = scanAt;
            if (readDigits(s, 2, 2) < 0 && scanAt !== at) return NaN; // one stray digit
        } else {
            return NaN;
        }
        while (scanAt < n && s.charCodeAt(scanAt) <= 32) scanAt++;
        if (scanAt < n) return NaN;
    }
    return localFieldsMs(y, mo, d, h, mi, sec, milli);
}

/** Epoch ms of every timestamp, or `null` if ANY of them does not parse (the
 *  chart then falls back to a category axis showing the raw text). Each stamp is
 *  placed at its own wall-clock time (`wallClockMs`); text in another shape is
 *  read by `Date`, as it always was. The server already normalised the text
 *  (Buddhist-Era years are Gregorian by now). */
export function parseTimestamps(ts: string[]): number[] | null {
    const out = new Array<number>(ts.length);
    for (let i = 0; i < ts.length; i++) {
        let t = wallClockMs(ts[i]);
        if (Number.isNaN(t)) t = new Date(ts[i]).getTime(); // not the usual shape
        if (!Number.isFinite(t)) return null;
        out[i] = t;
    }
    return out;
}

/** `[min, max, step]` of an axis. `step` is absent when the range could not be
 *  rounded (a zero or non-finite span). */
export type NiceRange = [min: number, max: number, step?: number];

/** Drops the float noise of `k × step` (0.1 × 3 = 0.30000000000000004); -0 is 0. */
const cleanTick = (v: number): number => Number(v.toPrecision(12)) || 0;

/** Rounds a value range out to "nice" axis ends (1, 2, 5 x 10^n steps), so the
 *  axis never starts at 62.884400945773835 — and returns that step, which the
 *  axis must use as its `interval`: left to itself ECharts picks another step and
 *  then adds the two ends as extra, unevenly spaced ticks (0, 3, 6 … 15, 16). */
export function niceExtent(lo: number, hi: number): NiceRange {
    const span = hi - lo;
    if (!(span > 0) || !Number.isFinite(span)) return [lo, hi];
    const raw = span / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
    return [cleanTick(Math.floor(lo / step) * step), cleanTick(Math.ceil(hi / step) * step), cleanTick(step)];
}

const tooltipBase = {
    backgroundColor: CHART.tooltipBg,
    borderColor: CHART.tooltipBorder,
    textStyle: { color: CHART.textPrimary },
    // Never cut off at the card's edge, and a number reads like everywhere else on the page.
    confine: true,
    valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtNum(v) : String(v ?? '')),
};

const axisCommon = {
    axisLabel: { color: CHART.textSecondary, fontSize: 10 },
    axisLine: { lineStyle: { color: CHART.gridLine } },
    axisTick: { show: false },
};
/** `axisCommon` for a VALUE axis: tick labels through the app's number formatter, so a
 *  computed min/max never shows float noise ("1,713.8000000000002" on the Distribution chart). */
/** Axis line of a scatter's value axis: on the plot's EDGE. ECharts' default draws it
 *  through the other axis' zero, which reads as a stray x = 0 / y = 0 line across the
 *  points whenever the data straddles zero. */
export const EDGE_AXIS_LINE = { ...axisCommon.axisLine, onZero: false };
export const valueAxisCommon = {
    ...axisCommon,
    axisLabel: { ...axisCommon.axisLabel, formatter: fmtAxisValue },
};
/** `valueAxisCommon` for a value axis whose min/max the chart sets: label decimals follow the
 *  tick step, so a narrow axis keeps distinct labels and a long bin edge reads short. */
export function fixedValueAxisCommon(min: number, max: number) {
    return { ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: axisValueFormatter(min, max) } };
}

export interface TimeLine {
    name: string;
    /** One value per timestamp; `null` = a gap. */
    values: (number | null)[];
    color: string;
    width?: number;
}

export interface HLine {
    y: number;
    color: string;
    dashed?: boolean;
    /** Short label of the line. A reference line (±1SD, ±3SD, ±2RMSE, 80) is
     *  labelled OUTSIDE the plot, on its right edge. */
    label?: string;
    /** Line width; a reference line is 1 px. */
    width?: number;
    /** One of the USER'S set points: the label goes INSIDE the plot at the right
     *  end, above (`'top'`) or below (`'bottom'`) the line, in bold. */
    inside?: 'top' | 'bottom';
    /** A reference line of a +/− pair: its outside label sits just above
     *  (`'above'`, the + side) or below (`'below'`, the − side) the line's end
     *  instead of centred on it, so "+2RMSE" and "−2RMSE" never print on top of
     *  each other when the two lines are only a few pixels apart (a wide Y range).
     *  Two lines of the SAME side that close together share one stacked label
     *  (`stackedEdgeLabels`). */
    edge?: 'above' | 'below';
}

export interface HBand {
    from: number;
    to: number;
    /** Fill colour (use an rgba with low alpha). */
    color: string;
}

// ---------------------------------------------------------------------------
// Train / scoring time scopes (2026-10-07; "just score it" 2026-10-10: a
// scoring period is only start → end — no Known-problem hatch, no EVENT line)
// ---------------------------------------------------------------------------

/** One scope band on a time chart. `start`/`end` `null` = open (runs to the
 *  edge of the data). */
export interface TimeScope {
    /** `'score'` = a scoring period (the magenta band). */
    kind: 'train' | 'score';
    start: string | null;
    end: string | null;
    /** Its full name: "TRAIN", "TRAIN P2", "S1". */
    label: string;
    /** Its short name: "P2", "S1" ("TRAIN" for the only train period). See
     *  `scopeStripNames` for which of the two the strip prints. */
    short: string;
}

/** What every Workbench time chart draws on top of its data (SPEC "Screens and
 *  UI" → time scopes). Built from `HealthPreview.test_validation` by `scopesOf`
 *  and passed in explicitly through `TimeSeriesSpec.scopes`. */
export interface TimeScopes {
    ranges: TimeScope[];
    /** A half-width chart: print the short names (numbers only, no "TRAIN"). */
    compact?: boolean;
    /** The chart shares its row with a side card (the Health score set-point
     *  chart), so its plot can be as narrow as a half-width one: the names keep
     *  the word "TRAIN" but are spaced for the narrow plot (`STRIP_PLOT_WIDTH`). */
    narrow?: boolean;
}

/**
 * The scopes of one health preview: every train range (none sent = the train
 * period is open at both ends, i.e. the whole time axis) and every scoring
 * period with its S-number. `null` when the preview carried no scoring
 * periods: the chart is then drawn exactly as before.
 *
 * S-numbers are the period's POSITION in the user's full list (invalid periods
 * included — they are not sent): `numbers` is `testPeriodsWirePlan(...).numbers`
 * of the list that was sent, looked up with each result's 1-based wire `index`
 * (`testNumberFor`). Without `numbers` the result's position is used (S1, S2 …).
 */
export function scopesOf(v: ValidationResult | null | undefined, numbers?: readonly number[] | null): TimeScopes | null {
    if (!v) return null;
    const tn = (t: ValidationResult['tests'][number], i: number) => testNumberFor(numbers, t.index, i);
    const train = v.train_ranges.length > 0 ? v.train_ranges : [{ start: null, end: null }];
    const many = train.length > 1;
    const ranges: TimeScope[] = [
        ...train.map((r, i) => ({
            kind: 'train' as const,
            start: r.start,
            end: r.end,
            label: many ? `TRAIN P${i + 1}` : 'TRAIN',
            short: many ? `P${i + 1}` : 'TRAIN',
        })),
        ...v.tests.map((t, i) => ({
            kind: 'score' as const,
            start: t.start,
            end: t.end,
            label: `S${tn(t, i)}`,
            short: `S${tn(t, i)}`,
        })),
    ];
    return { ranges };
}

/** The same scopes with the short names (half-width charts). */
export function compactScopes(s: TimeScopes | null | undefined): TimeScopes | null {
    return s ? { ...s, compact: true } : null;
}

/** The same scopes, their names spaced for a chart beside a side card. */
export function narrowScopes(s: TimeScopes | null | undefined): TimeScopes | null {
    return s ? { ...s, narrow: true } : null;
}

/** Height of the strip above the plot that names the scopes: two text lanes,
 *  train on the upper one and scoring periods on the lower one. */
export const SCOPE_STRIP = 26;
/** Distance of a scope name from the top of the plot, per lane. */
export const SCOPE_LANE = { train: 15, score: 3 } as const;
/** Room right of the plot for the reference-line labels ("+2RMSE"). */
export const REF_LABEL_GUTTER = 52;
/** Outside labels on the same side of their lines need about one line of text
 *  between the lines. As a share of the Y range: ~12 px of the shortest Workbench
 *  plot (a 250 px card with the scope strip, ~185 px). The builder is pure and
 *  never knows the real height, so a taller chart merges a little early. */
export const REF_LABEL_MIN_GAP = 0.07;
/** Line height of a stacked reference label. */
const REF_LABEL_LINE = 11;

/** The plot width (px) the strip names must stay apart on. The builder is pure and
 *  never knows the real width, so it spaces the names for the narrowest plot the
 *  Workbench layout gives that kind of chart: a card across the whole board
 *  (`full`), or a half-width card / a chart beside a side card (`narrow` — both
 *  are ~230 px at the narrowest two-column layout). On a wider chart a name that
 *  would have fitted may stay hidden; names do not print on each other. */
export const STRIP_PLOT_WIDTH = { full: 420, narrow: 200 } as const;
/** Advance of one character of the 9 px mono strip text, and the air between two names. */
const STRIP_CHAR = 5.6;
const STRIP_NAME_GAP = 6;

const scopeMs = (s: string | null | undefined): number | null => parseLocal(s);

/** The union of every scope range, merged, as sorted [start, end] intervals
 *  (open ends = ±Infinity). A point outside all of them is "outside every
 *  period". */
export function scopeIslands(scopes: TimeScopes): [number, number][] {
    const ivs: [number, number][] = [];
    for (const r of scopes.ranges) {
        const a = r.start ? scopeMs(r.start) : -Infinity;
        const b = r.end ? scopeMs(r.end) : Infinity;
        if (a === null || b === null || b < a) continue;
        ivs.push([a, b]);
    }
    ivs.sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const iv of ivs) {
        const last = out[out.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else out.push([iv[0], iv[1]]);
    }
    return out;
}

/** `[ms, value]` pairs with a `null` inserted wherever the line would cross
 *  time outside every period (between two islands, or into / out of
 *  unscored time), so the chart shows a gap there instead of a bridge. */
export function withScopeGaps(points: [number, number | null][], islands: [number, number][]): [number, number | null][] {
    const islandOf = (x: number) => islands.findIndex(([a, b]) => x >= a && x <= b);
    const out: [number, number | null][] = [];
    let prev = -2;
    for (let k = 0; k < points.length; k++) {
        const isl = islandOf(points[k][0]);
        if (k > 0 && (isl < 0 || prev < 0 || isl !== prev)) {
            out.push([(points[k - 1][0] + points[k][0]) / 2, null]);
        }
        out.push(points[k]);
        prev = isl;
    }
    return out;
}

/** One scope band as it is drawn: clamped to the data's time range. */
export interface StripBand { kind: TimeScope['kind']; label: string; short: string; a: number; b: number }

/**
 * What each band prints in the strip above the plot — `null` = its name is left
 * out (the band itself is still drawn).
 *
 *  - The word "TRAIN" is printed ONCE: the first train band reads its full name
 *    ("TRAIN", or "TRAIN P1"), every later one only its number ("P2", "P3" — SPEC
 *    §3 `TRAIN P1 P2`). A half-width chart (`short`) prints numbers only.
 *  - Names never print on each other. Each sits centred over its band; going left
 *    to right on a lane, a name that would touch the one before it (on a plot
 *    `plotWidth` px wide) is left out — so 20 short periods read
 *    "TRAIN P1 · P3 · P5 …" instead of a smear. Train and scoring names are on
 *    separate lanes and are thinned separately.
 */
export function scopeStripNames(
    bands: readonly StripBand[],
    xMin: number,
    xMax: number,
    { short = false, plotWidth = STRIP_PLOT_WIDTH.full }: { short?: boolean; plotWidth?: number } = {},
): (string | null)[] {
    const width = plotWidth;
    const span = xMax - xMin;
    const out: (string | null)[] = new Array(bands.length).fill(null);
    for (const kind of ['train', 'score'] as const) {
        const lane = bands.map((_, i) => i).filter(i => bands[i].kind === kind)
            .sort((i, j) => (bands[i].a + bands[i].b) - (bands[j].a + bands[j].b) || i - j);
        let free = -Infinity; // right edge of the last name printed, plus the air after it
        lane.forEach((i, at) => {
            const band = bands[i];
            const text = short || (kind === 'train' && at > 0) ? band.short : band.label;
            const centre = span > 0 ? (((band.a + band.b) / 2 - xMin) / span) * width : 0;
            const half = (text.length * STRIP_CHAR) / 2;
            if (centre - half < free) return;
            out[i] = text;
            free = centre + half + STRIP_NAME_GAP;
        });
    }
    return out;
}

/** The carrier series of the scope bands (no data of its own, drawn under the
 *  data). Each band carries its NAME in the strip above the plot — plain
 *  coloured text, never a pill and never inside the plot. */
function scopeSeries(scopes: TimeScopes, xMin: number, xMax: number): Record<string, unknown> {
    const name = { fontSize: 9, fontWeight: 600, fontFamily: CHART_MONO, padding: 0 };
    const bands: StripBand[] = scopes.ranges.flatMap(r => {
        const a = Math.max(xMin, r.start ? (scopeMs(r.start) ?? xMin) : xMin);
        const b = Math.min(xMax, r.end ? (scopeMs(r.end) ?? xMax) : xMax);
        return b >= a ? [{ kind: r.kind, label: r.label, short: r.short, a, b }] : [];
    });
    const names = scopeStripNames(bands, xMin, xMax, {
        short: !!scopes.compact,
        plotWidth: scopes.compact || scopes.narrow ? STRIP_PLOT_WIDTH.narrow : STRIP_PLOT_WIDTH.full,
    });
    const area = bands.map((band, i) => {
        const train = band.kind === 'train';
        const line = train ? CHART.train : CHART.test;
        return [
            {
                name: band.label,
                xAxis: band.a,
                // Train and scoring may overlap: train = a faint blue fill, scoring = a
                // faint magenta fill + dashed outline, so a scoring period over train
                // stays readable.
                itemStyle: train
                    ? { color: CHART.trainFill, borderWidth: 0 }
                    : { color: CHART.testFill, borderColor: CHART.testOutline, borderWidth: 1, borderType: 'dashed' },
                // Two text lanes in the strip ABOVE the plot: train names on the upper
                // lane, scoring names on the lower one (so S1 over TRAIN never collide).
                label: { ...name, show: names[i] !== null, color: line, position: 'top', distance: train ? SCOPE_LANE.train : SCOPE_LANE.score, formatter: names[i] ?? band.short },
            },
            { xAxis: band.b },
        ];
    });
    return {
        type: 'line',
        name: '__scopes',
        data: [],
        silent: true,
        z: 0,
        symbol: 'none',
        tooltip: { show: false },
        markArea: { silent: true, animation: false, data: area },
    };
}

/**
 * Reference lines whose OUTSIDE labels would print on each other: two lines on
 * the same side (`edge`) closer than `minGap` (in Y units). Normal data keeps
 * ±1SD and ±3SD far apart; with set points far from the data (a master alarm
 * limit) the whole ±3SD band is a few pixels tall and "+1SD" lands on "+3SD".
 * Such a run shares ONE label, stacked in the order the lines have on screen and
 * each name in its own line's colour, carried by the OUTERMOST line (the top one
 * above the lines, the bottom one below them).
 *
 * Returns, per index of `hLines`: the lines a carrier prints (top to bottom), or
 * `null` for a line whose name its neighbour carries. Lines not in the map keep
 * their own label.
 */
export function stackedEdgeLabels(hLines: readonly HLine[], minGap: number): Map<number, HLine[] | null> {
    const out = new Map<number, HLine[] | null>();
    if (!(minGap > 0)) return out;
    for (const edge of ['above', 'below'] as const) {
        const side = hLines.map((_, i) => i)
            .filter(i => hLines[i].edge === edge && !!hLines[i].label && !hLines[i].inside && Number.isFinite(hLines[i].y))
            .sort((i, j) => hLines[i].y - hLines[j].y);
        for (let from = 0; from < side.length;) {
            let to = from;
            while (to + 1 < side.length && hLines[side[to + 1]].y - hLines[side[to]].y < minGap) to++;
            if (to > from) {
                const run = side.slice(from, to + 1); // ascending y = bottom to top on screen
                const carrier = edge === 'above' ? run[run.length - 1] : run[0];
                for (const i of run) out.set(i, i === carrier ? run.map(k => hLines[k]).reverse() : null);
            }
            from = to + 1;
        }
    }
    return out;
}

/** The label of a reference line, outside the plot on its right edge. */
function outsideLabel(h: HLine, stack: HLine[] | null | undefined): Record<string, unknown> {
    if (stack === null) return { show: false }; // a neighbour carries this name
    const base = {
        show: true,
        formatter: h.label,
        position: 'end',
        distance: 4,
        color: h.color,
        fontSize: 9.5,
        fontWeight: 'normal',
        fontFamily: CHART_MONO,
        verticalAlign: h.edge === 'above' ? 'bottom' : h.edge === 'below' ? 'top' : 'middle',
    };
    if (!stack) return base;
    // One name per text line, each in its own line's colour.
    const rich: Record<string, unknown> = {};
    stack.forEach((s, i) => { rich[`l${i}`] = { color: s.color, fontSize: 9.5, fontFamily: CHART_MONO, lineHeight: REF_LABEL_LINE, align: 'left' }; });
    return { ...base, formatter: stack.map((s, i) => `{l${i}|${s.label}}`).join('\n'), rich };
}

export interface TimeSeriesSpec {
    timestamps: string[];
    lines: TimeLine[];
    hLines?: HLine[];
    bands?: HBand[];
    yName?: string;
    /** Fixed Y range (the Health score chart is always 0-100); overrides the
     *  data-driven one. */
    yRange?: [number, number];
    /** Train / scoring scope bands (`scopesOf`). Absent / null = no scopes (the
     *  chart is drawn as before). Only drawn on a time axis. */
    scopes?: TimeScopes | null;
}

/** Value(s) over time with horizontal reference lines and shaded bands. The
 *  Y range always includes every `hLine` / `band`, so a ±3SD line outside the
 *  data is still on screen. With `scopes`, the train / scoring periods are
 *  faint bands named in the strip above the plot, and time outside every period
 *  is a gap in the line. Reference-line labels sit outside the plot on its right
 *  edge (the grid keeps a gutter for them), set-point labels inside it. */
export function buildTimeSeriesOption(spec: TimeSeriesSpec) {
    const { timestamps, lines, hLines = [], bands = [], yName } = spec;
    const ms = parseTimestamps(timestamps);
    const scopes = ms && ms.length > 0 && spec.scopes ? spec.scopes : null;
    const islands = scopes ? scopeIslands(scopes) : null;
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v: number | null | undefined) => {
        if (typeof v === 'number' && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    };
    for (const l of lines) for (const v of l.values) take(v);
    for (const h of hLines) take(h.y);
    for (const b of bands) { take(b.from); take(b.to); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
    const [yMin, yMax, yStep]: NiceRange = spec.yRange ?? niceExtent(lo - pad, hi + pad);
    const stacks = stackedEdgeLabels(hLines, (yMax - yMin) * REF_LABEL_MIN_GAP);

    const series: Record<string, unknown>[] = lines.map((l, i) => {
        const pairs = ms ? l.values.map((v, k) => [ms[k], v] as [number, number | null]) : null;
        const data = pairs ? (islands ? withScopeGaps(pairs, islands) : pairs) : l.values;
        const base: Record<string, unknown> = {
            type: 'line',
            name: l.name,
            data,
            showSymbol: false,
            symbol: 'none',
            lineStyle: { color: l.color, width: l.width ?? 1 },
            itemStyle: { color: l.color },
            z: 2,
        };
        if (i === 0) {
            if (hLines.length) {
                base.markLine = {
                    silent: true,
                    symbol: 'none',
                    animation: false,
                    data: hLines.map((h, k) => ({
                        yAxis: h.y,
                        lineStyle: { color: h.color, width: h.width ?? 1, type: h.dashed ? 'dashed' : 'solid' },
                        label: h.label
                            ? h.inside
                                // A set point of the user: inside the plot, at the right end.
                                ? { show: true, formatter: h.label, position: h.inside === 'top' ? 'insideEndTop' : 'insideEndBottom', distance: 3, color: h.color, fontSize: 10, fontWeight: 600, fontFamily: CHART_MONO }
                                // A reference line: outside the plot, on its right edge.
                                : outsideLabel(h, stacks.get(k))
                            : { show: false },
                    })),
                };
            }
            if (bands.length) {
                base.markArea = {
                    silent: true,
                    animation: false,
                    data: bands.map(b => [{ yAxis: b.from, itemStyle: { color: b.color } }, { yAxis: b.to }]),
                };
            }
        }
        return base;
    });
    if (scopes && ms && series.length > 0) {
        // Its own (empty) carrier series, so the scope bands sit under the data and
        // never mix with the Y bands / reference lines of the first series.
        series.push(scopeSeries(scopes, ms[0], ms[ms.length - 1]));
    }

    // Room right of the plot for the reference-line labels.
    const right = hLines.some(h => h.label && !h.inside) ? REF_LABEL_GUTTER : 18;

    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,.35)', type: 'dashed' } } },
        legend: { show: false },
        grid: { left: 58, right, top: scopes ? 10 + SCOPE_STRIP : 14, bottom: 28, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
        xAxis: ms
            ? { type: 'time', ...axisCommon, splitLine: { show: false } }
            : { type: 'category', data: timestamps, boundaryGap: false, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, hideOverlap: true }, splitLine: { show: false } },
        yAxis: {
            type: 'value',
            name: yName,
            nameLocation: 'middle',
            nameGap: 44,
            nameTextStyle: { color: CHART.textSecondary, fontSize: 10 },
            min: yMin,
            max: yMax,
            // The step the range was rounded to: every tick is round and evenly spaced.
            interval: yStep,
            ...fixedValueAxisCommon(yMin, yMax),
            splitLine: { show: true, lineStyle: { color: CHART.splitLine } },
        },
        series,
    };
}

// ---------------------------------------------------------------------------
// Individual
// ---------------------------------------------------------------------------

/** "Sensor value over time" with the ±1SD band (green — the only fill, the
 *  score-100 band) and the ±3SD lines (amber, dashed, no fill). */
export function buildValueOverTimeOption(series: IndividualSeries, stats: IndividualStats, unit: string, scopes: TimeScopes | null = null) {
    const [l1, u1] = stats.boundary_1sd;
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        scopes,
        yName: unit || undefined,
        lines: [{ name: 'Value', values: series.value, color: CHART.series }],
        bands: [{ from: l1, to: u1, color: CHART.okFill }],
        hLines: sdReferenceLines(stats),
    });
}

/** Individual's four reference lines on a value-over-time chart: ±1SD solid green
 *  (the edges of the score-100 band), ±3SD dashed amber (score 80, no fill). */
export function sdReferenceLines(stats: IndividualStats): HLine[] {
    const [l1, u1] = stats.boundary_1sd;
    const [l3, u3] = stats.boundary_3sd;
    return [
        { y: u1, color: CHART.ok, label: '+1SD', edge: 'above' },
        { y: l1, color: CHART.ok, label: '−1SD', edge: 'below' },
        { y: u3, color: CHART.warn, label: '+3SD', dashed: true, edge: 'above' },
        { y: l3, color: CHART.warn, label: '−3SD', dashed: true, edge: 'below' },
    ];
}

/** Relationship's reference lines on a residual chart: ±2RMSE (the edges of the
 *  score-100 band) and an unlabelled zero line. */
export function rmseReferenceLines(twoRmse: number): HLine[] {
    return [
        { y: twoRmse, color: CHART.ok, label: '+2RMSE', edge: 'above' },
        { y: -twoRmse, color: CHART.ok, label: '−2RMSE', edge: 'below' },
        { y: 0, color: 'rgba(255,255,255,0.25)' },
    ];
}

export interface VLine { x: number; color: string; label?: string; dashed?: boolean }

/** Histogram (bars = rows per bin) with the fitted normal curve and vertical
 *  reference lines (±1SD / ±3SD for Individual). `h.curve` is already in rows
 *  per bin, so it sits on the same Y axis as the bars. Both axes end on round
 *  ticks — never a raw extreme such as a bin edge 36.1987 or a count 942.7 —
 *  and the X axis always holds every reference line. */
export function buildDistributionOption(h: HealthHistogram, vLines: VLine[], unit?: string) {
    const bars = h.counts.map((c, i) => [h.bin_edges[i], h.bin_edges[i + 1], c]);
    const curve = h.curve.map((c, i) => [(h.bin_edges[i] + h.bin_edges[i + 1]) / 2, c]);
    const xs = [h.bin_edges[0], h.bin_edges[h.bin_edges.length - 1], ...vLines.map(l => l.x)].filter(Number.isFinite);
    // Nothing finite to measure (no bins, no lines): the axis is left to ECharts — never
    // `min: Infinity, max: -Infinity`.
    const xRange: NiceRange | null = xs.length > 0 ? niceExtent(Math.min(...xs), Math.max(...xs)) : null;
    const xFixed = xRange && xRange[2] !== undefined ? { min: xRange[0], max: xRange[1], interval: xRange[2] } : null;
    // 10 % headroom, rounded up to a nice tick so the top label is a round count (it was a raw
    // max × 1.1 — "1,713.8000000000002" on screen, 2026-10-09).
    const top = Math.max(1, ...h.counts.filter(Number.isFinite), ...h.curve.filter(Number.isFinite));
    const [, yMax, yStep] = niceExtent(0, top * 1.1);
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'item' },
        legend: { show: false },
        grid: { left: 52, right: 18, top: 14, bottom: 32, containLabel: false },
        xAxis: {
            type: 'value',
            ...(xFixed ?? {}),
            name: unit || undefined,
            nameLocation: 'middle',
            nameGap: 22,
            nameTextStyle: { color: CHART.textSecondary, fontSize: 10 },
            scale: true,
            ...(xFixed ? fixedValueAxisCommon(xFixed.min, xFixed.max) : valueAxisCommon),
            splitLine: { show: false },
        },
        yAxis: {
            type: 'value',
            min: 0,
            max: yMax,
            interval: yStep,
            ...fixedValueAxisCommon(0, yMax),
            splitLine: { show: true, lineStyle: { color: CHART.splitLine } },
        },
        series: [
            {
                type: 'custom',
                name: 'Rows',
                data: bars,
                encode: { x: [0, 1], y: 2 },
                itemStyle: { color: CHART.bar },
                renderItem: (_params: unknown, api: any) => {
                    const left = api.coord([api.value(0), 0]);
                    const right = api.coord([api.value(1), 0]);
                    const top = api.coord([0, api.value(2)]);
                    return {
                        type: 'rect',
                        shape: { x: left[0], y: top[1], width: Math.max(right[0] - left[0] - 1, 1), height: left[1] - top[1] },
                        style: api.style(),
                    };
                },
                z: 1,
            },
            {
                type: 'line',
                name: 'Normal curve',
                data: curve,
                showSymbol: false,
                smooth: true,
                lineStyle: { color: CHART.normalCurve, width: 1.5 },
                itemStyle: { color: CHART.normalCurve },
                z: 3,
                markLine: vLines.length
                    ? {
                        silent: true,
                        symbol: 'none',
                        animation: false,
                        data: vLines.map(v => ({
                            xAxis: v.x,
                            lineStyle: { color: v.color, width: 1.2, type: v.dashed === false ? 'solid' : 'dashed' },
                            label: v.label
                                ? { show: true, formatter: v.label, position: 'insideEndTop', color: v.color, fontSize: 10, fontFamily: CHART_MONO }
                                : { show: false },
                        })),
                    }
                    : undefined,
            },
        ],
    };
}

/** Individual's ±1SD / ±3SD vertical lines for the Distribution chart. */
export function individualVLines(stats: IndividualStats): VLine[] {
    return [
        { x: stats.boundary_1sd[0], color: CHART.ok, label: '−1SD' },
        { x: stats.boundary_1sd[1], color: CHART.ok, label: '+1SD' },
        { x: stats.boundary_3sd[0], color: CHART.warn, label: '−3SD' },
        { x: stats.boundary_3sd[1], color: CHART.warn, label: '+3SD' },
    ];
}

/** Approximate rows outside ±3SD, estimated from the histogram (the series is
 *  downsampled, so it cannot be counted from there; `stats` has no such field).
 *  Bins fully outside count whole, the bin an edge falls in counts in
 *  proportion. `null` when there is no histogram. */
export function estimateRowsOutside3sd(h: HealthHistogram | null, stats: IndividualStats): number | null {
    if (!h || h.counts.length === 0) return null;
    const [lo, hi] = stats.boundary_3sd;
    let n = 0;
    for (let i = 0; i < h.counts.length; i++) {
        const a = h.bin_edges[i];
        const b = h.bin_edges[i + 1];
        const w = b - a;
        if (!(w > 0)) continue;
        const outside = Math.max(0, Math.min(b, lo) - a) + Math.max(0, b - Math.max(a, hi));
        n += h.counts[i] * Math.min(1, outside / w);
    }
    return Math.round(n);
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

/** "Fit": predictor (X) against the target — actual (blue) vs the Relation
 *  model's prediction (red). */
export function buildFitScatterOption(fit: HealthFitScatter, yName: string) {
    const actual: [number, number][] = [];
    const predicted: [number, number][] = [];
    const n = Math.min(fit.x.length, fit.actual.length);
    for (let i = 0; i < n; i++) {
        const x = fit.x[i];
        if (!Number.isFinite(x)) continue;
        const a = fit.actual[i];
        if (Number.isFinite(a)) actual.push([x, a]);
        const p = fit.predicted[i];
        if (typeof p === 'number' && Number.isFinite(p)) predicted.push([x, p]);
    }
    const big = actual.length + predicted.length > 6000;
    const common = { type: 'scatter' as const, symbolSize: big ? 2.5 : 4, large: big, largeThreshold: 2000, silent: false };
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'item' },
        legend: { show: false },
        grid: { left: 58, right: 18, top: 14, bottom: 40, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
        xAxis: { type: 'value', name: fit.x_sensor, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...valueAxisCommon, axisLine: EDGE_AXIS_LINE, splitLine: { show: false } },
        yAxis: { type: 'value', name: yName, nameLocation: 'middle', nameGap: 44, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...valueAxisCommon, axisLine: EDGE_AXIS_LINE, splitLine: { show: true, lineStyle: { color: CHART.splitLine } } },
        series: [
            { ...common, name: 'Actual', data: actual, itemStyle: { color: CHART.actual, opacity: 0.45 } },
            { ...common, name: 'Relation model', data: predicted, itemStyle: { color: CHART.predicted, opacity: 0.6 } },
        ],
    };
}

/** "Target vs predicted" over time: the Actual (blue) and Predicted (red) lines.
 *  Which is which is the card's own two-item colour key (`ModelFitPage`) — the
 *  lines are NOT named on the plot: ECharts places a line's end label only while
 *  it animates the line in, so after a wheel-zoom or a drag a name stayed where
 *  its line used to end and could sit beside the OTHER line. */
export function buildTargetVsPredictedOption(series: RelationshipSeries, unit: string, scopes: TimeScopes | null = null) {
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        scopes,
        yName: unit || undefined,
        lines: [
            { name: 'Actual', values: series.actual, color: CHART.actual },
            { name: 'Predicted', values: series.predicted, color: CHART.predicted },
        ],
    });
}

/** "Residual over time" (actual − predicted) with the ±2RMSE band (green) and
 *  a zero line. No set-point lines here — those belong to the Health score page. */
export function buildResidualOption(series: RelationshipSeries, twoRmse: number, unit: string, scopes: TimeScopes | null = null) {
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        scopes,
        yName: unit || undefined,
        lines: [{ name: 'Residual', values: series.residual, color: CHART.series }],
        bands: [{ from: -twoRmse, to: twoRmse, color: CHART.okFill }],
        hLines: rmseReferenceLines(twoRmse),
    });
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** One σ-ellipse of a cluster as an ECharts `custom` series. `sigma` is the
 *  multiple of the cluster's own SD (1×, 3×, and N× on the Health score page);
 *  `x_sd` is the major axis, rotated by `angle_deg` — the same convention Rust
 *  scores against. */
export function ellipseSeries(
    c: Pick<ClusterStat, 'x_center' | 'y_center' | 'x_sd' | 'y_sd' | 'angle_deg'>,
    sigma: number,
    o: { name: string; stroke: string; dashed?: boolean; lineWidth?: number; z?: number },
) {
    const rx = c.x_sd * sigma;
    const ry = c.y_sd * sigma;
    const rad = (c.angle_deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        type: 'custom' as const,
        name: o.name,
        data: [[c.x_center, c.y_center]],
        z: o.z ?? 3,
        silent: true,
        itemStyle: { color: o.stroke },
        renderItem: (params: any, api: any) => {
            const pts: number[][] = [];
            for (let th = 0; th < 2 * Math.PI; th += Math.PI / 36) {
                const x = rx * Math.cos(th);
                const y = ry * Math.sin(th);
                pts.push(api.coord([c.x_center + x * cos - y * sin, c.y_center + x * sin + y * cos]));
            }
            return {
                type: 'polygon',
                shape: { points: pts },
                style: { fill: 'none', stroke: o.stroke, lineWidth: o.lineWidth ?? 1.6, lineDash: o.dashed ? [6, 4] : [0, 0] },
                clipPath: { type: 'rect', shape: { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height } },
            };
        },
    };
}

export interface ClusterChartNames { x: string; y: string }

/** Title of a scatter axis: the sensor's description and unit ("GENERATOR ACTIVE
 *  POWER · MW"), or the tag when it has no description. The tag itself is in the
 *  card's subtitle, so the axis is not a second place that repeats it. */
export function sensorAxisTitle(info: Pick<SensorInfo, 'tag' | 'description' | 'unit'>): string {
    return [info.description || info.tag, info.unit].filter(Boolean).join(' · ');
}

type RingShape = Pick<ClusterStat, 'x_center' | 'y_center' | 'x_sd' | 'y_sd' | 'angle_deg'>;
type RingCluster = RingShape & Pick<ClusterStat, 'cluster_id'>;

/** Half-width / half-height of the box around the ellipse `sigma` × SD of a
 *  cluster (rotated by its angle) — so a ring that lies outside the data is
 *  still inside the axes. */
export function ringBox(c: RingShape, sigma: number) {
    const rx = c.x_sd * sigma;
    const ry = c.y_sd * sigma;
    const a = (c.angle_deg * Math.PI) / 180;
    const hx = Math.hypot(rx * Math.cos(a), ry * Math.sin(a));
    const hy = Math.hypot(rx * Math.sin(a), ry * Math.cos(a));
    return { x: [c.x_center - hx, c.x_center + hx] as [number, number], y: [c.y_center - hy, c.y_center + hy] as [number, number] };
}

/** The right-most point of a cluster's `sigma` ring (a rotated ellipse). */
export function ringRightPoint(c: RingShape, sigma: number): [number, number] {
    const rx = c.x_sd * sigma;
    const ry = c.y_sd * sigma;
    const a = (c.angle_deg * Math.PI) / 180;
    const th = Math.atan2(-ry * Math.sin(a), rx * Math.cos(a));
    return [
        c.x_center + rx * Math.cos(th) * Math.cos(a) - ry * Math.sin(th) * Math.sin(a),
        c.y_center + rx * Math.cos(th) * Math.sin(a) + ry * Math.sin(th) * Math.cos(a),
    ];
}

export interface RingLevel { sigma: number; text: string; color: string }

/** Height of one ring-label line (9.5 px text + its chip padding + air). */
export const RING_LABEL_LINE = 13;

/** Every ring LEVEL is named once — at the right edge of the ring that reaches
 *  furthest right ("1× · 100", "3× · 80", "5× · 0") — instead of once per
 *  cluster or in a legend row under the chart. */
export function ringLabelSeries(clusters: RingShape[], levels: RingLevel[]) {
    const named = levels.flatMap(l => {
        let best: [number, number] | null = null;
        for (const c of clusters) {
            const p = ringRightPoint(c, l.sigma);
            if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
            if (!best || p[0] > best[0]) best = p;
        }
        return best ? [{ level: l, at: best }] : [];
    });
    // The rings of one cluster reach furthest right at nearly the same height, and on a wide
    // axis only a few pixels apart — so the names are staggered one text line each around that
    // height. The stagger FOLLOWS THE DATA: the name whose ring edge is highest goes up, the
    // lowest goes down, so the stagger only ever adds to the distance the points already have
    // and two names are always at least one line apart. (A fixed "first level up, last level
    // down" pushed the names of a cluster tilted up to the right — positively correlated
    // sensors, the usual shape — INTO each other: there the 1× edge is the lowest.) Rings that
    // end at the same height (a flat cluster) keep the level order: first up, last down.
    const order = named.map((_, i) => i).sort((i, j) => named[j].at[1] - named[i].at[1] || i - j);
    const mid = (named.length - 1) / 2;
    const rank = new Array<number>(named.length);
    order.forEach((i, r) => { rank[i] = r; });
    const data = named.map((n, i) => ({
        name: n.level.text,
        value: n.at,
        // screen Y grows downwards: rank 0 (the highest edge) gets the most negative offset
        label: { formatter: n.level.text, color: n.level.color, offset: [0, (rank[i] - mid) * RING_LABEL_LINE] },
    }));
    return {
        type: 'scatter' as const,
        name: 'Ring labels',
        data,
        symbolSize: 0,
        silent: true,
        z: 5,
        label: { show: true, position: 'right' as const, distance: 4, fontSize: 9.5, fontFamily: CHART_MONO, backgroundColor: CHART.labelChipBg, padding: [1, 3], borderRadius: 3 },
        tooltip: { show: false },
    };
}

/** "Cluster N" at each centre, in the cluster's own colour, on a dark chip so it
 *  reads over dense points. */
export function centreLabelSeries(clusters: RingCluster[], colorOf: (id: number) => string) {
    return {
        type: 'scatter' as const,
        name: 'Centres',
        data: clusters.map(c => ({ value: [c.x_center, c.y_center], label: { color: colorOf(c.cluster_id) } })),
        symbolSize: 5,
        silent: true,
        itemStyle: { color: CHART.textPrimary },
        label: {
            show: true,
            position: 'top' as const,
            fontSize: 10.5,
            fontWeight: 600,
            backgroundColor: CHART.labelChipBg,
            padding: [1, 4],
            borderRadius: 3,
            formatter: (p: { dataIndex: number }) => `Cluster ${clusters[p.dataIndex]?.cluster_id ?? ''}`,
        },
        z: 4,
    };
}

/** Share of the X span kept free right of the furthest ring, for the ring labels. */
const RING_LABEL_ROOM = 0.1;

/** Axis extents of a Clusters chart: the points AND every ring drawn (a ring is
 *  never cut by the plot's edge), rounded out to nice ticks, with room on the
 *  right for the ring labels. */
export function clusterExtent(xs: readonly number[], ys: readonly number[], clusters: RingShape[], sigmas: readonly number[]) {
    let xLo = Infinity; let xHi = -Infinity; let yLo = Infinity; let yHi = -Infinity;
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < xLo) xLo = x;
        if (x > xHi) xHi = x;
        if (y < yLo) yLo = y;
        if (y > yHi) yHi = y;
    }
    for (const c of clusters) {
        for (const sg of sigmas) {
            const b = ringBox(c, sg);
            if (![...b.x, ...b.y].every(Number.isFinite)) continue;
            xLo = Math.min(xLo, b.x[0]); xHi = Math.max(xHi, b.x[1]);
            yLo = Math.min(yLo, b.y[0]); yHi = Math.max(yHi, b.y[1]);
        }
    }
    const ext = (lo: number, hi: number, room = 0): NiceRange => {
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
        // Everything at one value (a constant sensor, rings of no size): open the axis around
        // it like the time charts do — never `min === max`.
        const flat = hi > lo ? 0 : Math.abs(hi) * 0.05 || 1;
        const a = lo - flat;
        const b = hi + flat;
        return niceExtent(a - (b - a) * 0.03, b + (b - a) * (0.03 + room));
    };
    return { x: ext(xLo, xHi, RING_LABEL_ROOM), y: ext(yLo, yHi) };
}

/** The two value axes of a Clusters chart (Model fit and Health score draw the
 *  same ones): fixed to `clusterExtent` and stepped by the step it was rounded
 *  to, the axis lines on the plot's edge. */
export function clusterAxes(names: ClusterChartNames, ex: { x: NiceRange; y: NiceRange }) {
    const title = { nameLocation: 'middle' as const, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 } };
    const axis = ([min, max, interval]: NiceRange) => {
        const common = fixedValueAxisCommon(min, max);
        return { type: 'value' as const, min, max, interval, ...title, ...common, axisLabel: { ...common.axisLabel, hideOverlap: true }, axisLine: EDGE_AXIS_LINE };
    };
    return {
        xAxis: { ...axis(ex.x), name: names.x, nameGap: 24, splitLine: { show: false } },
        yAxis: { ...axis(ex.y), name: names.y, nameGap: 44, splitLine: { show: true, lineStyle: { color: CHART.splitLine } } },
    };
}

/** Cluster scatter (points coloured by cluster) with the 1× (green, solid) and
 *  3× (amber, dashed) SD ellipse of every cluster, a "Cluster N" label at each
 *  centre and each ring level named once at the right edge. `names` are the
 *  axis titles (description + unit; the tag is in the card's subtitle). */
export function buildClusterOption(scatter: HealthClusterScatter, clusters: ClusterStat[], names: ClusterChartNames) {
    const byCluster = new Map<number | null, [number, number][]>();
    const n = Math.min(scatter.x.length, scatter.y.length);
    for (let i = 0; i < n; i++) {
        const x = scatter.x[i];
        const y = scatter.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const k = scatter.cluster[i] ?? null;
        if (!byCluster.has(k)) byCluster.set(k, []);
        byCluster.get(k)!.push([x, y]);
    }
    const big = n > 6000;
    const colorOf = (id: number) => CLUSTER_COLORS[(id - 1 + CLUSTER_COLORS.length) % CLUSTER_COLORS.length];
    const pointSeries = [...byCluster.entries()].map(([id, data]) => ({
        type: 'scatter' as const,
        name: id === null ? 'No cluster' : `Cluster ${id}`,
        data,
        symbolSize: big ? 2.5 : 4,
        large: big,
        largeThreshold: 2000,
        itemStyle: { color: id === null ? 'rgba(180,190,210,0.35)' : colorOf(id), opacity: 0.5 },
        z: 1,
    }));
    const rings = clusters.flatMap(c => [
        ellipseSeries(c, 1, { name: `Cluster ${c.cluster_id} 1× SD`, stroke: CHART.ok }),
        ellipseSeries(c, 3, { name: `Cluster ${c.cluster_id} 3× SD`, stroke: CHART.warn, dashed: true }),
    ]);
    const centres = centreLabelSeries(clusters, colorOf);
    const ringLabels = ringLabelSeries(clusters, [
        { sigma: 1, text: '1× SD', color: CHART.ok },
        { sigma: 3, text: '3× SD', color: CHART.warn },
    ]);
    const axes = clusterAxes(names, clusterExtent(scatter.x, scatter.y, clusters, [1, 3]));
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'item' },
        legend: { show: false },
        grid: { left: 58, right: 18, top: 14, bottom: 40, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
        ...axes,
        series: [...pointSeries, ...rings, centres, ringLabels],
    };
}
