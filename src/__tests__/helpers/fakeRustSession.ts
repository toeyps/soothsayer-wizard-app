/**
 * A fake Rust backend for cross-window special-sensor integration tests.
 *
 * Unlike the small `fakeRust()` inside `AddSensorWindow.test.tsx` (which only
 * tracks column NAMES), this one holds real column VALUES and mirrors the
 * semantics of `src-tauri/src/lib.rs` closely enough that "the chart shows the
 * deleted sensor's old numbers" or "a downstream sensor was recomputed from a
 * stale source" is observable as wrong numbers, not just as a wrong call list:
 *
 *  - `store_derived_column`: create refuses any existing name (trimmed,
 *    case-insensitive, raw or derived); `replace: true` overwrites a DERIVED
 *    column in place (position kept, header takes the new casing), refuses a
 *    raw/timestamp column, appends when nothing matches.
 *  - `remove_derived_columns`: drops derived columns only (trimmed + ci),
 *    skips unknown/raw/timestamp names silently, returns the count.
 *  - `resolve_sensor` (sources of a formula/operation): exact header first,
 *    then the trimmed/case-insensitive match.
 *  - `scan_sensor_refs` (the ONE Rust tokenizer): `${...}` up to the first `}`,
 *    or a bare `$` name that starts with an alphanumeric/`_` and continues
 *    while alphanumeric/`_`/`.` -- where "alphanumeric" is Rust's
 *    `char::is_alphanumeric` (`Alphabetic || Numeric`).
 *  - `sensor_ref_token`: bare only when every char is alphanumeric or `_`.
 *  - `compute_formula_sensor`: any NaN input -> NaN; non-finite -> NaN;
 *    "cannot be built from itself" on a replace that reads its own column.
 *  - `compute_operation_sensor`: multi `sum` needs every input (any NaN ->
 *    NaN); `mean`/`median` skip NaN; single ops keep NaN; divide by 0 -> NaN.
 *  - `chart_query::resolve_ctx` and `ResolvedFilter::resolve`: EXACT header
 *    match (`h == s`), FIRST match, unknown names dropped silently.
 *  - Tauri v2 arg-key casing: every command rejects a key it would not
 *    deserialize (a snake_case key sent to a camelCase command is how a
 *    feature "silently does nothing" in this app), and a missing required key.
 */

export interface RawCsv {
    /** headers[0] is the timestamp column. */
    headers: string[];
    /** One column per header AFTER the timestamp (values; NaN = missing). */
    columns: number[][];
}

type Args = Record<string, any>;
type Pred = (args: Args) => boolean;

interface Fault { cmd: string; pred: Pred; error: string; once: boolean; }
interface Gate { cmd: string; pred: Pred; release: () => void; promise: Promise<void>; armed: boolean; }

const key = (s: string) => s.trim().toLowerCase();
// Rust `char::is_alphanumeric` == Alphabetic || Numeric (Nd/Nl/No).
const isAlnum = (c: string) => /^[\p{Alphabetic}\p{N}]$/u.test(c);

export interface RefSpan { start: number; end: number; token: string; name: string; }

