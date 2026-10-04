/**
 * Special sensors across a WORKSPACE SWITCH (qa-agent, 2026-10-03).
 *
 * User report (never re-verified after the 2026-10-03 special-sensor rewrite):
 * "special sensors of workspace A show up when I open workspace B".
 *
 * Mounts the REAL App (so the real DataUploadPage -> Dashboard hand-off, the
 * `key={workspace id}` remount and "Back to Import" are exercised), the REAL
 * Dashboard, and the REAL Add Special Sensor window -- spawned by the
 * Dashboard's own "Add special sensor" button through a fake `WebviewWindow`
 * and mounted in its own React root, the way Tauri gives it its own webview.
 * Everything talks over one shared fake Tauri event bus (payloads are
 * structured-cloned, events can be held and delivered late) and one fake Rust
 * session (`helpers/fakeRustSession.ts`) whose `load_csv` behaves like lib.rs:
 * a NEW session per load (raw columns of THAT dataset only, empty derived set,
 * new generation), a failed load keeps the old session, and a computation
 * that was running when the session was replaced is refused (`commit_derived`
 * generation check).
 *
 * Windows that should have been closed when the Dashboard unmounted can be
 * kept alive (`h.closeMode = 'ignore'`) to model a close that failed or came
 * late -- the CLAUDE.md "multi-project isolation" note calls closing them the
 * mitigation, not a structural fix, and this is what it has to cover.
 *
 * Bugs were recorded as `it.fails` with the repro in the title. 2026-10-03: ALL 14
 * are fixed (dataset generation pinned on every guarded Rust command, STALE_SESSION
 * handling, window epoch, `workspace-closing`, latest-click-wins on load, autosave
 * flush on Back) and are plain `it`s now -- the `// BUG` comments above them are
 * the original repro notes. Section `2b-guard` covers the case where BOTH the
 * window close and the `workspace-closing` broadcast are lost, i.e. only the Rust
 * generation guard is left.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup, within } from '@testing-library/react';
import type { SensorMetadata, WorkspaceState, SpecialSensorRecipe } from '../types';
import { createFakeRust, STALE_SESSION_ERROR, type FakeRust, type RawCsv } from './helpers/fakeRustSession';
import { mk } from './helpers/failureModelFixture';

// ── Shared fake Tauri: event bus, windows, workspace disk, dialogs ───────

const h = vi.hoisted(() => {
    type Cb = (e: { event: string; payload: unknown }) => void;
    const listeners: Record<string, Cb[]> = {};
    const log: Array<{ event: string; payload: any }> = [];
    let held: Array<{ event: string; payload: any }> | null = null;
    let holdFilter: ((event: string, payload: any) => boolean) | null = null;
    const clone = (p: unknown) => (p === undefined ? undefined : structuredClone(p));
    const deliver = (event: string, payload: unknown) => {
        for (const cb of [...(listeners[event] ?? [])]) cb({ event, payload: clone(payload) });
    };
    interface FakeWin { label: string; close: (...a: any[]) => Promise<void>; setFocus: () => Promise<void> }
    interface DiskGate { id: string; armed: boolean; promise: Promise<void>; release: () => void }
    const state = {
        rust: null as any,
        listeners,
        log,
        disk: new Map<string, any>(),
        writes: [] as Array<{ id: string; state: any }>,
        diskGates: [] as DiskGate[],
        message: vi.fn(async (_text: string, _opts?: unknown) => undefined),
        dialogOpen: null as unknown,
        /** Labels `new WebviewWindow(label)` was asked to create. */
        spawned: [] as string[],
        /** Open (mounted) sub-windows, as `WebviewWindow.getByLabel` sees them. */
        windows: new Map<string, FakeWin>(),
        /** 'immediate': `close()` really closes; 'ignore': the close is lost. */
        closeMode: 'immediate' as 'immediate' | 'ignore',
        closeCalls: [] as string[],
        onClose: null as null | ((label: string) => void),
        focusHandlers: [] as Array<(e: { payload: boolean }) => void>,
        listen(event: string, cb: Cb) {
            (listeners[event] ??= []).push(cb);
            return Promise.resolve(() => {
                listeners[event] = (listeners[event] ?? []).filter(c => c !== cb);
            });
        },
        emit(event: string, payload?: unknown) {
            log.push({ event, payload: clone(payload) });
            if (held && (!holdFilter || holdFilter(event, payload))) held.push({ event, payload: clone(payload) });
            else deliver(event, payload);
            return Promise.resolve();
        },
        hold(filter?: (event: string, payload: any) => boolean) { held = []; holdFilter = filter ?? null; },
        release(order?: number[]) {
            const q = held ?? [];
            held = null;
            holdFilter = null;
            for (const i of order ?? q.map((_, k) => k)) deliver(q[i].event, q[i].payload);
            return q;
        },
        /** Hold the next `loadWorkspaceData(id)` until released. */
        gateDisk(id: string) {
            let release!: () => void;
            const promise = new Promise<void>(r => { release = r; });
            const g = { id, armed: true, promise, release };
            state.diskGates.push(g);
            return g;
        },
        makeWin(label: string): FakeWin {
            return {
                label,
                close: vi.fn(async () => {
                    state.closeCalls.push(label);
                    if (state.closeMode === 'immediate') state.onClose?.(label);
                }),
                setFocus: vi.fn(async () => {}),
            };
        },
        reset() {
            for (const k of Object.keys(listeners)) delete listeners[k];
            log.length = 0;
            held = null;
            holdFilter = null;
            state.disk.clear();
            state.writes.length = 0;
            state.diskGates.length = 0;
            state.spawned.length = 0;
            state.windows.clear();
            state.closeMode = 'immediate';
            state.closeCalls.length = 0;
            state.focusHandlers.length = 0;
            state.dialogOpen = null;
        },
    };
    return state;
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: any) => h.rust.invoke(cmd, args) }));
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => h.listen(event, cb),
    emit: (event: string, payload?: unknown) => h.emit(event, payload),
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        // Only the Add Special Sensor window closes itself in these tests.
        close: () => { h.onClose?.('add-sensor'); return Promise.resolve(); },
        onCloseRequested: () => Promise.resolve(() => {}),
        onFocusChanged: (cb: any) => {
            h.focusHandlers.push(cb);
            return Promise.resolve(() => { h.focusHandlers.splice(h.focusHandlers.indexOf(cb), 1); });
        },
        destroy: () => Promise.resolve(),
        hide: () => Promise.resolve(),
        setFocus: () => Promise.resolve(),
    }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class {
        constructor(label: string) { h.spawned.push(label); }
        once = () => Promise.resolve(() => {});
        static getByLabel = (label: string) => Promise.resolve(h.windows.get(label) ?? null);
    },
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('0.0.0') }));
// The Import page's step-0 illustration is a canvas animation; jsdom has no 2D
// context (and logs "Not implemented" on every getContext) -- stand in a marker.
vi.mock('../components/upload/MachineMorphCanvas', () => ({ default: () => null }));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: (text: string, opts: unknown) => h.message(text, opts),
    ask: () => Promise.resolve(true),
    open: () => Promise.resolve(h.dialogOpen),
    save: () => Promise.resolve(null),
}));
vi.mock('split.js', () => ({ default: () => ({ destroy: () => {} }) }));

