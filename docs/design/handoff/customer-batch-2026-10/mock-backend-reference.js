// Mock of the Wizard Rust backend + Tauri runtime, for a browser-only mockup of the CURRENT app.
// Every window (main page + sub-window iframes) loads its own copy; the dataset is generated
// deterministically, so all windows hold the same data. Special sensors are recomputed from recipes.

// ---------------- dataset ----------------
let seed = 7;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const STEP_MIN = 10;
const T0 = Date.UTC(2026, 1, 9);
const DAYS = 180;
const N = DAYS * 24 * 60 / STEP_MIN;
const PER_H = 60 / STEP_MIN;
const NH = DAYS * 24;
const runH = Array.from({ length: NH }, (_, i) => { const d = Math.floor(i / 24); return !(d % 23 < 2) && !(d > 95 && d < 101); });
const loadH = Array.from({ length: NH }, (_, i) => runH[i] ? .62 + .25 * Math.sin(i / 24 * Math.PI * 2 / 7) + .06 * Math.sin(i / 6) : 0);
const LAG = (i, h) => loadH[Math.max(0, i - h)];
const SM = (i, h) => { let s = 0, n = 0; for (let k = 0; k < h; k += 3) { s += loadH[Math.max(0, i - k)]; n++; } return s / n; };
const COMP = ['BOILER', 'COOLING AND DRAIN WATER SYSTEM', 'FUEL GAS SYSTEM', 'GAS ENGINE', 'GENERATOR', 'INTAKE AIR AND EXHAUST GAS SYSTEM', 'LUBE OIL SYSTEM'];
const S0 = [
  ['11LT1601.PV', 'BOILER DRUM LEVEL', 'mm', 0, { LL: -10, L: 10, H: 95, HH: 110 }, (l, i) => l ? 58 + 11 * Math.sin(i / 7.3) + 6 * Math.sin(i / 1.9) + (rnd() - .5) * 5 : 22],
  ['11MOV1603.PV', 'DAMPER FOR BOILER BYPASS', '%', 0, null, (l, i) => { const x = LAG(i, 30); return x ? Math.max(0, Math.min(100, 95 - 120 * (x - .35) + (rnd() < .004 ? -25 : 0))) : 100; }],
  ['11FQ1603.PV', 'BOILER FEED WATER FLOW METER', 'TON/HR', 0, { LL: 1, L: 2, H: 3.4, HH: 3.8 }, (l, i) => l ? 2.2 + 1.6 * (l - .6) + .35 * Math.sin(i / 3.1) + (rnd() - .5) * .35 : 0],
  ['11PT1604.PV', 'STEAM PRESSURE HRSG4', 'BAR', 0, { L: 8, H: 21, HH: 24 }, (l, i) => { const x = SM(i, 48); return x ? 13 + 9 * x + i / NH * 1.5 : 1.2; }],
  ['11TE1520.PV', 'COOLING WATER OUTLET TEMP', 'DEGC', 1, { L: 25, H: 48, HH: 55 }, (l, i) => 30 + 4 * Math.sin((i / 24 - 35) / 180 * Math.PI * 2) + (l ? 8 * SM(i, 12) : 0) + (rnd() - .5) * .6],
  ['11PT1522.PV', 'COOLING WATER PRESSURE', 'BAR', 1, { LL: 1.8, L: 2.2, H: 4.6 }, (l, i) => (l ? 3.4 : 2.7) - i / NH * .5 + (rnd() - .5) * .08 + (Math.floor(i / 24) % 30 === 12 ? -.6 : 0)],
  ['11FG1801.PV', 'FUEL GAS FLOW', 'NM3/H', 2, null, (l) => l ? 2400 + 9800 * l + (rnd() - .5) * 500 : 0],
  ['11PT1802.PV', 'FUEL GAS PRESSURE', 'BAR', 2, { LL: 3.5, L: 4, H: 7.5, HH: 8 }, (l, i) => 5.9 - .9 * (l || 0) + .25 * Math.sin(i / 40) + (rnd() - .5) * .06],
  ['11ST1302.PV', 'ENGINE SPEED', 'RPM', 3, { LL: 900, L: 950, H: 1050, HH: 1100 }, (l) => l ? 1000 + (rnd() - .5) * 6 + (rnd() < .002 ? 40 : 0) : 0],
  ['11TE1310.PV', 'CYLINDER A1 EXHAUST TEMP', 'DEGC', 3, { L: 300, H: 520, HH: 560 }, (l, i) => { const x = LAG(i, 4); return x ? 330 + 190 * x + (rnd() - .5) * 14 : 45; }],
  ['11EI1301.PV', 'GENERATOR ACTIVE POWER', 'KW', 4, null, (l) => l ? 8400 * l + (rnd() - .5) * 180 : 0],
  // Bearing deterioration from mid-July (day 158) up to the 1 Aug event — drives the Known problem test demo.
  ['11TE1405.PV', 'BEARING DE TEMPERATURE', 'DEGC', 4, { L: 40, H: 85, HH: 95 }, (l, i) => { const x = SM(i, 9); const d = i / 24, w = d > 158 ? .05 * (d - 158) ** 2 : 0; return x ? 58 + 18 * x + w : 31 + .3 * w; }],
  ['11VT1410.PV', 'BEARING VIBRATION X', 'MM/S', 4, { L: 0.2, H: 4.5 }, (l, i) => l ? 2.1 + .3 * l + .25 * Math.sin(i / 11) + i / NH * .4 : .3],
  ['11TE1602.PV', 'EXHAUST TEMP OUTLET HRSG4', 'DEGC', 5, { L: 60, H: 210, HH: 230 }, (l, i) => { const x = SM(i, 24); return x ? 92 + 70 * x + i / NH * 22 + (rnd() - .5) * 3 : 38; }],
  ['11PT1901.PV', 'LUBE OIL PRESSURE', 'BAR', 6, { LL: 3, L: 3.4, H: 5.2 }, (l, i) => l ? 4.55 - .35 * l - i / NH * .3 + (rnd() - .5) * .04 : .2],
  // MOCKUP merge (2026-10-08): a tag with Thai text and spaces (formulas must write it as ${…}). Appended LAST so
  // every column above keeps exactly the same generated values.
  ['อุณหภูมิ ถังน้ำมัน 2', 'LUBE OIL TANK TEMPERATURE', 'DEGC', 6, { L: 30, H: 70, HH: 78 }, (l, i) => { const x = SM(i, 36); return x ? 44 + 14 * x + (rnd() - .5) * .8 : 33; }],
];
const TS = new Float64Array(N);
for (let k = 0; k < N; k++) TS[k] = T0 + k * STEP_MIN * 60000;
const COL = {};
const BASE_TAGS = [];
for (const [tag, , , , , f] of S0) {
  const h = new Float64Array(NH);
  let drift = 0;
  for (let i = 0; i < NH; i++) { drift += (rnd() - .5) * .02; const b = f(loadH[i], i); h[i] = b + (Math.abs(b) + 1) * .002 * drift; }
  const v = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const i = Math.floor(k / PER_H), j = Math.min(NH - 1, i + 1), t = (k % PER_H) / PER_H;
    v[k] = h[i] * (1 - t) + h[j] * t + (Math.abs(h[i]) + 1) * .006 * (rnd() - .5);
    if (rnd() < .0015) v[k] = NaN;
  }
  COL[tag] = v; BASE_TAGS.push(tag);
}
const pad = n => String(n).padStart(2, '0');
const fmtTs = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`; };
const parseTs = s => { if (s == null || s === '') return null; let t = String(s).trim().replace(' ', 'T'); if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00'; if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += 'Z'; const v = Date.parse(t); return isNaN(v) ? null : v; };
const FILES = [
  { name: 'raw_data_2026_Q1.csv', a: 0, b: Math.floor(N * 0.45) },
  { name: 'raw_data_2026_Q2.csv', a: Math.floor(N * 0.45), b: N - 1 },
];

// ---------------- session state (per window; rebuilt from recipes) ----------------
let loaded = false;
let generation = 0;
const derived = new Set();
const fitCache = new Map();
const allTags = () => [...BASE_TAGS, ...[...derived]];
function ensureLoaded() { if (!loaded) { loaded = true; generation = 1; } }
const SS_KEY = 'wizmock.session';
function sessionSave() { try { sessionStorage.setItem(SS_KEY, JSON.stringify({ loaded, generation })); } catch { } }
try { const s = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); if (s) { loaded = s.loaded; generation = s.generation; } } catch { }
// Sub-windows (iframes) share the main window's session through localStorage-backed recipes.
const REC_KEY = 'wizmock.recipes';
function recipesLoad() { try { return JSON.parse(localStorage.getItem(REC_KEY) || '[]'); } catch { return []; } }
function recipesSave(list) { try { localStorage.setItem(REC_KEY, JSON.stringify(list)); } catch { } }
function replayRecipes() { for (const r of recipesLoad()) { if (COL[r.tag]) continue; try { r.kind === 'formula' ? computeFormula(r.formula, r.tag) : computeOperation(r.sensors, r.config, r.tag); } catch { } } }

// ---------------- filters ----------------
const OPS = { greater_than: (v, a) => v > a, less_than: (v, a) => v < a, equals: (v, a) => v === a, between: (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b), '>': (v, a) => v > a, '<': (v, a) => v < a, '=': (v, a) => v === a, '>=': (v, a) => v >= a, '<=': (v, a) => v <= a };
function rowMask(filter) {
  const m = new Uint8Array(N).fill(1);
  if (!filter) return m;
  const ranges = (filter.timestamp_ranges && filter.timestamp_ranges.length) ? filter.timestamp_ranges.map(r => [parseTs(r.start), parseTs(r.end)]) : ((filter.timestamp_start || filter.timestamp_end) ? [[parseTs(filter.timestamp_start), parseTs(filter.timestamp_end)]] : null);
  const vfs = (filter.value_filters || []).filter(f => f && f.sensor && COL[f.sensor] && f.value1 != null && f.value1 !== '' && OPS[f.operation]);
  const or = filter.combine === 'or';
  for (let k = 0; k < N; k++) {
    if (ranges && !ranges.some(([a, b]) => (a == null || TS[k] >= a) && (b == null || TS[k] <= b))) { m[k] = 0; continue; }
    if (vfs.length) {
      const pass = f => { const v = COL[f.sensor][k]; return !isNaN(v) && OPS[f.operation](v, +f.value1, f.value2 == null ? NaN : +f.value2); };
      if (or ? !vfs.some(pass) : !vfs.every(pass)) m[k] = 0;
    }
  }
  return m;
}
const idxOf = m => { const o = []; for (let k = 0; k < N; k++) if (m[k]) o.push(k); return o; };
function stride(idx, max) { if (idx.length <= max) return idx; const o = [], st = idx.length / max; for (let j = 0; j < max; j++) o.push(idx[Math.floor(j * st)]); return o; }

// ---------------- chart data ----------------
function getChartData({ filter, sampling, operation, max_points }) {
  ensureLoaded();
  const sensors = (filter && filter.sensors && filter.sensors.length ? filter.sensors : []).filter(t => COL[t]);
  const m = rowMask(filter);
  const max = Math.min(max_points || 4000, 100000);
  let tsArr = [], cols = sensors.map(() => []);
  if (!sampling || sampling === 'raw') {
    for (let k = 0; k < N; k++) if (m[k]) { tsArr.push(TS[k]); sensors.forEach((t, s) => cols[s].push(COL[t][k])); }
  } else {
    let cur = -1, bucket = [];
    const flush = () => { if (!bucket.length) return; tsArr.push(Math.floor(TS[bucket[0]] / 3600000) * 3600000); sensors.forEach((t, s) => { const vs = bucket.map(k => COL[t][k]).filter(v => !isNaN(v)); let v = NaN; if (vs.length) v = sampling === 'avg' ? vs.reduce((a, b) => a + b, 0) / vs.length : sampling === 'max' ? Math.max(...vs) : sampling === 'min' ? Math.min(...vs) : sampling === 'first' ? vs[0] : vs[vs.length - 1]; cols[s].push(v); }); bucket = []; };
    for (let k = 0; k < N; k++) { if (!m[k]) continue; const h = Math.floor(TS[k] / 3600000); if (h !== cur) { flush(); cur = h; } bucket.push(k); }
    flush();
  }
  let headers = sensors.slice();
  if (operation && operation.mode === 'multi' && sensors.length) {
    const ty = operation.multiOp?.type || 'sum';
    const out = tsArr.map((_, i) => { const vs = cols.map(c => c[i]).filter(v => !isNaN(v)); if (!vs.length) return NaN; if (ty === 'mean') return vs.reduce((a, b) => a + b, 0) / vs.length; if (ty === 'median') { vs.sort((a, b) => a - b); const h = vs.length >> 1; return vs.length % 2 ? vs[h] : (vs[h - 1] + vs[h]) / 2; } return vs.reduce((a, b) => a + b, 0); });
    cols = [out]; headers = [`Result (${ty})`];
  }
  const total = tsArr.length;
  let keep = null;
  if (total > max) {
    const buckets = Math.max(1, Math.floor(max / 2)), size = total / buckets, set = new Set(), ref = cols[0] || [];
    for (let b = 0; b < buckets; b++) { const a = Math.floor(b * size), e = Math.min(total, Math.floor((b + 1) * size)); let mi = a, ma = a; for (let i = a; i < e; i++) { if (ref[i] < ref[mi] || isNaN(ref[mi])) mi = i; if (ref[i] > ref[ma] || isNaN(ref[ma])) ma = i; } set.add(mi); set.add(ma); }
    keep = [...set].sort((a, b) => a - b);
  }
  const pick = arr => keep ? keep.map(i => arr[i]) : arr;
  return {
    headers,
    timestamps: pick(tsArr).map(fmtTs),
    series: cols.map(c => pick(c).map(v => (v == null || isNaN(v)) ? null : v)),
    total_rows: total,
    ts_min: total ? fmtTs(tsArr[0]) : null,
    ts_max: total ? fmtTs(tsArr[total - 1]) : null,
  };
}
function getScatterSample({ filter, max_points }) {
  ensureLoaded();
  const sensors = (filter && filter.sensors || []).filter(t => COL[t]);
  const idx = idxOf(rowMask(filter));
  const s = stride(idx, max_points || 20000);
  return { headers: sensors, rows: s.map(k => ({ timestamp: fmtTs(TS[k]), values: sensors.map(t => isNaN(COL[t][k]) ? null : COL[t][k]) })), total: idx.length, sampled: s.length };
}

// ---------------- statistics ----------------
function statsOf(vals) { const v = vals.filter(x => !isNaN(x)); const n = v.length; if (!n) return null; const mean = v.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)); let mn = Infinity, mx = -Infinity; for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; } return { n, mean, sd, min: mn, max: mx }; }
function computeSensorStats({ sensor, filter }) {
  ensureLoaded();
  if (!COL[sensor]) throw `Unknown sensor ${sensor}`;
  const idx = idxOf(rowMask(filter));
  const st = statsOf(idx.map(k => COL[sensor][k]));
  if (!st) throw 'No valid numeric values for this sensor in the selected scope';
  return { mean: st.mean, sd: st.sd, min: st.min, max: st.max, count: st.n, lower1: st.mean - st.sd, upper1: st.mean + st.sd, lower3: st.mean - 3 * st.sd, upper3: st.mean + 3 * st.sd };
}

// ---------------- relationship fit (least squares; stands in for the Relation model) ----------------
function solve(A, b) { const n = b.length; const M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;[M[c], M[p]] = [M[p], M[c]]; if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12; for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } } return M.map((r, i) => r[n] / r[i]); }
function fitLinear(X, y) { const p = X[0].length + 1; const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0); for (let i = 0; i < y.length; i++) { const r = [1, ...X[i]]; for (let a = 0; a < p; a++) { b[a] += r[a] * y[i]; for (let c = 0; c < p; c++) A[a][c] += r[a] * r[c]; } } for (let a = 1; a < p; a++) A[a][a] += 1e-9; const w = solve(A, b); return x => w[0] + x.reduce((s, v, i) => s + v * w[i + 1], 0); }
function relRows(target, predictors, filter) { const idx = idxOf(rowMask(filter)).filter(k => !isNaN(COL[target][k]) && predictors.every(p => !isNaN(COL[p][k]))); return idx; }
function scoreR2(idx, target, preds, f) { const y = idx.map(k => COL[target][k]); const my = y.reduce((a, b) => a + b, 0) / y.length; let ss = 0, sr = 0; idx.forEach((k, i) => { const p = f(preds.map(t => COL[t][k])); sr += (y[i] - p) ** 2; ss += (y[i] - my) ** 2; }); return { r2: ss ? 1 - sr / ss : 0, rmse: Math.sqrt(sr / y.length) }; }
function previewRelationship({ predictors, target, lambda, filter, cache_key, max_points }) {
  ensureLoaded();
  if (!COL[target] || !predictors.length || predictors.some(p => !COL[p])) return { request: 'preview_relationship', error: 'Pick a target and at least one predictor.', r2_per_step: [], rmse2_per_step: [], n_rows: 0, predicted: [] };
  const idx = relRows(target, predictors, filter);
  if (idx.length < 10) return { request: 'preview_relationship', error: 'Not enough rows in the training scope.', r2_per_step: [], rmse2_per_step: [], n_rows: idx.length, predicted: [] };
  const fitIdx = stride(idx, 6000);
  const r2s = [], rm2 = [];
  let f = null;
  for (let s = 1; s <= predictors.length; s++) { const ps = predictors.slice(0, s); const ff = fitLinear(fitIdx.map(k => ps.map(t => COL[t][k])), fitIdx.map(k => COL[target][k])); const sc = scoreR2(fitIdx, target, ps, ff); r2s.push(+sc.r2.toFixed(4)); rm2.push(+(2 * sc.rmse).toFixed(4)); if (s === predictors.length) f = ff; }
  const samp = stride(idx, max_points || 3000);
  const res = {
    request: 'preview_relationship', r2_per_step: r2s, rmse2_per_step: rm2, n_rows: idx.length,
    predicted: samp.map(k => f(predictors.map(t => COL[t][k]))),
    target_raw: samp.map(k => COL[target][k]),
    predictor_raw: samp.map(k => predictors.map(t => COL[t][k])),
  };
  if (cache_key) {
    fitCache.set(cache_key, { f, target, predictors, idx, two_rmse: rm2[rm2.length - 1], r2: r2s[r2s.length - 1] });
    res.cache_key = cache_key; res.cached = true;
    res.health_preview = healthPreview({ kind: 'relationship', target, predictors, cache_key, filter, set_points: null, max_points: max_points || 3000 });
  }
  return res;
}

// ---------------- clustering ----------------
function ellipse(xs, ys) { const n = xs.length; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxx = 0, syy = 0, sxy = 0; for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; } sxx /= Math.max(1, n - 1); syy /= Math.max(1, n - 1); sxy /= Math.max(1, n - 1); const tr = sxx + syy, det = sxx * syy - sxy * sxy, d = Math.sqrt(Math.max(0, tr * tr / 4 - det)); const l1 = tr / 2 + d, l2 = Math.max(1e-12, tr / 2 - d); const ang = Math.atan2(l1 - sxx, sxy || 1e-12) * 180 / Math.PI; return { x_center: mx, y_center: my, x_sd: Math.sqrt(l1), y_sd: Math.sqrt(l2), angle_deg: ang, cov: [sxx, sxy, syy] }; }
function clusterAssign(first, second, n, crit, ranges, filter) {
  const idx = idxOf(rowMask(filter)).filter(k => !isNaN(COL[first][k]) && !isNaN(COL[second][k]));
  const groups = [];
  if (!crit || n <= 1) groups.push({ id: 1, range: null, idx });
  else for (let c = 0; c < n; c++) { const r = (ranges || [])[c] || { min: null, max: null }; groups.push({ id: c + 1, range: r, idx: idx.filter(k => { const v = COL[crit][k]; return !isNaN(v) && (r.min == null || v >= r.min) && (r.max == null || v < r.max); }) }); }
  return { idx, groups };
}
function clusteringPreview({ first_sensor, second_sensor, n_clusters, criteria_sensor, cluster_ranges, filter }) {
  ensureLoaded();
  const { groups } = clusterAssign(first_sensor, second_sensor, n_clusters, criteria_sensor, cluster_ranges, filter);
  const clusters = groups.filter(g => g.idx.length > 2).map(g => { const xs = g.idx.map(k => COL[first_sensor][k]), ys = g.idx.map(k => COL[second_sensor][k]); const e = ellipse(xs, ys); const s = stride(g.idx.map((_, i) => i), 2500); return { cluster_id: g.id, range: g.range, n_rows: g.idx.length, ellipse: { x_center: e.x_center, y_center: e.y_center, x_sd: e.x_sd, y_sd: e.y_sd, angle_deg: e.angle_deg }, xs: s.map(i => xs[i]), ys: s.map(i => ys[i]) }; });
  if (!clusters.length) throw 'NO_DATA: No rows fall inside the cluster ranges for this training scope.';
  return { first_sensor, second_sensor, criteria_sensor: n_clusters > 1 ? criteria_sensor : null, cluster_count: n_clusters, n_rows: clusters.reduce((a, c) => a + c.n_rows, 0), clusters };
}

// ---------------- health preview ----------------
const fmtN = x => Math.abs(x) >= 100 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(4);
const issue = (code, field, message) => ({ code, severity: 'error', message, field });
const lin = (x, x0, y0, x1, y1) => y0 + (y1 - y0) * (x - x0) / (x1 - x0);
function histogram(vals, bins = 40) { const v = vals.filter(x => !isNaN(x) && x != null); if (!v.length) return null; let mn = Infinity, mx = -Infinity; for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; } if (mx === mn) mx = mn + 1; const w = (mx - mn) / bins, counts = new Array(bins).fill(0); for (const x of v) counts[Math.min(bins - 1, Math.floor((x - mn) / w))]++; const st = statsOf(v); const edges = Array.from({ length: bins + 1 }, (_, i) => mn + i * w); const curve = counts.map((_, i) => { const c = mn + (i + .5) * w; return v.length * w * Math.exp(-((c - st.mean) ** 2) / (2 * st.sd * st.sd || 1)) / ((st.sd || 1) * Math.sqrt(2 * Math.PI)); }); return { bin_edges: edges, counts, curve, bin_width: w, n: v.length }; }
function summary(rowsIdx, scores, totalRows) { let scored = 0, below = 0, a = 0, b = 0, c = 0, min = null; scores.forEach((s, i) => { if (s == null) return; scored++; if (s < 80) below++; if (s >= 80) a++; else if (s >= 40) b++; else c++; if (!min || s < min.score) min = { score: s, row: rowsIdx[i], timestamp: fmtTs(TS[rowsIdx[i]]) }; }); return { scored, unscored: totalRows - scored, total_rows: totalRows, min_score: min, pct_below_80: scored ? below / scored * 100 : null, share_80_100: scored ? a / scored : null, share_40_80: scored ? b / scored : null, share_0_40: scored ? c / scored : null, share_basis: 'row_count' }; }
function downsampleSeries(idx, score, max) { if (idx.length <= max) return idx.map((_, i) => i); const buckets = Math.floor(max / 2), size = idx.length / buckets, keep = new Set(); for (let b = 0; b < buckets; b++) { const a = Math.floor(b * size), e = Math.min(idx.length, Math.floor((b + 1) * size)); keep.add(a); let mi = a; if (score) for (let i = a; i < e; i++) if (score[i] != null && (score[mi] == null || score[i] < score[mi])) mi = i; keep.add(mi); } return [...keep].sort((x, y) => x - y); }
// MOCKUP (Train/Test validation): masks of the test periods (same running condition, their own time ranges).
function testMasks(req) {
  const tp = (req.test_periods || []).filter(Boolean);
  if (!tp.length) return { tp, of: new Int16Array(N).fill(-1), none: true };
  const base = { ...(req.filter || {}), timestamp_start: null, timestamp_end: null };
  const masks = tp.map(t => rowMask({ ...base, timestamp_ranges: [{ start: t.start, end: t.end }] }));
  const of = new Int16Array(N).fill(-1);
  masks.forEach((mk, j) => { for (let k = 0; k < N; k++) if (mk[k] && of[k] < 0) of[k] = j; });
  return { tp, of };
}
const DAY_ROWS = 1440 / STEP_MIN;
const r1 = x => Math.round(x * 10) / 10;
// First drop below 80 = the first time the score stays below 80 for 1 hour (6 consecutive running rows).
// "Lowest" uses the same 1-hour rule: the lowest level the score STAYED at (or below) for 1 hour
// (min over every 6-row window of the window's max), so a single restart dip never shows as "Lowest 0".
const SUSTAIN_ROWS = 60 / STEP_MIN; // DROP_SUSTAIN_HOURS = 1
function scoreFacts(ks, sc, ev) {
  let scored = 0, below = 0, lowest = null, lowestK = null, first = null, run = 0, seg = 0;
  for (let i = 0; i < ks.length; i++) {
    const s = sc[i]; const gap = s == null || (i > 0 && ks[i] !== ks[i - 1] + 1); if (gap) { run = 0; seg = 0; } if (s == null) continue;
    seg++;
    scored++; if (s < 80) { below++; run++; if (run === SUSTAIN_ROWS && first == null) first = ks[i - SUSTAIN_ROWS + 1]; } else run = 0;
    if (seg >= SUSTAIN_ROWS) { let mx = -Infinity; for (let j = i - SUSTAIN_ROWS + 1; j <= i; j++) mx = Math.max(mx, sc[j]); if (lowest == null || mx < lowest) { lowest = mx; lowestK = ks[i - SUSTAIN_ROWS + 1]; } }
  }
  const evMs = ev ? parseTs(ev) : null;
  return {
    scored, pct_below_80: scored ? r1(below / scored * 100) : null,
    first_below_80: first == null ? null : fmtTs(TS[first]),
    lowest: lowest == null ? null : Math.round(lowest), lowest_at: lowestK == null ? null : fmtTs(TS[lowestK]),
    lead_days: first != null && evMs != null ? r1((evMs - TS[first]) / 86400000) : null,
  };
}
function buildValidation(req, info, allIdx, sc, trainKs, trainExtra, metric) {
  const tests = info.tp.map((t, j) => {
    const pos = []; allIdx.forEach((k, i) => { if (info.of[k] === j) pos.push(i); });
    const ks = pos.map(i => allIdx[i]);
    const facts = sc ? scoreFacts(ks, pos.map(i => sc[i]), t.label === 'problem' ? t.event_time : null) : { scored: 0, pct_below_80: null, first_below_80: null, lowest: null, lowest_at: null, lead_days: null };
    // Whole test period, rows that are also train rows included (user rule 2026-10-07).
    const trainRows = ks.filter(k => info.isTrain && info.isTrain(k)).length;
    return { index: j + 1, label: t.label, start: t.start, end: t.end, event_time: t.event_time || null, rows: ks.length, days: r1(ks.length / DAY_ROWS), train_rows: trainRows, train_days: r1(trainRows / DAY_ROWS), ...metric(ks), ...facts };
  });
  return { train: { rows: trainKs.length, days: r1(trainKs.length / DAY_ROWS), ...trainExtra }, train_ranges: (req.filter?.timestamp_ranges || []).map(r => ({ start: r.start, end: r.end })), tests };
}
const maskWhere = fn => { const o = []; for (let k = 0; k < N; k++) if (fn(k)) o.push(k); return o; };
function healthPreview(req) {
  ensureLoaded();
  const sp = req.set_points || {};
  const max = req.max_points || 3000;
  const m = rowMask(req.filter);
  const tinfo = testMasks(req);
  tinfo.isTrain = k => !!m[k];
  const inTest = k => tinfo.of[k] >= 0;
  const subset = (allIdx, arr, pred) => { const ks = [], v = []; allIdx.forEach((k, i) => { if (pred(k)) { ks.push(k); v.push(arr ? arr[i] : null); } }); return { ks, v }; };
  if (req.kind === 'individual') {
    const t = req.target; if (!COL[t]) throw 'BAD_REQUEST: Unknown target sensor';
    const scope = idxOf(m).filter(k => !isNaN(COL[t][k]));
    const st = statsOf(scope.map(k => COL[t][k])); if (!st) throw 'NO_DATA: No rows in the training scope.';
    const l3 = st.mean - 3 * st.sd, u3 = st.mean + 3 * st.sd;
    const iss = [];
    const L = sp.lower, H = sp.upper;
    if (L == null) iss.push(issue('required', 'lower', 'Enter the lower set point (L): the value where health reaches 0 on the low side.'));
    if (H == null) iss.push(issue('required', 'upper', 'Enter the upper set point (H): the value where health reaches 0 on the high side.'));
    if (L != null && H != null && L >= H) iss.push(issue('ordering', 'lower', `The lower set point (L = ${fmtN(L)}) must be below the upper set point (H = ${fmtN(H)}).`));
    if (L != null && L >= l3) iss.push(issue(L === l3 ? 'lower_equals_3sd' : 'lower_inside_3sd', 'lower', `The lower set point (L = ${fmtN(L)}) must be below the lower 3σ boundary (${fmtN(l3)}).`));
    if (H != null && H <= u3) iss.push(issue(H === u3 ? 'upper_equals_3sd' : 'upper_inside_3sd', 'upper', `The upper set point (H = ${fmtN(H)}) must be above the upper 3σ boundary (${fmtN(u3)}).`));
    const valid = !iss.length;
    const all = req.include_out_of_scope ? idxOf(new Uint8Array(N).fill(1)).filter(k => !isNaN(COL[t][k])) : maskWhere(k => (m[k] || inTest(k)) && !isNaN(COL[t][k]));
    const sc = valid ? all.map(k => { if (!m[k] && !inTest(k)) return null; const v = COL[t][k], z = Math.abs(v - st.mean) / st.sd; if (z <= 1) return 100; if (z <= 3) return lin(z, 1, 100, 3, 80); const lim = v < st.mean ? L : H, edge = v < st.mean ? l3 : u3; if (v < st.mean ? v <= lim : v >= lim) return 0; return Math.max(0, lin(v, edge, 80, lim, 0)); }) : null;
    const keep = downsampleSeries(all, sc, max);
    const tr = subset(all, sc, k => !!m[k]);
    const test_validation = tinfo ? buildValidation(req, tinfo, all, sc, tr.ks, { mean: st.mean, sd: st.sd, within_3sd_pct: r1(tr.ks.filter(k => Math.abs(COL[t][k] - st.mean) <= 3 * st.sd).length / Math.max(1, tr.ks.length) * 100) }, ks => { const v = ks.map(k => COL[t][k]); const s2 = statsOf(v); return { within_3sd_pct: v.length ? r1(v.filter(x => Math.abs(x - st.mean) <= 3 * st.sd).length / v.length * 100) : undefined, mean_shift_sd: s2 ? +((s2.mean - st.mean) / st.sd).toFixed(2) : undefined }; }) : null;
    return { kind: 'individual', test_validation, stats: { kind: 'individual', rows: st.n, mean: st.mean, sd: st.sd, boundary_1sd: [st.mean - st.sd, st.mean + st.sd], boundary_3sd: [l3, u3], min: st.min, max: st.max }, validation: iss, valid, series: { kind: 'individual', rows: keep.map(i => all[i]), timestamps: keep.map(i => fmtTs(TS[all[i]])), value: keep.map(i => COL[t][all[i]]), in_scope: keep.map(i => !!m[all[i]] || inTest(all[i])), score: sc ? keep.map(i => sc[i] == null ? null : +sc[i].toFixed(2)) : null, total_points: all.length }, score_summary: sc ? (tinfo ? summary(tr.ks, tr.v, tr.ks.length) : summary(all, sc, all.length)) : null, histogram: histogram(scope.map(k => COL[t][k])), fit_scatter: null, cluster_scatter: null };
  }
  if (req.kind === 'relationship') {
    const c = req.cache_key && fitCache.get(req.cache_key);
    if (!c) throw 'NOT_FITTED: This model has no fit in this session. Train it again.';
    const { f, target, predictors, idx: trainIdx, two_rmse: w } = c;
    const trainSet = new Set(trainIdx);
    const idx = tinfo ? trainIdx.concat(maskWhere(k => !trainSet.has(k) && inTest(k) && !isNaN(COL[target][k]) && predictors.every(p => !isNaN(COL[p][k])))).sort((x, y) => x - y) : trainIdx;
    const pred = idx.map(k => f(predictors.map(t => COL[t][k]))), resid = idx.map((k, i) => COL[target][k] - pred[i]);
    const rs = statsOf(resid.filter((_, i) => trainSet.has(idx[i])));
    const iss = [];
    const F = [['residual_at_80_lower', 'the lower 80-point (residual where health is 80, negative)'], ['residual_at_80_upper', 'the upper 80-point (residual where health is 80, positive)'], ['residual_at_0_lower', 'the lower 0-point (residual where health is 0, negative)'], ['residual_at_0_upper', 'the upper 0-point (residual where health is 0, positive)']];
    for (const [k, label] of F) if (sp[k] == null) iss.push(issue('required', k, `Enter ${label}.`));
    for (const side of ['lower', 'upper']) {
      const v80 = sp['residual_at_80_' + side], v0 = sp['residual_at_0_' + side], ok = v => side === 'lower' ? v < 0 : v > 0;
      if (v80 != null && !ok(v80)) iss.push(issue(side === 'lower' ? 'must_be_negative' : 'must_be_positive', 'residual_at_80_' + side, `The ${side} 80-point must be ${side === 'lower' ? 'negative' : 'positive'} (residual = actual − predicted); got ${fmtN(v80)}.`));
      if (v0 != null && !ok(v0)) iss.push(issue(side === 'lower' ? 'must_be_negative' : 'must_be_positive', 'residual_at_0_' + side, `The ${side} 0-point must be ${side === 'lower' ? 'negative' : 'positive'} (residual = actual − predicted); got ${fmtN(v0)}.`));
      if (v80 != null && ok(v80) && Math.abs(v80) <= w) iss.push(issue(Math.abs(v80) === w ? 'point80_equals_band' : 'point80_inside_band', 'residual_at_80_' + side, `The ${side} 80-point (${fmtN(v80)}) must be further from zero than the ±2RMSE band edge (${fmtN(w)}).`));
      if (v80 != null && v0 != null && ok(v80) && ok(v0) && Math.abs(v0) <= Math.abs(v80)) iss.push(issue(Math.abs(v0) === Math.abs(v80) ? 'point0_equals_point80' : 'point0_inside_point80', 'residual_at_0_' + side, `The ${side} 0-point (${fmtN(v0)}) must be further from zero than the ${side} 80-point (${fmtN(v80)}).`));
    }
    const valid = !iss.length;
    const sc = valid ? resid.map(r => { const a = Math.abs(r), s80 = Math.abs(r < 0 ? sp.residual_at_80_lower : sp.residual_at_80_upper), s0 = Math.abs(r < 0 ? sp.residual_at_0_lower : sp.residual_at_0_upper); if (a <= w) return 100; if (a <= s80) return lin(a, w, 100, s80, 80); if (a >= s0) return 0; return lin(a, s80, 80, s0, 0); }) : null;
    const keep = downsampleSeries(idx, sc, max);
    const xs = req.x_predictor && predictors.includes(req.x_predictor) ? req.x_predictor : predictors[0];
    const sct = stride(idx.map((_, i) => i).filter(i => trainSet.has(idx[i])), req.max_scatter_points || 3000);
    const tr = subset(idx, sc, k => trainSet.has(k));
    const relM = ks => { if (!ks.length) return {}; const y = ks.map(k => COL[target][k]), p = ks.map(k => f(predictors.map(t => COL[t][k]))), r = y.map((v, i) => v - p[i]); const my = y.reduce((a, b) => a + b, 0) / y.length; const ssr = r.reduce((a, b) => a + b * b, 0), sst = y.reduce((a, b) => a + (b - my) ** 2, 0); const st2 = statsOf(r); return { r2: +(sst ? 1 - ssr / sst : 0).toFixed(3), rmse: +Math.sqrt(ssr / y.length).toFixed(3), residual_mean: +st2.mean.toFixed(3), residual_sd: +st2.sd.toFixed(3) }; };
    const test_validation = tinfo ? buildValidation(req, tinfo, idx, sc, tr.ks, relM(tr.ks), relM) : null;
    return { kind: 'relationship', test_validation, stats: { kind: 'relationship', rows: trainIdx.length, target, predictors, r2: c.r2, rmse: w / 2, two_rmse: w, residual_mean: rs.mean, residual_sd: rs.sd, residual_min: rs.min, residual_max: rs.max, r2_per_step: [c.r2], rmse2_per_step: [w] }, validation: iss, valid, series: { kind: 'relationship', rows: keep.map(i => idx[i]), timestamps: keep.map(i => fmtTs(TS[idx[i]])), actual: keep.map(i => COL[target][idx[i]]), predicted: keep.map(i => pred[i]), residual: keep.map(i => resid[i]), score: sc ? keep.map(i => +sc[i].toFixed(2)) : null, total_points: idx.length }, score_summary: sc ? summary(tr.ks, tr.v, tr.ks.length) : null, histogram: histogram(resid.filter((_, i) => trainSet.has(idx[i]))), fit_scatter: { x_sensor: xs, predictors, x: sct.map(i => COL[xs][idx[i]]), actual: sct.map(i => COL[target][idx[i]]), predicted: sct.map(i => pred[i]), total: trainIdx.length }, cluster_scatter: null };
  }
  // clustering
  const { first_sensor: a, second_sensor: b, n_clusters: n, criteria_sensor: cr, cluster_ranges: rg } = req;
  if (!COL[a] || !COL[b]) throw 'BAD_REQUEST: Pick both sensors';
  const ca = clusterAssign(a, b, n || 1, cr, rg, req.filter);
  const groups = ca.groups, idx = ca.idx.slice(); // copy: test rows are appended below
  const geo = groups.filter(g => g.idx.length > 2).map(g => { const e = ellipse(g.idx.map(k => COL[a][k]), g.idx.map(k => COL[b][k])); return { g, e }; });
  if (!geo.length) throw 'NO_DATA: No rows fall inside the cluster ranges for this training scope.';
  const iss = [];
  const N3 = sp.outer_sd;
  if (N3 == null) iss.push(issue('required', 'outer_sd', 'Enter the outer ring (N × SD): the distance where health reaches 0.'));
  else if (N3 === 3) iss.push(issue('outer_sd_equals_3', 'outer_sd', "The outer ring can't equal 3× SD (that ring is the 80 point). Use more than 3."));
  else if (N3 < 3) iss.push(issue('outer_sd_not_above_3', 'outer_sd', `The outer ring (${fmtN(N3)}× SD) must be more than 3× SD (the 80 point).`));
  const valid = !iss.length;
  const cl = new Map(); geo.forEach(({ g, e }) => g.idx.forEach(k => cl.set(k, { id: g.id, e })));
  const trainSet = new Set(idx);
  if (tinfo) {
    const tIdx = maskWhere(k => !trainSet.has(k) && inTest(k) && !isNaN(COL[a][k]) && !isNaN(COL[b][k]));
    const inRange = (g, k) => { if (!g.range || !cr) return true; const v = COL[cr][k]; return !isNaN(v) && (g.range.min == null || v >= g.range.min) && (g.range.max == null || v < g.range.max); };
    for (const k of tIdx) { const hit = geo.find(({ g }) => inRange(g, k)); if (hit) cl.set(k, { id: hit.g.id, e: hit.e }); }
    idx.push(...tIdx); idx.sort((x, y) => x - y);
  }
  const dist = (k, e) => { const [sxx, sxy, syy] = e.cov, det = sxx * syy - sxy * sxy || 1e-12, dx = COL[a][k] - e.x_center, dy = COL[b][k] - e.y_center; return Math.sqrt((syy * dx * dx - 2 * sxy * dx * dy + sxx * dy * dy) / det); };
  const d = idx.map(k => { const c = cl.get(k); return c ? dist(k, c.e) : null; });
  const sc = valid ? d.map(x => x == null ? null : x <= 1 ? 100 : x <= 3 ? lin(x, 1, 100, 3, 80) : x >= N3 ? 0 : lin(x, 3, 80, N3, 0)) : null;
  const keep = downsampleSeries(idx, sc, max), sct = stride(idx.map((_, i) => i).filter(i => trainSet.has(idx[i])), req.max_scatter_points || 3000);
  const tr = subset(idx, sc, k => trainSet.has(k));
  const assignedTrain = tr.ks.filter(k => cl.has(k)).length;
  const dOf = new Map(idx.map((k, i) => [k, d[i]]));
  const test_validation = tinfo ? buildValidation(req, tinfo, idx, sc, tr.ks, { inside_3sd_ring_pct: (() => { const ds = tr.ks.map(k => dOf.get(k)).filter(x => x != null); return ds.length ? r1(ds.filter(x => x <= 3).length / ds.length * 100) : undefined; })() }, ks => { const ds = ks.map(k => dOf.get(k)).filter(x => x != null); return { inside_3sd_ring_pct: ds.length ? r1(ds.filter(x => x <= 3).length / ds.length * 100) : undefined }; }) : null;
  return { kind: 'clustering', test_validation, stats: { kind: 'clustering', rows: tr.ks.length, assigned_rows: assignedTrain, unassigned_rows: tr.ks.length - assignedTrain, cluster_count: n || 1, criteria_sensor: cr || null, clusters: geo.map(({ g, e }) => ({ cluster_id: g.id, range: g.range, n_rows: g.idx.length, x_center: e.x_center, y_center: e.y_center, x_sd: e.x_sd, y_sd: e.y_sd, angle_deg: e.angle_deg })) }, validation: iss, valid, series: { kind: 'clustering', rows: keep.map(i => idx[i]), timestamps: keep.map(i => fmtTs(TS[idx[i]])), x: keep.map(i => COL[a][idx[i]]), y: keep.map(i => COL[b][idx[i]]), cluster: keep.map(i => cl.get(idx[i])?.id ?? null), sd_distance: keep.map(i => d[i]), score: sc ? keep.map(i => sc[i] == null ? null : +sc[i].toFixed(2)) : null, total_points: idx.length }, score_summary: sc ? summary(tr.ks, tr.v, tr.ks.length) : null, histogram: histogram(d.filter((x, i) => x != null && trainSet.has(idx[i]))), fit_scatter: null, cluster_scatter: { x: sct.map(i => COL[a][idx[i]]), y: sct.map(i => COL[b][idx[i]]), cluster: sct.map(i => cl.get(idx[i])?.id ?? null), total: tr.ks.length } };
}

// ---------------- special sensors ----------------
function evalExpr(formula) {
  const src = String(formula).replace(/^\s*=/, '');
  const re = /\s*(\$\{[^}]+\}|\$[\p{Alphabetic}\p{N}_][\p{Alphabetic}\p{N}_.]*|\[[^\]]+\]|\d+(?:\.\d+)?(?:e[-+]?\d+)?[kMGTmunp]?|[A-Za-z_][A-Za-z0-9_]*|\*\*|[-+*\/^(),])/yu;
  const tk = []; let pos = 0;
  while (pos < src.length) { re.lastIndex = pos; const m = re.exec(src); if (!m) { if (/^\s*$/.test(src.slice(pos))) break; throw `Unexpected text near "${src.slice(pos, pos + 12)}"`; } tk.push(m[1]); pos = re.lastIndex; }
  let i = 0; const refs = new Set();
  const peek = () => tk[i], next = () => tk[i++];
  const ref = t => { const name = t.startsWith('${') ? t.slice(2, -1) : t.startsWith('$') ? t.slice(1) : t.slice(1, -1); const hit = allTags().find(x => x.toLowerCase() === name.toLowerCase()); if (!hit) throw `Unknown sensor ${name}`; refs.add(hit); return k => COL[hit][k]; };
  // MOCKUP (item 6): the engine's function list (FORMULA_FUNCTION_LIST in lib.rs). log = log10, ln = natural log,
  // round(step, x) rounds x to a multiple of step; min / max take any number of values.
  const FN = {
    abs: [1, 1, Math.abs], sqrt: [1, 1, Math.sqrt], pow: [2, 2, Math.pow], exp: [1, 1, Math.exp], ln: [1, 1, Math.log],
    log: [1, 1, Math.log10], log10: [1, 1, Math.log10], round: [1, 2, (a, b) => b === undefined ? Math.round(a) : Math.round(b / a) * a],
    min: [1, 99, Math.min], max: [1, 99, Math.max], ceil: [1, 1, Math.ceil], floor: [1, 1, Math.floor],
    sin: [1, 1, Math.sin], cos: [1, 1, Math.cos], tan: [1, 1, Math.tan], asin: [1, 1, Math.asin], acos: [1, 1, Math.acos], atan: [1, 1, Math.atan],
    sinh: [1, 1, Math.sinh], cosh: [1, 1, Math.cosh], tanh: [1, 1, Math.tanh], asinh: [1, 1, Math.asinh], acosh: [1, 1, Math.acosh], atanh: [1, 1, Math.atanh],
    sign: [1, 1, Math.sign], int: [1, 1, Math.trunc], pi: [0, 0, () => Math.PI], e: [0, 0, () => Math.E],
  };
  let depth = 0;
  function prim() {
    const t = next(); if (t == null) throw 'Incomplete formula';
    if (t === '(') { if (++depth > 64) throw 'too_deep'; if (peek() === ')') throw 'Empty brackets'; const e = add(); if (next() !== ')') throw 'Unbalanced brackets'; depth--; return e; }
    if (t === '-') { const e = pow(); return k => -e(k); }
    if (/^[\d.]/.test(t)) { const SI = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 }; const sf = SI[t.slice(-1)]; const v = sf ? +t.slice(0, -1) * sf : +t; return () => v; }
    if (t[0] === '$' || t[0] === '[') return ref(t);
    const f = FN[t.toLowerCase()];
    if (f && peek() === '(') {
      next(); if (++depth > 64) throw 'too_deep';
      const args = []; const firstTok = peek(); let secondTok = null, secondLen = 0;
      if (peek() !== ')') { args.push(add()); while (peek() === ',') { next(); secondTok = peek(); const at = i; args.push(add()); secondLen = i - at; } }
      if (t.toLowerCase() === 'round' && args.length === 2 && !/^[\d.]/.test(firstTok) && secondLen === 1 && /^[\d.]/.test(secondTok)) throw `round(x, ${secondTok}) is Excel's order. The engine rounds to a step: write round(0.01, x) for 2 decimals, or round(x * 100) / 100`;
      if (next() !== ')') throw 'Unbalanced brackets'; depth--;
      if (args.length < f[0] || args.length > f[1]) throw `${t}() takes ${f[0] === f[1] ? f[0] : `${f[0]}–${f[1] > 9 ? 'any number of' : f[1]}`} value${f[1] === 1 ? '' : 's'}`;
      const fn = f[2];
      return k => fn(...args.map(a => a(k)));
    }
    if (f) throw `Function ${t} needs brackets`;
    if (t.toLowerCase() === 'pi' || t.toLowerCase() === 'e') throw `unknown name '${t}'. Write ${t.toLowerCase()}() for ${t.toLowerCase() === 'pi' ? 'π' : 'e'}.`;
    if (/^[A-Za-z_]/.test(t) && !allTags().some(x => x.toLowerCase() === t.toLowerCase())) throw `unknown name '${t}'. Write sensors as $Name, or ${'${Name}'} when the name has spaces or symbols. Functions: ${Object.keys(FN).join(', ')}`;
    return ref('$' + t);
  }
  function pow() { const a = prim(); if (peek() === '^' || peek() === '**') { next(); const b = pow(); return k => Math.pow(a(k), b(k)); } return a; }
  function mul() { let a = pow(); while (peek() === '*' || peek() === '/') { const op = next(), b = pow(), x = a; a = op === '*' ? k => x(k) * b(k) : k => x(k) / b(k); } return a; }
  function add() { let a = mul(); while (peek() === '+' || peek() === '-') { const op = next(), b = mul(), x = a; a = op === '+' ? k => x(k) + b(k) : k => x(k) - b(k); } return a; }
  if (src.length > 4096) throw 'too_long';
  const e = add(); if (i < tk.length) throw `Unexpected "${tk[i]}"`;
  return { e, refs: [...refs] };
}
function nameFor(custom, fallback, replace) { let n = (custom || '').trim() || fallback; if (!replace && COL[n]) throw `A sensor named "${n}" already exists. Pick another name.`; return n; }
function computeFormula(formula, customName, replace) { const { e } = evalExpr(formula); const name = nameFor(customName, 'FORMULA_' + (derived.size + 1), replace); const v = new Float64Array(N); for (let k = 0; k < N; k++) { const x = e(k); v[k] = isFinite(x) ? x : NaN; } COL[name] = v; derived.add(name); return name; }
function computeOperation(sensors, config, customName, replace) {
  const src = sensors.filter(t => COL[t]); if (!src.length) throw 'Pick at least one source sensor';
  const v = new Float64Array(N);
  if (config.mode === 'multi') { const ty = config.multiOp?.type || 'sum'; for (let k = 0; k < N; k++) { const xs = src.map(t => COL[t][k]).filter(x => !isNaN(x)); if (!xs.length) { v[k] = NaN; continue; } if (ty === 'sum' && xs.length < src.length) { v[k] = NaN; continue; } if (ty === 'mean') v[k] = xs.reduce((a, b) => a + b, 0) / xs.length; else if (ty === 'median') { xs.sort((a, b) => a - b); const h = xs.length >> 1; v[k] = xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2; } else v[k] = xs.reduce((a, b) => a + b, 0); const dd = config.multiOp?.decimals; if (dd != null) v[k] = Math.round(v[k] * 10 ** dd) / 10 ** dd; } }
  else { const op = config.singleOp || { type: 'abs', value: 0 }, c = +op.value; const F = { add: x => x + c, subtract: x => x - c, multiply: x => x * c, divide: x => x / c, power: x => Math.pow(x, c), abs: Math.abs, log10: Math.log10, sqrt: Math.sqrt, round: Math.round, exp: Math.exp, ceil: Math.ceil, floor: Math.floor }[op.type] || (x => x); const s = COL[src[0]]; for (let k = 0; k < N; k++) { const x = F(s[k]); v[k] = isFinite(x) ? x : NaN; } }
  const fallback = config.mode === 'multi' ? `${(config.multiOp?.type || 'sum').toUpperCase()}_${src.length}` : `${src[0]}_${(config.singleOp?.type || 'op').toUpperCase()}`;
  const name = nameFor(config.customName || customName, fallback, replace);
  COL[name] = v; derived.add(name); return name;
}
function upsertRecipe(r) { const list = recipesLoad().filter(x => x.tag !== r.tag); list.push(r); recipesSave(list); }

