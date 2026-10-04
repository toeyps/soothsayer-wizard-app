/**
 * Special sensors, end to end across windows (qa-agent, 2026-10-03).
 *
 * Mounts the REAL Dashboard and the REAL Add Special Sensor window (with the
 * real SensorExplorer / SensorTooling / ManageSpecialSensors /
 * SpecialSensorEditor, and the real DataUploadPage for workspace-reopen
 * replay) side by side in one document, connected by a shared fake Tauri
 * event bus (every payload is structured-cloned, like real IPC), against a
 * fake Rust session that holds real column VALUES and enforces the same rules
 * as lib.rs (see `helpers/fakeRustSession.ts`). Only Tauri, the workspace file
 * store and a few heavy Dashboard children (charts, side panels) are mocked.
 *
 * The invariant every test here checks one way or another:
 *   - every special sensor the UI lists has exactly ONE column in the session,
 *     holding the values its recipe produces from the CURRENT data;
 *   - every column the UI removed is gone from the session;
 *   - every recipe only reads sensors that exist.
 *
 * Bugs found were first recorded as `it.fails` with the exact repro in the
 * title; the app fixes (2026-10-03, second pass) flipped them to plain `it`s.
 * Tests titled "regression:" are those former `it.fails`. Five of them needed
 * their SETUP or an intermediate expectation corrected because the fix changes
 * a premise the original encoded -- each says so in a "Note (fix pass)" comment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup, within } from '@testing-library/react';
import type { SensorMetadata, WorkspaceState, SpecialSensorRecipe } from '../types';
import { createFakeRust, rustRefToken, rustScanRefs, type FakeRust } from './helpers/fakeRustSession';
import { mk } from './helpers/failureModelFixture';

// ── Shared fake Tauri: event bus, workspace disk, dialogs ────────────────

const h = vi.hoisted(() => {
    type Cb = (e: { event: string; payload: unknown }) => void;
    const listeners: Record<string, Cb[]> = {};
    const log: Array<{ event: string; payload: any }> = [];
    let held: Array<{ event: string; payload: any }> | null = null;
    let holdFilter: ((event: string) => boolean) | null = null;
    const clone = (p: unknown) => (p === undefined ? undefined : structuredClone(p));
    const deliver = (event: string, payload: unknown) => {
        for (const cb of [...(listeners[event] ?? [])]) cb({ event, payload: clone(payload) });
    };
    const state = {
        rust: null as any,
        listeners,
        log,
        disk: new Map<string, any>(),
        message: vi.fn(async (_text: string, _opts?: unknown) => undefined),
        close: vi.fn(async () => undefined),
        listen(event: string, cb: Cb) {
            (listeners[event] ??= []).push(cb);
            return Promise.resolve(() => {
                listeners[event] = (listeners[event] ?? []).filter(c => c !== cb);
            });
        },
        emit(event: string, payload?: unknown) {
            log.push({ event, payload: clone(payload) });
            if (held && (!holdFilter || holdFilter(event))) held.push({ event, payload: clone(payload) });
            else deliver(event, payload);
            return Promise.resolve();
        },
        /** Start queueing (matching) events instead of delivering them. */
        hold(filter?: (event: string) => boolean) { held = []; holdFilter = filter ?? null; },
        /** Stop holding; deliver the queued events in `order` (indices into the
         *  queue; default = original order; omitted indices are DROPPED). */
        release(order?: number[]) {
            const q = held ?? [];
            held = null;
            holdFilter = null;
            for (const i of order ?? q.map((_, k) => k)) deliver(q[i].event, q[i].payload);
            return q;
        },
        queued() { return held ?? []; },
        reset() {
            for (const k of Object.keys(listeners)) delete listeners[k];
            log.length = 0;
            held = null;
            holdFilter = null;
            state.disk.clear();
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
        close: () => h.close(),
        onCloseRequested: () => Promise.resolve(() => {}),
        onFocusChanged: () => Promise.resolve(() => {}),
        destroy: () => Promise.resolve(),
        hide: () => Promise.resolve(),
        setFocus: () => Promise.resolve(),
    }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class {
        constructor() { /* never actually spawned here */ }
        once = () => Promise.resolve();
        static getByLabel = () => Promise.resolve(null);
    },
}));
// The Import page's step-0 illustration is a canvas animation; jsdom has no 2D
// context (and logs "Not implemented" on every getContext) -- stand in a marker.
vi.mock('../components/upload/MachineMorphCanvas', () => ({ default: () => null }));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: (text: string, opts: unknown) => h.message(text, opts),
    ask: () => Promise.resolve(true),
    open: () => Promise.resolve(null),
    save: () => Promise.resolve(null),
}));
vi.mock('split.js', () => ({ default: () => ({ destroy: () => {} }) }));

vi.mock('../workspaceManager', () => {
    const clone = <T,>(v: T): T => (v == null ? v : structuredClone(v));
    return {
        saveWorkspaceData: async (state: any) => { h.disk.set(state.id, clone(state)); },
        loadWorkspaceData: async (id: string) => clone(h.disk.get(id) ?? null),
        updateWorkspaceData: async (id: string, patch: (s: any) => any) => {
            const next = patch(clone(h.disk.get(id) ?? { id }));
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
// DataUploadPage's own upload/mapping hooks: only the Recent-workspace
// reopen path is exercised here.
vi.mock('../hooks/useDataUpload', () => ({
    useDataUpload: () => ({
        selectedFiles: [], loadReport: null, isLoading: false, isStale: false, error: null,
        selectFiles: () => {}, removeFile: () => {}, uploadDataset: () => {}, clearDataset: () => {},
    }),
}));
vi.mock('../hooks/useMappingData', () => ({
    useMappingData: () => ({
        mappingData: null, mappingFilePath: null, keyColumn: null, mappingResult: null, sensorMetadata: null,
        isLoading: false, error: null, selectMappingFile: () => {}, setKeyColumn: () => {}, applyMapping: () => {}, clearMapping: () => {},
    }),
    buildSensorMetadataFromMapping: () => null,
}));

import Dashboard from '../components/dashboard/Dashboard';
import AddSensorWindow from '../components/windows/AddSensorWindow';
import DataUploadPage from '../components/upload/DataUploadPage';
import { sensorRef } from '../utils/specialSensorNaming';
import { getErrors, dismissAllErrors } from '../errorReporter';

// ── Fixtures ────────────────────────────────────────────────────────────

const RAW = {
    headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3', 'TAG4'],
    columns: [
        [1, 2, 3, 4],
        [10, 20, NaN, 40],
        [100, 200, 300, 400],
        [5, 5, 5, 5],
    ],
};
const RAW_META: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
    { tag: 'TAG3', description: 'Line Flow', unit: 'm3', component: 'Line' },
    { tag: 'TAG4', description: 'Line Level', unit: 'm', component: 'Line' },
];
const WS = 'ws1';

let rust: FakeRust;

function baseState(over: Partial<WorkspaceState> = {}): WorkspaceState {
    return {
        id: WS, name: 'Test WS', lastRoute: 'dashboard', dataFilePaths: ['/data/a.csv'], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        ...over,
    };
}

/** What Build Model does when it changes a model: persist the slice to the
 *  workspace file FIRST, then broadcast it (`failure-group-state-changed`).
 *  Every real writer works this way, and the Add Sensor window now re-reads the
 *  file on a broadcast instead of trusting the payload's arrival order. */
async function writerPersistsThenBroadcasts(
    models: any[],
    extra: Record<string, unknown> = {},
    origin = 'build-model',
    opts: { broadcast?: boolean } = {},
) {
    const ws = h.disk.get(WS);
    const slice = { ...(ws.failureGroupState ?? {}), groups: [], models, ...extra };
    h.disk.set(WS, { ...ws, failureGroupState: slice });
    if (opts.broadcast === false) return;
    await act(async () => { await h.emit('failure-group-state-changed', { workspaceId: WS, origin, ...slice }); });
    await flush();
}

const metaFor = (tag: string, extra: Partial<SensorMetadata> = {}): SensorMetadata =>
    ({ tag, description: `${tag} desc`, unit: 'u', component: 'Special', ...extra });

// ── Async helpers (fake timers throughout) ─────────────────────────────

async function flush(n = 12) {
    for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
}
async function tick(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await flush();
}

/** Build the Rust columns a workspace would already have in-session (what the
 *  reopen replay produces) -- straight through the fake, in order. */
async function seedSession(recipes: SpecialSensorRecipe[]) {
    for (const r of recipes) {
        if (r.kind === 'formula') await rust.invoke('evaluate_formula', { formula: r.formula, customName: r.tag });
        else await rust.invoke('calculate_new_sensor', { sensors: r.sourceSensors, config: { ...r.operationConfig, customName: r.tag } });
    }
}

let dash: ReturnType<typeof render> | null = null;
let win: ReturnType<typeof render> | null = null;

async function openDashboard(state: WorkspaceState, sensorMetadata: SensorMetadata[] | null = RAW_META) {
    h.disk.set(state.id, structuredClone(state));
    await act(async () => {
        dash = render(
            <Dashboard
                metadata={{ headers: RAW.headers, total_rows: 4 }}
                sensorMetadata={sensorMetadata}
                onBack={() => {}}
                initialState={state}
            />,
        );
    });
    await flush();
    await tick(300); // first chart fetch
    return dash!;
}

async function openWindow() {
    await act(async () => { win = render(<AddSensorWindow />); });
    await flush();
    return win!;
}

const W = () => within(win!.container);
const lastOf = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];
const dashProps = () => sensorSelectionProps[sensorSelectionProps.length - 1];
const dashSelected = (): string[] => dashProps().selectedSensors;
const dashListed = (): string[] => dashProps().sensors;

/** Change the Dashboard's plotted selection the way the Sensor tab does. */
async function dashSelect(tags: string[]) {
    await act(async () => { dashProps().onSensorChange(tags); });
    await flush();
}

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

function lastChartFilter() {
    return rust.chartResponses[rust.chartResponses.length - 1]?.filter;
}

// Create tab ---------------------------------------------------------------

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
        if (!row) throw new Error(`no explorer row for ${tag}; rows: ${Array.from(createBody().querySelectorAll('.special-sensor-row')).map(r => r.textContent).join(' | ')}`);
        await act(async () => { fireEvent.click(row); });
    }
    await setSearch('');
    await flush();
}

