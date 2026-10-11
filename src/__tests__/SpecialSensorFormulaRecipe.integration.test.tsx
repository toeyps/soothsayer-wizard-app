import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/*
 * Special-sensor Formula editor + Quick build,
 * legacy `round($A, n)` conversion, `trainedFormulas` recipe staleness.
 *
 * The workers' unit tests stop at their own seams: `legacyFormulaConversion.test`
 * runs the pure converter / `applyLegacyConversion` on hand-made states,
 * `DataUploadPage.test` mocks `workspaceManager`, `incompleteRule.test` /
 * `specialSensorSignature.test` check the recipe rule on literals,
 * `SpecialSensorFormulaEditor.test` mounts the editor alone. Nothing ran the
 * whole loop across windows. Two journeys here, through the REAL App,
 * DataUploadPage, Dashboard, Add Special Sensor window, Build Model window and
 * workspaceManager; only Tauri is faked (in-memory plugin-fs / plugin-store /
 * event bus from `helpers/healthEnv`, the dataset session + health backend from
 * `helpers/crossFeatureBackend`) plus two Rust commands
 * (`convert_legacy_formula`, `preview_formula`), modelled below on lib.rs /
 * formula_diagnostics.rs.
 *
 *  (a) an OLD workspace whose special sensor is `round($TAG1, 2)` and is used
 *      by a Complete model: opened from Recent -> converted text + demotion in
 *      ONE write, the Dashboard holds (and autosaves) the converted recipe, the
 *      info dialog comes after the Dashboard, a second open converts / writes
 *      nothing.
 *  (b) Quick build Sum -> predictor of a Relationship model -> Train + Mark
 *      complete -> the sensor is LOCKED (a model uses it) -> reopen where its
 *      replay fails -> Repair its formula in Add Sensor while Build Model is
 *      open -> stale in the Build Model list AND the Dashboard dot -> Re-train
 *      clears it (fresh against the NEW recipes, Mark complete not blocked) ->
 *      Build Model reads the disk only on the `recipesChanged` broadcast.
 */

const wins = vi.hoisted(() => ({
    pending: [] as string[],
    open: new Map<string, { label: string; close: () => Promise<void>; setFocus: () => Promise<void> }>(),
    closed: [] as string[],
    dialogOpen: null as unknown,
    selfClose: 'add-sensor' as string,
}));
/** Every `readTextFile` path (plugin-fs) and every info `message` dialog. */
const probe = vi.hoisted(() => ({
    reads: [] as string[],
    messages: [] as { text: string; opts: any; dashboardUp: boolean; dashboardUpNextTask?: boolean; convertedOnDisk: boolean }[],
}));

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => {
    const base = (await import('./helpers/healthEnv')).fsModule();
    return {
        ...base,
        readTextFile: async (p: string) => { probe.reads.push(p); return base.readTextFile(p); },
    };
});
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => {
    const { env } = await import('./helpers/healthEnv');
    return {
        getCurrentWindow: () => ({
            close: async () => { env.windowClose++; await wins.open.get(wins.selfClose)?.close(); },
            onCloseRequested: async (cb: any) => {
                env.closeHandlers.push(cb);
                return () => { const i = env.closeHandlers.indexOf(cb); if (i >= 0) env.closeHandlers.splice(i, 1); };
            },
            onFocusChanged: async () => () => {},
            destroy: async () => {},
            hide: async () => {},
            setFocus: async () => {},
            minimize: async () => {},
            toggleMaximize: async () => {},
        }),
    };
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class {
        constructor(label: string) { wins.pending.push(label); }
        once() { return Promise.resolve(() => {}); }
        static getByLabel(label: string) { return Promise.resolve(wins.open.get(label) ?? null); }
    },
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('0.9.0') }));
vi.mock('../components/upload/MachineMorphCanvas', () => ({ default: () => null }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: vi.fn(async (text: string, opts: unknown) => {
        const { env } = await import('./helpers/healthEnv');
        const up = () => !!document.querySelector('button[title="Back to Import"]');
        const entry: (typeof probe.messages)[number] = {
            text, opts, dashboardUp: up(),
            // The conversion write has landed by the time the user is told about it.
            convertedOnDisk: [...env.files.entries()].some(([k, v]) => k.startsWith('workspaces/') && k.endsWith('.json') && v.includes('round($TAG1 * 100) / 100')),
        };
        probe.messages.push(entry);
        setTimeout(() => { entry.dashboardUpNextTask = up(); }, 0);
    }),
    ask: vi.fn().mockResolvedValue(true),
    open: () => Promise.resolve(wins.dialogOpen),
    save: () => Promise.resolve(null),
}));
vi.mock('../components/charts/ResponsiveECharts', async () => (await import('./helpers/healthEnv')).chartModule());
vi.mock('../components/charts', () => ({
    Chart: (p: any) => <div data-testid="dash-chart" data-type={p.chartType} />,
    defaultSensorColor: (tag: string) => `#${(tag.length * 1234567 % 0xffffff).toString(16).padStart(6, '0')}`,
    LINE_CHART_COLORS: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'],
    MAX_PAIR_PLOT_SENSORS: 4,
    RANGE_PALETTE: [[0.99, 0.75, 0.18, 1.0], [0.20, 0.83, 0.60, 1.0], [0.8, 0.4, 0.9, 1], [0.9, 0.4, 0.4, 1]],
}));
vi.mock('split.js', () => ({ default: () => ({ destroy: () => {} }) }));
vi.mock('../components/TitleBar', () => ({ default: () => <div data-testid="titlebar" /> }));
vi.mock('../hooks/useAppMenu', () => ({ useAppMenu: () => {} }));

