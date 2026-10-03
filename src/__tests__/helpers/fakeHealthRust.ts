/**
 * A fake Rust backend for the health-score integration tests (QA, 2026-10-04).
 *
 * It is a small, faithful TypeScript port of the REAL Rust contract — written
 * from `src-tauri/src/{health_score,health_preview,model_export,lib}.rs` and the
 * phase-2 handover entry, NOT from the app's own TypeScript — so a frontend that
 * assumes something Rust does not do shows up as a wrong number / wrong error:
 *
 *  - Session: `load_csv` (via `loadDataset`) starts a NEW session: generation
 *    bumped, the Relationship fit cache (`rel_cache`) cleared.
 *  - `check_expected_generation`: a pinned `expected_generation` that is not the
 *    session's -> `STALE_SESSION: the dataset changed since this window was opened`.
 *  - Training scope = `PreviewFilter` / `ResolvedFilter`: `timestamp_ranges`
 *    (inclusive, ANY period), `value_filters` on EXACT header match (unknown
 *    sensors dropped silently), AND by default, OR when `combine === 'or'`.
 *  - `compute_sensor_stats` (`sensor`, `filter`): mean / sample SD / ±1σ / ±3σ.
 *  - `compute_clustering_preview` (`rename_all = snake_case`): GMM(1) ellipse per
 *    criteria range (half-open `[min, max)`), biased covariance, SVD major axis.
 *  - `preview_relationship_model` (`rename_all = snake_case`; NO generation
 *    parameter): a least-squares stand-in for the sidecar (cumulative steps ->
 *    `r2_per_step`, `rmse2_per_step`, `predicted`, `residual`) plus
 *    `predictor_raw`/`target_raw`; with `cache_key` the full fit is cached and
 *    `cache_key`, `cached`, `health_preview` are added.
 *  - `compute_health_preview` (`request`): Individual / Clustering compute from
 *    the session; Relationship reads ONLY the cache (`NOT_FITTED` without a
 *    `cache_key`, for an unknown key, or when target/predictors differ from the
 *    cached fit); `BAD_REQUEST` for a missing sensor / field / unknown kind;
 *    `NO_DATA` for an empty scope. Validation = a port of `validate_individual`,
 *    `validate_relationship`, `validate_clustering` (codes, fields, messages);
 *    score = the piecewise-linear knots; `score_summary` = `summarize`.
 *  - `export_model_files` (`request`): Individual/Clustering re-validate against
 *    statistics computed in the call; Relationship pre-validates with the cached
 *    2RMSE (if cached) then "runs the sidecar" (gate-able) and validates again.
 *    Invalid = `ok:false` + `validation`, nothing written. Files land in the
 *    shared in-memory file map under `workspaces/{id}/output/...`.
 *  - `get_model_output_dir` (`workspace_id`).
 *  - Tauri arg-key casing: an unexpected or missing top-level key rejects.
 */

export interface HealthDataset {
    /** headers[0] is the timestamp column. */
    headers: string[];
    /** One timestamp per row (`YYYY-MM-DD HH:MM:SS`). */
    timestamps: string[];
    /** Values per sensor (header after the timestamp); `null`/NaN = missing. */
    columns: Record<string, (number | null)[]>;
}

type Args = Record<string, any>;
type Pred = (args: Args) => boolean;

interface Fault { cmd: string; pred: Pred; error: string; once: boolean }
interface Gate { cmd: string; pred: Pred; release: () => void; promise: Promise<void>; armed: boolean; entered: boolean }

export const STALE_SESSION_ERROR = 'STALE_SESSION: the dataset changed since this window was opened';
export const APP_DATA = 'C:/Users/qa/AppData/Roaming/com.wizard.app';

// ---------------------------------------------------------------------------
// round_metric (metrics.rs)
// ---------------------------------------------------------------------------

function metricDecimals(x: number): number {
    if (x === 0 || !Number.isFinite(x)) return 3;
    return Math.max(3, 3 - Math.floor(Math.log10(Math.abs(x))));
}
function roundTo(x: number, d: number): number {
    if (!Number.isFinite(x) || Math.abs(x) >= 1e15 || d > 300) return x;
    const f = Math.pow(10, d);
    if (!Number.isFinite(f)) return x;
    const r = Math.sign(x) * Math.round(Math.abs(x) * f) / f; // half away from zero
    return Number.isFinite(r) ? r : x;
}
export const roundMetric = (x: number) => roundTo(x, metricDecimals(x));
export const roundMetricScaled = (x: number, scale: number) =>
    roundTo(x, Math.max(metricDecimals(x), scale === 0 || !Number.isFinite(scale) ? 3 : metricDecimals(scale)));
const fmtNum = (x: number) => (Number.isFinite(x) ? String(roundMetric(x)) : String(x));

// ---------------------------------------------------------------------------
// Validation (health_score.rs) — codes / fields / messages as Rust writes them
// ---------------------------------------------------------------------------

export interface Issue { code: string; severity: 'error' | 'warning'; message: string; field: string }
const issue = (code: string, field: string, message: string): Issue => ({ code, severity: 'error', message, field });

/** `SetPointsArg`: snake_case, the TS camelCase aliases and the legacy names. */
export interface SetPointsArg {
    lower?: number | null; upper?: number | null;
    residual_at_80_lower?: number | null; residual_at_80_upper?: number | null;
    residual_at_0_lower?: number | null; residual_at_0_upper?: number | null;
    outer_sd?: number | null;
}
const optNum = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number') throw `invalid type: expected f64, got ${typeof v}`;
    return v;
};
export function parseSetPoints(raw: any): SetPointsArg {
    if (raw === null || raw === undefined) return {};
    const pick = (...keys: string[]) => {
        for (const k of keys) if (k in raw) return optNum(raw[k]);
        return null;
    };
    return {
        lower: pick('lower'),
        upper: pick('upper'),
        residual_at_80_lower: pick('residual_at_80_lower', 'residualAt80Lower', 'residual_at_health_80_lower'),
        residual_at_80_upper: pick('residual_at_80_upper', 'residualAt80Upper', 'residual_at_health_80_upper'),
        residual_at_0_lower: pick('residual_at_0_lower', 'residualAt0Lower', 'residual_at_health_0_lower'),
        residual_at_0_upper: pick('residual_at_0_upper', 'residualAt0Upper', 'residual_at_health_0_upper'),
        outer_sd: pick('outer_sd', 'outerSd'),
    };
}

export interface IndividualBand { mean: number; sd: number; l1: number; u1: number; l3: number; u3: number }
const bandDegenerate = (b: IndividualBand) => {
    const v = [b.l3, b.l1, b.u1, b.u3];
    return !v.every(Number.isFinite) || !v.every((x, i) => i === 0 || v[i - 1] < x);
};