function opCard(label: string): HTMLButtonElement {
    const cards = Array.from(createBody().querySelectorAll('.special-sensor-op-card')) as HTMLButtonElement[];
    const card = cards.find(c => c.querySelector('b')?.textContent === label);
    if (!card) throw new Error(`no op card ${label}`);
    return card;
}

function labelledInput(labelText: string): HTMLInputElement {
    const labels = Array.from(createBody().querySelectorAll('label'));
    const label = labels.find(l => l.textContent?.replace('*', '').trim() === labelText);
    if (!label) throw new Error(`no label ${labelText}`);
    return label.parentElement!.querySelector('input, select') as HTMLInputElement;
}

// SensorTooling keeps showing the previous sensor's Description/Unit after an
// Add (see the 1c bugs) and React ignores a change event that sets an input to
// the value it already shows -- so each fill uses fresh text.
let fillSeq = 0;
async function fillCreate(name: string, opts: { description?: string; unit?: string; component?: string } = {}) {
    fillSeq++;
    const nameInput = createBody().querySelector('input[placeholder="e.g. Total Power"]') as HTMLInputElement;
    if (!nameInput) throw new Error('Name field not shown -- nothing is being created');
    await act(async () => { fireEvent.change(nameInput, { target: { value: name } }); });
    await act(async () => { fireEvent.change(labelledInput('Description'), { target: { value: opts.description ?? `${name.trim()} desc ${fillSeq}` } }); });
    await act(async () => { fireEvent.change(labelledInput('Unit'), { target: { value: opts.unit ?? `u${fillSeq}` } }); });
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

/** The footer line that reports a FAILED Add (backend error), if any. */
const backendError = (): string | null => {
    const el = win!.container.querySelector('.special-sensor-footer [role="alert"]');
    return el ? el.textContent : null;
};

const addBtn = () => W().getByText('Add sensor').closest('button') as HTMLButtonElement;

async function clickAdd() {
    await act(async () => { fireEvent.click(addBtn()); });
    await flush(20);
    await tick(300); // Dashboard's debounced chart refetch
}

/** Create a formula sensor through the real UI. */
async function createFormula(name: string, formula: string, opts?: Parameters<typeof fillCreate>[1]) {
    await goCreate();
    await typeFormula(formula);
    await fillCreate(name, opts);
    await clickAdd();
}

// Manage tab ---------------------------------------------------------------

async function goManage() {
    await act(async () => { fireEvent.click(W().getByRole('tab', { name: /Manage/ })); });
    await flush();
}
async function goCreate() {
    await act(async () => { fireEvent.click(W().getByRole('tab', { name: /Create/ })); });
    await flush();
}
const deleteBtn = (tag: string) => W().getByLabelText(`Delete ${tag}`) as HTMLButtonElement;

async function deleteSensor(tag: string) {
    await goManage();
    const btn = deleteBtn(tag);
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
    if (fields.name !== undefined) {
        await act(async () => { fireEvent.change(W().getByLabelText('Name'), { target: { value: fields.name } }); });
    }
    if (fields.formula !== undefined) {
        await act(async () => { fireEvent.change(W().getByLabelText('Formula'), { target: { value: fields.formula } }); });
    }
    await flush();
}

async function saveEditor() {
    const btn = W().getByText('Save changes').closest('button') as HTMLButtonElement;
    if (btn.disabled) throw new Error(`Save is disabled: ${W().queryAllByRole('alert').map(a => a.textContent).join(' / ')}`);
    await act(async () => { fireEvent.click(btn); });
    await flush(30);
    await tick(300);
}

const editorError = () => {
    const editor = W().queryByLabelText('Name')?.closest('.rounded') as HTMLElement | null;
    return editor ? Array.from(editor.querySelectorAll('[role="alert"]')).map(a => a.textContent).join(' / ') : '';
};

/** Recipes as the Dashboard currently holds them (= what autosave persists). */
async function persistedRecipes(): Promise<SpecialSensorRecipe[]> {
    await tick(400); // autosave debounce
    return h.disk.get(WS)?.specialSensorRecipes ?? [];
}

/** The core invariant: every recipe the Dashboard holds has exactly one
 *  session column, with the values that recipe yields NOW, and every recipe
 *  input exists. Recomputes each recipe on a scratch copy of the session. */
async function expectConsistent(recipes: SpecialSensorRecipe[], opts: { allowOrphans?: boolean } = {}) {
    if (!opts.allowOrphans) {
        // Nothing the UI no longer lists may linger as a derived column.
        const k = (s: string) => s.trim().toLowerCase();
        expect(rust.derivedNames().map(k).sort(), 'derived columns in the session').toEqual(recipes.map(r => k(r.tag)).sort());
    }
    for (const r of recipes) {
        expect(rust.columnCount(r.tag), `columns named ${r.tag}`).toBe(1);
        const inputs = r.kind === 'operation' ? r.sourceSensors : rustScanRefs(r.formula).map(s => s.name);
        for (const input of inputs) expect(rust.has(input), `${r.tag} reads ${input}, which must exist`).toBe(true);
    }
    // Values: replay every recipe (dependency order = list order here) into a
    // fresh fake and compare column by column.
    const fresh = createFakeRust(RAW);
    const pending = [...recipes];
    for (let guard = 0; pending.length && guard < 50; guard++) {
        const r = pending.shift()!;
        try {
            if (r.kind === 'formula') await fresh.invoke('evaluate_formula', { formula: r.formula, customName: r.tag, replace: true });
            else await fresh.invoke('calculate_new_sensor', { sensors: r.sourceSensors, config: { ...r.operationConfig, customName: r.tag }, replace: true });
        } catch {
            pending.push(r); // a source further down the list -- retry later
        }
    }
    expect(pending.map(r => r.tag), 'recipes that cannot be rebuilt from the raw data').toEqual([]);
    for (const r of recipes) {
        expect(rust.resolvedValues(r.tag), `values of ${r.tag}`).toEqual(fresh.resolvedValues(r.tag));
    }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    h.reset();
    h.message.mockClear();
    h.close.mockClear();
    sensorSelectionProps.length = 0;
    rust = createFakeRust(RAW);
    h.rust = rust;
    dismissAllErrors();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    dash = null;
    win = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Create
// ═════════════════════════════════════════════════════════════════════════

describe('1. create -> only the new sensor is plotted, with the new values', () => {
    it('formula: the new tag is merged into the Dashboard\'s CURRENT selection (changed after the window opened), sources are not plotted, and the chart reads the new values', async () => {
        await openDashboard(baseState({ selectedSensors: ['TAG3'], visibleSensors: ['TAG3'] }));
        await openWindow();
        // The user changes the Dashboard's plot AFTER the window opened.
        await dashSelect(['TAG3', 'TAG4']);

        await createFormula('Combo', '$TAG1 * 2 + $TAG3');

        expect(dashSelected()).toEqual(['TAG3', 'TAG4', 'Combo']);
        expect(dashSelected()).not.toContain('TAG1');
        expect(chartSeriesFor('Combo')).toEqual([102, 204, 306, 408]);
        expect(rust.columnCount('Combo')).toBe(1);
        const recipes = await persistedRecipes();
        expect(recipes).toEqual([{ kind: 'formula', tag: 'Combo', formula: '$TAG1 * 2 + $TAG3' }]);
        await expectConsistent(recipes);
    });
});

/** Open a workspace that already has these special sensors (their columns
 *  built in the session, as the reopen replay would), plus the window. */
async function openWorkspace(recipes: SpecialSensorRecipe[], over: Partial<WorkspaceState> = {}) {
    await seedSession(recipes);
    await openDashboard(baseState({
        specialSensorRecipes: recipes,
        extraSensorMetadata: recipes.map(r => metaFor(r.tag)),
        ...over,
    }));
    await openWindow();
}

const F = (tag: string, formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula });
const SUM = (tag: string, sources: string[]): SpecialSensorRecipe =>
    ({ kind: 'operation', tag, sourceSensors: sources, operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: tag } });