import { env, resetEnv } from './helpers/healthEnv';
import { createCrossFeatureBackend, type CrossFeatureBackend } from './helpers/crossFeatureBackend';
import { plantDataset } from './helpers/fakeHealthRust';
import { rustScanRefs } from './helpers/fakeRustSession';
import {
    BASE_FG, bmw, bmwEl, enterSp, markComplete, model, openHealth, openSettings, pickInModal, pill, selectSensor, settle, train,
} from './helpers/healthWorkbench';
import { showSensorTab } from './helpers/dashboardLanding';
import App from '../App';
import '../components/dashboard'; // warm App's lazy chunk
import BuildModelWindow from '../components/windows/BuildModelWindow';
import AddSensorWindow from '../components/windows/AddSensorWindow';
import { dismissAllErrors } from '../errorReporter';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { recipeSignatures } from '../utils/specialSensorSignature';

vi.setConfig({ testTimeout: 120_000 });

const PATH_A = 'C:/data/plant-a.csv';
const DATA_A = plantDataset();

// ── backend: the shared fakes + the two commands of this phase ─────────

/** formula_diagnostics.rs `convert_legacy_round`, for the single-call shapes used here. */
function fakeConvertLegacyRound(formula: string): string {
    return formula.replace(/round\(\s*([^,()]+?)\s*,\s*(\d+)\s*\)/g, (_m, arg: string, nText: string) => {
        const n = Number(nText);
        const a = arg.trim();
        const single = rustScanRefs(a).length === 1 && rustScanRefs(a)[0].token === a;
        const operand = single ? a : `(${a})`;
        if (n === 0) return `round(${a})`;
        const f = `1${'0'.repeat(n)}`;
        return `round(${operand} * ${f}) / ${f}`;
    });
}

const FUNCTIONS = ['abs', 'sqrt', 'pow', 'exp', 'ln', 'log', 'log10', 'round', 'min', 'max', 'ceil', 'floor', 'sin', 'cos', 'tan', 'pi', 'e'];

let be: CrossFeatureBackend;
/** Calls of the two phase-5 commands (the shared fakes do not know them). */
let extraCalls: { cmd: string; args: any }[] = [];

function makeBackend() {
    be = createCrossFeatureBackend({ datasets: { [PATH_A]: DATA_A }, files: env.files });
    extraCalls = [];
    env.backend = {
        ...be,
        invoke: async (cmd: string, args: Record<string, any> = {}) => {
            if (cmd === 'convert_legacy_formula') {
                extraCalls.push({ cmd, args: structuredClone(args) });
                // Tauri default (camelCase) keys: exactly `formula`.
                expect(Object.keys(args)).toEqual(['formula']);
                const out = fakeConvertLegacyRound(args.formula);
                return { formula: out, changed: out !== args.formula };
            }
            if (cmd === 'preview_formula') {
                extraCalls.push({ cmd, args: structuredClone(args) });
                const base = { stats: null, timestamps: [], values: [], period: null, functions: FUNCTIONS, limits: { max_len: 2000, max_depth: 32 }, converted_formula: null };
                if (typeof args.formula !== 'string') return { ok: true, issues: [], ...base };
                // The same gate Create uses (session fake's validate_formula), generation-pinned.
                const v: any = await be.session.invoke('validate_formula', { formula: args.formula, expectedGeneration: args.expectedGeneration });
                return v.valid ? { ok: true, issues: [], ...base } : { ok: false, issues: [{ code: 'parse_error', message: v.error }], ...base };
            }
            return be.invoke(cmd, args);
        },
    } as any;
}

// ── console / rejection recorder ─────────────────────────────────────────

const logged: { level: 'error' | 'warn'; text: string }[] = [];
const rejections: string[] = [];
const onRejection = (e: PromiseRejectionEvent) => { rejections.push(String((e as any).reason)); };
const onNodeRejection = (r: unknown) => { rejections.push(String(r)); };
const nodeProcess = (globalThis as any).process as { on: (e: string, f: (r: unknown) => void) => void; off: (e: string, f: (r: unknown) => void) => void };
const fmt = (args: unknown[]) => args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
const REACT_WARNING = /not wrapped in act|unique "key" prop|React does not recognize|Unknown prop|Invalid DOM property|unmounted component|Maximum update depth|Cannot update a component .* while rendering|validateDOMNesting|is not a valid|non-boolean attribute|changing an uncontrolled|changing a controlled|Each child in a list/;
const reactWarnings = () => logged.filter(l => REACT_WARNING.test(l.text));

beforeEach(() => {
    resetEnv();
    wins.pending.length = 0;
    wins.open.clear();
    wins.closed.length = 0;
    wins.dialogOpen = null;
    wins.selfClose = 'add-sensor';
    roots.clear();
    closing.length = 0;
    probe.reads.length = 0;
    probe.messages.length = 0;
    logged.length = 0;
    rejections.length = 0;
    dismissAllErrors();
    makeBackend();
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push({ level: 'error', text: fmt(a) }); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logged.push({ level: 'warn', text: fmt(a) }); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    window.addEventListener('unhandledrejection', onRejection);
    nodeProcess.on('unhandledRejection', onNodeRejection);
});