vi.mock('../workspaceManager', () => {
    const clone = <T,>(v: T): T => (v == null ? v : structuredClone(v));
    return {
        saveWorkspaceData: async (state: any) => {
            h.writes.push({ id: state.id, state: clone(state) });
            h.disk.set(state.id, clone(state));
        },
        loadWorkspaceData: async (id: string) => {
            const g = h.diskGates.find(x => x.armed && x.id === id);
            if (g) { g.armed = false; await g.promise; }
            return clone(h.disk.get(id) ?? null);
        },
        updateWorkspaceData: async (id: string, patch: (s: any) => any) => {
            const next = patch(clone(h.disk.get(id) ?? { id }));
            h.writes.push({ id, state: clone(next) });
            h.disk.set(id, clone(next));
            return clone(next);
        },
        getRecentWorkspaces: async () =>
            [...h.disk.values()].map((s: any) => ({ id: s.id, name: s.name, lastModified: 1, filePath: `/ws/${s.id}.json` })),
        deleteWorkspace: async () => {},
        renameWorkspaceFile: async () => {},
        duplicateWorkspace: async () => {},
        writeUserTextFile: async () => {},
    };
});

// App chrome that is irrelevant here.
vi.mock('../components/TitleBar', () => ({ default: () => <div data-testid="titlebar" /> }));
vi.mock('../hooks/useAppMenu', () => ({ useAppMenu: () => {} }));
vi.mock('../components/ErrorToasts', () => ({ default: () => null }));

// Heavy Dashboard children: replaced with prop-capturing stand-ins.
const sensorSelectionProps: any[] = [];
vi.mock('../components/dashboard/SensorSelection', () => ({
    default: (props: any) => { sensorSelectionProps.push(props); return <div data-testid="sensor-selection" />; },
}));
vi.mock('../components/charts', () => ({
    Chart: () => <div data-testid="chart" />,
    defaultSensorColor: (tag: string) => `default-${tag}`,
    LINE_CHART_COLORS: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
    MAX_PAIR_PLOT_SENSORS: 4,
    RANGE_PALETTE: [[0.9, 0.7, 0.1, 1], [0.2, 0.8, 0.6, 1], [0.8, 0.4, 0.9, 1], [0.9, 0.4, 0.4, 1]],
}));
vi.mock('../components/dashboard/FilterPanel', () => ({ default: () => <div data-testid="filter-panel" /> }));
vi.mock('../components/dashboard/FailureGroupsPanel', () => ({ default: () => <div data-testid="fg-panel" /> }));
vi.mock('../components/dashboard/HighlightsPanel', () => ({ default: () => <div data-testid="hl-panel" /> }));
vi.mock('../components/dashboard/ColorPlatePicker', () => ({ default: () => <div /> }));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: () => ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null }),
}));
vi.mock('../hooks/useDatasetTimeBounds', () => ({
    useDatasetTimeBounds: () => ({ bounds: null, loading: false, error: null }),
}));

import App from '../App';
import AddSensorWindow from '../components/windows/AddSensorWindow';
// Warm App's lazy Dashboard chunk so <Suspense> resolves within a flush.
import '../components/dashboard';
import { getErrors, dismissAllErrors } from '../errorReporter';

// ── Fixtures ────────────────────────────────────────────────────────────

const HEADERS = ['timestamp', 'TAG1', 'TAG2', 'TAG3', 'TAG4'];
const RAW_A: RawCsv = {
    headers: HEADERS,
    columns: [[1, 2, 3, 4], [10, 20, NaN, 40], [100, 200, 300, 400], [5, 5, 5, 5]],
};
const RAW_B: RawCsv = {
    headers: HEADERS,
    columns: [[7, 8, 9, 10], [1, 1, 1, 1], [1000, 2000, 3000, 4000], [3, 3, 3, 3]],
};
const PATH_A = '/data/a.csv';
const PATH_B = '/data/b.csv';
const A_ID = 'wsA';
const B_ID = 'wsB';

const F = (tag: string, formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula });
const meta = (tag: string, description: string, component: string): SensorMetadata =>
    ({ tag, description, unit: 'u', component });

const A_RECIPES = [F('S1', '$TAG1 * 2'), F('S2', '${S1} + $TAG3')];
const A_META = [meta('S1', 'Alpha S1', 'AlphaComp'), meta('S2', 'Alpha S2', 'AlphaComp')];
const A_MODEL = mk({ id: 'mA', name: 'Alpha model', kind: 'relationship', targetSensor: 'S1' });

/** B's own special sensors -- SAME names as A's, different formulas. */
const B_RECIPES = [F('S1', '$TAG1 * 100'), F('S2', '$TAG4 - 1')];
const B_META = [meta('S1', 'Beta S1', 'BetaComp'), meta('S2', 'Beta S2', 'BetaComp')];

function wsA(over: Partial<WorkspaceState> = {}): WorkspaceState {
    return {
        id: A_ID, name: 'Alpha', lastRoute: 'dashboard', dataFilePaths: [PATH_A], metadataFilePath: null,
        selectedSensors: ['TAG1', 'S1', 'S2'], visibleSensors: ['TAG1', 'S1', 'S2'], operationConfig: null,
        specialSensorRecipes: A_RECIPES, extraSensorMetadata: A_META,
        failureGroupState: { groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'Alpha group' }], models: [A_MODEL] } as any,
        ...over,
    };
}
function wsB(opts: { samePath?: boolean; specials?: boolean } = {}, over: Partial<WorkspaceState> = {}): WorkspaceState {
    const specials = opts.specials ?? true;
    return {
        id: B_ID, name: 'Beta', lastRoute: 'dashboard', dataFilePaths: [opts.samePath ? PATH_A : PATH_B], metadataFilePath: null,
        selectedSensors: specials ? ['S2'] : ['TAG2'], visibleSensors: specials ? ['S2'] : ['TAG2'], operationConfig: null,
        ...(specials ? { specialSensorRecipes: B_RECIPES, extraSensorMetadata: B_META } : {}),
        ...over,
    };
}

/** What `recipes` produce from `raw` (a scratch session). */
async function valuesOf(raw: RawCsv, recipes: SpecialSensorRecipe[], tag: string) {
    const f = createFakeRust(raw);
    for (const r of recipes) {
        if (r.kind === 'formula') await f.invoke('evaluate_formula', { formula: r.formula, customName: r.tag, replace: true });
    }
    return f.resolvedValues(tag);
}

let rust: FakeRust;

// ── Async helpers (fake timers throughout) ─────────────────────────────

async function flush(n = 15) {
    for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
}
async function tick(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await flush();
}

// ── App / Dashboard / import page ───────────────────────────────────────

let app: ReturnType<typeof render> | null = null;
const A = () => within(app!.container);

async function renderApp() {
    await act(async () => { app = render(<App />); });
    await flush();
}

/** Click a workspace in the import page's "Recent projects" list. */
async function openRecent(name: string, opts: { settle?: boolean } = {}) {
    await act(async () => { fireEvent.click(A().getAllByText(name)[0]); });
    if (opts.settle === false) { await flush(); return; }
    await flush(40);
    await tick(800);
    await tick(300); // Dashboard's first chart fetch
}

const onDashboard = () => !!app!.container.querySelector('button[title="Back to Import"]');

async function backToImport() {
    const btn = app!.container.querySelector('button[title="Back to Import"]') as HTMLButtonElement;
    if (!btn) throw new Error('not on the Dashboard');
    sensorSelectionProps.length = 0;
    await act(async () => { fireEvent.click(btn); });
    await flush(20);
}

const dashProps = () => {
    const p = sensorSelectionProps[sensorSelectionProps.length - 1];
    if (!p) throw new Error('no Dashboard rendered since the last switch');
    return p;
};
const dashSelected = (): string[] => dashProps().selectedSensors;
const dashListed = (): string[] => dashProps().sensors;
const dashMeta = (tag: string): SensorMetadata | undefined =>
    (dashProps().sensorMetadata as SensorMetadata[] | null)?.find(m => m.tag === tag);

/** What the line chart last received for `tag` from get_chart_data. */
function chartSeriesFor(tag: string): (number | null)[] | undefined {
    for (let i = rust.chartResponses.length - 1; i >= 0; i--) {
        const { view } = rust.chartResponses[i];
        const k = view.headers.indexOf(tag);
        if (k >= 0) return view.series[k];
        if ((rust.chartResponses[i].filter.sensors as string[]).includes(tag)) return undefined;
    }
    return undefined;
}