export function validateIndividual(b: IndividualBand, sp: SetPointsArg): Issue[] {
    const out: Issue[] = [];
    const l = sp.lower ?? null;
    const h = sp.upper ?? null;
    if (l === null) out.push(issue('required', 'lower', 'Enter the lower set point (L): the value where health reaches 0 on the low side.'));
    if (h === null) out.push(issue('required', 'upper', 'Enter the upper set point (H): the value where health reaches 0 on the high side.'));
    const degenerate = bandDegenerate(b);
    if (degenerate) out.push(issue('degenerate_band', 'sd', `The ±1σ / ±3σ band is collapsed for this training scope (σ = ${fmtNum(b.sd)}), so a health score can't be calculated. Widen the training period or running condition so the sensor varies.`));
    if (l !== null && h !== null && l >= h) out.push(issue('ordering', 'lower', `The lower set point (L = ${fmtNum(l)}) must be below the upper set point (H = ${fmtNum(h)}).`));
    if (!degenerate) {
        if (l !== null) {
            if (l === b.l3) out.push(issue('lower_equals_3sd', 'lower', `The lower set point (L = ${fmtNum(l)}) equals the lower 3σ boundary, so the 80 and the 0 point would coincide. Set L below ${fmtNum(b.l3)}.`));
            else if (l > b.l3) out.push(issue('lower_inside_3sd', 'lower', `The lower set point (L = ${fmtNum(l)}) must be below the lower 3σ boundary (${fmtNum(b.l3)}).`));
        }
        if (h !== null) {
            if (h === b.u3) out.push(issue('upper_equals_3sd', 'upper', `The upper set point (H = ${fmtNum(h)}) equals the upper 3σ boundary, so the 80 and the 0 point would coincide. Set H above ${fmtNum(b.u3)}.`));
            else if (h < b.u3) out.push(issue('upper_inside_3sd', 'upper', `The upper set point (H = ${fmtNum(h)}) must be above the upper 3σ boundary (${fmtNum(b.u3)}).`));
        }
    }
    return out;
}

export function validateRelationship(w: number | null, sp: SetPointsArg): Issue[] {
    const out: Issue[] = [];
    const fields: [keyof SetPointsArg, string][] = [
        ['residual_at_80_lower', 'the lower 80-point (residual where health is 80, negative)'],
        ['residual_at_80_upper', 'the upper 80-point (residual where health is 80, positive)'],
        ['residual_at_0_lower', 'the lower 0-point (residual where health is 0, negative)'],
        ['residual_at_0_upper', 'the upper 0-point (residual where health is 0, positive)'],
    ];
    for (const [k, label] of fields) if ((sp[k] ?? null) === null) out.push(issue('required', k, `Enter ${label}.`));
    let bandOk = false;
    if (w !== null) {
        if (Number.isFinite(w) && w > 0) bandOk = true;
        else out.push(issue('degenerate_band', 'two_rmse', `The model's 2RMSE is ${fmtNum(w)}, so there is no residual band to build a health score on. Check the model fit or widen the training scope.`));
    }
    for (const side of ['lower', 'upper'] as const) {
        const f80 = `residual_at_80_${side}` as const;
        const f0 = `residual_at_0_${side}` as const;
        const v80 = sp[f80] ?? null;
        const v0 = sp[f0] ?? null;
        const signOk = (v: number) => (side === 'lower' ? v < 0 : v > 0);
        const code = side === 'lower' ? 'must_be_negative' : 'must_be_positive';
        const word = side === 'lower' ? 'negative' : 'positive';
        let ok80 = false;
        let ok0 = false;
        if (v80 !== null) {
            if (signOk(v80)) ok80 = true;
            else out.push(issue(code, f80, `The ${side} 80-point must be ${word} (residual = actual − predicted); got ${fmtNum(v80)}.`));
        }
        if (v0 !== null) {
            if (signOk(v0)) ok0 = true;
            else out.push(issue(code, f0, `The ${side} 0-point must be ${word} (residual = actual − predicted); got ${fmtNum(v0)}.`));
        }
        if (bandOk && ok80 && w !== null && v80 !== null) {
            const m = Math.abs(v80);
            if (m === w) out.push(issue('point80_equals_band', f80, `The ${side} 80-point (${fmtNum(v80)}) sits exactly on the ±2RMSE band edge (${fmtNum(w)}), so the 100 and the 80 point would coincide. Move it further from zero.`));
            else if (m < w) out.push(issue('point80_inside_band', f80, `The ${side} 80-point (${fmtNum(v80)}) must be further from zero than the ±2RMSE band edge (${fmtNum(w)}).`));
        }
        if (ok80 && ok0 && v80 !== null && v0 !== null) {
            const m80 = Math.abs(v80);
            const m0 = Math.abs(v0);
            if (m0 === m80) out.push(issue('point0_equals_point80', f0, `The ${side} 0-point (${fmtNum(v0)}) equals the ${side} 80-point, so the score would drop from 80 to 0 instantly. Move the 0-point further from zero.`));
            else if (m0 < m80) out.push(issue('point0_inside_point80', f0, `The ${side} 0-point (${fmtNum(v0)}) must be further from zero than the ${side} 80-point (${fmtNum(v80)}).`));
        }
    }
    return out;
}

export interface ClusterGeom { cluster_id: number; x_center: number; y_center: number; x_sd: number; y_sd: number; angle_deg: number }
export function validateClustering(clusters: ClusterGeom[], sp: SetPointsArg): Issue[] {
    const out: Issue[] = [];
    const n = sp.outer_sd ?? null;
    if (n === null) out.push(issue('required', 'outer_sd', 'Enter the outer ring (N × SD): the distance where health reaches 0.'));
    else if (!Number.isFinite(n)) out.push(issue('outer_sd_not_a_number', 'outer_sd', 'The outer ring must be a number.'));
    else if (n === 3) out.push(issue('outer_sd_equals_3', 'outer_sd', "The outer ring can't equal 3× SD (that ring is the 80 point). Use more than 3."));
    else if (n < 3) out.push(issue('outer_sd_not_above_3', 'outer_sd', `The outer ring (${fmtNum(n)}× SD) must be more than 3× SD (the 80 point).`));
    for (const c of clusters) {
        const v = [c.x_center, c.y_center, c.x_sd, c.y_sd, c.angle_deg];
        if (!v.every(Number.isFinite) || c.x_sd <= 0 || c.y_sd <= 0) {
            out.push(issue('degenerate_band', `cluster_${c.cluster_id}`, `Cluster ${c.cluster_id} has no spread in one direction (SDs ${fmtNum(c.x_sd)} × ${fmtNum(c.y_sd)}), so a health score can't be calculated for it. Adjust the criteria ranges or the training scope.`));
        }
    }
    if (clusters.length === 0) out.push(issue('degenerate_band', 'clusters', 'No cluster could be fitted, so a health score can\'t be calculated.'));
    return out;
}

// ---------------------------------------------------------------------------
// Scores (health_score.rs)
// ---------------------------------------------------------------------------

const lerp = (x: number, x0: number, y0: number, x1: number, y1: number) => (x1 <= x0 ? y1 : y0 + (y1 - y0) * (x - x0) / (x1 - x0));
const clamp = (s: number) => Math.min(100, Math.max(0, s));