afterEach(() => {
    cleanup();
    window.removeEventListener('unhandledrejection', onRejection);
    nodeProcess.off('unhandledRejection', onNodeRejection);
    vi.restoreAllMocks();
});

// ── windows (same harness as CrossFeatureSmoke) ─────────────────────────

const roots = new Map<string, ReturnType<typeof render>>();
const closing: string[] = [];

async function processClosedWindows() {
    await settle(20);
    while (closing.length) {
        const label = closing.shift()!;
        const root = roots.get(label);
        roots.delete(label);
        if (root) await act(async () => { root.unmount(); });
    }
    await settle(20);
}

async function mountPendingWindows() {
    await processClosedWindows();
    while (wins.pending.length) {
        const label = wins.pending.shift()!;
        if (roots.has(label)) continue;
        let r!: ReturnType<typeof render>;
        await act(async () => {
            r = render(label === 'build-model'
                ? <div data-testid="build-model-window"><BuildModelWindow /></div>
                : <div data-testid="add-sensor-window"><AddSensorWindow /></div>);
        });
        roots.set(label, r);
        wins.open.set(label, {
            label,
            setFocus: async () => {},
            close: async () => {
                if (!wins.open.has(label)) return;
                if (label === 'build-model') {
                    let prevented = false;
                    for (const cb of [...env.closeHandlers]) void cb({ preventDefault: () => { prevented = true; } });
                    if (prevented) return;
                }
                wins.open.delete(label);
                wins.closed.push(label);
                closing.push(label);
            },
        });
        await settle(60);
    }
}

const app = () => within(screen.getByTestId('app-root'));
const ASW = () => within(screen.getByTestId('add-sensor-window'));
const aswBody = () => screen.getByTestId('add-sensor-window').querySelector('.special-sensor-body') as HTMLElement;
const onDashboard = () => !!document.querySelector('button[title="Back to Import"]');

async function renderApp() {
    await act(async () => { render(<div data-testid="app-root"><App /></div>); });
    await settle(50);
}

async function importProject(name: string, path: string) {
    await act(async () => { fireEvent.click(app().getByRole('button', { name: /New project/ })); });
    await settle();
    fireEvent.change(app().getByPlaceholderText('e.g. Compressor Line 3 — Q3 Baseline'), { target: { value: name } });
    await act(async () => { fireEvent.click(app().getByText('Continue')); });
    await settle();
    wins.dialogOpen = [path];
    await act(async () => { fireEvent.click(app().getByText('browse').closest('button')!); });
    await settle(20);
    await act(async () => { fireEvent.click(app().getByText('Parse files')); });
    await settle(50);
    await act(async () => { fireEvent.click(app().getByText('Continue')); });
    await settle();
    await act(async () => { fireEvent.click(app().getByRole('button', { name: 'Skip for now' })); });
    await settle(700);
    await waitFor(() => expect(onDashboard()).toBe(true), { timeout: 5000 });
    showSensorTab();
    await settle(400);
}

async function backToImport() {
    await act(async () => { fireEvent.click(document.querySelector('button[title="Back to Import"]') as HTMLElement); });
    await settle(300);
    await processClosedWindows();
    await waitFor(() => expect(onDashboard()).toBe(false));
}

async function openRecent(name: string) {
    await act(async () => { fireEvent.click(app().getAllByText(name)[0]); });
    await settle(900);
    await waitFor(() => expect(onDashboard()).toBe(true), { timeout: 5000 });
    await settle(400);
}

const wsIdByName = (name: string) => ((env.store.get('recent_workspaces') as any[]) ?? []).find(w => w.name === name)?.id as string;
const wsFile = (id: string) => `workspaces/${id}.json`;
const disk = (id: string) => JSON.parse(env.files.get(wsFile(id))!);
const diskModel = (id: string, mid: string) => disk(id).failureGroupState.models.find((m: any) => m.id === mid);
/** Every write of the workspace file from index `from` on, parsed. */
const wsWrites = (id: string, from = 0) => env.writes.slice(from).filter(w => w.path === wsFile(id)).map(w => JSON.parse(w.content));