const ws = (id: string) => h.disk.get(id) as WorkspaceState;
const k = (s: string) => s.trim().toLowerCase();

// ── The Add Special Sensor window (its own React root) ───────────────────

let win: ReturnType<typeof render> | null = null;
const W = () => within(win!.container);

function unmountWindow(label: string) {
    if (label === 'add-sensor' && win) {
        const w = win;
        win = null;
        h.windows.delete('add-sensor');
        w.unmount();
    } else {
        h.windows.delete(label);
    }
}

/** Click the Dashboard's "Add special sensor" button. A new window is
 *  mounted like Tauri would create it; an existing one is re-pointed (the
 *  Dashboard re-sends `sensors-data`). */
async function clickAddSpecialSensor() {
    const btn = app!.container.querySelector('.add-sensor-btn') as HTMLButtonElement;
    if (!btn) throw new Error('no Add special sensor button');
    await act(async () => { fireEvent.click(btn); });
    await flush(20);
    if (h.spawned.includes('add-sensor') && !win) {
        h.spawned.splice(h.spawned.indexOf('add-sensor'), 1);
        await act(async () => { win = render(<AddSensorWindow />); });
        h.windows.set('add-sensor', h.makeWin('add-sensor'));
        await flush(20);
    }
}

/** A Build Model window that is open (not mounted -- only its presence and
 *  its close matter to the Dashboard). */
function openBuildModelWindow() {
    h.windows.set('build-model', h.makeWin('build-model'));
}

const createBody = () => win!.container.querySelector('.special-sensor-body') as HTMLElement;

function explorerRow(tag: string): HTMLElement | undefined {
    const rows = Array.from(createBody().querySelectorAll('.special-sensor-row')) as HTMLElement[];
    return rows.find(r => (r.querySelector('.sensor-row-tag')?.textContent ?? r.querySelector('.special-sensor-row-name')?.textContent) === tag);
}
async function setSearch(term: string) {
    const input = createBody().querySelector('.special-sensor-explorer-search input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: term } }); });
}
async function pick(...tags: string[]) {
    for (const tag of tags) {
        await setSearch(tag);
        const row = explorerRow(tag);
        if (!row) throw new Error(`no explorer row for ${tag}`);
        await act(async () => { fireEvent.click(row); });
    }
    await setSearch('');
    await flush();
}
function labelledInput(labelText: string): HTMLInputElement {
    const labels = Array.from(createBody().querySelectorAll('label'));
    const label = labels.find(l => l.textContent?.replace('*', '').trim() === labelText);
    if (!label) throw new Error(`no label ${labelText}`);
    return label.parentElement!.querySelector('input, select') as HTMLInputElement;
}
const nameField = () => createBody().querySelector('input[placeholder="e.g. Total Power"]') as HTMLInputElement | null;
async function fillCreate(name: string, opts: { description?: string; unit?: string; component?: string } = {}) {
    const nameInput = nameField();
    if (!nameInput) throw new Error('Name field not shown -- nothing is being created');
    await act(async () => { fireEvent.change(nameInput, { target: { value: name } }); });
    await act(async () => { fireEvent.change(labelledInput('Description'), { target: { value: opts.description ?? `${name} desc` } }); });
    await act(async () => { fireEvent.change(labelledInput('Unit'), { target: { value: opts.unit ?? 'u' } }); });
    await act(async () => { fireEvent.change(createBody().querySelector('select[aria-label="Component"]')!, { target: { value: opts.component ?? 'Uncategorized' } }); });
    await flush();
}
async function typeFormula(formula: string) {
    const toggle = W().queryByText('Edit as text instead');
    if (toggle) await act(async () => { fireEvent.click(toggle); });
    const ta = createBody().querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(ta, { target: { value: formula, selectionStart: formula.length } }); });
    await flush();
}
const addBtn = () => W().getByText('Add sensor').closest('button') as HTMLButtonElement;
async function clickAdd(opts: { settle?: boolean } = {}) {
    await act(async () => { fireEvent.click(addBtn()); });
    await flush(20);
    if (opts.settle !== false) await tick(300);
}
async function goManage() {
    await act(async () => { fireEvent.click(W().getByRole('tab', { name: /Manage/ })); });
    await flush();
}
async function goCreate() {
    await act(async () => { fireEvent.click(W().getByRole('tab', { name: /Create/ })); });
    await flush();
}
async function createFormula(name: string, formula: string, opts: { settle?: boolean; description?: string } = {}) {
    await goCreate();
    await typeFormula(formula);
    await fillCreate(name, { description: opts.description });
    await clickAdd(opts);
}
async function deleteSensor(tag: string) {
    await goManage();
    const btn = W().getByLabelText(`Delete ${tag}`) as HTMLButtonElement;
    if (btn.disabled) throw new Error(`Delete ${tag} is disabled`);
    await act(async () => { fireEvent.click(btn); });
    await flush();
}
async function openEditor(tag: string) {
    await goManage();
    await act(async () => { fireEvent.click(W().getByLabelText(`Edit ${tag}`)); });
    await flush();
}
async function setEditor(fields: { name?: string; formula?: string }) {
    if (fields.name !== undefined) await act(async () => { fireEvent.change(W().getByLabelText('Name'), { target: { value: fields.name } }); });
    if (fields.formula !== undefined) await act(async () => { fireEvent.change(W().getByLabelText('Formula'), { target: { value: fields.formula } }); });
    await flush();
}
async function clickSaveEditor(opts: { settle?: boolean } = {}) {
    const btn = W().getByText('Save changes').closest('button') as HTMLButtonElement;
    if (btn.disabled) throw new Error(`Save is disabled: ${W().queryAllByRole('alert').map(a => a.textContent).join(' / ')}`);
    await act(async () => { fireEvent.click(btn); });
    await flush(30);
    if (opts.settle !== false) await tick(300);
}

// ── Composite flows ─────────────────────────────────────────────────────

/** Both workspaces on disk; the App on the import page. */
async function start(b: WorkspaceState | null = wsB(), a: WorkspaceState = wsA()) {
    h.disk.set(a.id, structuredClone(a));
    if (b) h.disk.set(b.id, structuredClone(b));
    await renderApp();
}

/** The Rust session's invariant for the workspace on screen: its derived
 *  columns are exactly its recipes' tags, each holding what ITS recipe
 *  produces from ITS dataset. */
async function expectSessionIs(raw: RawCsv, recipes: SpecialSensorRecipe[]) {
    expect(rust.derivedNames().map(k).sort(), 'derived columns in the session').toEqual(recipes.map(r => k(r.tag)).sort());
    for (const r of recipes) {
        expect(rust.columnCount(r.tag), `columns named ${r.tag}`).toBe(1);
        expect(rust.resolvedValues(r.tag), `values of ${r.tag}`).toEqual(await valuesOf(raw, recipes, r.tag));
    }
}

/** A's alive window: open A, open the Add Special Sensor window (and a Build
 *  Model window), then switch to B with both closes LOST. */