describe('1b. create via operation, Sum vs Mean with a missing source, Pair Plot cap', () => {
    it('Sum all of two picked sources: only the new sensor is plotted, a row with a missing source is EMPTY, and the card says so', async () => {
        await openDashboard(baseState({ selectedSensors: ['TAG3'], visibleSensors: ['TAG3'] }));
        await openWindow();
        await pick('TAG1', 'TAG2');
        await act(async () => { fireEvent.click(opCard('Sum all')); });
        await flush();
        expect(W().getAllByText('Rows where any source is missing are left empty').length).toBeGreaterThan(0);
        expect(opCard('Sum all').getAttribute('title')).toBe('Rows where any source is missing are left empty');
        await fillCreate('S');
        await clickAdd();

        expect(rust.cmds('calculate_new_sensor')).toHaveLength(1);
        expect(dashSelected()).toEqual(['TAG3', 'S']);
        expect(chartSeriesFor('S')).toEqual([11, 22, null, 44]);
        await expectConsistent(await persistedRecipes());
    });

    it('Average all skips the missing source instead (and shows no "left empty" hint)', async () => {
        await openDashboard(baseState());
        await openWindow();
        await pick('TAG1', 'TAG2');
        await act(async () => { fireEvent.click(opCard('Average all')); });
        await flush();
        expect(W().queryByText('Rows where any source is missing are left empty')).toBeNull();
        await fillCreate('M');
        await clickAdd();
        expect(dashSelected()).toEqual(['M']);
        expect(chartSeriesFor('M')).toEqual([5.5, 11, 3, 22]);
    });

    it('the default "+" chain is a formula: a missing source gives an empty row too (same rule as Sum)', async () => {
        await openDashboard(baseState());
        await openWindow();
        await pick('TAG1', 'TAG2');
        await fillCreate('Chain');
        await clickAdd();
        expect(lastOf(rust.cmds('evaluate_formula'))!.args).toEqual({ formula: '$TAG1 + $TAG2', customName: 'Chain' });
        expect(chartSeriesFor('Chain')).toEqual([11, 22, null, 44]);
    });

    it('Pair Plot already at 4 sensors: the sensor is created and listed, NOT plotted, and the user is told', async () => {
        await openDashboard(baseState({ chartType: 'pair', selectedSensors: ['TAG1', 'TAG2', 'TAG3', 'TAG4'], visibleSensors: ['TAG1', 'TAG2', 'TAG3', 'TAG4'] }));
        await openWindow();
        await createFormula('P5', '$TAG1 + 1');

        expect(rust.columnCount('P5')).toBe(1);
        expect(dashSelected()).toEqual(['TAG1', 'TAG2', 'TAG3', 'TAG4']);
        expect(dashListed()).toContain('P5');
        expect(h.message).toHaveBeenCalledTimes(1);
        expect(String(h.message.mock.calls[0][0])).toMatch(/P5 was added to the workspace but not plotted/);
        expect((await persistedRecipes()).map(r => r.tag)).toEqual(['P5']);
    });

    // Was a BUG (low, cosmetic): the window's own "on chart" mirror merges without
    // the Pair Plot cap, so Manage shows the badge for a sensor the Dashboard
    // refused to plot.
    it('regression: Pair Plot at 4 sensors -> create P5 (not plotted) -> Manage tab still shows P5 as "on chart"', async () => {
        await openDashboard(baseState({ chartType: 'pair', selectedSensors: ['TAG1', 'TAG2', 'TAG3', 'TAG4'], visibleSensors: ['TAG1', 'TAG2', 'TAG3', 'TAG4'] }));
        await openWindow();
        await createFormula('P5', '$TAG1 + 1');
        await goManage();
        const row = W().getByLabelText('Delete P5').closest('div.rounded') as HTMLElement;
        expect(within(row).queryByText('on chart')).toBeNull();
    });

    it('"add as-is" (one raw sensor, no calculation) adds it to the Dashboard current plot and creates nothing', async () => {
        await openDashboard(baseState({ selectedSensors: ['TAG3'], visibleSensors: ['TAG3'] }));
        await openWindow();
        await pick('TAG4');
        expect(createBody().querySelector('input[placeholder="e.g. Total Power"]')).toBeNull();
        await clickAdd();
        expect(dashSelected()).toEqual(['TAG3', 'TAG4']);
        expect(rust.derivedNames()).toEqual([]);
        expect(await persistedRecipes()).toEqual([]);
    });

    it('a double click on Add creates ONCE (one backend call, one recipe, no "already exists" error)', async () => {
        await openDashboard(baseState());
        await openWindow();
        await typeFormula('$TAG1 * 3');
        await fillCreate('Twice');
        await act(async () => { fireEvent.click(addBtn()); fireEvent.click(addBtn()); });
        await flush(20);
        await tick(300);
        expect(rust.cmds('evaluate_formula')).toHaveLength(1);
        expect(rust.cmds('evaluate_formula')[0].error).toBeUndefined();
        expect(backendError()).toBeNull();
        expect((await persistedRecipes()).map(r => r.tag)).toEqual(['Twice']);
        expect(dashSelected()).toEqual(['Twice']);
    });
});