async function openSensorTab() {
    const btn = app().queryByRole('button', { name: /^Sensor \(/ });
    if (btn) { fireEvent.click(btn); await settle(); }
}
async function openFgTab() {
    const b = app().queryByRole('button', { name: 'Failure Groups' });
    if (b) { fireEvent.click(b); await settle(); }
}
function sensorRow(tag: string): HTMLElement {
    const el = document.querySelector(`[id="sensor-${tag}"]`) as HTMLElement | null;
    expect(el, `sensor row ${tag}`).toBeTruthy();
    return el!.closest('.sensor-list-row') as HTMLElement;
}
async function searchSensors(q: string) {
    fireEvent.change(app().getByPlaceholderText('Search description, tag, unit or component…'), { target: { value: q } });
    await settle();
}
async function inSheet(tag: string, fn: (sheet: ReturnType<typeof within>) => Promise<void>) {
    await openSensorTab();
    await searchSensors(tag);
    await act(async () => { fireEvent.click(within(sensorRow(tag)).getByTitle('Add to failure group')); });
    const sheet = within(await screen.findByTestId('fg-sheet'));
    await fn(sheet);
    if (screen.queryByTestId('fg-sheet')) await act(async () => { fireEvent.click(sheet.getByText('Done')); });
    await searchSensors('');
    await settle(100);
}
async function clickCell(sheet: ReturnType<typeof within>, label: string) {
    await act(async () => { fireEvent.click(sheet.getByRole('button', { name: label })); });
    await settle(400);
}

/** Dashboard Failure Groups tab dot of a model: 'none' | 'trained' | 'complete' | 'need' | 'bad'. */
function dashDot(groupNo: number, key: string, kind: string): string {
    const el = document.querySelector(`[data-testid="fg-kind-badge-dot-${groupNo}-${key}-${kind}"]`);
    if (!el) return 'none';
    return el.className.match(/f4-kb-dot--(\w+)/)?.[1] ?? '?';
}
/** Build Model left-list dot state of a model (`data-state`), 'none' when no dot. */
const bmwDotState = (mid: string) => bmwEl().querySelector(`[data-testid="sensor-kind-badge-dot-${mid}"]`)?.getAttribute('data-state') ?? 'none';

// ── Add Special Sensor window ────────────────────────────────────────────

async function openAddSensorWindow() {
    await openSensorTab();
    await act(async () => { fireEvent.click(document.querySelector('.add-sensor-btn') as HTMLElement); });
    await mountPendingWindows();
    await waitFor(() => expect(aswBody()).toBeTruthy());
    await settle(100);
}
async function closeAddSensorWindow() {
    await act(async () => { fireEvent.click(within(screen.getByTestId('add-sensor-window').querySelector('.special-sensor-footer') as HTMLElement).getByRole('button', { name: /^(Close|Cancel)$/ })); });
    await processClosedWindows();
    expect(roots.has('add-sensor')).toBe(false);
}
function explorerRow(tag: string): HTMLElement | undefined {
    const rows = Array.from(aswBody().querySelectorAll('.special-sensor-row')) as HTMLElement[];
    return rows.find(r => (r.querySelector('.sl-tag')?.textContent ?? r.querySelector('.sl-desc')?.textContent) === tag);
}
async function setExplorerSearch(term: string) {
    const input = aswBody().querySelector('.special-sensor-explorer-search input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: term } }); });
}
async function pick(...tags: string[]) {
    for (const tag of tags) {
        await setExplorerSearch(tag);
        const row = explorerRow(tag);
        expect(row, `explorer row ${tag}`).toBeTruthy();
        await act(async () => { fireEvent.click(row!); });
    }
    await setExplorerSearch('');
    await settle(30);
}
const quickBuild = () => within(within(aswBody()).getByTestId('quick-build'));
function labelledInput(labelText: string): HTMLInputElement {
    const label = Array.from(aswBody().querySelectorAll('label')).find(l => l.textContent?.replace('*', '').trim() === labelText);
    if (!label) throw new Error(`no label ${labelText}`);
    return label.parentElement!.querySelector('input, select') as HTMLInputElement;
}
const formulaBox = () => aswBody().querySelector('textarea[aria-label="Formula"]') as HTMLTextAreaElement;

// ═════════════════════════════════════════════════════════════════════════
// (a) legacy round($A, n) conversion on workspace open
// ═════════════════════════════════════════════════════════════════════════

describe('(a) opening an old workspace with a legacy round($TAG1, 2) special sensor used by a Complete model', () => {
    it('converts on open: new text + demotion in ONE write, the Dashboard holds and autosaves the converted recipe, the info dialog follows the Dashboard, a second open converts and writes nothing', async () => {
        await renderApp();
        await importProject('Legacy', PATH_A);
        const A = wsIdByName('Legacy');
        expect(A).toBeTruthy();
        await backToImport();

        // Turn the file into an OLD workspace: SPR = round($TAG1, 2) (the spreadsheet order, which the
        // engine refuses), an Individual model on SPR and one on TAG1, both trained
        // (fresh fingerprints, no `trainedFormulas` snapshot -- written before it existed) and Complete.
        const ws = disk(A);
        const slice: any = { ...ws.failureGroupState, ...BASE_FG, groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }] };
        const stamp = (m: Record<string, any>): Record<string, any> => ({ ...m, lastTrainedAt: '2026-10-01T10:00:00.000Z', trainedFingerprint: computeTrainFingerprint(m as any, slice) });
        const mSpr = stamp(model({ id: 'm-spr', name: 'Rounded pressure', targetSensor: 'SPR', status: true, healthSetPoints: { kind: 'individual', lower: 1, upper: 99 } }));
        const mTag = stamp(model({ id: 'm-tag1', name: 'Pressure', targetSensor: 'TAG1', status: true, healthSetPoints: { kind: 'individual', lower: 20, upper: 80 } }));
        const LEGACY = 'round($TAG1, 2)';
        env.files.set(wsFile(A), JSON.stringify({
            ...ws,
            lastRoute: 'failure-group',
            specialSensorRecipes: [{ kind: 'formula', tag: 'SPR', formula: LEGACY }],
            extraSensorMetadata: [{ tag: 'SPR', description: 'Rounded pressure', unit: 'bar', component: 'Pump' }],
            failureGroupState: { ...slice, models: [mSpr, mTag] },
        }));

        // ── first open ──
        const w0 = env.writes.length;
        const r0 = be.session.cmds('evaluate_formula').length;
        await openRecent('Legacy');
        await settle(600); // Dashboard autosave debounce + the not-awaited dialog

        // Rust was asked once, with the stored text; the replay used the CONVERTED text, so the sensor has data.
        expect(extraCalls.filter(c => c.cmd === 'convert_legacy_formula').map(c => c.args)).toEqual([{ formula: LEGACY }]);
        const CONVERTED = 'round($TAG1 * 100) / 100';
        expect(be.session.cmds('evaluate_formula').slice(r0).map(c => c.args.formula)).toEqual([CONVERTED]);
        expect(be.session.has('SPR')).toBe(true);
        const tag1 = DATA_A.columns.TAG1 as number[];
        expect(be.session.chartValues('SPR')).toEqual(tag1.map(v => Math.sign(v) * Math.round(Math.abs(v) * 100) / 100));

        // ONE write carries the new text AND the demotion; nothing before it touched the file.
        const writes = wsWrites(A, w0);
        expect(writes.length, 'the conversion wrote the workspace').toBeGreaterThanOrEqual(1);
        const conv = writes[0];
        expect(conv.specialSensorRecipes).toEqual([{ kind: 'formula', tag: 'SPR', formula: CONVERTED }]);
        const convSpr = conv.failureGroupState.models.find((m: any) => m.id === 'm-spr');
        expect(convSpr.status, 'model on SPR demoted in the conversion write').toBe(false);
        expect(convSpr.trainedFingerprint, 'and out of date (a recipe is not in the fingerprint)').toBeUndefined();
        expect(convSpr.lastTrainedAt).toBe('2026-10-01T10:00:00.000Z');
        expect(convSpr.healthSetPoints).toEqual(mSpr.healthSetPoints);
        const convTag = conv.failureGroupState.models.find((m: any) => m.id === 'm-tag1');
        expect(convTag, 'the model that does not use SPR is untouched').toEqual(mTag);

        // No write since (Dashboard autosave included) brought the old text or the old status back.
        for (const w of writes) {
            expect(JSON.stringify(w.specialSensorRecipes)).not.toContain('$TAG1, 2');
            expect(w.failureGroupState.models.find((m: any) => m.id === 'm-spr').status).toBe(false);
        }

        // The info dialog: once, after the Dashboard was up, informational.
        expect(probe.messages).toHaveLength(1);
        // Asked for right after the Dashboard hand-off (`onDataReady`), not awaited: React commits the
        // Dashboard in the next task, so it is on screen behind the dialog. (At the very call the
        // Import page is still in the DOM -- see the QA report; harmless with a native dialog.)
        expect(probe.messages[0].convertedOnDisk, 'the conversion was written before the user is told').toBe(true);
        expect(probe.messages[0].dashboardUpNextTask, 'Dashboard on screen behind the dialog').toBe(true);
        expect(probe.messages[0].opts).toEqual({ title: 'Rounding updated', kind: 'info' });
        expect(probe.messages[0].text).toMatch(/^Updated the rounding in 1 special sensor \(SPR\)/);
        expect(probe.messages[0].text).toMatch(/1 model set back to Incomplete — train it again\.$/);

        // The Dashboard's Failure Groups tab reads the demoted model as not complete, the other as complete.
        await openFgTab();
        expect(dashDot(1, 'spr', 'individual')).toBe('none');
        expect(dashDot(1, 'tag1', 'individual')).toBe('complete');

        // The Dashboard's OWN state holds the converted recipe: an ordinary Dashboard edit (plot a
        // sensor) -> its full-overwrite autosave keeps the converted text and the demotion.
        const w1 = env.writes.length;
        await openSensorTab();
        await searchSensors('TAG3');
        await act(async () => { fireEvent.click(document.querySelector('[id="sensor-TAG3"]') as HTMLElement); });
        await searchSensors('');
        await settle(600);
        const after = wsWrites(A, w1);
        expect(after.length, 'the Dashboard autosaved the edit').toBeGreaterThanOrEqual(1);
        const last = after[after.length - 1];
        expect(last.selectedSensors).toContain('TAG3');
        expect(last.specialSensorRecipes).toEqual([{ kind: 'formula', tag: 'SPR', formula: CONVERTED }]);
        expect(last.failureGroupState.models.find((m: any) => m.id === 'm-spr').status).toBe(false);
        expect(last.failureGroupState.models.find((m: any) => m.id === 'm-tag1').status).toBe(true);
        // ... and hands the converted text to the Add Sensor window (Manage lists it).
        await openAddSensorWindow();
        await act(async () => { fireEvent.click(ASW().getByRole('tab', { name: /Manage/ })); });
        await settle(100);
        // Manage describes the engine form in words; the legacy text is gone.
        expect(screen.getByTestId('add-sensor-window').textContent).toContain('$TAG1 · rounded to 2 decimals');
        expect(screen.getByTestId('add-sensor-window').textContent).not.toContain(LEGACY);
        // Edit opens it as `$TAG1` with "Round the result" = 2 (the stored text, split back).
        await act(async () => { fireEvent.click(ASW().getByLabelText('Edit SPR')); });
        await settle(100);
        expect(formulaBox().value).toBe('$TAG1');
        expect(within(ASW().getByRole('radiogroup', { name: 'Round the result' })).getByRole('radio', { checked: true }).textContent).toBe('2');
        await act(async () => { fireEvent.click(ASW().getByText('Cancel edit')); });
        await settle(50);
        await closeAddSensorWindow();

        // ── second open: nothing left to convert, no write from the open ──
        await settle(400);
        await backToImport();
        const w2 = env.writes.length;
        const onDiskBefore = env.files.get(wsFile(A));
        const c2 = extraCalls.filter(c => c.cmd === 'convert_legacy_formula').length;
        const m2 = probe.messages.length;
        await openRecent('Legacy');
        await settle(600);
        expect(extraCalls.filter(c => c.cmd === 'convert_legacy_formula').length - c2, 'convert_legacy_formula calls on the second open').toBe(0);
        // Nothing changes on disk. (The Dashboard's first autosave after mount re-writes the SAME
        // bytes once -- pre-existing, `lastSavedPayloadRef` starts empty -- never a conversion write.)
        const second = env.writes.slice(w2).filter(x => x.path === wsFile(A));
        expect(second.length, "at most the Dashboard's one identical first autosave").toBeLessThanOrEqual(1);
        for (const x of second) expect(x.content, 'a write on the second open changed the file').toBe(onDiskBefore);
        expect(probe.messages.length - m2, 'no second "Rounding updated" dialog').toBe(0);
        expect(be.session.has('SPR')).toBe(true);
        expect(disk(A).specialSensorRecipes).toEqual([{ kind: 'formula', tag: 'SPR', formula: CONVERTED }]);

        expect(logged.map(l => `[${l.level}] ${l.text.slice(0, 200)}`), 'console.error / console.warn').toEqual([]);
        expect(reactWarnings(), 'React warnings').toEqual([]);
        expect(rejections, 'unhandled rejections').toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// (b) Quick build -> model -> Train -> Repair the formula -> stale -> Re-train
// ═════════════════════════════════════════════════════════════════════════

describe('(b) Dashboard + Add Sensor + Build Model: a special sensor\'s recipe changes under a trained model', () => {
    it('Quick build Sum -> predictor -> Train + Mark complete -> locked -> replay fails on reopen -> Repair -> stale in both windows -> Re-train clears it; Build Model reads the disk only on recipesChanged', async () => {
        await renderApp();
        await importProject('Recipe', PATH_A);
        const A = wsIdByName('Recipe');

        // 1) Quick build: pick TAG3 + TAG4 -> Sum -> "Use this formula" -> SP.
        await openAddSensorWindow();
        await act(async () => { fireEvent.click(ASW().getByRole('tab', { name: /Create/ })); });
        await pick('TAG3', 'TAG4');
        await act(async () => { fireEvent.click(quickBuild().getByRole('button', { name: 'Sum' })); });
        expect(quickBuild().getByTestId('quick-build-output').textContent).toBe('$TAG3 + $TAG4');
        await act(async () => { fireEvent.click(quickBuild().getByRole('button', { name: 'Use this formula' })); });
        expect(formulaBox().value).toBe('$TAG3 + $TAG4');
        await act(async () => { fireEvent.change(aswBody().querySelector('#fx-name')!, { target: { value: 'SP' } }); });
        await act(async () => { fireEvent.change(labelledInput('Description'), { target: { value: 'Flow plus mode' } }); });
        await act(async () => { fireEvent.change(labelledInput('Unit'), { target: { value: 'u' } }); });
        await act(async () => { fireEvent.change(aswBody().querySelector('select[aria-label="Component"]')!, { target: { value: 'Uncategorized' } }); });
        await settle(400); // the preview's debounce
        // The editor's live check went to Rust with the stored text (camelCase keys, pinned).
        const lastPreview = extraCalls.filter(c => c.cmd === 'preview_formula').pop()!.args;
        expect(lastPreview).toEqual(expect.objectContaining({ formula: '$TAG3 + $TAG4', maxPoints: 600, replace: false, expectedGeneration: be.session.generation() }));
        const add = ASW().getByText('Add sensor').closest('button') as HTMLButtonElement;
        expect(add.disabled, 'Add sensor enabled').toBe(false);
        await act(async () => { fireEvent.click(add); });
        await settle(600);
        expect(be.session.cmds('evaluate_formula').map(c => c.args)).toEqual([{ formula: '$TAG3 + $TAG4', customName: 'SP', expectedGeneration: be.session.generation() }]);
        expect(disk(A).specialSensorRecipes).toEqual([{ kind: 'formula', tag: 'SP', formula: '$TAG3 + $TAG4' }]);

        // 2) FG sheet on TAG1: group FG-A with a Relationship model (drop the Individual one it brings).
        await inSheet('TAG1', async sheet => {
            fireEvent.change(sheet.getByLabelText('New failure group name'), { target: { value: 'FG-A' } });
            await act(async () => { fireEvent.click(sheet.getByText('Create')); });
            await settle(400);
            await clickCell(sheet, 'Relation model · FG-A');
            await clickCell(sheet, 'Individual · FG-A');
        });
        const models0 = disk(A).failureGroupState.models;
        expect(models0.map((m: any) => m.kind)).toEqual(['relationship']);
        const mid = models0[0].id as string;

        // 3) Build Model: running condition, SP as predictor, Train, set points, Mark complete.
        await openFgTab();
        await act(async () => { fireEvent.click(app().getByText(/Build Model →/)); });
        await mountPendingWindows();
        await waitFor(() => expect(bmw().getByTestId('rc-card')).toBeTruthy(), { timeout: 4000 });
        await settle(300);
        await setRunningCondition();
        selectSensor('tag1');
        await settle(100);
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(50);
        openSettings();
        fireEvent.click(bmwEl().querySelector('button.pk-add') as HTMLElement);
        await pickInModal('predictors', ['SP']);
        await settle(200);
        await train();
        expect(pill()).toBe('Trained');
        const sig1 = recipeSignatures(disk(A).specialSensorRecipes).get('sp');
        expect(sig1).toBeTruthy();
        expect(diskModel(A, mid).trainedFormulas, 'the Train write stamped the recipe it trained on').toEqual({ sp: sig1 });
        await openHealth();
        const w = be.health.lastOk('compute_health_preview').stats.two_rmse as number;
        await enterSp({
            'sp-residual_at_80_lower': String(-w * 1.5), 'sp-residual_at_80_upper': String(w * 2),
            'sp-residual_at_0_lower': String(-w * 4), 'sp-residual_at_0_upper': String(w * 4),
        });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy(), { timeout: 4000 });
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy(), { timeout: 4000 });
        expect(diskModel(A, mid).status).toBe(true);
        const completeModel = diskModel(A, mid);

        // 4) The lock rule: a model uses SP -> its Name and formula are locked in Manage (so the only
        //    road to a different formula while the model uses it is a Repair).
        await act(async () => { fireEvent.click(ASW().getByRole('tab', { name: /Manage/ })); });
        await settle(200);
        await act(async () => { fireEvent.click(ASW().getByLabelText('Edit SP')); });
        await settle(100);
        expect((ASW().getByLabelText('Name') as HTMLInputElement).readOnly, 'Name locked').toBe(true);
        expect(ASW().getByTestId('edit-lock-banner').textContent).toMatch(/Name and formula are locked/);
        expect(ASW().getByTestId('formula-lock-pill').textContent).toMatch(/Used by/);
        await act(async () => { fireEvent.click(ASW().getByText('Cancel edit')); });
        await settle(50);

        // 5) Close + reopen the project; this time Rust refuses SP's replay (e.g. the engine changed),
        //    so SP has no data this session -> the editor's Repair road is open despite the lock.
        await settle(400);
        await backToImport();
        expect(roots.size).toBe(0);
        be.session.failOn('evaluate_formula', a => a.customName === 'SP', 'Formula error: injected replay refusal');
        await openRecent('Recipe');
        expect(be.session.has('SP'), 'SP not restored').toBe(false);
        expect(extraCalls.filter(c => c.cmd === 'convert_legacy_formula'), 'no legacy round -> no conversion call').toEqual([]);
        expect(diskModel(A, mid).status, 'reopening alone changes no model').toBe(true);

        // Build Model open on the model (Complete), then Add Sensor -> Manage -> Edit SP (repair).
        await openFgTab();
        await act(async () => { fireEvent.click(app().getByText(/Build Model →/)); });
        await mountPendingWindows();
        await waitFor(() => expect(bmw().getByTestId('rc-card')).toBeTruthy(), { timeout: 4000 });
        await settle(300);
        selectSensor('tag1');
        await settle(200);
        await openAddSensorWindow();
        await act(async () => { fireEvent.click(ASW().getByRole('tab', { name: /Manage/ })); });
        await settle(300);
        await act(async () => { fireEvent.click(ASW().getByLabelText('Edit SP')); });
        await settle(200);
        expect(ASW().getByTestId('restore-note')).toBeTruthy();
        expect(ASW().queryByTestId('edit-lock-banner'), 'a repair is not locked').toBeNull();
        expect(formulaBox().readOnly).toBe(false);
        await act(async () => { fireEvent.change(formulaBox(), { target: { value: '$TAG3 + $TAG4 + 1', selectionStart: 17 } }); });
        await settle(400);
        const emitted0 = env.emitted.length;
        const save = ASW().getByText('Save changes').closest('button') as HTMLButtonElement;
        expect(save.disabled, `Save enabled: ${ASW().queryAllByRole('alert').map(a => a.textContent).join(' / ')}`).toBe(false);
        await act(async () => { fireEvent.click(save); });
        await settle(800);

        // The recipe change reached disk WITH the demotion; Rust holds the new values.
        expect(disk(A).specialSensorRecipes).toEqual([{ kind: 'formula', tag: 'SP', formula: '$TAG3 + $TAG4 + 1' }]);
        const t3 = DATA_A.columns.TAG3 as number[];
        const t4 = DATA_A.columns.TAG4 as number[];
        expect(be.session.chartValues('SP')).toEqual(t3.map((v, i) => v + t4[i] + 1));
        const demoted = diskModel(A, mid);
        expect(demoted.status, 'Incomplete again').toBe(false);
        expect(demoted.trainedFingerprint, 'out of date').toBeUndefined();
        expect(demoted.lastTrainedAt).toBe(completeModel.lastTrainedAt);
        expect(demoted.healthSetPoints, 'set points kept').toEqual(completeModel.healthSetPoints);
        // Exactly one broadcast said "the recipes on disk changed" -- the Dashboard autosave's.
        const recipeBroadcasts = env.emitted.slice(emitted0).filter(e => e.event === 'failure-group-state-changed' && e.payload?.recipesChanged === true);
        expect(recipeBroadcasts.map(e => [e.payload.workspaceId, e.payload.origin])).toEqual([[A, 'dashboard']]);

        // Stale in the Build Model list (and its pill), and not complete on the Dashboard dot.
        await waitFor(() => expect(bmwDotState(mid)).toBe('stale'));
        expect(pill()).not.toBe('Complete');
        await openFgTab();
        expect(dashDot(1, 'tag1', 'relationship')).toBe('none');

        // 6) Re-train in Build Model: fresh against the NEW recipe, Mark complete not blocked.
        await train();
        expect(pill()).toBe('Trained');
        expect(bmwDotState(mid)).toBe('trained');
        const sig2 = recipeSignatures(disk(A).specialSensorRecipes).get('sp');
        expect(sig2).not.toBe(sig1);
        expect(diskModel(A, mid).trainedFormulas, 'the re-train stamped the NEW recipe').toEqual({ sp: sig2 });
        expect(dashDot(1, 'tag1', 'relationship')).toBe('trained');
        await openHealth();
        expect(bmw().queryByTestId('mark-block-reason')?.textContent ?? '').not.toMatch(/re-train|Train the model/i);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy(), { timeout: 4000 });
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy(), { timeout: 4000 });
        expect(diskModel(A, mid).status).toBe(true);
        await waitFor(() => expect(bmwDotState(mid)).toBe('complete'));
        await settle(300);
        expect(dashDot(1, 'tag1', 'relationship')).toBe('complete');

        // 7) Disk reads of the Build Model window on FG broadcasts. Close Add Sensor (it re-reads the
        //    models on every broadcast by design) so only Build Model can read; then deliver the
        //    Dashboard's own broadcasts again, as a late arrival would: an ordinary one costs NO read,
        //    the recipesChanged one exactly ONE.
        await closeAddSensorWindow();
        await settle(400);
        const deliver = async (payload: any) => {
            await act(async () => {
                for (const cb of [...(env.listeners['failure-group-state-changed'] ?? [])]) cb({ event: 'failure-group-state-changed', payload: structuredClone(payload), id: 0 });
            });
            await settle(100);
        };
        const fresh = { ...disk(A).failureGroupState, workspaceId: A, origin: 'dashboard' };
        const before = probe.reads.length;
        await deliver(fresh);
        await deliver(fresh);
        expect(probe.reads.slice(before), 'reads on ordinary FG broadcasts').toEqual([]);
        await deliver({ ...fresh, recipesChanged: true });
        expect(probe.reads.slice(before), 'one read on a recipesChanged broadcast').toEqual([wsFile(A)]);
        // ... and the model stays fresh / Complete against the recipes it re-read.
        expect(bmwDotState(mid)).toBe('complete');

        // The only console line of the whole journey is the injected replay refusal.
        expect(logged.map(l => `[${l.level}] ${l.text.slice(0, 200)}`), 'console.error / console.warn').toEqual([
            '[warn] Failed to restore special sensor "SP": Formula error: injected replay refusal',
        ]);
        expect(reactWarnings(), 'React warnings').toEqual([]);
        expect(rejections, 'unhandled rejections').toEqual([]);
    });
});