async function switchWithWindowsLeftOpen(b: WorkspaceState = wsB(), beforeSwitch?: () => Promise<void>) {
    await start(b);
    await openRecent('Alpha');
    await clickAddSpecialSensor();
    openBuildModelWindow();
    if (beforeSwitch) await beforeSwitch();
    await tick(400); // A's autosave
    h.closeMode = 'ignore';
    await backToImport();
    await openRecent('Beta');
    await tick(400);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    h.reset();
    h.message.mockClear();
    h.onClose = unmountWindow;
    sensorSelectionProps.length = 0;
    rust = createFakeRust(RAW_A, { datasets: { [PATH_A]: RAW_A, [PATH_B]: RAW_B } });
    h.rust = rust;
    dismissAllErrors();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    app = null;
    win = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// 1. A clean switch A -> Import -> B
// ═════════════════════════════════════════════════════════════════════════

describe('1. A -> Back to Import -> B: nothing of A reaches B', () => {
    it.each([
        ['a different CSV', false],
        ['the SAME CSV path as A', true],
    ])('B with NO special sensors on %s: B\'s sensor list, metadata, selection, Build Model data, session and file contain none of A\'s S1/S2; A\'s file is untouched', async (_label, samePath) => {
        await start(wsB({ samePath, specials: false }));
        await openRecent('Alpha');
        // Sanity: A is really built and plotted.
        await expectSessionIs(RAW_A, A_RECIPES);
        expect(dashListed()).toEqual(expect.arrayContaining(['S1', 'S2']));
        expect(chartSeriesFor('S2')).toEqual([102, 204, 306, 408]);
        await tick(400);
        const aBefore = structuredClone(ws(A_ID));

        await backToImport();
        const writesFrom = h.writes.length;
        await openRecent('Beta');
        await tick(400);

        // Session: B's raw data only.
        expect(rust.loadedPaths()).toEqual([samePath ? PATH_A : PATH_B]);
        expect(rust.derivedNames()).toEqual([]);
        expect(rust.headers()).toEqual(HEADERS);
        // Dashboard: no S1/S2 anywhere.
        expect(dashListed()).toEqual(['TAG1', 'TAG2', 'TAG3', 'TAG4']);
        expect(dashSelected()).toEqual(['TAG2']);
        expect(dashMeta('S1')).toBeUndefined();
        expect(dashMeta('S2')).toBeUndefined();
        expect(rust.chartResponses[rust.chartResponses.length - 1].filter.sensors).toEqual(['TAG2']);

        // Exactly ONE Dashboard answers each request, and it is B's.
        const from = h.log.length;
        await act(async () => { await h.emit('request-sensors'); await h.emit('request-build-model-data'); });
        await flush();
        const replies = h.log.slice(from).filter(e => e.event === 'sensors-data' || e.event === 'build-model-data');
        expect(replies.map(e => [e.event, e.payload.workspaceId])).toEqual([['sensors-data', B_ID], ['build-model-data', B_ID]]);
        const sd = replies[0].payload;
        expect(sd.sensors).toEqual(['TAG1', 'TAG2', 'TAG3', 'TAG4']);
        expect(sd.specialSensorRecipes).toEqual([]);
        expect(sd.models).toEqual([]);
        expect((sd.sensorMetadata ?? []).map((m: SensorMetadata) => m.tag)).toEqual([]);
        const bm = replies[1].payload;
        expect(bm.sensorHeaders).toEqual(['TAG1', 'TAG2', 'TAG3', 'TAG4']);
        expect((bm.sensorMetadata ?? []).map((m: SensorMetadata) => m.tag)).toEqual([]);

        // Files: B's autosaves carry nothing of A; A's file never written again.
        const bWrites = h.writes.slice(writesFrom).filter(w => w.id === B_ID);
        expect(bWrites.length).toBeGreaterThan(0);
        for (const w of bWrites) {
            const text = JSON.stringify(w.state);
            expect(text).not.toMatch(/Alpha|"S1"|"S2"|mA/);
        }
        expect(h.writes.slice(writesFrom).filter(w => w.id === A_ID)).toEqual([]);
        expect(ws(A_ID)).toEqual(aBefore);
        expect(getErrors()).toHaveLength(0);
    });

    it.each([
        ['a different CSV', false],
        ['the SAME CSV path as A', true],
    ])('B with its OWN same-named S1/S2 (different formulas) on %s: B\'s S1/S2 hold B\'s values and metadata, listed once, and neither file gets the other\'s recipes', async (_label, samePath) => {
        await start(wsB({ samePath }));
        await openRecent('Alpha');
        await tick(400);
        const aBefore = structuredClone(ws(A_ID));
        await backToImport();
        const writesFrom = h.writes.length;
        await openRecent('Beta');
        await tick(400);

        const rawB = samePath ? RAW_A : RAW_B;
        await expectSessionIs(rawB, B_RECIPES);
        expect(chartSeriesFor('S2')).toEqual((await valuesOf(rawB, B_RECIPES, 'S2'))!);
        expect(dashSelected()).toEqual(['S2']);
        const listed = dashListed();
        expect(listed.filter(t => k(t) === 's1')).toHaveLength(1);
        expect(listed.filter(t => k(t) === 's2')).toHaveLength(1);
        expect(dashMeta('S1')).toEqual(B_META[0]);
        expect(dashMeta('S2')).toEqual(B_META[1]);

        const from = h.log.length;
        await act(async () => { await h.emit('request-sensors'); await h.emit('request-build-model-data'); });
        await flush();
        const sd = h.log.slice(from).find(e => e.event === 'sensors-data')!.payload;
        expect(sd.workspaceId).toBe(B_ID);
        expect(sd.specialSensorRecipes).toEqual(B_RECIPES);
        expect(sd.models).toEqual([]);
        expect(sd.sensorMetadata.filter((m: SensorMetadata) => ['S1', 'S2'].includes(m.tag))).toEqual(B_META);
        const bm = h.log.slice(from).find(e => e.event === 'build-model-data')!.payload;
        expect(bm.sensorMetadata.filter((m: SensorMetadata) => ['S1', 'S2'].includes(m.tag))).toEqual(B_META);

        for (const w of h.writes.slice(writesFrom).filter(w => w.id === B_ID)) {
            expect(w.state.specialSensorRecipes).toEqual(B_RECIPES);
            expect(w.state.extraSensorMetadata).toEqual(B_META);
            expect(JSON.stringify(w.state)).not.toMatch(/Alpha|mA/);
        }
        expect(ws(A_ID)).toEqual(aBefore);
    });

    it('B\'s Add Special Sensor window (opened fresh in B) lists only B\'s sensors, recipes and metadata, and Manage shows B\'s S1 unlocked (A\'s model on S1 does not follow)', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await clickAddSpecialSensor();
        await backToImport(); // closes the window (closeMode immediate)
        expect(win).toBeNull();
        await openRecent('Beta');
        await clickAddSpecialSensor();
        expect(win).not.toBeNull();
        await goManage();
        expect(W().queryByText('Alpha S1')).toBeNull();
        expect(W().getAllByText(/Beta S1/).length).toBeGreaterThan(0);
        expect(W().queryByText(/Alpha model/)).toBeNull();
        expect((W().getByLabelText('Delete S2') as HTMLButtonElement).disabled).toBe(false);
        await openEditor('S1');
        expect(W().queryByTestId('edit-lock-banner')).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Windows left OPEN across the switch (close lost / late)
// ═════════════════════════════════════════════════════════════════════════

describe('2a. late events from A\'s still-alive windows are ignored by B\'s Dashboard', () => {
    it('Dashboard A\'s unmount asks BOTH the add-sensor and build-model windows to close', async () => {
        await switchWithWindowsLeftOpen();
        expect(h.closeCalls.sort()).toEqual(['add-sensor', 'build-model']);
    });

    it('every A-scoped event arriving after B is loaded (add/delete/update/rename/data-changed/plot-result/FG-changed/sensors-data) leaves B\'s Dashboard, B\'s file and B\'s chart untouched', async () => {
        await switchWithWindowsLeftOpen();
        const bBefore = structuredClone(ws(B_ID));
        const listedBefore = dashListed();
        const selectedBefore = dashSelected();
        const chartCallsBefore = rust.cmds('get_chart_data').length;
        const writesFrom = h.writes.length;

        const late: Array<[string, any]> = [
            ['add-sensor-selection', { sensors: ['S9'], operation: null, newMetadata: [meta('S9', 'Alpha S9', 'AlphaComp')], newRecipes: [F('S9', '$TAG1 + 9')], workspaceId: A_ID }],
            ['delete-special-sensors', { tags: ['S1', 'S2'], workspaceId: A_ID }],
            ['update-special-sensor', { recipe: F('S2', '$TAG1 * 9'), metadata: meta('S2', 'Alpha S2 edited', 'AlphaComp'), recomputed: ['S2'], workspaceId: A_ID }],
            ['rename-special-sensor', { oldTag: 'S2', newTag: 'S3', recipe: F('S3', '${S1} + $TAG3'), metadata: meta('S3', 'Alpha S3', 'AlphaComp'), updatedRecipes: [], workspaceId: A_ID }],
            ['special-sensor-data-changed', { workspaceId: A_ID }],
            ['add-sensor-plot-result', { workspaceId: A_ID, selectedSensors: ['TAG1', 'S1'] }],
            ['failure-group-state-changed', { ...wsA().failureGroupState, workspaceId: A_ID, origin: 'build-model' }],
            ['failure-group-state-changed', { ...wsA().failureGroupState, workspaceId: A_ID, origin: 'other-window' }],
            ['sensors-data', { workspaceId: A_ID, sensors: ['TAG1', 'S1', 'S2'], selectedSensors: ['S1'], sensorMetadata: A_META, specialSensorRecipes: A_RECIPES, models: [A_MODEL] }],
        ];
        for (const [event, payload] of late) {
            await act(async () => { await h.emit(event, payload); });
            await flush();
        }
        // Payloads with NO workspace id are foreign too.
        await act(async () => { await h.emit('add-sensor-selection', { sensors: ['S8'], operation: null, newMetadata: [], newRecipes: [F('S8', '$TAG1')] }); });
        await act(async () => { await h.emit('delete-special-sensors', { tags: ['S2'] }); });
        await tick(400);

        expect(dashListed()).toEqual(listedBefore);
        expect(dashSelected()).toEqual(selectedBefore);
        expect(rust.cmds('get_chart_data').length).toBe(chartCallsBefore);
        expect(h.writes.slice(writesFrom).filter(w => w.id === B_ID)).toEqual([]);
        expect(ws(B_ID)).toEqual(bBefore);
        expect(ws(B_ID).failureGroupState?.models ?? []).toEqual([]);
        await expectSessionIs(RAW_B, B_RECIPES);
    });
});

describe('2b. A\'s still-alive window, NOT re-pointed, acting after B is loaded', () => {
    // BUG: the window still serves A (its sensors-data never changed) but every
    // Rust command it sends runs against the ONE shared session -- now B's.
    // Its delete commit fires 8 s after the click, reads A's file (nothing uses
    // S2 in A), then `remove_sensor_columns(['S2'])` drops B's OWN S2 column.
    // Its emit carries A's id, so B's Dashboard keeps listing and plotting S2
    // with no data behind it.
    it('A\'s window: delete S2 (undo window) -> Back (close lost) -> open B (own S2) -> 8 s later the commit drops B\'s S2 column from the session while B still lists/plots S2', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => { await deleteSensor('S2'); });
        const from = rust.calls.length; // B is loaded and replayed
        await tick(9000);
        expect(dashListed()).toContain('S2'); // B still lists it ...
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
        expect(rust.calls.slice(from).filter(c => c.cmd === 'remove_sensor_columns')).toEqual([]); // ... but its column was dropped
        await expectSessionIs(RAW_B, B_RECIPES);
    });

    // BUG: same channel -- an edit in the stale window recomputes S2 with
    // `replace: true` in B's session, overwriting B's S2 with A's formula
    // (computed from B's S1 and B's raw data). B's recipe still says
    // `$TAG4 - 1`; its chart and every model trained on S2 now read A's.
    it('A\'s window left open -> open B (own S2 = $TAG4 - 1) -> in A\'s window edit S2 to $TAG1 * 9 -> B\'s S2 column now holds A\'s formula values while B\'s recipe is unchanged', async () => {
        await switchWithWindowsLeftOpen();
        await openEditor('S2');
        await setEditor({ formula: '$TAG1 * 9' });
        await clickSaveEditor();
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
        await expectSessionIs(RAW_B, B_RECIPES);
    });

    // BUG (low-medium): a create in the stale window adds an orphan derived
    // column to B's session (B's Dashboard drops the A-scoped event). The name
    // is then taken in B's session: B creating its own "S9" fails with
    // "already exists" for a sensor B never had.
    it('A\'s window left open -> open B -> create S9 in A\'s window -> B\'s session gains an orphan derived column S9 that B does not list', async () => {
        await switchWithWindowsLeftOpen();
        await createFormula('S9', '$TAG1 + 9');
        expect(dashListed()).not.toContain('S9');
        expect(rust.has('S9')).toBe(false);
    });

    // BUG: rename in the stale window: recompute under the new name in B's
    // session, then remove the OLD name -- B's own S2.
    it('A\'s window left open -> open B (own S2) -> rename S2 -> S3 in A\'s window -> B\'s S2 column is removed and an orphan S3 appears in B\'s session', async () => {
        await switchWithWindowsLeftOpen();
        await openEditor('S2');
        await setEditor({ name: 'S3' });
        await clickSaveEditor();
        await expectSessionIs(RAW_B, B_RECIPES);
    });
});

describe('2b-guard. A\'s window AND its `workspace-closing` both lost: only the Rust generation guard stands between it and B\'s session', () => {
    // The Dashboard's close of the window is lost (closeMode 'ignore') and so is
    // the `workspace-closing` broadcast (held, never released). The window still
    // thinks it serves A -- but every guarded command it sends is pinned to A's
    // generation, which Rust refuses once `load_csv` installed B's session.
    const loseClosing = () => h.hold(event => event === 'workspace-closing');
    const guarded = () => rust.calls.filter(c => ['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns'].includes(c.cmd) && c.args.expectedGeneration !== undefined);
    const refused = () => guarded().filter(c => c.error?.startsWith('STALE_SESSION'));
    const lostBanner = () => W().queryByTestId('special-sensor-session-lost');

    it('delete S2 (undo window) -> Back -> open B (own S2) -> 8 s later the commit is REFUSED: B\'s S2 column stays, nothing is announced to B\'s Dashboard, the window says its project is gone', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => { loseClosing(); await deleteSensor('S2'); });
        const bBefore = structuredClone(ws(B_ID));
        const from = h.log.length;
        await tick(9000);
        expect(refused().map(c => c.cmd)).toEqual(['remove_sensor_columns']);
        expect(rust.calls.filter(c => c.cmd === 'remove_sensor_columns' && !c.error)).toEqual([]);
        expect(h.log.slice(from).filter(e => e.event === 'delete-special-sensors')).toEqual([]);
        expect(dashListed()).toContain('S2');
        expect(ws(B_ID)).toEqual(bBefore);
        await expectSessionIs(RAW_B, B_RECIPES);
        expect(lostBanner()).toBeTruthy();
    });

    it('edit S2 in A\'s window -> the first recompute is refused, NO rollback command follows, B\'s session and file are untouched, the editor shows why', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => { loseClosing(); });
        const from = rust.calls.length;
        await openEditor('S2');
        await setEditor({ formula: '$TAG1 * 9' });
        await clickSaveEditor();
        const mine = rust.calls.slice(from).filter(c => ['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns'].includes(c.cmd));
        expect(mine.map(c => [c.cmd, c.error?.slice(0, 13)])).toEqual([['evaluate_formula', 'STALE_SESSION']]);
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
        await expectSessionIs(RAW_B, B_RECIPES);
        expect(W().getAllByRole('alert').map(a => a.textContent).join(' ')).toMatch(/closed or reloaded/);
    });

    it('create S9 and rename S2 -> S3 in A\'s window: both refused, B\'s session gains no orphan column and loses none', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => { loseClosing(); });
        await createFormula('S9', '$TAG1 + 9');
        expect(rust.has('S9')).toBe(false);
        expect(lostBanner()).toBeTruthy();
        await expectSessionIs(RAW_B, B_RECIPES);
    });

    it('a re-point after the stale refusal recovers the window: B\'s sensors-data re-binds it (banner gone) and a create then works against B', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => { loseClosing(); });
        await createFormula('S9', '$TAG1 + 9');
        expect(lostBanner()).toBeTruthy();
        await clickAddSpecialSensor(); // B's Dashboard re-sends sensors-data with its generation
        expect(lostBanner()).toBeNull();
        await createFormula('N', '$TAG3 + 5', { description: 'Beta N' });
        expect(rust.has('N')).toBe(true);
        expect(ws(B_ID).specialSensorRecipes!.map(r => r.tag)).toEqual(['S1', 'S2', 'N']);
        const plotted = h.log.filter(e => e.event === 'add-sensor-plot-result');
        expect(plotted.map(e => e.payload.workspaceId)).toEqual([B_ID]);
    });
});