export function scoreIndividual(b: IndividualBand, L: number, H: number, v: number): number | null {
    if (!Number.isFinite(v)) return null;
    let s: number;
    if (v > b.u1) s = v >= H ? 0 : v <= b.u3 ? lerp(v, b.u1, 100, b.u3, 80) : lerp(v, b.u3, 80, H, 0);
    else if (v < b.l1) s = v <= L ? 0 : v >= b.l3 ? lerp(-v, -b.l1, 100, -b.l3, 80) : lerp(-v, -b.l3, 80, -L, 0);
    else s = 100;
    return clamp(s);
}
export function scoreRelationship(w: number, sp: Required<Pick<SetPointsArg, 'residual_at_80_lower' | 'residual_at_80_upper' | 'residual_at_0_lower' | 'residual_at_0_upper'>>, r: number): number | null {
    if (!Number.isFinite(r)) return null;
    const lo80 = sp.residual_at_80_lower!, lo0 = sp.residual_at_0_lower!, up80 = sp.residual_at_80_upper!, up0 = sp.residual_at_0_upper!;
    let s: number;
    if (r > w) s = r >= up0 ? 0 : r <= up80 ? lerp(r, w, 100, up80, 80) : lerp(r, up80, 80, up0, 0);
    else if (r < -w) s = r <= lo0 ? 0 : r >= lo80 ? lerp(-r, w, 100, -lo80, 80) : lerp(-r, -lo80, 80, -lo0, 0);
    else s = 100;
    return clamp(s);
}
export function sdDistance(g: ClusterGeom, x: number, y: number): number {
    const dx = x - g.x_center;
    const dy = y - g.y_center;
    const a = g.angle_deg * Math.PI / 180;
    const u = dx * Math.cos(a) + dy * Math.sin(a);
    const v = -dx * Math.sin(a) + dy * Math.cos(a);
    return Math.sqrt((u / g.x_sd) ** 2 + (v / g.y_sd) ** 2);
}
export function scoreClusterDistance(d: number, N: number): number | null {
    if (!Number.isFinite(d)) return null;
    const s = d <= 1 ? 100 : d <= 3 ? lerp(d, 1, 100, 3, 80) : d < N ? lerp(d, 3, 80, N, 0) : 0;
    return clamp(s);
}

function summarize(scores: (number | null)[], totalRows: number, locate: (i: number) => { row: number; timestamp: string | null }) {
    let scored = 0, hi = 0, mid = 0, lo = 0;
    let min: { i: number; s: number } | null = null;
    scores.forEach((s, i) => {
        if (s === null || Number.isNaN(s)) return;
        scored++;
        if (s >= 80) hi++; else if (s >= 40) mid++; else lo++;
        if (!min || s < min.s) min = { i, s };
    });
    const pct = (c: number) => (scored === 0 ? null : c * 100 / scored);
    const m = min as { i: number; s: number } | null;
    return {
        scored,
        unscored: Math.max(0, totalRows - scored),
        total_rows: totalRows,
        min_score: m ? { score: m.s, ...locate(m.i) } : null,
        pct_below_80: pct(mid + lo),
        share_80_100: pct(hi),
        share_40_80: pct(mid),
        share_0_40: pct(lo),
        share_basis: 'row_count' as const,
    };
}