/** Running condition: Step-1 card -> modal -> TAG2 > 10, a train period and a scoring period (start -> end only) -> Apply. */
async function setRunningCondition() {
    if (!screen.queryByRole('dialog', { name: 'Running condition' })) {
        await act(async () => { fireEvent.click(bmw().getByTestId('rc-card-open')); });
    }
    const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
    if (dlg.getByTestId('rc-mode-condition').getAttribute('aria-pressed') !== 'true') fireEvent.click(dlg.getByTestId('rc-mode-condition'));
    await act(async () => { fireEvent.click(dlg.getByTestId('rc-add-condition')); });
    const cond = within(dlg.getByTestId('rc-cond-1'));
    fireEvent.click(dlg.getByTestId('rc-cond-1').querySelector('button.pk-trigger') as HTMLElement);
    await pickInModal('sensor', ['TAG2'], true);
    fireEvent.click(cond.getByRole('button', { name: 'Greater than' }));
    fireEvent.change(cond.getByLabelText('Value'), { target: { value: '10' } });
    if (dlg.queryByTestId('periods-empty')) await act(async () => { fireEvent.click(dlg.getByTestId('period-add')); });
    if (dlg.queryByTestId('tests-empty')) {
        await act(async () => { fireEvent.click(dlg.getByTestId('test-add')); });
        const typeDate = (label: string, value: string) => {
            const el = dlg.getByLabelText(label);
            fireEvent.change(el, { target: { value } });
            fireEvent.blur(el);
        };
        typeDate('Scoring period 1 start', '2026-01-01T00:00');
        typeDate('Scoring period 1 end', '2026-01-03T00:00');
    }
    await settle(30);
    await act(async () => { fireEvent.click(dlg.getByTestId('rc-apply')); });
    await settle(400);
    expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
}