/** Mirror of `scan_sensor_refs` (char-indexed spans). */
export function rustScanRefs(formula: string): RefSpan[] {
    const chars = Array.from(formula);
    const refs: RefSpan[] = [];
    let i = 0;
    while (i < chars.length) {
        if (chars[i] === '$') {
            if (i + 1 < chars.length && chars[i + 1] === '{') {
                let j = i + 2;
                while (j < chars.length && chars[j] !== '}') j++;
                if (j < chars.length) {
                    const name = chars.slice(i + 2, j).join('');
                    if (name) refs.push({ start: i, end: j + 1, token: chars.slice(i, j + 1).join(''), name });
                    i = j + 1;
                } else {
                    i += 1;
                }
            } else if (i + 1 < chars.length && (isAlnum(chars[i + 1]) || chars[i + 1] === '_')) {
                let j = i + 1;
                while (j < chars.length && (isAlnum(chars[j]) || chars[j] === '_' || chars[j] === '.')) j++;
                const name = chars.slice(i + 1, j).join('');
                if (name) refs.push({ start: i, end: j, token: chars.slice(i, j).join(''), name });
                i = j;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    return refs;
}

/** Mirror of `sensor_ref_token`. */
export function rustRefToken(name: string): string {
    const chars = Array.from(name);
    return chars.length > 0 && chars.every(c => isAlnum(c) || c === '_') ? `$${name}` : `\${${name}}`;
}

/** Mirror of `rewrite_sensor_ref`. */
export function rustRewrite(formula: string, oldName: string, newName: string): string {
    const chars = Array.from(formula);
    const token = rustRefToken(newName.trim());
    let out = '';
    let pos = 0;
    for (const span of rustScanRefs(formula)) {
        if (key(span.name) === key(oldName)) {
            out += chars.slice(pos, span.start).join('') + token;
            pos = span.end;
        }
    }
    return out + chars.slice(pos).join('');
}

/** Mirror of `extract_formula_refs` for one formula (dedup by exact name). */
export function rustExtractRefs(formula: string): string[] {
    const seen = new Set<string>();
    return rustScanRefs(formula).map(s => s.name).filter(n => (seen.has(n) ? false : (seen.add(n), true)));
}

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const finite = (v: number) => (Number.isFinite(v) ? v : NaN);

/** Allowed argument keys per command, exactly as Tauri v2 deserializes them
 *  for the Rust signatures in lib.rs (camelCase unless `rename_all`). */
const SIGNATURES: Record<string, { required: string[]; optional?: string[] }> = {
    evaluate_formula: { required: ['formula'], optional: ['customName', 'replace'] },
    calculate_new_sensor: { required: ['sensors', 'config'], optional: ['replace'] },
    remove_sensor_columns: { required: ['names'] },
    extract_formula_refs: { required: ['formulas'] },
    rename_formula_refs: { required: ['formula', 'oldName', 'newName'] },
    validate_formula: { required: ['formula'] },
    load_csv: { required: ['paths'] },
    // `#[tauri::command(rename_all = "snake_case")]`
    get_chart_data: { required: ['filter', 'sampling', 'max_points'], optional: ['operation'] },
};

export function createFakeRust(raw: RawCsv) {
    let headers: string[] = [];
    let columns: number[][] = [];
    let derived = new Set<string>();
    let generation = 0;
    let loaded = false;
    const nRows = raw.columns[0]?.length ?? 0;
    const timestamps = Array.from({ length: nRows }, (_, i) => `2026-01-01 0${i}:00:00`);

    const calls: Array<{ cmd: string; args: Args; result?: unknown; error?: string }> = [];
    const chartResponses: Array<{ filter: any; view: any }> = [];
    const faults: Fault[] = [];
    const gates: Gate[] = [];

    const reset = () => {
        headers = [...raw.headers];
        columns = [timestamps.map(() => NaN), ...raw.columns.map(c => [...c])];
        derived = new Set();
        generation++;
        loaded = true;
    };

    const findCi = (name: string) => headers.findIndex(h => key(h) === key(name));
    const resolve = (name: string) => {
        const exact = headers.findIndex(h => h === name);
        return exact >= 0 ? exact : findCi(name);
    };

    const store = (nameIn: string, col: number[], replace: boolean): string => {
        const name = nameIn.trim();
        if (!name) throw 'Sensor name cannot be empty';
        if (col.length !== nRows) throw `Computed column has ${col.length} rows but the dataset has ${nRows}`;
        const idx = findCi(name);
        if (idx >= 0) {
            if (!replace) throw `A sensor named '${name}' already exists`;
            if (idx === 0 || !derived.has(key(name))) throw `'${name}' is an imported data column and cannot be overwritten`;
            columns[idx] = col;
            headers[idx] = name;
        } else {
            columns.push(col);
            headers.push(name);
            derived.add(key(name));
        }
        return name;
    };

    const evalFormula = (formula: string, customName: string | null | undefined, replace: boolean): string => {
        const spans = rustScanRefs(formula);
        if (spans.length === 0) throw 'Formula contains no sensor references. Use $SensorName or ${Sensor Name} syntax.';
        const chars = Array.from(formula);
        const safe: string[] = []; // distinct names, exact
        let expr = '';
        let pos = 0;
        for (const s of spans) {
            expr += chars.slice(pos, s.start).join('');
            let i = safe.indexOf(s.name);
            if (i < 0) { safe.push(s.name); i = safe.length - 1; }
            expr += `__v[${i}]`;
            pos = s.end;
        }
        expr += chars.slice(pos).join('');
        const idx = safe.map(n => {
            const i = resolve(n);
            if (i < 0) throw `Sensor not found: ${n}`;
            return i;
        });
        const name = (customName ?? '').trim() || `f(${formula.trim()})`;
        if (replace) {
            const target = findCi(name);
            if (target >= 0 && idx.includes(target)) throw `'${name}' cannot be built from itself`;
        } else if (findCi(name) >= 0) {
            throw `A sensor named '${name}' already exists`;
        }
        let fn: (...a: any[]) => number;
        try {
            // eslint-disable-next-line no-new-func
            fn = new Function('__v', 'abs', 'sqrt', 'exp', 'log10', 'pow', 'min', 'max', 'ceil', 'floor', 'round',
                `return (${expr.replace(/\^/g, '**')});`) as any;
        } catch (e) {
            throw `Formula parse error: ${String(e)}`;
        }
        const round = (modulus: number, x: number) => Math.round(x / modulus) * modulus;
        const col: number[] = [];
        for (let r = 0; r < nRows; r++) {
            const v = idx.map(i => columns[i][r]);
            if (v.some(Number.isNaN)) { col.push(NaN); continue; }
            let out: number;
            try { out = fn(v, Math.abs, Math.sqrt, Math.exp, Math.log10, Math.pow, Math.min, Math.max, Math.ceil, Math.floor, round); }
            catch { out = NaN; }
            col.push(finite(out));
        }
        return store(name, col, replace);
    };

    const calcOperation = (sensors: string[], config: any, replace: boolean): string => {
        if (!sensors || sensors.length === 0) throw 'No sensors selected';
        const idx = sensors.map(s => {
            const i = resolve(s);
            if (i < 0) throw `Sensor not found: ${s}`;
            return i;
        });
        let defaultName: string;
        let compute: (r: number) => number;
        if (config.mode === 'single') {
            if (sensors.length !== 1) throw 'Single mode requires exactly one sensor';
            const op = config.singleOp;
            if (!op) throw 'Missing singleOp config';
            const sym: Record<string, string> = { add: '+', subtract: '-', multiply: '*', divide: '/', power: '^' };
            defaultName = `${sensors[0]} ${sym[op.type] ?? op.type} ${op.value}`;
            const f = (x: number): number => {
                switch (op.type) {
                    case 'add': return x + op.value;
                    case 'subtract': return x - op.value;
                    case 'multiply': return x * op.value;
                    case 'divide': return op.value === 0 ? NaN : x / op.value;
                    case 'power': return Math.pow(x, op.value);
                    case 'abs': return Math.abs(x);
                    case 'sqrt': return Math.sqrt(x);
                    case 'log10': return Math.log10(x);
                    case 'exp': return Math.exp(x);
                    case 'ceil': return Math.ceil(x);
                    case 'floor': return Math.floor(x);
                    case 'round': { const m = Math.pow(10, op.value); return Math.round(x * m) / m; }
                    default: throw `Unknown single op ${op.type}`;
                }
            };
            compute = r => { const x = columns[idx[0]][r]; return Number.isNaN(x) ? NaN : finite(f(x)); };
        } else if (config.mode === 'multi') {
            const op = config.multiOp;
            if (!op) throw 'Missing multiOp config';
            const fns: Record<string, (xs: number[]) => number> = {
                sum: xs => xs.reduce((a, b) => a + b, 0),
                mean: xs => xs.reduce((a, b) => a + b, 0) / xs.length,
                median,
            };
            const f = fns[op.type];
            if (!f) throw `Unknown multi op ${op.type}`;
            const needsAll = op.type === 'sum'; // operation_registry::multi_op_needs_all_inputs
            defaultName = `${op.type}(${JSON.stringify(sensors)})`;
            compute = r => {
                const all = idx.map(i => columns[i][r]);
                const valid = all.filter(v => !Number.isNaN(v));
                if (valid.length === 0 || (needsAll && valid.length !== all.length)) return NaN;
                return finite(f(valid));
            };
        } else {
            throw 'Invalid mode';
        }
        const name = (config.customName ?? '').trim() || defaultName.trim();
        if (replace) {
            const target = findCi(name);
            if (target >= 0 && idx.includes(target)) throw `'${name}' cannot be built from itself`;
        } else if (findCi(name) >= 0) {
            throw `A sensor named '${name}' already exists`;
        }
        const col = Array.from({ length: nRows }, (_, r) => compute(r));
        return store(name, col, replace);
    };

    const remove = (names: string[]): number => {
        let n = 0;
        for (const name of names) {
            if (!derived.delete(key(name))) continue;
            const idx = findCi(name);
            if (idx > 0) { headers.splice(idx, 1); columns.splice(idx, 1); n++; }
        }
        return n;
    };

    const chart = (filter: any) => {
        const cols: number[] = [];
        const outHeaders: string[] = [];
        for (const s of filter.sensors as string[]) {
            const i = headers.findIndex(h => h === s); // chart_query: exact, first
            if (i >= 0) { cols.push(i); outHeaders.push(s); }
        }
        const vfs = (filter.value_filters ?? [])
            .map((vf: any) => ({ ...vf, idx: headers.findIndex(h => h === vf.sensor) }))
            .filter((vf: any) => vf.idx >= 0); // unknown sensor -> filter dropped silently
        const passes = (r: number) => vfs.every((vf: any) => {
            const v = columns[vf.idx][r];
            if (Number.isNaN(v)) return false;
            switch (vf.operation) {
                case 'greater_than': return v > vf.value1;
                case 'less_than': return v < vf.value1;
                case 'equals': return v === vf.value1;
                case 'between': return v >= vf.value1 && v <= vf.value2;
                default: return true;
            }
        });
        const rows = Array.from({ length: nRows }, (_, r) => r).filter(passes);
        const view = {
            headers: outHeaders,
            timestamps: rows.map(r => timestamps[r]),
            series: cols.map(c => rows.map(r => (Number.isNaN(columns[c][r]) ? null : columns[c][r]))),
            total_rows: rows.length,
            ts_min: rows.length ? timestamps[rows[0]] : null,
            ts_max: rows.length ? timestamps[rows[rows.length - 1]] : null,
        };
        chartResponses.push({ filter, view });
        return view;
    };

    const checkArgs = (cmd: string, args: Args) => {
        const sig = SIGNATURES[cmd];
        if (!sig) return;
        const allowed = new Set([...sig.required, ...(sig.optional ?? [])]);
        for (const k of Object.keys(args ?? {})) {
            if (!allowed.has(k)) throw `invalid args for command ${cmd}: unexpected key '${k}' (arg-key casing?)`;
        }
        for (const k of sig.required) {
            if (!(k in (args ?? {})) || (args as Args)[k] === undefined) throw `invalid args for command ${cmd}: missing required key ${k}`;
        }
    };

    const run = (cmd: string, args: Args): unknown => {
        checkArgs(cmd, args);
        switch (cmd) {
            case 'load_csv':
                reset();
                return { headers: [...headers], total_rows: nRows };
            case 'get_all_sensors':
                if (!loaded) throw 'No data loaded';
                return [...headers];
            case 'get_loaded_paths':
                return [];
            case 'evaluate_formula':
                if (!loaded) throw 'No data loaded';
                return evalFormula(args.formula, args.customName, !!args.replace);
            case 'calculate_new_sensor':
                if (!loaded) throw 'No data loaded';
                return calcOperation(args.sensors, args.config, !!args.replace);
            case 'remove_sensor_columns':
                return loaded ? remove(args.names) : 0;
            case 'extract_formula_refs':
                return (args.formulas as string[]).map(rustExtractRefs);
            case 'rename_formula_refs':
                return rustRewrite(args.formula, args.oldName, args.newName);
            case 'validate_formula': {
                const refs = rustExtractRefs(args.formula);
                const missing = refs.find(r => resolve(r) < 0);
                return missing
                    ? { valid: false, error: `Sensor not found: ${missing}`, referenced_sensors: refs }
                    : { valid: true, error: null, referenced_sensors: refs };
            }
            case 'get_chart_data':
                return chart(args.filter);
            default:
                return null;
        }
    };

    const invoke = async (cmd: string, args: Args = {}): Promise<unknown> => {
        const entry: { cmd: string; args: Args; result?: unknown; error?: string } = { cmd, args: structuredClone(args ?? {}) };
        calls.push(entry);
        const gate = gates.find(g => g.armed && g.cmd === cmd && g.pred(args));
        if (gate) { gate.armed = false; await gate.promise; }
        const fault = faults.find(f => f.cmd === cmd && f.pred(args));
        if (fault) {
            if (fault.once) faults.splice(faults.indexOf(fault), 1);
            entry.error = fault.error;
            throw fault.error;
        }
        try {
            const result = run(cmd, args);
            entry.result = result;
            return structuredClone(result);
        } catch (e) {
            entry.error = String(e);
            throw e; // Tauri rejects with the command's Err(String) itself
        }
    };

    reset();

    return {
        invoke,
        calls,
        chartResponses,
        /** Values the CHART would read for `name` (exact, first header match). */
        chartValues: (name: string): (number | null)[] | undefined => {
            const i = headers.findIndex(h => h === name);
            return i < 0 ? undefined : columns[i].map(v => (Number.isNaN(v) ? null : v));
        },
        /** Values the formula/operation resolver would read for `name`. */
        resolvedValues: (name: string): (number | null)[] | undefined => {
            const i = resolve(name);
            return i < 0 ? undefined : columns[i].map(v => (Number.isNaN(v) ? null : v));
        },
        /** How many session columns answer to `name` (trimmed, ci). */
        columnCount: (name: string) => headers.filter(h => key(h) === key(name)).length,
        has: (name: string) => findCi(name) >= 0,
        headers: () => [...headers],
        derivedNames: () => headers.filter(h => derived.has(key(h))),
        isDerived: (name: string) => derived.has(key(name)),
        cmds: (cmd: string) => calls.filter(c => c.cmd === cmd),
        /** Make the next matching call (or every one, `once: false`) reject. */
        failOn: (cmd: string, pred: Pred, error = 'injected failure', once = true) => { faults.push({ cmd, pred, error, once }); },
        clearFaults: () => { faults.length = 0; },
        /** Hold the next matching call until `release()`; it then runs against
         *  the session AS IT IS at release time (Rust computes + commits then). */
        gate: (cmd: string, pred: Pred = () => true) => {
            let release!: () => void;
            const promise = new Promise<void>(r => { release = r; });
            const g: Gate = { cmd, pred, release, promise, armed: true };
            gates.push(g);
            return g;
        },
        generation: () => generation,
    };
}

export type FakeRust = ReturnType<typeof createFakeRust>;
