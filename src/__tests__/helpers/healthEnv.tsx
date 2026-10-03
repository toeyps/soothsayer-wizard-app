import type { FakeHealthRust } from './fakeHealthRust';

/**
 * Shared environment of the health-score integration tests (QA, 2026-10-04):
 * ONE in-memory plugin-fs (workspace JSON + exported model files), ONE plugin-store,
 * ONE Tauri event bus (every window mounted in the test talks over it, with an
 * optional `drop` switch to lose broadcasts), the fake Rust backend
 * (`fakeHealthRust.ts`) behind `invoke`, a recorder for every ECharts option
 * drawn, and the native-close handlers of `getCurrentWindow()`.
 *
 * Each test file wires its `vi.mock(...)` factories to the module objects
 * below (`await import('./helpers/healthEnv')`), so every file uses the SAME
 * semantics without copy-pasting them.
 */

export interface ChartRecord { option: any; props: any }

export const env = {
    listeners: {} as Record<string, Set<(e: any) => void>>,
    emitted: [] as { event: string; payload: any }[],
    files: new Map<string, string>(),
    /** Every write of a file (path + content), in order. */
    writes: [] as { path: string; content: string }[],
    removed: [] as string[],
    store: new Map<string, unknown>(),
    drop: null as null | ((event: string, payload: any) => boolean),
    backend: null as FakeHealthRust | null,
    charts: [] as ChartRecord[],
    closeHandlers: [] as ((e: { preventDefault: () => void }) => unknown)[],
    windowClose: 0,
};

export function resetEnv() {
    for (const k of Object.keys(env.listeners)) delete env.listeners[k];
    env.emitted.length = 0;
    env.files.clear();
    env.writes.length = 0;
    env.removed.length = 0;
    env.store.clear();
    env.drop = null;
    env.backend = null;
    env.charts.length = 0;
    env.closeHandlers.length = 0;
    env.windowClose = 0;
}

export const eventModule = () => ({
    listen: async (event: string, cb: (e: any) => void) => {
        (env.listeners[event] ??= new Set()).add(cb);
        return () => { env.listeners[event]?.delete(cb); };
    },
    emit: async (event: string, payload?: unknown) => {
        env.emitted.push({ event, payload: structuredClone(payload) });
        if (env.drop?.(event, payload)) return;
        for (const cb of [...(env.listeners[event] ?? [])]) cb({ event, payload: structuredClone(payload), id: 0 });
    },
});

const hasPrefix = (p: string) => [...env.files.keys()].some(k => k.startsWith(`${p}/`));

export const fsModule = () => ({
    readTextFile: async (p: string) => {
        const v = env.files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
    },
    writeTextFile: async (p: string, c: string) => { env.writes.push({ path: p, content: c }); env.files.set(p, c); },
    exists: async (p: string) => p === 'workspaces' || env.files.has(p) || hasPrefix(p),
    mkdir: async () => {},
    remove: async (p: string, o?: { recursive?: boolean }) => {
        env.removed.push(p);
        env.files.delete(p);
        if (o?.recursive) for (const k of [...env.files.keys()]) if (k.startsWith(`${p}/`)) env.files.delete(k);
    },
    BaseDirectory: { AppData: 'AppData' },
});

export const storeModule = () => ({
    load: async () => ({
        get: async (k: string) => env.store.get(k),
        set: async (k: string, v: unknown) => { env.store.set(k, v); },
        save: async () => {},
    }),
});

export const coreModule = () => ({
    invoke: (cmd: string, args?: any) => (env.backend ? env.backend.invoke(cmd, args) : Promise.resolve(undefined)),
});

export const windowModule = () => ({
    getCurrentWindow: () => ({
        close: async () => { env.windowClose++; },
        onCloseRequested: async (cb: (e: { preventDefault: () => void }) => unknown) => {
            env.closeHandlers.push(cb);
            return () => { const i = env.closeHandlers.indexOf(cb); if (i >= 0) env.closeHandlers.splice(i, 1); };
        },
    }),
});

/** Fires the native close of every mounted window; resolves with whether any handler prevented it. */
export async function nativeClose(): Promise<boolean> {
    let prevented = false;
    for (const cb of [...env.closeHandlers]) await cb({ preventDefault: () => { prevented = true; } });
    return prevented;
}

/** `ResponsiveECharts` stand-in: records every option it is drawn with. */
export function chartModule() {
    return {
        default: (props: any) => {
            env.charts.push({ option: props.option, props });
            const names = ((props.option?.series ?? []) as any[]).map(s => s?.name).filter(Boolean).join('|');
            return <div data-testid="echarts" data-series={names} data-y-name={props.option?.yAxis?.name ?? ''} />;
        },
    };
}

/** Series names of every chart drawn since `from`. */
export const chartSeriesNames = (from = 0): string[][] =>
    env.charts.slice(from).map(c => ((c.option?.series ?? []) as any[]).map(s => s?.name ?? ''));