describe('1c. the Create form after a successful Add', () => {
    // Was a BUG (medium -- reads as "did my sensor fail?"): AddSensorWindow resets
    // ITS copy of the form after an Add, but SensorTooling keeps its own
    // engine/formula-editor state; `setSelectedSensors([])` hands it a new
    // array, its build result re-memoizes, and it re-submits the old formula
    // + name to the window -- so right after a SUCCESSFUL add the Name field
    // turns red with 'A sensor named "Once" already exists', the footer says
    // "Fix the name before adding." and Add is disabled. Only visible with
    // the real SensorTooling (AddSensorWindow.test mocks it).
    it('regression: "Edit as text" -> formula $TAG1 * 3, name Once -> Add (succeeds) -> the form keeps the formula and name and immediately shows "A sensor named Once already exists" + "Fix the name before adding."', async () => {
        await openDashboard(baseState());
        await openWindow();
        await typeFormula('$TAG1 * 3');
        await fillCreate('Once');
        await clickAdd();
        expect(rust.cmds('evaluate_formula')).toHaveLength(1);
        const ta = createBody().querySelector('textarea') as HTMLTextAreaElement | null;
        expect(ta?.value ?? '').toBe('');
        expect(createBody().querySelector('input[placeholder="e.g. Total Power"]')).toBeNull();
        expect(W().queryByText(/already exists/)).toBeNull();
        expect(W().queryByText('Fix the name before adding.')).toBeNull();
    });

    // Same root cause: after an Add with no Explorer picks, SensorTooling's
    // Description/Unit fields still SHOW the previous values while the window
    // has reset its copies to '' -- the footer then demands "Fill in a
    // description, a unit" for fields that look filled, and re-typing the
    // same text does not register (no change event for an identical value).
    // Note (fix pass): this used to demand that Description/Unit keep showing the
    // OLD sensor's text ('Same desc' / 'kPa') while Add is enabled. The fix
    // resets the whole Create form after an Add (the user asked for ALL of it to
    // be cleared), so the fields are BLANK for the next sensor. The invariant the
    // original really checks -- what the fields show must agree with what the
    // footer/Add button believe -- is asserted below, in both directions.
    it('regression: "Edit as text" -> create Once (desc/unit/component filled) -> type a new formula + new name Twice -> the fields and the footer agree: they are blank, the footer says so, and filling them enables Add', async () => {
        await openDashboard(baseState());
        await openWindow();
        await typeFormula('$TAG1 * 3');
        await fillCreate('Once', { description: 'Same desc', unit: 'kPa' });
        await clickAdd();
        await typeFormula('$TAG3 * 3');
        const nameInput = createBody().querySelector('input[placeholder="e.g. Total Power"]') as HTMLInputElement;
        await act(async () => { fireEvent.change(nameInput, { target: { value: 'Twice' } }); });
        await flush();
        expect(labelledInput('Description').value).toBe('');
        expect(labelledInput('Unit').value).toBe('');
        expect((createBody().querySelector('select[aria-label="Component"]') as HTMLSelectElement).value).toBe('');
        expect(W().getByText('Fill in a description, a unit, a component before adding.')).toBeTruthy();
        expect(addBtn().disabled).toBe(true);
        // Typing the SAME text as last time registers (the fields really were reset).
        await act(async () => { fireEvent.change(labelledInput('Description'), { target: { value: 'Same desc' } }); });
        await act(async () => { fireEvent.change(labelledInput('Unit'), { target: { value: 'kPa' } }); });
        await act(async () => { fireEvent.change(createBody().querySelector('select[aria-label="Component"]')!, { target: { value: 'Uncategorized' } }); });
        await flush();
        expect(W().queryByText(/Fill in/)).toBeNull();
        expect(addBtn().disabled).toBe(false);
        await clickAdd();
        expect(chartSeriesFor('Twice')).toEqual([300, 600, 900, 1200]);
        await expectConsistent(await persistedRecipes());
    });

    // Same root cause in buttons mode: SensorTooling never clears
    // `engine.customName`, so the NEXT sensor's Name field opens with the
    // previous name, already flagged as taken.
    it('regression: pick TAG1+TAG2 -> name First -> Add -> pick TAG3+TAG4 -> the Name field is pre-filled with "First" and flagged "already exists"', async () => {
        await openDashboard(baseState());
        await openWindow();
        await pick('TAG1', 'TAG2');
        await fillCreate('First');
        await clickAdd();
        await pick('TAG3', 'TAG4');
        const nameInput = createBody().querySelector('input[placeholder="e.g. Total Power"]') as HTMLInputElement;
        expect(nameInput.value).toBe('');
        expect(W().queryByText(/already exists/)).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Delete -> recreate, Undo, protection
// ═════════════════════════════════════════════════════════════════════════

describe('2. delete then recreate the same name', () => {
    it.each([
        ['same spelling', 'X'],
        ['different casing', 'x'],
        ['trailing space', 'X '],
        ['casing + spaces', '  x  '],
    ])('delete X (after the undo window) then create %s: new values, one column, no error', async (_label, newName) => {
        await openWorkspace([F('X', '$TAG1 * 2')], { selectedSensors: ['X'], visibleSensors: ['X'] });
        expect(chartSeriesFor('X')).toEqual([2, 4, 6, 8]);

        await deleteSensor('X');
        await tick(8100);
        expect(rust.has('X')).toBe(false);
        expect(dashSelected()).toEqual([]);
        expect(await persistedRecipes()).toEqual([]);

        await createFormula(newName, '$TAG1 + 1000');
        const stored = newName.trim();
        expect(lastOf(rust.cmds('evaluate_formula'))!.error).toBeUndefined();
        expect(backendError()).toBeNull();
        expect(rust.columnCount('X')).toBe(1);
        expect(dashSelected()).toEqual([stored]);
        expect(chartSeriesFor(stored)).toEqual([1001, 1002, 1003, 1004]);
        const recipes = await persistedRecipes();
        expect(recipes).toEqual([F(stored, '$TAG1 + 1000')]);
        await expectConsistent(recipes);
        const meta: SensorMetadata[] = h.disk.get(WS).extraSensorMetadata;
        expect(meta).toHaveLength(1);
        expect(meta[0].tag).toBe(stored);
        expect(meta[0].description).not.toBe('X desc'); // not the deleted sensor's
    });

    it.each([['X'], ['x'], ['X '], [' x']])('delete X then IMMEDIATELY (inside the undo window) create %j: the delete settles first, new values, one column', async (newName) => {
        await openWorkspace([F('X', '$TAG1 * 2')], { selectedSensors: ['X'], visibleSensors: ['X'] });
        await deleteSensor('X');
        // still inside the 8 s undo window
        await createFormula(newName, '$TAG1 + 1000');
        const stored = newName.trim();
        expect(lastOf(rust.cmds('evaluate_formula'))!.error).toBeUndefined();
        expect(backendError()).toBeNull();
        expect(rust.columnCount('X')).toBe(1);
        expect(rust.chartValues(stored)).toEqual([1001, 1002, 1003, 1004]);
        expect(dashSelected()).toEqual([stored]);
        expect(chartSeriesFor(stored)).toEqual([1001, 1002, 1003, 1004]);
        // and the (already settled) delete never fires a second time
        await tick(9000);
        expect(rust.columnCount('X')).toBe(1);
        expect(rust.cmds('remove_sensor_columns')).toHaveLength(1);
        const recipes = await persistedRecipes();
        expect(recipes.map(r => r.tag)).toEqual([stored]);
        await expectConsistent(recipes);
    });

    it('delete -> Undo: nothing is removed from the session or the Dashboard, even long after', async () => {
        await openWorkspace([F('X', '$TAG1 * 2')], { selectedSensors: ['X'], visibleSensors: ['X'] });
        await deleteSensor('X');
        await act(async () => { fireEvent.click(W().getByText('Undo')); });
        await tick(20000);
        expect(rust.cmds('remove_sensor_columns')).toHaveLength(0);
        expect(rust.chartValues('X')).toEqual([2, 4, 6, 8]);
        expect(dashSelected()).toEqual(['X']);
        expect((await persistedRecipes()).map(r => r.tag)).toEqual(['X']);
        expect(W().getByLabelText('Delete X')).toBeTruthy();
    });

    it('closing the window mid-undo commits the delete end to end (column dropped, Dashboard drops the recipe)', async () => {
        await openWorkspace([F('X', '$TAG1 * 2')], { selectedSensors: ['X'], visibleSensors: ['X'] });
        await deleteSensor('X');
        await act(async () => { fireEvent.click(W().getByText('Close')); });
        await flush();
        expect(h.close).toHaveBeenCalled();
        expect(rust.has('X')).toBe(false);
        expect(dashSelected()).toEqual([]);
        expect(await persistedRecipes()).toEqual([]);
    });
});

describe('2b. delete protection', () => {
    it('blocked while another special sensor (formula or operation) is built on it', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1'), SUM('C', ['B', 'TAG3'])]);
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
        expect(deleteBtn('B').disabled).toBe(true);
        expect(deleteBtn('C').disabled).toBe(false);
    });

    it('blocked while a Failure Group model uses it (models handed over when the window opened)', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], {
            failureGroupState: { groups: [], models: [mk({ id: 'm1', targetSensor: 'A' })] } as any,
        });
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
    });

    it('blocked once ANOTHER window (Build Model) starts using it while the Add Sensor window is open', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        await goManage();
        expect(deleteBtn('A').disabled).toBe(false);
        // Note (fix pass): a real writer persists BEFORE it broadcasts, and the
        // window now re-reads the file on a broadcast (arrival order of payloads
        // is not trustworthy). The original emitted without writing anything.
        await writerPersistsThenBroadcasts([mk({ id: 'm1', predictorSensors: ['A'] })]);
        expect(deleteBtn('A').disabled).toBe(true);
    });

    // Was a BUG (medium): the dependency check happens at CLICK time only. The
    // commit 8 s later drops the column regardless of what started using the
    // sensor in between.
    it('regression: delete A (Manage) -> within the 8 s undo window Build Model makes A a model\'s target -> the delete still commits and drops A\'s column from under the model', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        await deleteSensor('A');
        // (persist-then-broadcast, as a real writer does -- see the helper.)
        await writerPersistsThenBroadcasts([mk({ id: 'm1', targetSensor: 'A' })]);
        await tick(8100);
        // a model references A, so A must still exist -- the delete was
        // cancelled at commit time, the sensor is back in the list, and the
        // user was told why.
        expect(rust.has('A')).toBe(true);
        expect(rust.cmds('remove_sensor_columns')).toHaveLength(0);
        expect((await persistedRecipes()).map(r => r.tag)).toEqual(['A']);
        expect(W().getByLabelText('Delete A')).toBeTruthy();
        expect(W().getByRole('alert').textContent).toMatch(/Didn't delete A: it is now used by/);
        await expectConsistent(await persistedRecipes());
    });

    // Same commit-time re-check, for the workspace Running condition (which is
    // not part of the models list) and for another special sensor built on it.
    it('regression: delete A -> within the undo window the workspace Running condition starts using A -> the delete is cancelled at commit time', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        await deleteSensor('A');
        await writerPersistsThenBroadcasts([], {
            runningConditionFilters: [{ id: 'rc1', sensor: 'A', operation: 'greater_than', value1: '3', value2: '' }],
        });
        await tick(8100);
        expect(rust.has('A')).toBe(true);
        expect(W().getByRole('alert').textContent).toMatch(/Running condition/);
        expect((await persistedRecipes()).map(r => r.tag)).toEqual(['A']);
    });

    // Was a BUG (medium): the Explorer on the Create tab lists the full `sensors`
    // list, not `liveSensors`, so a sensor inside its undo window can still be
    // picked as a SOURCE. Its delete then commits under the new sensor.
    // Note (fix pass): the original PICKED A in the Explorer while it was inside
    // its undo window and expected the broken result. The fix is that A is not
    // offered as a source at all, so the first half of that repro is
    // impossible; it now asserts A is not offered, that a reference typed in by
    // hand is refused, and that nothing is left built on a column that is dropped.
    it('regression: delete A -> inside the undo window A is not offered as a source on the Create tab, a $A typed by hand is refused, and nothing ends up built on a dropped column', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        await deleteSensor('A');
        await goCreate();
        await setSearch('A');
        expect(explorerRow('A')).toBeUndefined();
        expect(explorerRow('TAG3')).toBeTruthy(); // the picker itself still works
        await setSearch('');
        await typeFormula('${A} + $TAG3');
        await fillCreate('B');
        await clickAdd();
        expect(backendError()).toMatch(/"A" is being deleted/);
        expect(rust.cmds('evaluate_formula').filter(c => c.args.customName === 'B')).toHaveLength(0);
        await tick(8100);
        const recipes = await persistedRecipes();
        expect(recipes).toEqual([]);
        expect(rust.has('A')).toBe(false);
        await expectConsistent(recipes);
    });

    // Was a KNOWN GAP, made worse (high for model results): delete-protection does
    // not look at the workspace Running Condition (documented "not wired up"
    // in specialSensorRename.ts). Before 2026-10-03 the stale column lingered;
    // now it is really dropped, and Rust's ResolvedFilter silently DROPS a
    // condition on an unknown sensor -- so every model trains on different rows.
    it('regression (was a known gap): a special sensor used in the workspace Running Condition cannot be deleted -> its column stays and the condition keeps filtering', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], {
            failureGroupState: {
                groups: [], models: [],
                runningConditionFilters: [{ id: 'rc1', sensor: 'A', operation: 'greater_than', value1: '3', value2: '' }],
            } as any,
        });
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Rename
// ═════════════════════════════════════════════════════════════════════════

/** A, a formula B and an operation C both built on A. */
const CHAIN = () => [F('A', '$TAG1 * 2'), F('B', '${A} + 1'), SUM('C', ['A', 'TAG3'])];

async function renameViaEditor(from: string, to: string, formula?: string) {
    await openEditor(from);
    await setEditor({ name: to, formula });
    await saveEditor();
}