/** `select_indices` / `stride_indices` simplified: every index when it fits. */
function selectIdx(n: number, max: number): number[] {
    const cap = Math.min(Math.max(max, 8), 100_000);
    if (n <= cap) return Array.from({ length: n }, (_, i) => i);
    const out = new Set<number>([0, n - 1]);
    for (let i = 0; i < cap - 2; i++) out.add(Math.floor(i * n / (cap - 2)));
    return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

/** Allowed top-level argument keys, as Tauri v2 deserializes them. */
const SIGNATURES: Record<string, { required: string[]; optional?: string[] }> = {
    compute_health_preview: { required: ['request'] },
    export_model_files: { required: ['request'] },
    get_model_output_dir: { required: ['workspace_id'] }, // rename_all = snake_case
    preview_relationship_model: { required: ['predictors', 'target', 'lambda'], optional: ['filter', 'cache_key', 'max_points'] },
    compute_clustering_preview: { required: ['first_sensor', 'second_sensor', 'n_clusters'], optional: ['criteria_sensor', 'cluster_ranges', 'filter'] },
    compute_sensor_stats: { required: ['sensor'], optional: ['filter'] },
    get_dataset_time_bounds: { required: [], optional: ['filter'] },
    get_session_generation: { required: [] },
};

interface RelFit {
    target: string;
    predictors: string[];
    lambda: number;
    rows: number[];
    actual: number[];
    predicted: number[];
    x_cols: number[][];
    r2_per_step: number[];
    rmse2_per_step: number[];
    generation: number;
}

export interface FakeHealthRustOptions {
    datasets: Record<string, HealthDataset>;
    /** Dataset loaded at start (the first key when omitted). */
    initial?: string;
    /** Shared file map (the test's plugin-fs) — exports are written into it. */
    files?: Map<string, string>;
}

const tsMicros = (s: string | null | undefined): number | null => {
    if (!s) return null;
    const t = s.trim().replace(' ', 'T');
    const full = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00` : /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00` : t;
    const ms = Date.parse(`${full}Z`);
    return Number.isFinite(ms) ? ms : null;
};

export function createFakeHealthRust(opts: FakeHealthRustOptions) {
    const files = opts.files ?? new Map<string, string>();
    let datasetName = opts.initial ?? Object.keys(opts.datasets)[0];
    let data: HealthDataset = opts.datasets[datasetName];
    let generation = 1;
    let relCache = new Map<string, RelFit>();
    const calls: { cmd: string; args: Args; result?: unknown; error?: string; at: number }[] = [];
    const faults: Fault[] = [];
    const gates: Gate[] = [];
    const overrides: { cmd: string; pred: Pred; fn: (args: Args, real: () => Promise<unknown>) => unknown; once: boolean }[] = [];
    let clock = 0;

    const nRows = () => data.timestamps.length;
    const col = (name: string): number[] | null => {
        if (name === data.headers[0]) return null;
        if (!data.headers.includes(name)) return null; // exact match (col_index)
        return (data.columns[name] ?? []).map(v => (v === null || v === undefined ? NaN : v));
    };
    const tsParsed = () => data.timestamps.map(tsMicros);

    /** `ResolvedFilter::resolve` + `keeps`. */
    const resolveFilter = (f: any) => {
        if (!f) return { noop: true, keeps: (_r: number) => true };
        const ranges: [number | null, number | null][] = [];
        (f.timestamp_ranges ?? []).forEach((r: any, i: number) => {
            const s = r.start ? tsMicros(r.start) : null;
            const e = r.end ? tsMicros(r.end) : null;
            if (r.start && s === null) throw `time period ${i + 1} start: cannot parse '${r.start}'`;
            if (r.end && e === null) throw `time period ${i + 1} end: cannot parse '${r.end}'`;
            if (s !== null && e !== null && s > e) throw `time period ${i + 1} ends before it starts`;
            ranges.push([s, e]);
        });
        const vfs = (f.value_filters ?? [])
            .map((vf: any) => ({ ...vf, c: col(vf.sensor) }))
            .filter((vf: any) => vf.c !== null);
        const or = f.combine === 'or';
        const ts = tsParsed();
        const noop = ranges.length === 0 && vfs.length === 0;
        const keeps = (r: number) => {
            if (ranges.length) {
                const t = ts[r];
                if (t === null) return false;
                if (!ranges.some(([s, e]) => (s === null || t >= s) && (e === null || t <= e))) return false;
            }
            if (vfs.length === 0) return true;
            let any = false;
            for (const vf of vfs) {
                const v = vf.c[r];
                let ok: boolean;
                if (Number.isNaN(v)) ok = false;
                else switch (vf.operation) {
                    case 'greater_than': ok = vf.value1 === null || v > vf.value1; break;
                    case 'less_than': ok = vf.value1 === null || v < vf.value1; break;
                    case 'equals': ok = vf.value1 === null || Math.abs(v - vf.value1) < Number.EPSILON; break;
                    case 'between': ok = vf.value1 === null || vf.value2 === null ? true : v >= vf.value1 && v <= vf.value2; break;
                    default: ok = true;
                }
                if (or) { if (ok) { any = true; break; } } else if (!ok) return false;
            }
            return or ? any : true;
        };
        return { noop, keeps };
    };

    const meanSd = (vals: number[]) => {
        const n = vals.length;
        const mean = vals.reduce((a, b) => a + b, 0) / n;
        const sd = n < 2 ? 0 : Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
        return { mean, sd };
    };

    const individualBandOf = (mean: number, sd: number): IndividualBand => {
        const sdR = roundMetric(sd);
        const meanR = roundMetricScaled(mean, sdR);
        return {
            mean: meanR,
            sd: sdR,
            l1: roundMetricScaled(meanR - sdR, sdR),
            u1: roundMetricScaled(meanR + sdR, sdR),
            l3: roundMetricScaled(meanR - 3 * sdR, sdR),
            u3: roundMetricScaled(meanR + 3 * sdR, sdR),
        };
    };

    const inScopeIndividual = (target: string, filter: any) => {
        const c = col(target);
        if (!c) throw `BAD_REQUEST: Sensor not found: ${target}`;
        const f = resolveFilter(filter);
        const rows: number[] = [];
        for (let r = 0; r < nRows(); r++) if (Number.isFinite(c[r]) && (f.noop || f.keeps(r))) rows.push(r);
        return { c, rows };
    };

    // ---- clustering (clustering_preview_in) ----
    const fitEllipse = (xs: number[], ys: number[]) => {
        const n = xs.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = ys.reduce((a, b) => a + b, 0) / n;
        let sxx = 0, syy = 0, sxy = 0;
        for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
        const a = sxx / n, d = syy / n, b = sxy / n;
        const tr = a + d, det = a * d - b * b;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l0 = Math.max(0, tr / 2 + disc), l1 = Math.max(0, tr / 2 - disc);
        // eigenvector of the larger eigenvalue
        let vx = b, vy = l0 - a;
        if (Math.abs(vx) < 1e-15 && Math.abs(vy) < 1e-15) { vx = a >= d ? 1 : 0; vy = a >= d ? 0 : 1; }
        const angle = Math.atan2(vy, vx) * 180 / Math.PI;
        return { x_center: mx, y_center: my, x_sd: Math.sqrt(l0), y_sd: Math.sqrt(l1), angle_deg: angle };
    };

    const clusteringPreviewIn = (a: Args) => {
        const first = a.first_sensor, second = a.second_sensor;
        const n = a.n_clusters;
        if (!Number.isInteger(n) || n < 0) throw `invalid args for command compute_clustering_preview: n_clusters must be a u32, got ${JSON.stringify(n)}`;
        if (n === 0) throw 'n_clusters must be at least 1';
        if (!first || !second) throw 'Both sensors are required.';
        const c1 = col(first); if (!c1) throw `Sensor not found: ${first}`;
        const c2 = col(second); if (!c2) throw `Sensor not found: ${second}`;
        const f = resolveFilter(a.filter);
        const clusters: any[] = [];
        if (n === 1) {
            const xs: number[] = [], ys: number[] = [];
            for (let r = 0; r < nRows(); r++) {
                if (!f.noop && !f.keeps(r)) continue;
                if (Number.isFinite(c1[r]) && Number.isFinite(c2[r])) { xs.push(c1[r]); ys.push(c2[r]); }
            }
            if (!xs.length) throw 'No rows remain after dropping nulls.';
            clusters.push({ cluster_id: 1, range: null, n_rows: xs.length, ellipse: fitEllipse(xs, ys), xs, ys });
            return { first_sensor: first, second_sensor: second, criteria_sensor: null, cluster_count: 1, n_rows: xs.length, clusters };
        }
        if (!a.criteria_sensor) throw 'criteria_sensor is required when n_clusters > 1';
        const ranges = a.cluster_ranges;
        if (!ranges) throw 'cluster_ranges is required when n_clusters > 1';
        if (ranges.length !== n) throw `cluster_ranges length (${ranges.length}) must equal n_clusters (${n})`;
        const cc = col(a.criteria_sensor); if (!cc) throw `Criteria sensor not found: ${a.criteria_sensor}`;
        let total = 0;
        ranges.forEach((rg: any, idx: number) => {
            const xs: number[] = [], ys: number[] = [];
            for (let r = 0; r < nRows(); r++) {
                if (!f.noop && !f.keeps(r)) continue;
                const c = cc[r];
                if (!Number.isFinite(c) || (rg.min !== null && c < rg.min) || (rg.max !== null && c >= rg.max)) continue;
                if (Number.isFinite(c1[r]) && Number.isFinite(c2[r])) { xs.push(c1[r]); ys.push(c2[r]); }
            }
            if (!xs.length) throw `Cluster ${idx + 1} has no rows after applying its criteria range.`;
            total += xs.length;
            clusters.push({ cluster_id: idx + 1, range: { min: rg.min, max: rg.max }, n_rows: xs.length, ellipse: fitEllipse(xs, ys), xs, ys });
        });
        return { first_sensor: first, second_sensor: second, criteria_sensor: a.criteria_sensor, cluster_count: n, n_rows: total, clusters };
    };

    const roundedGeom = (id: number, e: any): ClusterGeom => ({
        cluster_id: id,
        x_center: roundMetricScaled(e.x_center, e.x_sd),
        y_center: roundMetricScaled(e.y_center, e.y_sd),
        x_sd: roundMetric(e.x_sd),
        y_sd: roundMetric(e.y_sd),
        angle_deg: roundMetric(e.angle_deg),
    });

    // ---- relationship (least squares stand-in for the sidecar) ----
    const solve = (A: number[][], b: number[]): number[] => {
        const n = b.length;
        const M = A.map((r, i) => [...r, b[i]]);
        for (let i = 0; i < n; i++) {
            let p = i;
            for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
            [M[i], M[p]] = [M[p], M[i]];
            if (Math.abs(M[i][i]) < 1e-12) return new Array(n).fill(0);
            for (let k = i + 1; k < n; k++) {
                const f = M[k][i] / M[i][i];
                for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
            }
        }
        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let s = M[i][n];
            for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
            x[i] = s / M[i][i];
        }
        return x;
    };
    const ols = (X: number[][], y: number[]): number[] => {
        const k = X[0].length + 1;
        const A = Array.from({ length: k }, () => new Array(k).fill(0));
        const b = new Array(k).fill(0);
        for (let i = 0; i < y.length; i++) {
            const row = [1, ...X[i]];
            for (let p = 0; p < k; p++) { b[p] += row[p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += row[p] * row[q]; }
        }
        const beta = solve(A, b);
        return X.map(r => [1, ...r].reduce((s, v, i) => s + v * beta[i], 0));
    };
    const r2 = (y: number[], p: number[]) => {
        const m = y.reduce((a, b) => a + b, 0) / y.length;
        const ssr = y.reduce((a, v, i) => a + (v - p[i]) ** 2, 0);
        const sst = y.reduce((a, v) => a + (v - m) ** 2, 0);
        return sst === 0 ? 0 : 1 - ssr / sst;
    };
    const rmse = (y: number[], p: number[]) => Math.sqrt(y.reduce((a, v, i) => a + (v - p[i]) ** 2, 0) / y.length);

    const relStats = (fit: RelFit) => {
        const y: number[] = [], p: number[] = [], resid: number[] = [];
        fit.actual.forEach((a, i) => {
            const b = fit.predicted[i];
            if (Number.isFinite(a) && Number.isFinite(b)) { y.push(a); p.push(roundMetric(b)); resid.push(a - b); }
        });
        if (!y.length) throw 'NO_DATA: The fitted model has no predictions';
        const rr = r2(y, p);
        const e = rmse(y, p);
        const { mean, sd } = meanSd(resid);
        return {
            kind: 'relationship' as const,
            rows: y.length,
            target: fit.target,
            predictors: [...fit.predictors],
            r2: Math.round(rr * 100) / 100,
            rmse: roundMetric(e),
            two_rmse: roundMetric(2 * e),
            residual_mean: mean,
            residual_sd: sd,
            residual_min: Math.min(...resid),
            residual_max: Math.max(...resid),
            r2_per_step: [...fit.r2_per_step],
            rmse2_per_step: [...fit.rmse2_per_step],
        };
    };

    const relationshipPreview = (fit: RelFit, req: any) => {
        if (req.target && req.target !== fit.target) throw `NOT_FITTED: the cached fit is for target '${fit.target}', not '${req.target}' — train it first`;
        const preds: string[] = req.predictors ?? [];
        if (preds.length && JSON.stringify(preds) !== JSON.stringify(fit.predictors)) throw 'NOT_FITTED: the cached fit used different predictors — train it first';
        let xIdx = 0;
        if (req.x_predictor) {
            xIdx = fit.predictors.indexOf(req.x_predictor);
            if (xIdx < 0) throw `BAD_REQUEST: x_predictor '${req.x_predictor}' is not a predictor of this model`;
        }
        const stats = relStats(fit);
        if (fit.rows.some(r => r >= nRows())) throw 'NOT_FITTED: the cached fit does not belong to the loaded dataset';
        const residual = fit.actual.map((a, i) => a - fit.predicted[i]);
        const sp = parseSetPoints(req.set_points);
        const validation = validateRelationship(stats.two_rmse, sp);
        const valid = validation.length === 0;
        const scores = valid ? residual.map(r => scoreRelationship(stats.two_rmse, sp as any, r)) : null;
        const sel = selectIdx(fit.rows.length, req.max_points ?? 4000);
        const scIdx = selectIdx(fit.rows.length, req.max_scatter_points ?? 8000);
        return {
            kind: 'relationship',
            stats,
            validation,
            valid,
            series: {
                kind: 'relationship',
                rows: sel.map(i => fit.rows[i]),
                timestamps: sel.map(i => data.timestamps[fit.rows[i]] ?? ''),
                actual: sel.map(i => fit.actual[i]),
                predicted: sel.map(i => fit.predicted[i]),
                residual: sel.map(i => residual[i]),
                score: scores ? sel.map(i => scores[i]) : null,
                total_points: fit.rows.length,
            },
            score_summary: scores ? summarize(scores, fit.rows.length, i => ({ row: fit.rows[i], timestamp: data.timestamps[fit.rows[i]] ?? null })) : null,
            histogram: null,
            fit_scatter: {
                x_sensor: fit.predictors[xIdx],
                predictors: [...fit.predictors],
                x: scIdx.map(i => fit.x_cols[xIdx][i]),
                actual: scIdx.map(i => fit.actual[i]),
                predicted: scIdx.map(i => fit.predicted[i]),
                total: fit.rows.length,
            },
            cluster_scatter: null,
        };
    };

    const individualPreview = (req: any) => {
        if (!req.target) throw 'BAD_REQUEST: target is required';
        const { c, rows } = inScopeIndividual(req.target, req.filter);
        if (!rows.length) throw `NO_DATA: No valid numeric values for sensor '${req.target}' in the training scope`;
        const vals = rows.map(r => c[r]);
        const { mean, sd } = meanSd(vals);
        const band = individualBandOf(mean, sd);
        const sp = parseSetPoints(req.set_points);
        const validation = validateIndividual(band, sp);
        const valid = validation.length === 0;
        const scores = valid ? vals.map(v => scoreIndividual(band, sp.lower!, sp.upper!, v)) : null;
        const sel = selectIdx(rows.length, req.max_points ?? 4000);
        // histogram (health_score::histogram)
        const mn = Math.min(...vals), mx = Math.max(...vals);
        let edges: number[], counts: number[], width: number;
        if (mx > mn) {
            const bins = Math.min(80, Math.max(10, Math.ceil(Math.sqrt(vals.length))));
            width = (mx - mn) / bins;
            edges = Array.from({ length: bins + 1 }, (_, i) => mn + width * i);
            counts = new Array(bins).fill(0);
            for (const v of vals) counts[Math.min(bins - 1, Math.floor((v - mn) / width))]++;
        } else {
            edges = [mn - 0.5, mn + 0.5]; counts = [vals.length]; width = 1;
        }
        const curve = counts.map((_, i) => {
            if (!(band.sd > 0)) return 0;
            const cx = (edges[i] + edges[i + 1]) / 2;
            const z = (cx - band.mean) / band.sd;
            return vals.length * width * Math.exp(-0.5 * z * z) / (band.sd * Math.sqrt(2 * Math.PI));
        });
        return {
            kind: 'individual',
            stats: { kind: 'individual', rows: vals.length, mean: band.mean, sd: band.sd, boundary_1sd: [band.l1, band.u1], boundary_3sd: [band.l3, band.u3], min: mn, max: mx },
            validation,
            valid,
            series: {
                kind: 'individual',
                rows: sel.map(i => rows[i]),
                timestamps: sel.map(i => data.timestamps[rows[i]] ?? ''),
                value: sel.map(i => vals[i]),
                in_scope: sel.map(() => true),
                score: scores ? sel.map(i => scores[i]) : null,
                total_points: rows.length,
            },
            score_summary: scores ? summarize(scores, nRows(), i => ({ row: rows[i], timestamp: data.timestamps[rows[i]] ?? null })) : null,
            histogram: { bin_edges: edges, counts, curve, bin_width: width, n: vals.length },
            fit_scatter: null,
            cluster_scatter: null,
        };
    };

    const clusteringGeoms = (req: any) => {
        if (!req.first_sensor) throw 'BAD_REQUEST: first_sensor is required';
        if (!req.second_sensor) throw 'BAD_REQUEST: second_sensor is required';
        const n = req.n_clusters ?? 1;
        if (n === 0) throw 'BAD_REQUEST: n_clusters must be at least 1';
        let preview: any;
        try {
            preview = clusteringPreviewIn({ ...req, n_clusters: n });
        } catch (e) {
            const s = String(e);
            throw /no rows/i.test(s) ? `NO_DATA: ${s}` : s;
        }
        return { preview, geoms: preview.clusters.map((c: any) => roundedGeom(c.cluster_id, c.ellipse)) as ClusterGeom[] };
    };

    const clusteringPreview = (req: any) => {
        const n = req.n_clusters ?? 1;
        const { preview, geoms } = clusteringGeoms(req);
        const c1 = col(req.first_sensor);
        const c2 = col(req.second_sensor);
        if (!c1 || !c2) throw `BAD_REQUEST: Sensor not found: ${!c1 ? req.first_sensor : req.second_sensor}`;
        const f = resolveFilter(req.filter);
        const ranges: [number | null, number | null][] = n > 1 ? (req.cluster_ranges ?? []).map((r: any) => [r.min, r.max]) : [];
        const cc = n > 1 && preview.criteria_sensor ? col(preview.criteria_sensor) : null;
        const rows: number[] = [];
        for (let r = 0; r < nRows(); r++) if (Number.isFinite(c1[r]) && Number.isFinite(c2[r]) && (f.noop || f.keeps(r))) rows.push(r);
        if (!rows.length) throw 'NO_DATA: No rows remain after dropping nulls.';
        const assign = rows.map(r => {
            if (!cc) return 0;
            const v = cc[r];
            if (!Number.isFinite(v)) return null;
            const k = ranges.findIndex(([lo, hi]) => (lo === null || v >= lo) && (hi === null || v < hi));
            return k < 0 ? null : k;
        });
        const sp = parseSetPoints(req.set_points);
        const validation = validateClustering(geoms, sp);
        const valid = validation.length === 0;
        const scored = valid ? rows.map((r, i) => {
            const k = assign[i];
            if (k === null) return { s: null as number | null, d: null as number | null };
            const d = sdDistance(geoms[k], c1[r], c2[r]);
            return { s: scoreClusterDistance(d, sp.outer_sd!), d };
        }) : null;
        const sel = selectIdx(rows.length, req.max_points ?? 4000);
        const sc = selectIdx(rows.length, req.max_scatter_points ?? 8000);
        const scores = scored ? scored.map(x => x.s) : null;
        return {
            kind: 'clustering',
            stats: {
                kind: 'clustering',
                rows: rows.length,
                assigned_rows: assign.filter(a => a !== null).length,
                unassigned_rows: assign.filter(a => a === null).length,
                cluster_count: n,
                criteria_sensor: preview.criteria_sensor,
                clusters: preview.clusters.map((c: any, i: number) => ({ ...geoms[i], cluster_id: c.cluster_id, range: c.range, n_rows: c.n_rows })),
            },
            validation,
            valid,
            series: {
                kind: 'clustering',
                rows: sel.map(i => rows[i]),
                timestamps: sel.map(i => data.timestamps[rows[i]] ?? ''),
                x: sel.map(i => c1[rows[i]]),
                y: sel.map(i => c2[rows[i]]),
                cluster: sel.map(i => (assign[i] === null ? null : (assign[i] as number) + 1)),
                sd_distance: sel.map(i => (scored ? scored[i].d : null)),
                score: scores ? sel.map(i => scores[i]) : null,
                total_points: rows.length,
            },
            score_summary: scores ? summarize(scores, nRows(), i => ({ row: rows[i], timestamp: data.timestamps[rows[i]] ?? null })) : null,
            histogram: null,
            fit_scatter: null,
            cluster_scatter: { x: sc.map(i => c1[rows[i]]), y: sc.map(i => c2[rows[i]]), cluster: sc.map(i => (assign[i] === null ? null : (assign[i] as number) + 1)), total: rows.length },
        };
    };

    const checkGeneration = (expected: unknown) => {
        if (expected === undefined || expected === null) return;
        if (expected !== generation) throw STALE_SESSION_ERROR;
    };

    const outputDirAbs = (ws: string) => `${APP_DATA}/workspaces/${ws}/output`;
    const sanitizeWs = (ws: string) => {
        if (!ws || ws === '.' || ws === '..' || /[\\/:*?"<>|\0]/.test(ws) || /^\s|\s$|\.$/.test(ws)) throw `BAD_REQUEST: invalid workspace id '${ws}'`;
        return ws;
    };

    /** The files a successful export writes (relative paths inside `output/`). */
    const writeFiles = (ws: string, entries: { kind: 'info' | 'model' | 'dataset'; rel: string; content: unknown }[]) => {
        const out = entries.map(e => {
            files.set(`workspaces/${ws}/output/${e.rel}`, typeof e.content === 'string' ? e.content : JSON.stringify(e.content));
            return { kind: e.kind, file_name: e.rel.split('/').pop()!, path: `${outputDirAbs(ws)}/${e.rel}` };
        });
        exports.push({ workspaceId: ws, files: out.map(f => f.path), generation });
        return out;
    };
    const exports: { workspaceId: string; files: string[]; generation: number }[] = [];

    const okResult = (ws: string, written: any[]) => ({ ok: true, files: written, output_dir: outputDirAbs(ws), validation: [], warnings: [] });
    const refused = (ws: string, validation: Issue[]) => ({ ok: false, files: [], output_dir: outputDirAbs(ws), validation, warnings: [] });

    /** Sync part of export (`export_sync`). */
    const exportSync = (req: any) => {
        const ws = sanitizeWs(req.workspace_id);
        const sp = parseSetPoints(req.set_points);
        if (req.kind === 'individual') {
            if (!req.target) throw 'BAD_REQUEST: target is required';
            const { c, rows } = inScopeIndividual(req.target, req.filter);
            if (!rows.length) throw `No valid numeric values for sensor '${req.target}'`;
            const { mean, sd } = meanSd(rows.map(r => c[r]));
            const band = individualBandOf(mean, sd);
            const v = validateIndividual(band, sp);
            if (v.length) return refused(ws, v);
            return okResult(ws, writeFiles(ws, [{
                kind: 'info',
                rel: `${req.target}/INDV_INFO_${req.target}.json`,
                content: { model_metrics: { mean: band.mean, sd: band.sd, '1sd_boundary': [band.l1, band.u1], '3sd_boundary': [band.l3, band.u3], setpoint_health_score: [sp.lower, sp.upper] }, model_name: req.model_name ?? null },
            }]));
        }
        if (req.kind === 'clustering') {
            if (!req.first_sensor) throw 'BAD_REQUEST: first_sensor is required';
            if (!req.second_sensor) throw 'BAD_REQUEST: second_sensor is required';
            const { geoms, preview } = clusteringGeoms(req);
            const v = validateClustering(geoms, sp);
            if (v.length) return refused(ws, v);
            const info: Record<string, unknown> = {};
            preview.clusters.forEach((c: any, i: number) => {
                info[String(c.cluster_id)] = {
                    ...geoms[i],
                    boundary_sd_health_score: sp.outer_sd,
                    ...(c.range ? {
                        criteria_sensor_value_higher_than: c.range.min, criteria_sensor_value_lower_than: c.range.max,
                        critera_sensor_value_higher_than: c.range.min, critera_sensor_value_lower_than: c.range.max,
                    } : {}),
                };
            });
            return okResult(ws, writeFiles(ws, [{ kind: 'info', rel: `${req.second_sensor}/CLUS_INFO_${req.first_sensor}_${req.second_sensor}.json`, content: { cluster_info: info } }]));
        }
        throw `BAD_REQUEST: unknown kind '${req.kind}'`;
    };

    const fitRelationship = (predictors: string[], target: string, lambda: number, filter: any) => {
        if (!predictors?.length) throw 'At least one predictor is required.';
        if (!target) throw 'Target sensor is required.';
        const pcs = predictors.map(p => { const c = col(p); if (!c) throw `Predictor not found: ${p}`; return c; });
        const tc = col(target); if (!tc) throw `Target not found: ${target}`;
        const f = resolveFilter(filter);
        const X: number[][] = [], y: number[] = [], rows: number[] = [];
        for (let r = 0; r < nRows(); r++) {
            if (!f.noop && !f.keeps(r)) continue;
            const xr = pcs.map(c => c[r]);
            if (xr.some(v => !Number.isFinite(v)) || !Number.isFinite(tc[r])) continue;
            X.push(xr); y.push(tc[r]); rows.push(r);
        }
        if (!X.length) throw 'No rows remain after dropping nulls.';
        const r2s: number[] = [], rm2: number[] = [];
        let last: number[] = [];
        for (let k = 1; k <= predictors.length; k++) {
            const p = ols(X.map(r => r.slice(0, k)), y);
            r2s.push(Math.round(r2(y, p) * 100) / 100);
            rm2.push(Math.round(2 * rmse(y, p) * 1e4) / 1e4);
            last = p;
        }
        return { X, y, rows, predicted: last, r2_per_step: r2s, rmse2_per_step: rm2, lambda };
    };

    const run = async (cmd: string, a: Args, entry: { held?: boolean }): Promise<unknown> => {
        switch (cmd) {
            case 'get_session_generation': return generation;
            case 'get_dataset_time_bounds': return { min: data.timestamps[0] ?? null, max: data.timestamps[nRows() - 1] ?? null };
            case 'compute_sensor_stats': {
                const c = col(a.sensor);
                if (!c) throw `Sensor not found: ${a.sensor}`;
                const f = resolveFilter(a.filter);
                const vals: number[] = [];
                for (let r = 0; r < nRows(); r++) if (Number.isFinite(c[r]) && (f.noop || f.keeps(r))) vals.push(c[r]);
                if (!vals.length) throw `No valid numeric values for sensor '${a.sensor}'`;
                const { mean, sd } = meanSd(vals);
                return { mean, sd, min: Math.min(...vals), max: Math.max(...vals), count: vals.length, lower1: mean - sd, upper1: mean + sd, lower3: mean - 3 * sd, upper3: mean + 3 * sd };
            }
            case 'compute_clustering_preview': {
                const p = clusteringPreviewIn(a);
                return { ...p, clusters: p.clusters.map((c: any) => ({ ...c })) };
            }
            case 'preview_relationship_model': {
                const startedIn = generation;
                const fit = fitRelationship(a.predictors, a.target, a.lambda, a.filter);
                const resp: Record<string, unknown> = {
                    request: 'PreviewModel/relationship',
                    r2_per_step: fit.r2_per_step,
                    rmse2_per_step: fit.rmse2_per_step,
                    predicted: fit.predicted,
                    residual: fit.y.map((v, i) => v - fit.predicted[i]),
                    predictor_raw: fit.X,
                    target_raw: fit.y,
                };
                await sidecar(cmd, a);
                const key = typeof a.cache_key === 'string' && a.cache_key ? a.cache_key : null;
                if (key) {
                    const rf: RelFit = {
                        target: a.target, predictors: [...a.predictors], lambda: a.lambda, rows: fit.rows,
                        actual: fit.y, predicted: fit.predicted, x_cols: a.predictors.map((_: string, k: number) => fit.X.map(r => r[k])),
                        r2_per_step: fit.r2_per_step, rmse2_per_step: fit.rmse2_per_step, generation: startedIn,
                    };
                    // `store_rel_fit`: refused when the session was replaced meanwhile.
                    const cached = generation === startedIn;
                    if (cached) {
                        relCache.set(key, rf);
                        while (relCache.size > 8) relCache.delete(relCache.keys().next().value as string);
                    }
                    resp.cache_key = key;
                    resp.cached = cached;
                    if (cached) resp.health_preview = relationshipPreview(rf, { kind: 'relationship', target: a.target, predictors: a.predictors, max_points: a.max_points });
                }
                return resp;
            }
            case 'compute_health_preview': {
                const req = a.request;
                if (!req || typeof req !== 'object') throw 'invalid args `request` for command `compute_health_preview`';
                if (req.n_clusters !== undefined && req.n_clusters !== null && (!Number.isInteger(req.n_clusters) || req.n_clusters < 0)) throw `invalid args \`request\` for command \`compute_health_preview\`: invalid type for n_clusters: ${req.n_clusters}`;
                checkGeneration(req.expected_generation);
                if (req.kind === 'individual') return individualPreview(req);
                if (req.kind === 'clustering') return clusteringPreview(req);
                if (req.kind === 'relationship') {
                    if (!req.cache_key) throw 'NOT_FITTED: no cache_key was given';
                    const fit = relCache.get(req.cache_key);
                    if (!fit) throw 'NOT_FITTED: this Relationship model has no fit in memory (not trained yet, or the data changed) - train it first';
                    return relationshipPreview(fit, req);
                }
                throw `BAD_REQUEST: unknown kind '${req.kind}'`;
            }
            case 'get_model_output_dir': {
                const ws = sanitizeWs(a.workspace_id);
                return outputDirAbs(ws);
            }
            case 'export_model_files': {
                const req = a.request;
                checkGeneration(req.expected_generation);
                if (req.kind !== 'relationship') return exportSync(req);
                const ws = sanitizeWs(req.workspace_id);
                const cachedFit = req.cache_key ? relCache.get(req.cache_key) : undefined;
                const cachedW = cachedFit ? relStats(cachedFit).two_rmse : null;
                if (!req.target) throw 'BAD_REQUEST: target is required';
                if (!req.predictors?.length) throw 'BAD_REQUEST: at least one predictor is required';
                if (req.lambda === undefined || req.lambda === null) throw 'BAD_REQUEST: lambda is required';
                const sp = parseSetPoints(req.set_points);
                const pre = validateRelationship(cachedW, sp);
                if (pre.length) return refused(ws, pre);
                // The ~15 s sidecar re-fit (gate-able in tests).
                const fit = fitRelationship(req.predictors, req.target, req.lambda, req.filter);
                await sidecar(cmd, a);
                const e = rmse(fit.y, fit.predicted.map(roundMetric));
                const w = roundMetric(2 * e);
                const post = validateRelationship(w, sp);
                if (post.length) return refused(ws, post);
                const tok = req.predictors.join('_');
                return okResult(ws, writeFiles(ws, [
                    { kind: 'info', rel: `${req.target}/REL_INFO_${tok}_${req.target}.json`, content: { '2rmse': w, setpoint_health_score: { residual_at_health_80_lower: sp.residual_at_80_lower, residual_at_health_80_upper: sp.residual_at_80_upper, residual_at_health_0_lower: sp.residual_at_0_lower, residual_at_health_0_upper: sp.residual_at_0_upper } } },
                    { kind: 'dataset', rel: `${req.target}/REL_DATASET_${tok}_${req.target}.csv`, content: 'x,y' },
                    { kind: 'model', rel: `${req.target}/REL_MODEL_${tok}_${req.target}.pkl`, content: 'pkl' },
                ]));
            }
            default:
                void entry;
                return null;
        }
    };

    /** A sidecar run point: a gate on `sidecar:<cmd>` holds it here. */
    const sidecar = async (cmd: string, a: Args) => {
        const g = gates.find(x => x.armed && x.cmd === `sidecar:${cmd}` && x.pred(a));
        if (g) { g.armed = false; g.entered = true; await g.promise; }
    };

    const checkArgs = (cmd: string, args: Args) => {
        const sig = SIGNATURES[cmd];
        if (!sig) return;
        const allowed = new Set([...sig.required, ...(sig.optional ?? [])]);
        for (const k of Object.keys(args ?? {})) {
            if (!allowed.has(k)) throw `invalid args for command ${cmd}: unexpected key '${k}' (arg-key casing?)`;
        }
        for (const k of sig.required) {
            if (!(k in (args ?? {})) || args[k] === undefined) throw `invalid args for command ${cmd}: missing required key ${k}`;
        }
    };

    const invoke = async (cmd: string, args: Args = {}): Promise<unknown> => {
        const entry: { cmd: string; args: Args; result?: unknown; error?: string; at: number; held?: boolean } = { cmd, args: structuredClone(args ?? {}), at: ++clock };
        calls.push(entry);
        try {
            checkArgs(cmd, args);
            const gate = gates.find(g => g.armed && g.cmd === cmd && g.pred(args));
            if (gate) { gate.armed = false; gate.entered = true; entry.held = true; await gate.promise; }
            const fault = faults.find(f => f.cmd === cmd && f.pred(args));
            if (fault) {
                if (fault.once) faults.splice(faults.indexOf(fault), 1);
                throw fault.error;
            }
            const ov = overrides.find(o => o.cmd === cmd && o.pred(args));
            if (ov && ov.once) overrides.splice(overrides.indexOf(ov), 1);
            const result = ov ? await ov.fn(args, () => run(cmd, args, entry)) : await run(cmd, args, entry);
            entry.result = result;
            return structuredClone(result);
        } catch (e) {
            entry.error = String(e);
            throw e;
        }
    };

    return {
        invoke,
        calls,
        exports,
        files,
        cmds: (cmd: string) => calls.filter(c => c.cmd === cmd),
        lastOk: (cmd: string) => [...calls].reverse().find(c => c.cmd === cmd && c.result !== undefined)?.result as any,
        generation: () => generation,
        datasetName: () => datasetName,
        relCacheKeys: () => [...relCache.keys()],
        /** `load_csv`: a new session (generation + 1, fit cache cleared). */
        loadDataset: (name: string) => {
            datasetName = name;
            data = opts.datasets[name];
            generation++;
            relCache = new Map();
        },
        /** Drop every cached fit (e.g. special sensor replaced) without a reload. */
        clearRelCache: () => { relCache = new Map(); },
        outputDir: outputDirAbs,
        /** Statistics the Individual preview would show for `target` under `filter`. */
        individualBand: (target: string, filter: any = null): IndividualBand => {
            const { c, rows } = inScopeIndividual(target, filter);
            const { mean, sd } = meanSd(rows.map(r => c[r]));
            return individualBandOf(mean, sd);
        },
        failOn: (cmd: string, pred: Pred, error = 'injected failure', once = true) => { faults.push({ cmd, pred, error, once }); },
        clearFaults: () => { faults.length = 0; },
        /** Answer the next matching call (or every one) with `fn(args, real)`; `real()` runs the real fake. */
        override: (cmd: string, pred: Pred, fn: (args: Args, real: () => Promise<unknown>) => unknown, once = true) => { overrides.push({ cmd, pred, fn, once }); },
        /** Hold the next matching call (or `sidecar:<cmd>` = its sidecar run) until `release()`. */
        gate: (cmd: string, pred: Pred = () => true) => {
            let release!: () => void;
            const promise = new Promise<void>(r => { release = r; });
            const g: Gate = { cmd, pred, release, promise, armed: true, entered: false };
            gates.push(g);
            return g;
        },
    };
}

export type FakeHealthRust = ReturnType<typeof createFakeHealthRust>;

// ---------------------------------------------------------------------------
// Datasets used by the integration tests
// ---------------------------------------------------------------------------

/** `n` hourly timestamps from 2026-01-01 00:00:00. */
export function hourly(n: number, startDay = 1): string[] {
    return Array.from({ length: n }, (_, i) => {
        const d = new Date(Date.UTC(2026, 0, startDay, 0, 0, 0) + i * 3600_000);
        const p = (x: number) => String(x).padStart(2, '0');
        return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:00:00`;
    });
}

/**
 * The default plant: 60 hourly rows.
 *  - TAG1 "Pump Pressure" (bar): ~50 with a deterministic wobble — the Individual / Relationship target.
 *  - TAG2 "Pump Speed": 0..59 ramp — the running condition sensor (TAG2 > 10 keeps 49 rows).
 *  - TAG3 "Flow": a predictor, TAG1 ≈ 30 + 0.4·TAG3 + noise.
 *  - TAG4 "Mode": the clustering criteria (0..99 in steps), TAG5 "Temp" the clustering Y.
 */
export function plantDataset(n = 60): HealthDataset {
    const noise = (i: number) => (((i * 37) % 11) - 5) / 5; // -1..1
    const tag3 = Array.from({ length: n }, (_, i) => 40 + ((i * 7) % 23));
    const tag1 = tag3.map((x, i) => 30 + 0.4 * x + noise(i) * 1.5);
    const tag4 = Array.from({ length: n }, (_, i) => (i * 13) % 100);
    const tag5 = tag4.map((m, i) => (m < 50 ? 20 : 40) + noise(i + 3) * 2 + ((i * 5) % 7) / 3);
    const tag2 = Array.from({ length: n }, (_, i) => i);
    return {
        headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3', 'TAG4', 'TAG5'],
        timestamps: hourly(n),
        columns: { TAG1: tag1, TAG2: tag2, TAG3: tag3, TAG4: tag4, TAG5: tag5 },
    };
}

export const PLANT_META = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmL: 20, alarmH: 80 },
    { tag: 'TAG2', description: 'Pump Speed', unit: 'rpm', component: 'Pump' },
    { tag: 'TAG3', description: 'Flow', unit: 'm3/h', component: 'Pump', alarmH: 90 },
    { tag: 'TAG4', description: 'Mode', unit: '', component: 'Pump' },
    { tag: 'TAG5', description: 'Temp', unit: 'C', component: 'Motor' },
];