describe('2c. A\'s still-alive window RE-POINTED to B (B\'s "Add special sensor" button re-sends sensors-data)', () => {
    it('re-pointing: the window lists B\'s recipes/metadata and B\'s models; a pending A deletion (undo window) is cancelled and never touches B', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => { await deleteSensor('S2'); });
        await clickAddSpecialSensor(); // existing window -> re-pointed
        expect(h.spawned).toEqual([]);
        await tick(9000);
        expect(rust.cmds('remove_sensor_columns')).toEqual([]);
        await goManage();
        expect(W().getAllByText(/Beta S2/).length).toBeGreaterThan(0);
        expect(W().queryByText(/Alpha/)).toBeNull();
        expect((W().getByLabelText('Delete S2') as HTMLButtonElement).disabled).toBe(false);
        await expectSessionIs(RAW_B, B_RECIPES);
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
    });

    // BUG (medium): the `sensors-data` handler resets only the deletions. The
    // Create form keeps A's picked sources, the "+" chain, Name, Description,
    // Unit and Component (both this window's copy and SensorTooling's own
    // state -- `formKey` is not bumped), so the next "Add sensor" click builds
    // A's draft into B.
    it('A\'s window: pick TAG1+TAG2, name "Draft", description "Alpha draft" (not added) -> switch to B, re-point the window -> the Create form still shows A\'s sources, name and description', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => {
            await pick('TAG1', 'TAG2');
            await fillCreate('Draft', { description: 'Alpha draft' });
        });
        await clickAddSpecialSensor();
        await goCreate();
        expect(nameField()).toBeNull();
        expect(createBody().textContent ?? '').not.toContain('Alpha draft');
        expect(Array.from(createBody().querySelectorAll('input')).map(i => (i as HTMLInputElement).value)).not.toContain('Draft');
    });

    // BUG (high when names collide): `editingTag` and the open editor's
    // draft survive the re-point. B has its own S2, so the row still exists
    // and the editor stays open on A's draft; Save writes it into B's S2 --
    // recomputing B's column and B's recipe with A's formula.
    it('A\'s window: open the editor on S2 and type $TAG1 * 9 (not saved) -> switch to B (own S2), re-point the window -> the editor is still open with A\'s draft and Save writes it into B\'s S2', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => {
            await openEditor('S2');
            await setEditor({ formula: '$TAG1 * 9' });
        });
        await clickAddSpecialSensor();
        await goManage();
        // The user clicks Save in whatever editor is still on screen.
        const stillOpen = !!W().queryByText('Save changes');
        if (stillOpen) await clickSaveEditor();
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
        await expectSessionIs(RAW_B, B_RECIPES);
        expect(stillOpen).toBe(false);
    });

    // BUG (high): the serial queue is not drained/cancelled on re-point and
    // every task reads `workspaceIdRef.current` at EMIT time. A create queued
    // in A runs after the re-point against B's session and is announced with
    // B's id -- B's Dashboard adopts A's sensor (recipe + metadata) into B's
    // file.
    it('A\'s window: an edit of S2 is computing (held in Rust) and "N" is created behind it in the queue -> switch to B, re-point the window, the edit finishes -> the queued create of A\'s "N" runs in B\'s session and lands in B\'s file with B\'s workspace id', async () => {
        let g!: ReturnType<FakeRust['gate']>;
        await switchWithWindowsLeftOpen(wsB(), async () => {
            g = rust.gate('evaluate_formula', a => a.replace === true && a.customName === 'S2');
            await openEditor('S2');
            await setEditor({ formula: '$TAG1 * 7' });
            await clickSaveEditor({ settle: false });
            await createFormula('N', '$TAG3 + 5', { settle: false, description: 'Alpha N' });
        });
        await clickAddSpecialSensor(); // re-point to B
        g.release();
        await flush(40);
        await tick(400);
        // The held computation itself is refused: it was pinned to A's generation
        // (`expectedGeneration`) and `load_csv` replaced the session (Rust checks
        // the pinned generation first at commit, so this is STALE_SESSION, not the
        // un-pinned "dataset changed while computing" text).
        expect(rust.cmds('evaluate_formula').some(c => c.error === STALE_SESSION_ERROR)).toBe(true);
        expect((ws(B_ID).specialSensorRecipes ?? []).map(r => r.tag)).toEqual(['S1', 'S2']);
        expect(dashListed()).not.toContain('N');
        expect(rust.has('N')).toBe(false);
    });

    // BUG (high): a delete commit that has STARTED (re-reading the workspace
    // file) when the window is re-pointed carries on with B's recipes, drops
    // B's same-named column and emits `delete-special-sensors` with B's id --
    // B's Dashboard deletes its own S2 recipe and metadata.
    it('A\'s window: delete S2 -> after 8 s its commit is re-reading A\'s file (slow) -> switch to B, re-point the window, the read completes -> B\'s own S2 is deleted from B\'s session AND from B\'s file', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => {
            await deleteSensor('S2');
            h.gateDisk(A_ID);
            await tick(8100); // commit starts, stuck reading A's file
        });
        await clickAddSpecialSensor();
        h.diskGates.forEach(g => g.release());
        await flush(40);
        await tick(400);
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
        expect((ws(B_ID).extraSensorMetadata ?? []).map(m => m.tag)).toEqual(['S1', 'S2']);
        await expectSessionIs(RAW_B, B_RECIPES);
    });

    // BUG (high): same for an edit already past the click: its first await
    // (re-reading the models from A's file) resolves after the re-point, so it
    // runs `runSpecialSensorEdit` over B's recipes with A's draft, overwrites
    // B's S2 column and emits `update-special-sensor` with B's id.
    it('A\'s window: save an edit of S2 to $TAG1 * 9 while the model re-read of A\'s file is slow -> switch to B, re-point, the read completes -> B\'s S2 recipe AND column become A\'s draft', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => {
            await openEditor('S2');
            await setEditor({ formula: '$TAG1 * 9' });
            h.gateDisk(A_ID);
            await clickSaveEditor({ settle: false });
        });
        await clickAddSpecialSensor();
        h.diskGates.forEach(g => g.release());
        await flush(40);
        await tick(400);
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
        await expectSessionIs(RAW_B, B_RECIPES);
    });

    // BUG (high): rename variant -- B's S2 is renamed to S3 in B's file (and
    // its old column removed) by a rename the user made in A.
    it('A\'s window: rename S2 -> S3 while the model re-read of A\'s file is slow -> switch to B, re-point, the read completes -> B\'s own S2 is renamed to S3 in B\'s file and session', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => {
            await openEditor('S2');
            await setEditor({ name: 'S3' });
            h.gateDisk(A_ID);
            await clickSaveEditor({ settle: false });
        });
        await clickAddSpecialSensor();
        h.diskGates.forEach(g => g.release());
        await flush(40);
        await tick(400);
        expect((ws(B_ID).specialSensorRecipes ?? []).map(r => r.tag)).toEqual(['S1', 'S2']);
        await expectSessionIs(RAW_B, B_RECIPES);
    });

    // BUG (low -- UI only; delete/edit re-read the file inside their task):
    // a models re-read for A that started before the re-point (A's Build Model
    // window broadcast) applies after it, so B's Manage tab shows A's model.
    it('A\'s window: A\'s Build Model broadcasts a change, the window\'s re-read of A\'s file is slow -> switch to B, re-point, the read completes -> B\'s Manage tab shows B\'s S1 as locked by A\'s "Alpha model"', async () => {
        await switchWithWindowsLeftOpen(wsB(), async () => {
            h.gateDisk(A_ID);
            await act(async () => { await h.emit('failure-group-state-changed', { ...ws(A_ID).failureGroupState, workspaceId: A_ID, origin: 'build-model' }); });
            await flush();
        });
        await clickAddSpecialSensor();
        h.diskGates.forEach(g => g.release());
        await flush(40);
        await goManage();
        expect(W().queryByText(/Alpha model/)).toBeNull();
        await openEditor('S1');
        expect(W().queryByTestId('edit-lock-banner')).toBeNull();
    });

    // BUG (low -- needs an IPC delay across a whole switch): `sensors-data`
    // is accepted from ANY workspace, so a late copy of A's re-points the
    // window back to A while B is on screen.
    it('a `sensors-data` for A delivered late (after the window was re-pointed to B) re-points the window back to A -- it lists A\'s "Alpha" recipes while B is open', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await clickAddSpecialSensor();
        openBuildModelWindow();
        h.hold((event, payload) => event === 'sensors-data' && payload?.workspaceId === A_ID);
        await clickAddSpecialSensor(); // A re-sends sensors-data -- held in transit
        h.closeMode = 'ignore';
        const q = h.release([]); // still in transit: nothing delivered yet
        expect(q).toHaveLength(1);
        await backToImport();
        await openRecent('Beta');
        await clickAddSpecialSensor(); // re-point to B
        await act(async () => { await h.emit(q[0].event, q[0].payload); });
        await flush();
        await goManage();
        expect(W().queryByText(/Alpha S1/)).toBeNull();
        expect(W().getAllByText(/Beta S1/).length).toBeGreaterThan(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Delete / rename / edit in A, then switch (window closed promptly)
// ═════════════════════════════════════════════════════════════════════════

describe('3. pending work in A, then a normal switch (the window IS closed)', () => {
    it('documents current behaviour: delete S2 in A (inside the 8 s undo window) -> Back -> B: the delete is DROPPED (A keeps S2 on reopen), and nothing reaches B', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await clickAddSpecialSensor();
        await deleteSensor('S2');
        await backToImport();
        expect(win).toBeNull(); // closed by the Dashboard's unmount
        await openRecent('Beta');
        await tick(9000);
        expect(rust.cmds('remove_sensor_columns')).toEqual([]);
        await expectSessionIs(RAW_B, B_RECIPES);
        expect(ws(B_ID).specialSensorRecipes).toEqual(B_RECIPES);
        // The deletion never left A's window: A's file still has S2.
        expect(ws(A_ID).specialSensorRecipes).toEqual(A_RECIPES);
        // (Closing the window with its own X/Cancel button COMMITS a pending
        // delete -- `handleClose`; a workspace switch silently undoes it.)
    });

    it('a rename S2 -> S3 in A whose recompute Rust is still running when the user goes Back -> B: Rust refuses to attach it to B (generation changed), the window is gone, B and A\'s file are untouched', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await clickAddSpecialSensor();
        const g = rust.gate('evaluate_formula', a => a.customName === 'S3');
        await openEditor('S2');
        await setEditor({ name: 'S3' });
        await clickSaveEditor({ settle: false });
        expect(W().getByTestId('special-sensor-busy')).toBeTruthy();
        await backToImport();
        expect(win).toBeNull();
        await openRecent('Beta');
        // The window's webview is gone: Rust finishes the command, nobody hears
        // the reply. (jsdom would keep running its JS -- that part is not real.)
        g.release();
        await flush(10);
        expect(rust.cmds('evaluate_formula').find(c => c.args.customName === 'S3')!.error).toBe(STALE_SESSION_ERROR);
        await expectSessionIs(RAW_B, B_RECIPES);
        expect(rust.has('S3')).toBe(false);
        expect(ws(A_ID).specialSensorRecipes).toEqual(A_RECIPES);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Reopen the same workspace / A -> B -> A
// ═════════════════════════════════════════════════════════════════════════

describe('4. reopening: specials restored exactly once each', () => {
    it('A -> Back -> A again: S1/S2 restored once each (no duplicate columns, list entries, metadata or recipes), same values', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await tick(400);
        await backToImport();
        await openRecent('Alpha');
        await tick(400);
        await expectSessionIs(RAW_A, A_RECIPES);
        expect(dashListed().filter(t => ['S1', 'S2'].includes(t))).toEqual(['S1', 'S2']);
        expect(chartSeriesFor('S2')).toEqual([102, 204, 306, 408]);
        expect(ws(A_ID).specialSensorRecipes).toEqual(A_RECIPES);
        expect(ws(A_ID).extraSensorMetadata).toEqual(A_META);
        expect(getErrors()).toHaveLength(0);
    });

    it('A -> B -> A: A\'s values come back exactly (not B\'s same-named ones), B\'s file untouched by the second A visit', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await backToImport();
        await openRecent('Beta');
        await tick(400);
        const bAfter = structuredClone(ws(B_ID));
        await backToImport();
        await openRecent('Alpha');
        await tick(400);
        await expectSessionIs(RAW_A, A_RECIPES);
        expect(dashMeta('S1')).toEqual(A_META[0]);
        expect(chartSeriesFor('S2')).toEqual([102, 204, 306, 408]);
        expect(ws(B_ID)).toEqual(bAfter);
        expect(ws(A_ID).failureGroupState?.models).toEqual([A_MODEL]);
    });

    it('A saved with its recipes in the WRONG order [S2 (built on S1), S1] -> B -> A: the replay builds S1 first, S2 has the right values, nothing is reported', async () => {
        await start(wsB(), wsA({ specialSensorRecipes: [A_RECIPES[1], A_RECIPES[0]] }));
        await openRecent('Alpha');
        await backToImport();
        await openRecent('Beta');
        await backToImport();
        const from = rust.calls.length;
        await openRecent('Alpha');
        expect(rust.calls.slice(from).filter(c => c.cmd === 'evaluate_formula').map(c => c.args.customName)).toEqual(['S1', 'S2']);
        await expectSessionIs(RAW_A, A_RECIPES);
        expect(getErrors()).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. New workspace right after A
// ═════════════════════════════════════════════════════════════════════════

describe('5. "New project" right after working in A', () => {
    it('A with specials (one created live) -> Back -> New project on the SAME CSV -> the new workspace has no specials, no A metadata, and no leftover derived columns', async () => {
        await start(null);
        await openRecent('Alpha');
        await clickAddSpecialSensor();
        await createFormula('Live', '$TAG2 + 1', { description: 'Alpha live' });
        expect(rust.has('Live')).toBe(true);
        await tick(400);
        await backToImport();

        await act(async () => { fireEvent.click(A().getByRole('button', { name: /New project/ })); });
        await flush();
        const nameInput = app!.container.querySelector('input[placeholder="e.g. Compressor Line 3 — Q3 Baseline"]') as HTMLInputElement;
        await act(async () => { fireEvent.change(nameInput, { target: { value: 'Gamma' } }); });
        await act(async () => { fireEvent.click(A().getByText('Continue')); });
        await flush();
        h.dialogOpen = [PATH_A];
        await act(async () => { fireEvent.click(A().getByText('browse').closest('button')!); });
        await flush();
        await act(async () => { fireEvent.click(A().getByText('Parse files').closest('button')!); });
        await flush(20);
        await act(async () => { fireEvent.click(A().getByText('Continue').closest('button')!); });
        await tick(600);
        await flush(20);
        await tick(400);

        expect(onDashboard()).toBe(true);
        expect(rust.derivedNames()).toEqual([]);
        expect(dashListed()).toEqual(['TAG1', 'TAG2', 'TAG3', 'TAG4']);
        expect(dashSelected()).toEqual([]);
        expect(dashMeta('S1')).toBeUndefined();
        expect(dashMeta('Live')).toBeUndefined();
        const gamma = [...h.disk.values()].find((s: any) => s.name === 'Gamma') as WorkspaceState;
        expect(gamma).toBeTruthy();
        expect(gamma.specialSensorRecipes ?? []).toEqual([]);
        expect(gamma.extraSensorMetadata ?? []).toEqual([]);
        expect(gamma.failureGroupState?.models ?? []).toEqual([]);
        // A kept its live-created sensor.
        expect(ws(A_ID).specialSensorRecipes!.map(r => r.tag)).toEqual(['S1', 'S2', 'Live']);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. Failed / slow load of B
// ═════════════════════════════════════════════════════════════════════════

describe('6. B\'s load_csv fails or is slow', () => {
    it('B\'s load_csv rejects: error shown, still on the import page (no Dashboard showing A\'s data as B), files untouched; a retry loads B cleanly', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await tick(400);
        const aBefore = structuredClone(ws(A_ID));
        const bBefore = structuredClone(ws(B_ID));
        await backToImport();
        rust.failOn('load_csv', a => a.paths?.[0] === PATH_B, 'Failed to open /data/b.csv: file is locked');
        await openRecent('Beta');
        expect(onDashboard()).toBe(false);
        expect(A().getByText(/file is locked/)).toBeTruthy();
        expect(sensorSelectionProps).toHaveLength(0);
        // The old session survives a failed load (lib.rs fails before the swap).
        expect(rust.loadedPaths()).toEqual([PATH_A]);
        expect(ws(A_ID)).toEqual(aBefore);
        expect(ws(B_ID)).toEqual(bBefore);

        await openRecent('Beta');
        expect(onDashboard()).toBe(true);
        await expectSessionIs(RAW_B, B_RECIPES);
        expect(dashMeta('S1')).toEqual(B_META[0]);
        expect(chartSeriesFor('S2')).toEqual([2, 2, 2, 2]);
    });

    it('B\'s load_csv is slow: the import page (with the loading overlay) stays up and nothing of A is shown meanwhile; then B appears with B\'s data', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await backToImport();
        const g = rust.gate('load_csv', a => a.paths?.[0] === PATH_B);
        await openRecent('Beta', { settle: false });
        await tick(1500);
        expect(onDashboard()).toBe(false);
        expect(app!.container.querySelector('[aria-busy="true"]')).toBeTruthy();
        expect(sensorSelectionProps).toHaveLength(0);
        g.release();
        await flush(40);
        await tick(800);
        expect(onDashboard()).toBe(true);
        await expectSessionIs(RAW_B, B_RECIPES);
    });

    // BUG (medium): `handleLoadWorkspace` has no "latest click wins" guard.
    // Its focus fallback clears the loading overlay when the window regains
    // focus > 2 s into a load (meant for the sub-window hand-off), so during a
    // slow load a second workspace can be clicked. The two loads then
    // interleave on the ONE Rust session: here A's `load_csv` lands while B is
    // replaying its recipes, B's replay builds B's S1/S2 on top of A's raw
    // CSV, and B (the last `onDataReady`) is shown on A's data.
    it('import page: click Alpha (load_csv slow, > 2 s) -> window regains focus (overlay cleared) -> click Beta -> A\'s load_csv completes while B replays -> B\'s Dashboard is shown on A\'s raw data (S2 = $TAG4 - 1 computed from A\'s TAG4)', async () => {
        await start(wsB());
        const gA = rust.gate('load_csv', a => a.paths?.[0] === PATH_A);
        await openRecent('Alpha', { settle: false });
        await tick(2100);
        for (const cb of [...h.focusHandlers]) await act(async () => { cb({ payload: true }); });
        await flush();
        // The load is genuinely in flight (load_csv is running): the focus event
        // is NOT a sign of a stuck spinner, so the overlay stays (before the fix
        // it was cleared here, which is what let a second workspace be clicked).
        expect(app!.container.querySelector('[aria-busy="true"]')).toBeTruthy();
        const gB = rust.gate('extract_formula_refs', a => (a.formulas as string[]).includes('$TAG4 - 1'));
        await openRecent('Beta', { settle: false });
        await flush(20);
        gA.release();
        await flush(40);
        gB.release();
        await flush(40);
        await tick(800);
        await tick(400);
        // B -- the workspace clicked LAST -- is what is on screen ...
        expect(onDashboard()).toBe(true);
        expect(dashMeta('S1')?.description).toBe('Beta S1');
        // ... so the session must hold B's dataset and B's specials.
        expect(rust.loadedPaths()).toEqual([PATH_B]);
        await expectSessionIs(RAW_B, B_RECIPES);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 7. Other state that crosses a switch
// ═════════════════════════════════════════════════════════════════════════

describe('7. other state carried across a switch', () => {
    // BUG (medium, data loss -- not special-sensor specific): the Dashboard's
    // autosave is a 250 ms debounce whose timer is CLEARED on unmount, and
    // "Back to Import" just unmounts it (the flush-before-close path only
    // covers closing the OS window). A special sensor created right before
    // Back is gone on the next open: no recipe, no metadata.
    it('A: create special sensor "Late" -> click Back to Import within 250 ms -> reopen A -> "Late" is gone (recipe and metadata never saved)', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await clickAddSpecialSensor();
        await createFormula('Late', '$TAG2 + 1', { settle: false });
        expect(dashListed()).toContain('Late'); // the Dashboard has it
        await backToImport();
        await tick(1000);
        expect(ws(A_ID).specialSensorRecipes!.map(r => r.tag)).toContain('Late');
        expect(ws(A_ID).extraSensorMetadata!.map(m => m.tag)).toContain('Late');
    });

    it('B\'s Add Special Sensor window whose `request-sensors` reply is late: the get_all_sensors fallback shows B\'s session (B\'s raw + B\'s specials only), then B\'s sensors-data takes over', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await backToImport();
        await openRecent('Beta');
        h.hold(event => event === 'sensors-data');
        await clickAddSpecialSensor();
        await flush(20);
        const rows = () => Array.from(createBody().querySelectorAll('.special-sensor-row')).map(r => r.textContent ?? '');
        expect(rows().join('|')).not.toMatch(/Alpha/);
        h.release();
        await flush(20);
        await goManage();
        expect(W().getAllByText(/Beta S1/).length).toBeGreaterThan(0);
        expect(W().queryByText(/Alpha/)).toBeNull();
    });

    it('A\'s Dashboard listeners are really gone after Back: B\'s window creating "N" in B reaches ONLY B\'s file, and A\'s file is never written', async () => {
        await start(wsB());
        await openRecent('Alpha');
        await tick(400);
        const aBefore = structuredClone(ws(A_ID));
        await backToImport();
        await openRecent('Beta');
        await clickAddSpecialSensor();
        await createFormula('N', '$TAG3 + 5', { description: 'Beta N' });
        await tick(400);
        expect(ws(B_ID).specialSensorRecipes!.map(r => r.tag)).toEqual(['S1', 'S2', 'N']);
        expect(ws(A_ID)).toEqual(aBefore);
        expect(rust.chartValues('N')).toEqual([1005, 2005, 3005, 4005]);
        const plotted = h.log.filter(e => e.event === 'add-sensor-plot-result');
        expect(plotted.map(e => e.payload.workspaceId)).toEqual([B_ID]);
    });
});