describe('3. rename', () => {
    it('rename A -> A2 rewrites the formula AND the operation built on it, recomputes them against A2, drops A\'s column, and A is free for a brand-new sensor', async () => {
        await openWorkspace(CHAIN(), { selectedSensors: ['A', 'B'], visibleSensors: ['A', 'B'] });
        await renameViaEditor('A', 'A2');
        expect(editorError()).toBe('');

        expect(rust.has('A')).toBe(false);
        expect(rust.chartValues('A2')).toEqual([2, 4, 6, 8]);
        expect(dashSelected()).toEqual(['A2', 'B']);
        expect(chartSeriesFor('A2')).toEqual([2, 4, 6, 8]);
        let recipes = await persistedRecipes();
        expect(recipes).toEqual([
            F('A2', '$TAG1 * 2'),
            F('B', '$A2 + 1'),
            { ...SUM('C', ['A2', 'TAG3']) },
        ]);
        await expectConsistent(recipes);

        // The OLD name is free again -- and reading it gives the NEW sensor.
        await createFormula('A', '$TAG3 / 100');
        expect(lastOf(rust.cmds('evaluate_formula'))!.error).toBeUndefined();
        expect(rust.columnCount('A')).toBe(1);
        expect(chartSeriesFor('A')).toEqual([1, 2, 3, 4]);
        expect(dashSelected()).toEqual(['A2', 'B', 'A']);
        recipes = await persistedRecipes();
        expect(recipes.map(r => r.tag)).toEqual(['A2', 'B', 'C', 'A']);
        // One metadata entry per sensor, and "A" carries the NEW sensor's description.
        const meta: SensorMetadata[] = h.disk.get(WS).extraSensorMetadata;
        expect(meta.map(m => m.tag).sort()).toEqual(['A', 'A2', 'B', 'C']);
        expect(meta.find(m => m.tag === 'A')!.description).not.toBe('A desc');
        expect(meta.find(m => m.tag === 'A2')!.description).toBe('A desc');
        await expectConsistent(recipes);
    });

    it('a case-only rename (A -> a) removes nothing, keeps ONE column, and the chart reads it under the new casing', async () => {
        await openWorkspace(CHAIN(), { selectedSensors: ['A'], visibleSensors: ['A'] });
        await renameViaEditor('A', 'a');
        expect(editorError()).toBe('');
        expect(rust.cmds('remove_sensor_columns')).toHaveLength(0);
        expect(rust.columnCount('a')).toBe(1);
        expect(rust.chartValues('a')).toEqual([2, 4, 6, 8]);
        expect(dashSelected()).toEqual(['a']);
        expect(chartSeriesFor('a')).toEqual([2, 4, 6, 8]);
        const recipes = await persistedRecipes();
        expect(recipes.map(r => r.tag)).toEqual(['a', 'B', 'C']);
        await expectConsistent(recipes);
    });

    // 2026-10-03 (edit lock): these two used to assert that renaming a sensor a
    // model uses is CARRIED INTO the model (and that the window protected the
    // new name from deletion before the Dashboard's broadcast landed). The user
    // decided instead that a model-used sensor cannot be renamed at all (a
    // trained model built from it would go stale), so the premise is gone:
    // the rename is refused and the model keeps the name it was built on. The
    // Dashboard's rename-into-models code stays as a safety net but is
    // unreachable from the window; see "9. edit lock" below for the full set.
    it('a model using the sensor blocks its RENAME: Name is read-only, the model on disk keeps pointing at A, and the window keeps blocking its delete', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], {
            failureGroupState: { groups: [], models: [mk({ id: 'm1', targetSensor: 'A' })] } as any,
        });
        await openEditor('A');
        expect((W().getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
        await tick(400);
        expect(h.disk.get(WS).failureGroupState.models[0].targetSensor).toBe('A');
        expect(h.log.some(e => e.event === 'rename-special-sensor')).toBe(false);
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
    });

    it('regression (superseded by the edit lock): model m1 targets A -> the rename cannot even start, so there is no window in which "Delete A2" is enabled before the FG broadcast arrives', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], {
            failureGroupState: { groups: [], models: [mk({ id: 'm1', targetSensor: 'A' })] } as any,
        });
        h.hold(e => e === 'failure-group-state-changed');
        await openEditor('A');
        expect((W().getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
    });

    // Was a BUG (medium): Dashboard's rename handler re-keys selection, colours,
    // axes, scatter, highlights and models -- but NOT its own Filter tab.
    // The condition keeps naming A; the rename drops A's column; Rust's
    // ResolvedFilter silently drops a condition on an unknown sensor, so the
    // chart goes from "filtered" to "unfiltered" while the Filter tab still
    // shows the condition. (Same for a DELETED sensor used in the filter.)
    it('regression: Dashboard Filter tab has "A > 4" -> rename A to A2 -> the filter still names A, whose column is gone, so the chart silently shows every row', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], {
            selectedSensors: ['A'], visibleSensors: ['A'],
            filters: { timestampStart: '', timestampEnd: '', sensorFilters: [{ id: 'f1', sensor: 'A', operation: 'greater_than', value1: '4', value2: '' }] } as any,
        });
        expect(lastOf(rust.chartResponses)!.view.total_rows).toBe(2);
        await renameViaEditor('A', 'A2');
        await tick(400);
        expect(lastChartFilter().value_filters.map((f: any) => f.sensor)).toEqual(['A2']);
        expect(lastOf(rust.chartResponses)!.view.total_rows).toBe(2);
    });

    describe('a rename that fails part-way leaves every recipe pointing at an existing column and never deletes another sensor\'s column', () => {
        const steps: Array<[string, (r: FakeRust) => void]> = [
            ['reading the edited formula\'s references', r => r.failOn('extract_formula_refs', a => a.formulas.length === 1 && a.formulas[0] === '$TAG1 * 2')],
            ['rewriting a downstream formula (rename_formula_refs)', r => r.failOn('rename_formula_refs', () => true)],
            ['building the column under the NEW name', r => r.failOn('evaluate_formula', a => a.customName === 'A2')],
            ['recomputing the downstream formula B', r => r.failOn('evaluate_formula', a => a.customName === 'B')],
            ['recomputing the downstream operation C', r => r.failOn('calculate_new_sensor', a => a.config.customName === 'C')],
        ];
        it.each(steps)('injected failure while %s', async (_step, inject) => {
            await openWorkspace(CHAIN(), { selectedSensors: ['A', 'B', 'C'], visibleSensors: ['A', 'B', 'C'] });
            inject(rust);
            await renameViaEditor('A', 'A2');

            expect(editorError()).not.toBe('');
            // Nothing was told to the Dashboard ...
            expect(h.log.some(e => e.event === 'rename-special-sensor')).toBe(false);
            expect(dashSelected()).toEqual(['A', 'B', 'C']);
            // ... the old column is intact, the half-built new one is gone ...
            expect(rust.chartValues('A')).toEqual([2, 4, 6, 8]);
            expect(rust.has('A2')).toBe(false);
            // ... no other sensor lost its column ...
            for (const t of ['TAG1', 'TAG2', 'TAG3', 'TAG4', 'B', 'C']) expect(rust.has(t), t).toBe(true);
            const recipes = await persistedRecipes();
            expect(recipes.map(r => r.tag)).toEqual(['A', 'B', 'C']);
            await expectConsistent(recipes);

            // ... and the same rename succeeds once the fault is gone.
            rust.clearFaults();
            await saveEditor();
            expect(editorError()).toBe('');
            const after = await persistedRecipes();
            expect(after.map(r => r.tag)).toEqual(['A2', 'B', 'C']);
            expect(rust.has('A')).toBe(false);
            await expectConsistent(after);
        });

        it('if dropping the OLD column fails after everything else worked: the rename stands, the user is told, and reusing the old name is refused inline (not a silent wrong-values sensor)', async () => {
            await openWorkspace(CHAIN());
            rust.failOn('remove_sensor_columns', a => a.names[0] === 'A', 'disk on fire');
            await renameViaEditor('A', 'A2');
            expect(W().getByRole('alert').textContent).toMatch(/couldn't free the old data/);
            const recipes = await persistedRecipes();
            expect(recipes.map(r => r.tag)).toEqual(['A2', 'B', 'C']);
            await expectConsistent(recipes, { allowOrphans: true }); // A's column is the reported orphan
            expect(rust.derivedNames()).toContain('A');

            await createFormula('A', '$TAG3 / 100');
            expect(lastOf(rust.cmds('evaluate_formula'))!.error).toMatch(/already exists/);
            expect(W().getAllByText(/already exists/).length).toBeGreaterThan(0);
            expect((await persistedRecipes()).map(r => r.tag)).toEqual(['A2', 'B', 'C']);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Edit with dependents, order, cycles
// ═════════════════════════════════════════════════════════════════════════

/** Simulate quitting and restarting the app: every window is gone and the
 *  Rust session is empty again; only the workspace files survive. */
function restartApp() {
    cleanup();
    dash = null;
    win = null;
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.log.length = 0;
    sensorSelectionProps.length = 0;
    rust = createFakeRust(RAW);
    h.rust = rust;
    dismissAllErrors();
}

/** Reopen the workspace from the Recent list of the REAL DataUploadPage
 *  (load_csv + recipe replay), then hand its result to a fresh Dashboard. */
async function reopenWorkspace() {
    const onDataReady = vi.fn();
    let up!: ReturnType<typeof render>;
    await act(async () => { up = render(<DataUploadPage onDataReady={onDataReady} />); });
    await flush();
    await act(async () => { fireEvent.click(within(up.container).getAllByText('Test WS')[0]); });
    await flush(40);
    await tick(800);
    expect(onDataReady).toHaveBeenCalledTimes(1);
    const [metadata, state, sm] = onDataReady.mock.calls[0];
    up.unmount();
    await act(async () => {
        dash = render(<Dashboard metadata={metadata} sensorMetadata={sm ?? RAW_META} onBack={() => {}} initialState={state} />);
    });
    await flush();
    await tick(300);
    return state as WorkspaceState;
}

describe('4. editing a sensor others depend on', () => {
    it('edit the root of A -> B -> C: B and C are recomputed in order, the chart refetches, every value matches the recipes', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1'), F('C', '$B * 10')], { selectedSensors: ['C'], visibleSensors: ['C'] });
        expect(chartSeriesFor('C')).toEqual([30, 50, 70, 90]);
        await openEditor('A');
        await setEditor({ formula: '$TAG1 * 3' });
        await saveEditor();
        expect(editorError()).toBe('');
        expect(chartSeriesFor('C')).toEqual([40, 70, 100, 130]);
        await expectConsistent(await persistedRecipes());
    });

    // Was a BUG (medium): `dependentsToRecompute` returns the dependents in the
    // stored ARRAY order, and `recomputeSpecialSensors` runs them in that
    // order. A workspace saved before today's ordering fix (or any list not
    // in build order) recomputes C before B, so C is built from B's OLD
    // values. The same edit also writes a corrected `recipeOrder`, so only the
    // first edit per such workspace is hit -- but it's silent wrong numbers.
    it('regression: workspace saved with recipes in the order [C=$B*10, B=${A}+1, A=$TAG1*2] -> edit A to $TAG1*3 -> C is recomputed BEFORE B and keeps values from the old B', async () => {
        const recipes = [F('C', '$B * 10'), F('B', '${A} + 1'), F('A', '$TAG1 * 2')];
        await seedSession([recipes[2], recipes[1], recipes[0]]); // what the (dependency-ordered) replay built
        await openDashboard(baseState({ specialSensorRecipes: recipes, extraSensorMetadata: recipes.map(r => metaFor(r.tag)), selectedSensors: ['C'], visibleSensors: ['C'] }));
        await openWindow();
        await openEditor('A');
        await setEditor({ formula: '$TAG1 * 3' });
        await saveEditor();
        expect(rust.chartValues('C')).toEqual([40, 70, 100, 130]);
    });

    it('an edit that makes an EARLY sensor read a LATER one is reordered, and a full app restart + workspace reopen replays it correctly', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('C', '$TAG3 + 1')], { selectedSensors: ['A'], visibleSensors: ['A'] });
        await openEditor('A');
        await setEditor({ formula: '$C * 2' });
        await saveEditor();
        expect(editorError()).toBe('');
        expect(chartSeriesFor('A')).toEqual([202, 402, 602, 802]);
        const saved = await persistedRecipes();
        expect(saved.map(r => r.tag)).toEqual(['C', 'A']);

        restartApp();
        await reopenWorkspace();
        expect(getErrors()).toHaveLength(0);
        expect(rust.chartValues('A')).toEqual([202, 402, 602, 802]);
        expect(chartSeriesFor('A')).toEqual([202, 402, 602, 802]);
        await expectConsistent(saved);
    });

    it('a cycle is refused (A -> B -> A) and nothing changes', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1')]);
        await openEditor('A');
        await setEditor({ formula: '$B + 1' });
        await saveEditor();
        expect(editorError()).toMatch(/depend on itself/);
        expect(h.log.some(e => e.event === 'update-special-sensor')).toBe(false);
        expect(rust.chartValues('A')).toEqual([2, 4, 6, 8]);
        await expectConsistent(await persistedRecipes());
    });

    // Was a BUG (low -- needs a second save inside the formula-reference lookup's
    // round trip): the cycle check reads the window's `formulaRefs` map,
    // which is refreshed ASYNCHRONOUSLY after each save. A second save that
    // lands before the refresh reasons about the OLD references.
    it('regression: edit A to $C * 2 -> save -> before the extract_formula_refs refresh answers, edit C to $A + 1 -> save: the A <-> C cycle is accepted', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('C', '$TAG3 + 1')]);
        // Hold the background refresh that follows the first save.
        const g = rust.gate('extract_formula_refs', a => a.formulas.length === 2 && a.formulas.includes('$C * 2'));
        await openEditor('A');
        await setEditor({ formula: '$C * 2' });
        await saveEditor();
        await openEditor('C');
        await setEditor({ formula: '$A + 1' });
        await saveEditor();
        g.release();
        await flush();
        expect(editorError()).toMatch(/depend on itself/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Workspace reopen replay
// ═════════════════════════════════════════════════════════════════════════

describe('5. workspace reopen replay (real DataUploadPage -> real Dashboard -> real window)', () => {
    it('a broken recipe + one built on it: dependent skipped, ONE toast naming both, no ghost line, recipes + metadata kept, and fixing the broken one in Manage brings both back', async () => {
        const recipes = [F('BROKEN', '$GONE + 1'), F('DEP', '${BROKEN} * 2'), F('OK', '$TAG1 * 2')];
        h.disk.set(WS, baseState({
            specialSensorRecipes: recipes,
            extraSensorMetadata: recipes.map(r => metaFor(r.tag)),
            selectedSensors: ['TAG1', 'BROKEN', 'DEP', 'OK'],
            visibleSensors: ['TAG1', 'BROKEN', 'DEP', 'OK'],
        }));
        await reopenWorkspace();

        expect(rust.cmds('evaluate_formula').map(c => c.args.customName)).toEqual(['BROKEN', 'OK']);
        const errors = getErrors();
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/BROKEN/);
        expect(errors[0].message).toMatch(/Skipped.*DEP/);
        expect(dashSelected()).toEqual(['TAG1', 'OK']);
        expect(lastChartFilter().sensors).toEqual(['TAG1', 'OK']);
        expect(dashListed()).toEqual(expect.arrayContaining(['BROKEN', 'DEP', 'OK']));
        expect(chartSeriesFor('OK')).toEqual([2, 4, 6, 8]);
        const kept = await persistedRecipes();
        expect(kept.map(r => r.tag)).toEqual(['BROKEN', 'DEP', 'OK']);
        expect(h.disk.get(WS).extraSensorMetadata.map((m: SensorMetadata) => m.tag)).toEqual(['BROKEN', 'DEP', 'OK']);

        // Fix it in Manage.
        await openWindow();
        await goManage();
        expect(W().getByLabelText('Edit BROKEN')).toBeTruthy();
        expect(W().getByLabelText('Edit DEP')).toBeTruthy();
        await openEditor('BROKEN');
        await setEditor({ formula: '$TAG1 + 1' });
        await saveEditor();
        expect(editorError()).toBe('');
        expect(rust.chartValues('BROKEN')).toEqual([2, 3, 4, 5]);
        expect(rust.chartValues('DEP')).toEqual([4, 6, 8, 10]);
        await expectConsistent(await persistedRecipes());
    });

    it('all-good workspace: every value is restored; reopening it a second time in the same session is idempotent', async () => {
        const recipes = [F('A', '$TAG1 * 2'), F('B', '${A} + 1'), SUM('S', ['TAG1', 'TAG2'])];
        h.disk.set(WS, baseState({
            specialSensorRecipes: recipes,
            extraSensorMetadata: recipes.map(r => metaFor(r.tag)),
            selectedSensors: ['B', 'S'], visibleSensors: ['B', 'S'],
        }));
        await reopenWorkspace();
        expect(getErrors()).toHaveLength(0);
        expect(chartSeriesFor('B')).toEqual([3, 5, 7, 9]);
        expect(chartSeriesFor('S')).toEqual([11, 22, null, 44]);
        await expectConsistent(recipes);

        // Back to the Import page and open the same workspace again (same
        // Rust process: load_csv resets the session, the replay runs again).
        cleanup();
        for (const k of Object.keys(h.listeners)) delete h.listeners[k];
        await reopenWorkspace();
        expect(getErrors()).toHaveLength(0);
        for (const r of recipes) expect(rust.columnCount(r.tag), r.tag).toBe(1);
        expect(chartSeriesFor('B')).toEqual([3, 5, 7, 9]);
        await expectConsistent(recipes);

        // A replay on top of a session that ALREADY has the columns (no
        // load_csv in between) is idempotent too -- replace: true.
        const { replaySpecialSensorRecipes } = await import('../utils/specialSensorReplay');
        const res = await replaySpecialSensorRecipes(recipes, (c, a) => rust.invoke(c, a));
        expect(res).toEqual({ failed: [], skipped: [] });
        for (const r of recipes) expect(rust.columnCount(r.tag), r.tag).toBe(1);
        await expectConsistent(recipes);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. Name rules end to end
// ═════════════════════════════════════════════════════════════════════════

const ODD_NAMES = [
    'Total-Power', 'A/B', 'Eff%', '(x)', 'Sum All', 'a.b', '11PT1214A', '11PT1214A.PV',
    'อุณหภูมิ', 'ค่าสูงสุด', '2nd stage', 'x_y', '50%', 'ºC', 'a+b',
];

describe('6. names: the TS brace rule matches the Rust tokenizer', () => {
    it.each([...ODD_NAMES, 'plain_1', 'Temp', 'x*y', 'Spacey Name', 'ไทย'])('sensorRef(%j) is exactly what Rust\'s sensor_ref_token writes, and it scans back to the same name', (name) => {
        expect(sensorRef(name)).toBe(rustRefToken(name));
        const scanned = rustScanRefs(`1 + ${sensorRef(name)} * 2`).map(s => s.name);
        expect(scanned).toEqual([name]);
    });

    // Rename targets: a different odd name, so the downstream formula has to be
    // rewritten from one braced/bare form to another.
    const pairs = ODD_NAMES.map((n, i) => [n, ODD_NAMES[(i + 5) % ODD_NAMES.length]] as const)
        .filter(([a, b]) => a.toLowerCase() !== b.toLowerCase());

    it.each(pairs)('create %j -> build D on it from the Explorer chain -> rename it to %j -> restart + reopen: D keeps the right values all the way', async (name, renamed) => {
        await openDashboard(baseState());
        await openWindow();
        await createFormula(name, '$TAG1 * 2');
        expect(rust.chartValues(name)).toEqual([2, 4, 6, 8]);

        // D from the Explorer + default "+" chain (TS writes the reference).
        await goCreate();
        const toButtons = W().queryByText('Use buttons instead');
        if (toButtons) await act(async () => { fireEvent.click(toButtons); });
        await pick(name, 'TAG3');
        await fillCreate('D');
        await clickAdd();
        const dRecipe = (await persistedRecipes()).find(r => r.tag === 'D') as { formula: string };
        expect(dRecipe.formula).toBe(`${rustRefToken(name)} + $TAG3`);
        expect(rust.chartValues('D')).toEqual([102, 204, 306, 408]);

        await renameViaEditor(name, renamed);
        expect(editorError()).toBe('');
        const saved = await persistedRecipes();
        expect((saved.find(r => r.tag === 'D') as { formula: string }).formula).toBe(`${rustRefToken(renamed)} + $TAG3`);
        expect(rust.has(name)).toBe(false);
        await expectConsistent(saved);

        restartApp();
        await reopenWorkspace();
        expect(getErrors()).toHaveLength(0);
        expect(rust.chartValues('D')).toEqual([102, 204, 306, 408]);
        expect(rust.chartValues(renamed)).toEqual([2, 4, 6, 8]);
    });

    it('a sensor whose name is a PREFIX of another (11PT1214A / 11PT1214A.PV): renaming the short one leaves the long one\'s reference alone', async () => {
        await openWorkspace([F('11PT1214A', '$TAG1 * 2'), F('11PT1214A.PV', '$TAG3 + 0'), F('D', '$11PT1214A + ${11PT1214A.PV}')]);
        expect(rust.chartValues('D')).toEqual([102, 204, 306, 408]);
        await renameViaEditor('11PT1214A', 'P');
        expect(editorError()).toBe('');
        const saved = await persistedRecipes();
        expect((saved.find(r => r.tag === 'D') as { formula: string }).formula).toBe('$P + ${11PT1214A.PV}');
        await expectConsistent(saved);
    });

    it.each([
        ['a}b', /can't contain "}"/],
        ['timestamp', /reserved for the time column/],
        [' Time ', /reserved for the time column/],
        ['tag1', /already exists/],
    ])('creating a sensor named %j is refused inline before anything reaches the backend', async (name, why) => {
        await openDashboard(baseState());
        await openWindow();
        await typeFormula('$TAG1 * 2');
        await fillCreate(name);
        expect(W().getByText(why)).toBeTruthy();
        expect(addBtn().disabled).toBe(true);
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(rust.cmds('evaluate_formula')).toHaveLength(0);
    });

    it.each([['a}b'], ['Timestamp'], ['TAG1'], ['b']])('renaming to %j is refused in the editor (Save disabled) and nothing changes', async (to) => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1')]);
        await openEditor('A');
        await setEditor({ name: to });
        expect(W().getByText('Save changes').closest('button')!.disabled).toBe(true);
        expect(editorError()).not.toBe('');
        expect(rust.calls.filter(c => c.args?.replace)).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 8. Nasty interleavings
// ═════════════════════════════════════════════════════════════════════════

describe('8. interleavings', () => {
    it('rename A -> B, then delete B inside the undo window: both names are gone from the session and the Dashboard', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], { selectedSensors: ['A'], visibleSensors: ['A'] });
        await renameViaEditor('A', 'B');
        await deleteSensor('B');
        await tick(8100);
        expect(rust.has('A')).toBe(false);
        expect(rust.has('B')).toBe(false);
        expect(rust.derivedNames()).toEqual([]);
        expect(dashSelected()).toEqual([]);
        expect(await persistedRecipes()).toEqual([]);
    });

    it('edit Y while X is inside its undo window: the delete settles first (exactly once), the edit lands, everything consistent', async () => {
        await openWorkspace([F('X', '$TAG1 * 2'), F('Y', '$TAG3 + 1')], { selectedSensors: ['X', 'Y'], visibleSensors: ['X', 'Y'] });
        await deleteSensor('X');
        await openEditor('Y');
        await setEditor({ formula: '$TAG3 + 2' });
        await saveEditor();
        expect(editorError()).toBe('');
        expect(rust.has('X')).toBe(false);
        expect(dashSelected()).toEqual(['Y']);
        expect(chartSeriesFor('Y')).toEqual([102, 202, 302, 402]);
        await tick(9000);
        expect(rust.cmds('remove_sensor_columns')).toHaveLength(1);
        const recipes = await persistedRecipes();
        expect(recipes.map(r => r.tag)).toEqual(['Y']);
        await expectConsistent(recipes);
    });

    it('a second Add while the first create is still computing is impossible (button locked), and exactly one sensor results', async () => {
        await openDashboard(baseState());
        await openWindow();
        const g = rust.gate('evaluate_formula', a => a.customName === 'Slow');
        await typeFormula('$TAG1 * 2');
        await fillCreate('Slow');
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(addBtn().disabled).toBe(true);
        await act(async () => { fireEvent.click(addBtn()); });
        await act(async () => { g.release(); });
        await flush(20);
        await tick(300);
        expect(rust.cmds('evaluate_formula')).toHaveLength(1);
        expect(rust.columnCount('Slow')).toBe(1);
        expect((await persistedRecipes()).map(r => r.tag)).toEqual(['Slow']);
    });

    // Note (fix pass): with every mutation serialized, the FIRST one clicked wins.
    // The original expected the (later) rename to win and the (earlier) create to
    // be refused -- an artifact of the two overlapping. Now the create finishes
    // first and the rename is refused inline ("already in use"); either way
    // nothing is duplicated or overwritten.
    it('create N is still computing when A is renamed to N in Manage: they run one after the other -- the create (clicked first) wins, the rename is refused inline, nothing is duplicated', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        const g = rust.gate('evaluate_formula', a => a.customName === 'N' && !a.replace);
        await typeFormula('$TAG3 * 1');
        await fillCreate('N');
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        await renameViaEditor('A', 'N');
        // The rename has not started: it waits behind the create.
        expect(rust.cmds('rename_formula_refs')).toHaveLength(0);
        expect(rust.calls.filter(c => c.args?.replace)).toHaveLength(0);
        await act(async () => { g.release(); });
        await flush(30);
        await tick(300);
        expect(editorError()).toMatch(/"N" is already in use by another sensor/);
        const recipes = await persistedRecipes();
        expect(recipes.map(r => r.tag)).toEqual(['A', 'N']);
        expect(rust.columnCount('N')).toBe(1);
        expect(rust.chartValues('N')).toEqual([100, 200, 300, 400]);
        expect(rust.chartValues('A')).toEqual([2, 4, 6, 8]);
        await expectConsistent(recipes);
    });

    // Was a BUG (medium-low, needs a slow recompute -- seconds on a big CSV): the
    // rename's collision check runs BEFORE its recompute, and the Create tab
    // does not know a rename to that name is in flight. The rename's
    // `replace: true` recompute then OVERWRITES the freshly created sensor's
    // column in place, and both recipes end up under one tag.
    it('regression: rename A -> N is recomputing (slow) -> meanwhile Create makes a NEW sensor N ($TAG3 * 1) -> the rename overwrites N\'s column with A\'s values and two recipes are named N', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        const g = rust.gate('evaluate_formula', a => a.customName === 'N' && a.replace === true);
        await openEditor('A');
        await setEditor({ name: 'N' });
        await act(async () => { fireEvent.click(W().getByText('Save changes').closest('button')!); });
        await flush();
        await goCreate();
        await typeFormula('$TAG3 * 1');
        await fillCreate('N');
        await clickAdd();
        await act(async () => { g.release(); });
        await flush(30);
        await tick(400);
        const recipes = await persistedRecipes();
        expect(recipes.filter(r => r.tag.toLowerCase() === 'n')).toHaveLength(1);
        await expectConsistent(recipes);
    });

    // Was a BUG (low, design-level): the window keeps whichever
    // `failure-group-state-changed` arrived LAST, with no ordering/version.
    // Two writers (Dashboard echo + Build Model) can deliver out of order.
    it('regression: Build Model\'s "model m1 now uses A" and an older FG broadcast arrive out of order -> the window ends on the older list and lets A be deleted', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        h.hold(e => e === 'failure-group-state-changed');
        // Dashboard's echo (before Build Model's write), then Build Model's write
        // (persist, then broadcast) -- delivered in the OPPOSITE order.
        await h.emit('failure-group-state-changed', { workspaceId: WS, origin: 'dashboard', groups: [], models: [] });
        await writerPersistsThenBroadcasts([mk({ id: 'm1', targetSensor: 'A' })], {}, 'build-model', { broadcast: false });
        await h.emit('failure-group-state-changed', { workspaceId: WS, origin: 'build-model', groups: [], models: [mk({ id: 'm1', targetSensor: 'A' })] });
        await act(async () => { h.release([1, 0]); });
        await flush();
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
    });

    // Was a BUG (medium): an edit (no rename) that fails on the 2nd downstream
    // recompute has ALREADY overwritten the edited sensor (and the 1st
    // downstream) in place with the NEW formula's values -- there is no
    // rollback -- while the window and the Dashboard keep the OLD recipe.
    // The chart shows numbers no recipe produces until the workspace is
    // reopened. (Same with a rename + formula change: B is left computed from
    // the new formula while its recipe still reads A.)
    it('regression: A -> B, C; edit A to $TAG1 * 3; recomputing C fails -> A\'s column already holds $TAG1 * 3 while every recipe still says $TAG1 * 2 (Cancel leaves it so)', async () => {
        await openWorkspace(CHAIN());
        rust.failOn('calculate_new_sensor', a => a.config.customName === 'C');
        await openEditor('A');
        await setEditor({ formula: '$TAG1 * 3' });
        await saveEditor();
        expect(editorError()).toMatch(/Could not recompute "C"/);
        await act(async () => { fireEvent.click(W().getByText('Cancel')); });
        await expectConsistent(await persistedRecipes());
    });

    it('rename A to the name of a sensor that is still inside its undo window: the delete settles first, then the rename takes the name', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('X', '$TAG3 + 1')], { selectedSensors: ['A', 'X'], visibleSensors: ['A', 'X'] });
        await deleteSensor('X');
        await renameViaEditor('A', 'x');
        expect(editorError()).toBe('');
        expect(rust.columnCount('x')).toBe(1);
        expect(rust.chartValues('x')).toEqual([2, 4, 6, 8]);
        expect(dashSelected()).toEqual(['x']);
        await tick(9000);
        const recipes = await persistedRecipes();
        expect(recipes).toEqual([F('x', '$TAG1 * 2')]);
        await expectConsistent(recipes);
    });

    // Was a BUG (medium-low, same class as the rename/create race above: Create is
    // not serialized with an in-flight Manage edit). The edit decides its
    // downstream set when it STARTS; a sensor created on top of the edited
    // one while its recompute is still running reads the OLD values and is
    // never recomputed.
    it('regression: edit A ($TAG1 * 2 -> $TAG1 * 3) is recomputing (slow) -> meanwhile Create builds B = $A + 1 -> B keeps old-A values (3,5,7,9) instead of (4,7,10,13)', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        const g = rust.gate('evaluate_formula', a => a.customName === 'A' && a.replace === true);
        await openEditor('A');
        await setEditor({ formula: '$TAG1 * 3' });
        await act(async () => { fireEvent.click(W().getByText('Save changes').closest('button')!); });
        await flush();
        await goCreate();
        await typeFormula('$A + 1');
        await fillCreate('B');
        await clickAdd();
        await act(async () => { g.release(); });
        await flush(30);
        await tick(400);
        await expectConsistent(await persistedRecipes());
    });

    // Was a BUG (low, needs a recompute slower than the 8 s undo window): Delete is
    // not locked while an edit is recomputing. Deleting a downstream sensor
    // and letting the undo window expire drops its column; the edit's
    // `replace: true` recompute of that sensor then APPENDS it again -- an
    // orphan column no recipe owns, which then blocks the name ("already
    // exists") until the app restarts.
    it('regression: edit A (B = ${A} + 1 built on it) -> B\'s recompute is slow -> delete B and let the 8 s undo window expire -> the edit re-creates B\'s column after the delete dropped it (orphan; a new "B" is then refused)', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1')]);
        const g = rust.gate('evaluate_formula', a => a.customName === 'B' && a.replace === true);
        await openEditor('A');
        await setEditor({ formula: '$TAG1 * 3' });
        await act(async () => { fireEvent.click(W().getByText('Save changes').closest('button')!); });
        await flush();
        await act(async () => { fireEvent.click(deleteBtn('B')); });
        await tick(8100);
        // Note (fix pass): the original asserted here that the delete had ALREADY
        // dropped B's column while the edit was still recomputing -- i.e. that the
        // two ran at the same time, which is exactly the bug. Now the delete
        // waits its turn behind the edit: B is still there, untouched.
        expect(rust.has('B')).toBe(true);
        expect(rust.cmds('remove_sensor_columns')).toHaveLength(0);
        await act(async () => { g.release(); });
        await flush(30);
        await tick(400);
        // The edit finished (B recomputed), THEN the queued delete dropped it:
        // one column fewer, no orphan, and a new "B" is free to be created.
        expect(rust.has('B')).toBe(false);
        const recipes = await persistedRecipes();
        expect(recipes.map(r => r.tag)).toEqual(['A']);
        await expectConsistent(recipes);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 9. Edit lock (2026-10-03) -- a special sensor used by a model cannot be
//    edited / renamed / deleted; only its description, unit and component can
//    change. Real Dashboard + real window + fake Rust session.
// ═════════════════════════════════════════════════════════════════════════

describe('9. edit lock: a sensor a model uses', () => {
    const WRITES = ['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns', 'rename_formula_refs'];
    const sessionWrites = (from: number) => rust.calls.slice(from).filter(c => WRITES.includes(c.cmd) || c.args?.replace);
    const modelOn = (tag: string, over: Record<string, unknown> = {}) =>
        mk({ id: 'm1', name: 'Pump model', kind: 'relationship', targetSensor: tag, ...over });
    const withModel = (m: any, extra: Record<string, unknown> = {}) =>
        ({ failureGroupState: { groups: [], models: [m], ...extra } as any });
    const banner = () => W().queryByTestId('edit-lock-banner');
    const sentEvents = (names: string[]) => h.log.filter(e => names.includes(e.event));

    it('end to end: model on A -> Name/Formula are read-only with the reason; a rename/formula edit cannot be made; Delete is off with the reason; remove the model -> the same edit works and the values update', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1')], {
            selectedSensors: ['B'], visibleSensors: ['B'], ...withModel(modelOn('A')),
        });
        expect(chartSeriesFor('B')).toEqual([3, 5, 7, 9]);

        // Edit / rename: locked, with a plain reason.
        await openEditor('A');
        expect(banner()!.textContent).toContain('Used by 1 model: Pump model (Relationship). Remove it from those models first, then you can edit it.');
        expect((W().getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
        expect((W().getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(true);

        // Delete: off, with the reason in the same row.
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
        await act(async () => { fireEvent.click(W().getByText('Used by 1 sensor and 1 model')); });
        expect(W().getByText(/Used by models:/)).toBeTruthy();
        expect(W().getByTestId('edit-lock-A').textContent).toContain('Pump model (Relationship)');

        // The user removes the sensor from the model in Build Model.
        await writerPersistsThenBroadcasts([modelOn('TAG3')]);
        await tick(400);
        expect(deleteBtn('A').disabled).toBe(true); // B is still built on it -- an unrelated, existing rule
        // The editor is still open on A and simply unlocks in place.
        expect(banner()).toBeNull();
        expect((W().getByLabelText('Name') as HTMLInputElement).readOnly).toBe(false);
        await setEditor({ formula: '$TAG1 * 3' });
        await saveEditor();
        expect(editorError()).toBe('');
        expect(chartSeriesFor('B')).toEqual([4, 7, 10, 13]); // A and B recomputed
        expect(rust.chartValues('A')).toEqual([3, 6, 9, 12]);
        await expectConsistent(await persistedRecipes());
    });

    it('a metadata-only save of a locked sensor is accepted: values, columns and recipes are untouched, the description is saved and reaches the Dashboard', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1')], {
            selectedSensors: ['B'], visibleSensors: ['B'], ...withModel(modelOn('B')),
        });
        const from = rust.calls.length;
        await openEditor('A'); // locked transitively through B
        expect(banner()!.textContent).toContain('Built on by "B", which is used by 1 model: Pump model (Relationship).');
        await act(async () => { fireEvent.change(W().getByLabelText('Description'), { target: { value: 'Generator power' } }); });
        await act(async () => { fireEvent.change(W().getByLabelText('Unit'), { target: { value: 'kW' } }); });
        await saveEditor();
        expect(editorError()).toBe('');
        expect(sessionWrites(from)).toHaveLength(0);
        expect(rust.chartValues('A')).toEqual([2, 4, 6, 8]);
        expect(chartSeriesFor('B')).toEqual([3, 5, 7, 9]);
        const recipes = await persistedRecipes();
        expect(recipes).toEqual([F('A', '$TAG1 * 2'), F('B', '${A} + 1')]);
        expect(h.disk.get(WS).extraSensorMetadata.find((m: SensorMetadata) => m.tag === 'A')).toMatchObject({ description: 'Generator power', unit: 'kW' });
        await expectConsistent(recipes);
    });

    it('a model added from ANOTHER window after the editor was opened (no broadcast at all) still refuses the save: inline reason, the session untouched, the Dashboard never told', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], { selectedSensors: ['A'], visibleSensors: ['A'] });
        await openEditor('A');
        expect(banner()).toBeNull(); // unlocked when opened
        await setEditor({ name: 'A2', formula: '$TAG1 * 5' });
        // Build Model persists a model that targets A -- the window is NOT told.
        await writerPersistsThenBroadcasts([modelOn('A')], {}, 'build-model', { broadcast: false });
        const from = rust.calls.length;
        await saveEditor();
        expect(editorError()).toMatch(/Can't rename "A"\. Used by 1 model: Pump model \(Relationship\)\./);
        expect(sessionWrites(from)).toHaveLength(0);
        expect(sentEvents(['rename-special-sensor', 'update-special-sensor'])).toHaveLength(0);
        expect(rust.chartValues('A')).toEqual([2, 4, 6, 8]);
        expect(rust.has('A2')).toBe(false);
        expect((await persistedRecipes()).map(r => r.tag)).toEqual(['A']);
    });

    it('the same refusal for a formula-only change (no rename)', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        await openEditor('A');
        await setEditor({ formula: '$TAG1 * 5' });
        await writerPersistsThenBroadcasts([modelOn('A')], {}, 'build-model', { broadcast: false });
        const from = rust.calls.length;
        await saveEditor();
        expect(editorError()).toMatch(/Can't change the formula, operation or sources of "A"/);
        expect(sessionWrites(from)).toHaveLength(0);
        expect(rust.chartValues('A')).toEqual([2, 4, 6, 8]);
    });

    it('the workspace Running condition locks a sensor the same way ("Used by the running condition") -- edit, rename and delete', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], {
            failureGroupState: {
                groups: [], models: [],
                runningConditionFilters: [{ id: 'rc1', sensor: 'A', operation: 'greater_than', value1: '3', value2: '' }],
            } as any,
        });
        await openEditor('A');
        expect(banner()!.textContent).toContain('Used by the running condition.');
        expect((W().getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
        await goManage();
        expect(deleteBtn('A').disabled).toBe(true);
    });

    it('a model\'s own Custom running condition counts too', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')], withModel(mk({
            id: 'm1', name: 'Custom RC', targetSensor: 'TAG3', runningConditionMode: 'custom',
            customRunningConditionFilters: [{ id: 'c1', sensor: 'A', operation: 'greater_than', value1: '1', value2: '' }],
        })));
        await openEditor('A');
        expect(banner()!.textContent).toContain('Custom RC (Individual)');
    });

    it('TRANSITIVE through a chain: only C (built on B, built on A) is used by a model -> A and B are locked; an unrelated unused sensor stays editable', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1'), F('C', '$B * 10'), F('Z', '$TAG3 + 1')], withModel(modelOn('C')));
        await openEditor('A');
        expect(banner()!.textContent).toContain('Built on by "C", which is used by 1 model');
        await openEditor('B');
        expect(banner()!.textContent).toContain('Built on by "C"');
        await openEditor('Z');
        expect(banner()).toBeNull();
        expect((W().getByLabelText('Name') as HTMLInputElement).readOnly).toBe(false);
    });

    it('a failed read of the workspace file at save time (models unknown) refuses a rename -- nothing is touched', async () => {
        await openWorkspace([F('A', '$TAG1 * 2')]);
        await openEditor('A');
        await setEditor({ name: 'A2' });
        // The file becomes unreadable right now.
        const real = h.disk.get(WS);
        h.disk.delete(WS);
        const from = rust.calls.length;
        await saveEditor();
        h.disk.set(WS, real);
        expect(editorError()).toMatch(/Can't rename "A" right now: couldn't check whether a model uses it/);
        expect(sessionWrites(from)).toHaveLength(0);
        expect(rust.has('A2')).toBe(false);
    });

    it('an unlocked sensor still renames exactly as before (the lock must not get in the way)', async () => {
        await openWorkspace([F('A', '$TAG1 * 2'), F('B', '${A} + 1')], { selectedSensors: ['A'], visibleSensors: ['A'], ...withModel(modelOn('TAG3')) });
        await renameViaEditor('A', 'A2');
        expect(editorError()).toBe('');
        expect(rust.has('A')).toBe(false);
        expect(rust.chartValues('A2')).toEqual([2, 4, 6, 8]);
        await expectConsistent(await persistedRecipes());
    });
});
