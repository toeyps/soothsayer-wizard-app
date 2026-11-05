import { createFakeRust, type FakeRust, type RawCsv } from './fakeRustSession';
import { createFakeHealthRust, type FakeHealthRust, type HealthDataset } from './fakeHealthRust';

/** Special-sensor fake and health fake behind one `invoke`, on the SAME data; `load_csv` re-points the health side. */

export interface CrossFeatureBackend {
    invoke: (cmd: string, args?: Record<string, any>) => Promise<unknown>;
    session: FakeRust;
    health: FakeHealthRust;
    /** Every call, in order (both sides). */
    calls: { cmd: string; args: any; error?: string }[];
    cmds: (cmd: string) => { cmd: string; args: any; error?: string }[];
}

const SESSION_CMDS = new Set([
    'load_csv', 'get_all_sensors', 'evaluate_formula', 'calculate_new_sensor',
    'remove_sensor_columns', 'extract_formula_refs', 'rename_formula_refs', 'validate_formula', 'get_chart_data',
]);
const MUTATING = new Set(['load_csv', 'evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns']);

export function toRaw(d: HealthDataset): RawCsv {
    return {
        headers: [...d.headers],
        columns: d.headers.slice(1).map(h => (d.columns[h] ?? []).map(v => (v === null || v === undefined ? NaN : v))),
    };
}

export function createCrossFeatureBackend(opts: {
    /** Datasets by `load_csv` paths joined with `|`. */
    datasets: Record<string, HealthDataset>;
    files: Map<string, string>;
}): CrossFeatureBackend {
    const first = Object.values(opts.datasets)[0];
    const raws = Object.fromEntries(Object.entries(opts.datasets).map(([k, d]) => [k, toRaw(d)]));
    const session = createFakeRust(raws[Object.keys(raws)[0]], { datasets: raws });
    // The health side reads THIS object; it is rewritten in place on every sync.
    const live: HealthDataset = { headers: [...first.headers], timestamps: [...first.timestamps], columns: { ...first.columns } };
    const health = createFakeHealthRust({ datasets: { live }, initial: 'live', files: opts.files });
    let loadedKey = Object.keys(opts.datasets)[0];
    const calls: CrossFeatureBackend['calls'] = [];

    const sync = () => {
        const src = opts.datasets[loadedKey];
        live.headers = session.headers();
        live.timestamps = [...src.timestamps];
        live.columns = Object.fromEntries(live.headers.slice(1).map(h => [h, session.chartValues(h) ?? []]));
        while (health.generation() < session.generation()) health.loadDataset('live');
    };

    const invoke = async (cmd: string, args: Record<string, any> = {}) => {
        const entry: { cmd: string; args: any; error?: string } = { cmd, args: structuredClone(args) };
        calls.push(entry);
        try {
            if (SESSION_CMDS.has(cmd)) {
                const r = await session.invoke(cmd, args);
                if (cmd === 'load_csv') loadedKey = (args.paths as string[]).join('|');
                if (MUTATING.has(cmd)) {
                    sync();
                    // A replaced/removed special sensor invalidates every cached fit (lib.rs drops the cache with the column).
                    if (cmd !== 'load_csv') health.clearRelCache();
                }
                return r;
            }
            switch (cmd) {
                case 'get_scatter_sample': return { headers: [], rows: [], total: 0, sampled: 0 };
                case 'load_metadata_command':
                case 'load_mapping_csv':
                case 'apply_sensor_mapping':
                case 'log_frontend_error':
                case 'get_error_log_path':
                    return null;
                default:
                    return await health.invoke(cmd, args);
            }
        } catch (e) {
            entry.error = String(e);
            throw e;
        }
    };

    return { invoke, session, health, calls, cmds: (c: string) => calls.filter(x => x.cmd === c) };
}