// ---------------- formula preview (MOCKUP, item 6) ----------------
const FUNCTION_LIST = ['abs', 'sqrt', 'pow', 'exp', 'ln', 'log', 'log10', 'round', 'min', 'max', 'ceil', 'floor', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'sign', 'int', 'pi', 'e'];
const LIMITS = { max_length: 4096, max_depth: 64 };
function previewFormula({ formula, aggregate, max_points }) {
  ensureLoaded(); replayRecipes();
  const base = { functions: FUNCTION_LIST, limits: LIMITS };
  let col;
  try {
    if (aggregate) {
      const src = (aggregate.sources || []).filter(t => COL[t]);
      const missing = (aggregate.sources || []).find(t => !COL[t]);
      if (missing) return { ...base, ok: false, issues: [{ code: 'unknown_sensor', message: `${missing} is not in this dataset.` }] };
      col = new Float64Array(N);
      for (let k = 0; k < N; k++) {
        const xs = src.map(t => COL[t][k]); const ok = xs.filter(x => !isNaN(x));
        let v = NaN;
        if (aggregate.type === 'sum') v = ok.length < xs.length ? NaN : ok.reduce((a, b) => a + b, 0);
        else if (ok.length) { if (aggregate.type === 'mean') v = ok.reduce((a, b) => a + b, 0) / ok.length; else { ok.sort((a, b) => a - b); const h = ok.length >> 1; v = ok.length % 2 ? ok[h] : (ok[h - 1] + ok[h]) / 2; } }
        if (aggregate.decimals != null && !isNaN(v)) v = Math.round(v * 10 ** aggregate.decimals) / 10 ** aggregate.decimals;
        col[k] = v;
      }
    } else {
      const { e } = evalExpr(formula || '');
      col = new Float64Array(N);
      for (let k = 0; k < N; k++) { const x = e(k); col[k] = isFinite(x) ? x : NaN; }
    }
  } catch (err) {
    const m = String(err);
    if (m === 'too_long') return { ...base, ok: false, issues: [{ code: 'too_long', message: `The formula is ${String(formula).length.toLocaleString('en-US')} characters; the limit is 4,096. Split it: create part of it as its own sensor, then use that sensor here.` }] };
    if (m === 'too_deep') return { ...base, ok: false, issues: [{ code: 'too_deep', message: 'Too many nested brackets — the limit is 64 levels. Create the inner part as its own sensor, then use that sensor here.' }] };
    if (/^Unknown sensor/.test(m)) return { ...base, ok: false, issues: [{ code: 'unknown_sensor', message: m.replace('Unknown sensor ', '') + ' is not in this dataset.' }] };
    return { ...base, ok: false, issues: [{ code: 'parse_error', message: m }] };
  }
  let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
  for (let k = 0; k < N; k++) { const v = col[k]; if (isNaN(v)) continue; n++; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const max = Math.min(max_points || 600, 2000), step = N / max, ts = [], vals = [];
  for (let j = 0; j < max; j++) { const a = Math.floor(j * step), b = Math.floor((j + 1) * step); let lo = NaN, hi = NaN, kl = a, kh = a; for (let k = a; k < b; k++) { const v = col[k]; if (isNaN(v)) continue; if (isNaN(lo) || v < lo) { lo = v; kl = k; } if (isNaN(hi) || v > hi) { hi = v; kh = k; } } if (isNaN(lo)) { ts.push(fmtTs(TS[a])); vals.push(null); continue; } const [p, q] = kl < kh ? [kl, kh] : [kh, kl]; ts.push(fmtTs(TS[p])); vals.push(col[p]); ts.push(fmtTs(TS[q])); vals.push(col[q]); }
  return { ...base, ok: true, issues: [], stats: { min: n ? mn : null, max: n ? mx : null, mean: n ? sum / n : null, rows: N, missing: N - n }, timestamps: ts, values: vals, period: [fmtTs(TS[0]), fmtTs(TS[N - 1])] };
}

// ---------------- command table ----------------
const MAPPING = { headers: ['TAG', 'DESCRIPTION', 'UNIT', 'COMPONENT', 'ALARM_LL', 'ALARM_L', 'ALARM_H', 'ALARM_HH'], rows: S0.map(([t, d, u, c, al]) => [t, d, u, COMP[c], al?.LL ?? '', al?.L ?? '', al?.H ?? '', al?.HH ?? ''].map(String)) };
const delay = ms => new Promise(r => setTimeout(r, ms));
export const COMMANDS = {
  async load_csv({ paths }, emit) {
    const files = FILES.slice(0, Math.max(1, Math.min(FILES.length, (paths || []).length)));
    for (let i = 0; i < files.length; i++) { emit('csv-load-progress', { file_index: i, file_count: files.length, file_name: files[i].name, stage: 'reading', files_done: i }); await delay(350); }
    emit('csv-load-progress', { file_index: files.length, file_count: files.length, file_name: '', stage: 'merging', files_done: files.length }); await delay(250);
    emit('csv-load-progress', { file_index: files.length, file_count: files.length, file_name: '', stage: 'done', files_done: files.length });
    loaded = true; generation += 1; derived.clear(); fitCache.clear(); recipesSave([]); sessionSave();
    for (const t of Object.keys(COL)) if (!BASE_TAGS.includes(t)) delete COL[t];
    const a = files[0].a, b = files[files.length - 1].b;
    const nulls = t => { let c = 0; for (let k = a; k <= b; k++) if (isNaN(COL[t][k])) c++; return c; };
    const cols = [{ name: 'timestamp', dtype: 'datetime', null_count: 0, valid_count: b - a + 1 }, ...BASE_TAGS.map(t => { const n = nulls(t); return { name: t, dtype: 'numeric', null_count: n, valid_count: b - a + 1 - n }; })];
    const miss = cols.slice(1).reduce((s, c) => s + c.null_count, 0) / (BASE_TAGS.length * (b - a + 1)) * 100;
    return { headers: ['timestamp', ...BASE_TAGS], total_rows: b - a + 1, columns: cols, warnings: [], generation, files: files.map(f => ({ name: f.name, size_bytes: Math.round((f.b - f.a + 1) * BASE_TAGS.length * 9.3), rows: f.b - f.a + 1, start: fmtTs(TS[f.a]), end: fmtTs(TS[f.b]), start_micros: TS[f.a] * 1000, end_micros: TS[f.b] * 1000 })), period_start: fmtTs(TS[a]), period_end: fmtTs(TS[b]), period_start_micros: TS[a] * 1000, period_end_micros: TS[b] * 1000, interval_seconds: STEP_MIN * 60, missing_percent: +miss.toFixed(2) };
  },
  load_mapping_csv() { return MAPPING; },
  apply_sensor_mapping({ keyColumn, mappingData, datasetHeaders }) { const ki = mappingData.headers.indexOf(keyColumn); const keys = mappingData.rows.map(r => r[ki < 0 ? 0 : ki]); const ds = (datasetHeaders || []).slice(1); return { matched: keys.filter(k => ds.includes(k)), not_in_dataset: keys.filter(k => !ds.includes(k)), not_in_mapping: ds.filter(h => !keys.includes(h)) }; },
  get_all_sensors() { if (!loaded) return []; replayRecipes(); return allTags(); },
  get_session_generation() { try { const s = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); if (s && typeof s.generation === 'number') generation = s.generation; } catch { } return loaded ? generation : null; },
  get_dataset_time_bounds() { return { min: fmtTs(TS[0]), max: fmtTs(TS[N - 1]) }; },
  get_chart_data(a) { replayRecipes(); return getChartData(a); },
  get_scatter_sample(a) { replayRecipes(); return getScatterSample(a); },
  // MOCKUP (items 8 + 9): training takes a few seconds per model so the queue is visible (I ≈ 1.2 s, C ≈ 1.8 s, R ≈ 4 s).
  async compute_sensor_stats(a) { replayRecipes(); await delay(1200); return computeSensorStats(a); },
  async preview_relationship_model(a) { replayRecipes(); await delay(4000); return previewRelationship(a); },
  async compute_clustering_preview(a) { replayRecipes(); await delay(1800); return clusteringPreview(a); },
  compute_health_preview({ request }) { replayRecipes(); return healthPreview(request); },
  async export_model_files({ request }) { await delay(500); const dir = `C:\\Users\\you\\AppData\\Roaming\\com.wizard.app\\workspaces\\${request.workspace_id}\\output\\${request.target || request.second_sensor}`; const base = (request.model_name || 'model').replace(/[^A-Za-z0-9_-]+/g, '_'); const files = request.kind === 'relationship' ? [{ kind: 'info', file_name: `REL_INFO_${base}.json`, path: `${dir}\\REL_INFO_${base}.json` }, { kind: 'model', file_name: `${base}.pkl`, path: `${dir}\\${base}.pkl` }, { kind: 'dataset', file_name: 'REL_DATASET.csv', path: `${dir}\\REL_DATASET.csv` }] : [{ kind: 'info', file_name: `${request.kind === 'individual' ? 'INDV' : 'CLUS'}_INFO_${base}.json`, path: `${dir}\\${request.kind === 'individual' ? 'INDV' : 'CLUS'}_INFO_${base}.json` }]; return { ok: true, files, output_dir: dir, validation: [], warnings: [] }; },
  get_model_output_dir({ workspace_id }) { return `C:\\Users\\you\\AppData\\Roaming\\com.wizard.app\\workspaces\\${workspace_id}\\output`; },
  evaluate_formula({ formula, customName, replace }) { replayRecipes(); const n = computeFormula(formula, customName, replace); upsertRecipe({ kind: 'formula', tag: n, formula }); return n; },
  calculate_new_sensor({ sensors, config, replace }) { replayRecipes(); const n = computeOperation(sensors, config, config?.customName, replace); upsertRecipe({ kind: 'operation', tag: n, sensors, config }); return n; },
  extract_formula_refs({ formulas }) { replayRecipes(); return formulas.map(f => { try { return evalExpr(f).refs; } catch { return []; } }); },
  remove_sensor_columns({ sensors, names, columns }) { const list = sensors || names || columns || []; for (const t of list) { if (derived.has(t)) { derived.delete(t); delete COL[t]; } } recipesSave(recipesLoad().filter(r => !list.includes(r.tag))); return list.length; },
  preview_formula(a) { return previewFormula(a); },
  validate_formula({ formula }) { replayRecipes(); try { const { refs } = evalExpr(formula); if (!String(formula).trim()) return { valid: false, error: 'Enter a formula', referenced_sensors: [] }; return { valid: true, error: null, referenced_sensors: refs }; } catch (e) { const names = [...String(formula).matchAll(/\$\{([^}]+)\}|\$([\p{Alphabetic}\p{N}_][\p{Alphabetic}\p{N}_.]*)/gu)].map(m => m[1] || m[2]); return { valid: false, error: String(e), referenced_sensors: [...new Set(names)] }; } },
  rename_formula_refs({ formula, oldName, newName }) { const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const ref = /^[A-Za-z0-9_]+$/.test(newName) ? '$' + newName : '${' + newName + '}'; return String(formula).replace(new RegExp('\\$\\{' + esc + '\\}|\\$' + esc + '(?![A-Za-z0-9_])', 'gi'), ref); },
  get_loaded_paths() { return loaded ? FILES.map(f => 'C:\\Data\\GEG-4\\' + f.name) : []; },
  load_metadata_command() { return []; },
  write_user_file() { return null; },
  log_frontend_error() { return null; },
  get_error_log_path() { return 'C:\\Users\\you\\AppData\\Roaming\\com.wizard.app\\logs\\frontend-errors.log'; },
};
