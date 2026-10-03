import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/*
 * Cross-feature smoke through the REAL components (qa-agent, 2026-10-04 final
 * sweep after health score phase 4 removed the full-view PM page).
 *
 * ONE long user journey per model kind that chains the features built this
 * week, with nothing but Tauri and the Rust backend faked:
 *
 *   real App (DataUploadPage import: Create project -> browse -> Parse -> Continue)
 *   -> real Dashboard -> "Add special sensor" spawns the REAL Add Special Sensor
 *      window (own React root) -> formula sensor created
 *   -> Sensor tab FG sheet: new group (creates an Individual model), assign the
 *      kind under test, un-assign the extra Individual model -> Undo toast
 *   -> "Build Model ->" spawns the REAL Build Model window (own React root)
 *   -> Running condition: Step-1 card -> modal -> condition -> Apply -> strip
 *   -> settings -> Train -> Model fit -> Health score -> set points -> Mark complete
 *   -> the special sensor is now LOCKED in Manage (edit + delete)
 *   -> FG sheet un-assign of the COMPLETE model -> Undo restores it whole
 *   -> Back to Import -> import workspace B (none of A's sensors/models leak)
 *   -> reopen A from Recent (special sensor replayed, model Complete, set points intact)
 *   -> Back -> delete A (workspace file AND its model output folder removed, B untouched).
 *
 * Plus the Dashboard VIS behaviour that sits next to all of that: Filter tab +
 * value highlight follow a rename of a special sensor no model uses, the time
 * range bar, and a chart-type switch closes the open colour popover.
 *
 * Shared fakes: `helpers/healthEnv.tsx` (in-memory plugin-fs / plugin-store /
 * event bus, the REAL workspaceManager runs on top of them) and
 * `helpers/crossFeatureBackend.ts` (special-sensor session fake + health fake on
 * the SAME columns). Every console.error / console.warn and every unhandled
 * promise rejection is recorded; React warnings (act / key / unknown prop /
 * update on unmounted) fail the test, anything else is asserted explicitly.
 */

const wins = vi.hoisted(() => ({
    pending: [] as string[],
    open: new Map<string, { label: string; close: () => Promise<void>; setFocus: () => Promise<void> }>(),
    closed: [] as string[],
    dialogOpen: null as unknown,
    /** Which window `getCurrentWindow().close()` closes (one JS realm hosts every window here). */
    selfClose: 'add-sensor' as string,
}));

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./helpers/healthEnv')).fsModule());
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => {
    const { env } = await import('./helpers/healthEnv');
    return {
        getCurrentWindow: () => ({
            // Only the Add Special Sensor window closes itself in these flows.
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
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('0.7.0') }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: vi.fn().mockResolvedValue(undefined),
    ask: vi.fn().mockResolvedValue(true),
    open: () => Promise.resolve(wins.dialogOpen),
    save: () => Promise.resolve(null),
}));
vi.mock('../components/charts/ResponsiveECharts', async () => (await import('./helpers/healthEnv')).chartModule());
// The Dashboard's own chart (ECharts line / regl scatter) cannot run in jsdom.
const chartProps: any[] = [];
vi.mock('../components/charts', () => ({
    Chart: (p: any) => { chartProps.push(p); return <div data-testid="dash-chart" data-type={p.chartType} />; },
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
import { plantDataset, type HealthDataset } from './helpers/fakeHealthRust';
import {
    bmw, bmwEl, enterSp, markComplete, openHealth, openSettings, pickInModal, pill, selectSensor, settle, train,
} from './helpers/healthWorkbench';
import App from '../App';
import '../components/dashboard'; // warm App's lazy chunk
import BuildModelWindow from '../components/windows/BuildModelWindow';
import AddSensorWindow from '../components/windows/AddSensorWindow';
import { dismissAllErrors } from '../errorReporter';

vi.setConfig({ testTimeout: 120_000 });

// ── data ───────────────────────────────────────────────────────────────

const PATH_A = 'C:/data/plant-a.csv';
const PATH_B = 'C:/data/plant-b.csv';
const DATA_A = plantDataset();
/** B: same headers, different numbers — anything of A's showing up here is a leak. */
const DATA_B: HealthDataset = (() => {
    const d = plantDataset();
    return { ...d, columns: Object.fromEntries(Object.entries(d.columns).map(([k, v]) => [k, v.map(x => (x === null ? null : x * 3 + 1))])) };
})();
const RC_FILTER = { timestamp_ranges: [], value_filters: [{ sensor: 'TAG2', operation: 'greater_than', value1: 10, value2: null }], combine: 'and' };

let be: CrossFeatureBackend;

// ── console / rejection recorder ─────────────────────────────────────────

const logged: { level: 'error' | 'warn'; text: string }[] = [];
const rejections: string[] = [];
const onRejection = (e: PromiseRejectionEvent) => { rejections.push(String((e as any).reason)); };
const onNodeRejection = (r: unknown) => { rejections.push(String(r)); };
/** Node's process (no @types/node in this repo). */
const nodeProcess = (globalThis as any).process as { on: (e: string, f: (r: unknown) => void) => void; off: (e: string, f: (r: unknown) => void) => void };
const fmt = (args: unknown[]) => args.map(a => (a instanceof Error ? `${a.message}` : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
const REACT_WARNING = /not wrapped in act|unique "key" prop|React does not recognize|Unknown prop|Invalid DOM property|unmounted component|Maximum update depth|Cannot update a component .* while rendering|validateDOMNesting|is not a valid|non-boolean attribute|changing an uncontrolled|changing a controlled|defaultValue|Each child in a list/;
const reactWarnings = () => logged.filter(l => REACT_WARNING.test(l.text));

beforeEach(() => {
    resetEnv();
    wins.pending.length = 0;
    wins.open.clear();
    wins.closed.length = 0;
    wins.dialogOpen = null;
    wins.selfClose = 'add-sensor';
    chartProps.length = 0;
    roots.clear();
    closing.length = 0;
    logged.length = 0;
    rejections.length = 0;
    dismissAllErrors();
    be = createCrossFeatureBackend({ datasets: { [PATH_A]: DATA_A, [PATH_B]: DATA_B }, files: env.files });
    env.backend = be as any;
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

// ── windows ──────────────────────────────────────────────────────────────

const roots = new Map<string, ReturnType<typeof render>>();
const closing: string[] = [];

/** Let queued window closes happen (each root unmounts in its own act). */
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

/** Mount every window the Dashboard asked Tauri to create, each in its own root. */
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
            // A Tauri close is IPC: the webview goes away later. Queue it -- unmounting
            // here would nest act() inside the Dashboard's own unmount.
            close: async () => {
                if (!wins.open.has(label)) return;
                // Tauri v2: close() emits CloseRequested first; a handler may preventDefault
                // (Build Model does while a save / Mark complete is running) and close later itself.
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

async function renderApp() {
    await act(async () => { render(<div data-testid="app-root"><App /></div>); });
    await settle(50);
}

const onDashboard = () => !!document.querySelector('button[title="Back to Import"]');

/** Import page: Create new project -> name -> browse -> Parse files -> Continue. */
async function importProject(name: string, path: string) {
    await act(async () => { fireEvent.click(app().getByText('Create new project')); });
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
    await settle(700);
    await waitFor(() => expect(onDashboard()).toBe(true), { timeout: 5000 });
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

const recentIds = () => ((env.store.get('recent_workspaces') as any[]) ?? []).map(w => w.id as string);
const wsIdByName = (name: string) => ((env.store.get('recent_workspaces') as any[]) ?? []).find(w => w.name === name)?.id as string;
const disk = (id: string) => JSON.parse(env.files.get(`workspaces/${id}.json`)!);

// ── Dashboard: sensors, FG sheet ─────────────────────────────────────────

async function openSensorTab() {
    const btn = app().queryByRole('button', { name: /^Sensor \(/ });
    if (btn) { fireEvent.click(btn); await settle(); }
}

function sensorRow(tag: string): HTMLElement {
    const el = document.querySelector(`[id="sensor-${tag}"]`) as HTMLElement | null;
    expect(el, `sensor row ${tag}`).toBeTruthy();
    return el!.closest('.sensor-list-row') as HTMLElement;
}

async function searchSensors(q: string) {
    fireEvent.change(app().getByPlaceholderText('Search sensors...'), { target: { value: q } });
    await settle();
}

/** Open the FG sheet of `tag`, run `fn` inside it, close it. */
async function inSheet(tag: string, fn: (sheet: ReturnType<typeof within>) => Promise<void>) {
    await openSensorTab();
    await searchSensors(tag);
    const btn = within(sensorRow(tag)).getByTitle('Add to failure group');
    await act(async () => { fireEvent.click(btn); });
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

// ── Add Special Sensor window ────────────────────────────────────────────

async function openAddSensorWindow() {
    await act(async () => { fireEvent.click(document.querySelector('.add-sensor-btn') as HTMLElement); });
    await mountPendingWindows();
    await waitFor(() => expect(aswBody()).toBeTruthy());
}

function labelledInput(labelText: string): HTMLInputElement {
    const label = Array.from(aswBody().querySelectorAll('label')).find(l => l.textContent?.replace('*', '').trim() === labelText);
    if (!label) throw new Error(`no label ${labelText}`);
    return label.parentElement!.querySelector('input, select') as HTMLInputElement;
}

async function createFormulaSensor(name: string, formula: string, description: string) {
    await act(async () => { fireEvent.click(ASW().getByRole('tab', { name: /Create/ })); });
    const toggle = ASW().queryByText('Edit as text instead');
    if (toggle) await act(async () => { fireEvent.click(toggle); });
    const ta = aswBody().querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(ta, { target: { value: formula, selectionStart: formula.length } }); });
    await act(async () => { fireEvent.change(aswBody().querySelector('input[placeholder="e.g. Total Power"]')!, { target: { value: name } }); });
    await act(async () => { fireEvent.change(labelledInput('Description'), { target: { value: description } }); });
    await act(async () => { fireEvent.change(labelledInput('Unit'), { target: { value: 'u' } }); });
    await act(async () => { fireEvent.change(aswBody().querySelector('select[aria-label="Component"]')!, { target: { value: 'Uncategorized' } }); });
    await settle(30);
    const add = ASW().getByText('Add sensor').closest('button') as HTMLButtonElement;
    expect(add.disabled, 'Add sensor enabled').toBe(false);
    await act(async () => { fireEvent.click(add); });
    await settle(500);
}

async function goManage() {
    await act(async () => { fireEvent.click(ASW().getByRole('tab', { name: /Manage/ })); });
    await settle(30);
}

// ── Build Model window ───────────────────────────────────────────────────

async function openBuildModel() {
    await openFgTab();
    await act(async () => { fireEvent.click(app().getByText(/Build Model →/)); });
    await mountPendingWindows();
    await waitFor(() => expect(bmw().getByTestId('rc-card')).toBeTruthy(), { timeout: 4000 });
    await settle(300);
}

async function openFgTab() {
    const b = app().queryByRole('button', { name: 'Failure Groups' });
    if (b) { fireEvent.click(b); await settle(); }
}

/** Running condition: Step-1 card -> modal -> "Only when running" TAG2 > 10 -> Apply. */
async function setRunningCondition() {
    if (!screen.queryByRole('dialog', { name: 'Running condition' })) {
        await act(async () => { fireEvent.click(bmw().getByTestId('rc-card-open')); });
    }
    const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
    if (dlg.getByTestId('rc-mode-condition').getAttribute('aria-pressed') !== 'true') fireEvent.click(dlg.getByTestId('rc-mode-condition'));
    await act(async () => { fireEvent.click(dlg.getByTestId('rc-add-condition')); });
    const cond = within(dlg.getByTestId('rc-cond-1'));
    // pick TAG2 in the single-sensor picker
    fireEvent.click(dlg.getByTestId('rc-cond-1').querySelector('button.sensor-picker-trigger-single') as HTMLElement);
    await pickInModal('sensor', ['TAG2'], true);
    fireEvent.click(cond.getByRole('button', { name: 'Greater than' }));
    fireEvent.change(cond.getByLabelText('Value'), { target: { value: '10' } });
    await settle(30);
    await act(async () => { fireEvent.click(dlg.getByTestId('rc-apply')); });
    await settle(400);
    expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
}

// ═════════════════════════════════════════════════════════════════════════

type Kind = 'individual' | 'relationship' | 'clustering';
const KIND_LABEL: Record<Kind, 'Individual' | 'Relationship' | 'Clustering'> = { individual: 'Individual', relationship: 'Relationship', clustering: 'Clustering' };

interface KindPlan {
    /** The special sensor's formula. */
    formula: string;
    /** Sensor whose FG sheet creates the model (the model's "own" sensor). */
    sheetTag: string;
    configure: () => Promise<void>;
    setPoints: () => Promise<void>;
    outputFile: (wsId: string) => string;
}

const PLANS: Record<Kind, KindPlan> = {
    individual: {
        formula: '$TAG1 * 2',
        sheetTag: 'SP1',
        configure: async () => {},
        setPoints: async () => {
            const b = be.health.individualBand('SP1', RC_FILTER);
            await enterSp({ 'sp-lower': String(Math.floor(b.l3 - 10)), 'sp-upper': String(Math.ceil(b.u3 + 10)) });
        },
        outputFile: ws => `workspaces/${ws}/output/SP1/INDV_INFO_SP1.json`,
    },
    relationship: {
        formula: '$TAG3 * 2',
        sheetTag: 'TAG1',
        configure: async () => {
            openSettings();
            fireEvent.click(bmwEl().querySelector('button.predictor-picker-trigger') as HTMLElement);
            await pickInModal('predictors', ['SP1']);
        },
        setPoints: async () => {
            const w = be.health.lastOk('compute_health_preview').stats.two_rmse as number;
            await enterSp({
                'sp-residual_at_80_lower': String(-w * 1.5), 'sp-residual_at_80_upper': String(w * 2),
                'sp-residual_at_0_lower': String(-w * 4), 'sp-residual_at_0_upper': String(w * 4),
            });
        },
        outputFile: ws => `workspaces/${ws}/output/TAG1/REL_INFO_SP1_TAG1.json`,
    },
    clustering: {
        formula: '$TAG3 * 2',
        sheetTag: 'SP1',
        configure: async () => {
            openSettings();
            fireEvent.click(bmwEl().querySelectorAll('button.sensor-picker-trigger-single')[0]);
            await pickInModal('Y sensor', ['TAG5'], true);
            openSettings();
            fireEvent.click(bmwEl().querySelectorAll('button.sensor-picker-trigger-single')[1]);
            await pickInModal('criteria sensor', ['TAG4'], true);
            await settle(100);
            openSettings();
            fireEvent.click(bmw().getByRole('button', { name: 'Fewer clusters' }));
            await settle(100);
        },
        setPoints: async () => {
            await act(async () => { fireEvent.click(bmw().getByTestId('ring-quick-5')); });
            await settle(350);
        },
        outputFile: ws => `workspaces/${ws}/output/TAG5/CLUS_INFO_SP1_TAG5.json`,
    },
};

describe.each(['individual', 'relationship', 'clustering'] as Kind[])('cross-feature journey: %s', kind => {
    it('import -> special sensor -> FG sheet (+Undo) -> Running condition -> Train -> set points -> Mark complete -> lock -> A/B switch -> reopen -> delete', async () => {
        const plan = PLANS[kind];
        const label = KIND_LABEL[kind];
        await renderApp();

        // 1) Import workspace A through the real import page.
        await importProject('Alpha', PATH_A);
        const A = wsIdByName('Alpha');
        expect(A, 'workspace A in Recent').toBeTruthy();
        expect(be.cmds('load_csv').map(c => c.args.paths)).toEqual([[PATH_A]]);

        // 2) Special sensor SP1 through the real Add Special Sensor window.
        await openAddSensorWindow();
        await createFormulaSensor('SP1', plan.formula, 'Special one');
        expect(be.session.has('SP1')).toBe(true);
        await settle(400);
        expect(disk(A).specialSensorRecipes).toEqual([{ kind: 'formula', tag: 'SP1', formula: plan.formula }]);

        // 3) FG sheet: a new group (creates an Individual model of the sheet's sensor), then the kind under test.
        await inSheet(plan.sheetTag, async sheet => {
            fireEvent.change(sheet.getByLabelText('New failure group name'), { target: { value: 'FG-A' } });
            await act(async () => { fireEvent.click(sheet.getByText('Create')); });
            await settle(400);
            if (kind !== 'individual') {
                await clickCell(sheet, `${label} · FG-A`);
                // drop the Individual model the new group brought along -> Undo toast (expire it, not undone)
                await clickCell(sheet, 'Individual · FG-A');
            }
        });
        let models = disk(A).failureGroupState.models;
        expect(models.map((m: any) => m.kind)).toEqual([kind]);
        const mid = models[0].id as string;
        if (kind !== 'individual') {
            expect(screen.getAllByTestId('fg-undo-toast').map(t => t.textContent)).toEqual([expect.stringMatching(/Individual model of .* deleted/)]);
        }

        // 4) Build Model window: Running condition through the Step-1 card + modal.
        await openBuildModel();
        await setRunningCondition();
        const fg = disk(A).failureGroupState;
        expect(fg.runningConditionFilters).toEqual([expect.objectContaining({ sensor: 'TAG2', operation: 'greater_than', value1: '10' })]);
        await waitFor(() => expect(bmw().getByTestId('rc-card-cond').textContent).toMatch(/TAG2/));

        // 5) settings -> Train -> Model fit -> Health score -> set points -> Mark complete.
        selectSensor(plan.sheetTag.toLowerCase());
        await settle(100);
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(50);
        await plan.configure();
        await train();
        expect(pill()).toBe('Trained');
        await openHealth();
        await plan.setPoints();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy(), { timeout: 4000 });
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy(), { timeout: 4000 });
        expect(env.files.has(plan.outputFile(A)), `export ${plan.outputFile(A)}`).toBe(true);
        expect(disk(A).failureGroupState.models.find((m: any) => m.id === mid).status).toBe(true);

        // 6) The special sensor is now locked in Manage (a model uses it).
        if (!roots.has('add-sensor')) await openAddSensorWindow();
        await goManage();
        await settle(200);
        expect((ASW().getByLabelText('Delete SP1') as HTMLButtonElement).disabled, 'Delete SP1 locked').toBe(true);
        await act(async () => { fireEvent.click(ASW().getByLabelText('Edit SP1')); });
        await settle(50);
        expect((ASW().getByLabelText('Name') as HTMLInputElement).readOnly, 'Name locked').toBe(true);

        // 7) FG sheet: un-assign the COMPLETE model -> Undo restores it whole (same id, Complete, export record).
        const before = disk(A).failureGroupState.models.find((m: any) => m.id === mid);
        await inSheet(plan.sheetTag, async sheet => {
            await clickCell(sheet, `${label} · FG-A`);
            expect(disk(A).failureGroupState.models.some((m: any) => m.id === mid)).toBe(false);
            const toast = screen.getAllByTestId('fg-undo-toast').find(t => t.textContent?.includes(`${label} model`))!;
            await act(async () => { fireEvent.click(within(toast).getByText('Undo')); });
            await settle(400);
        });
        const restored = disk(A).failureGroupState.models.find((m: any) => m.id === mid);
        expect(restored).toEqual(before);
        await waitFor(() => expect(bmwEl().querySelector(`[data-testid="sensor-kind-badge-dot-${mid}"]`)?.getAttribute('data-state')).toBe('complete'));

        // 8) Switch to a NEW workspace B: both sub-windows close, nothing of A leaks.
        await settle(400); // autosave
        await backToImport();
        expect(roots.has('build-model')).toBe(false);
        expect(roots.has('add-sensor')).toBe(false);
        await importProject('Beta', PATH_B);
        const B = wsIdByName('Beta');
        expect(B).not.toBe(A);
        expect(be.session.has('SP1')).toBe(false);
        await openSensorTab();
        await searchSensors('SP');
        expect(document.querySelector('[id="sensor-SP1"]'), 'special sensor of A listed in B').toBeNull();
        await searchSensors('TAG1');
        expect(document.querySelector('[id="sensor-TAG1"]'), 'search works in B').toBeTruthy();
        await searchSensors('');
        await settle(400);
        expect(disk(B).specialSensorRecipes ?? []).toEqual([]);
        expect(disk(B).failureGroupState?.models ?? []).toEqual([]);

        // 9) Reopen A from Recent: special sensor replayed, model Complete, set points intact.
        await backToImport();
        await openRecent('Alpha');
        expect(be.session.has('SP1')).toBe(true);
        await openSensorTab();
        await searchSensors('SP1');
        expect(document.querySelector('[id="sensor-SP1"]'), 'SP1 listed again in A').toBeTruthy();
        await searchSensors('');
        await openBuildModel();
        selectSensor(plan.sheetTag.toLowerCase());
        await settle(500);
        expect(pill()).toBe('Complete');
        const reopened = disk(A).failureGroupState.models.find((m: any) => m.id === mid);
        expect(reopened.healthSetPoints).toEqual(before.healthSetPoints);
        expect(reopened.healthExport).toEqual(before.healthExport);

        // 10) Back -> delete A: workspace file + model output folder gone; B untouched.
        await backToImport();
        let row: HTMLElement | null = app().getAllByText('Alpha')[0];
        while (row && !row.querySelector('button[title="Delete workspace"]')) row = row.parentElement;
        expect(row, 'Recent row of Alpha').toBeTruthy();
        await act(async () => { fireEvent.click(row!.querySelector('button[title="Delete workspace"]')!); });
        await settle(200);
        expect(env.files.has(`workspaces/${A}.json`)).toBe(false);
        expect([...env.files.keys()].filter(k => k.startsWith(`workspaces/${A}/`))).toEqual([]);
        expect(recentIds()).toEqual([B]);
        expect(env.files.has(`workspaces/${B}.json`)).toBe(true);

        expect(reactWarnings(), 'React warnings').toEqual([]);
        expect(logged.map(l => `[${l.level}] ${l.text.slice(0, 200)}`), 'console.error / console.warn during the journey').toEqual([]);
        expect(rejections, 'unhandled rejections').toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Dashboard VIS behaviour next to the special-sensor lifecycle
// ═════════════════════════════════════════════════════════════════════════

const lastChartFilter = () => [...be.session.cmds('get_chart_data')].reverse().find(c => !c.error)?.args.filter;
const openPopovers = () => Array.from(document.querySelectorAll<HTMLElement>('#wizard-portal-root .sensor-popover'));
const dataTab = (name: 'Filter' | 'Highlights') => fireEvent.click(app().getByRole('button', { name }));
const chartBtn = (name: 'Line' | 'Scatter' | 'Pair Plot') =>
    app().getAllByRole('button').find(b => b.classList.contains('chart-type-btn') && (b.textContent ?? '').trim().startsWith(name)) as HTMLButtonElement;

async function renameSpecialSensor(from: string, to: string) {
    await goManage();
    await act(async () => { fireEvent.click(ASW().getByLabelText(`Edit ${from}`)); });
    await settle(30);
    await act(async () => { fireEvent.change(ASW().getByLabelText('Name'), { target: { value: to } }); });
    await settle(30);
    const save = ASW().getByText('Save changes').closest('button') as HTMLButtonElement;
    expect(save.disabled, `Save enabled: ${ASW().queryAllByRole('alert').map(a => a.textContent).join(' / ')}`).toBe(false);
    await act(async () => { fireEvent.click(save); });
    await settle(600);
}

describe('Dashboard VIS behaviour around a special sensor no model uses', () => {
    it('Filter tab + value highlight follow a rename; a chart-type switch closes the open colour popover; Reset period keeps an unapplied filter draft; no console errors', async () => {
        await renderApp();
        await importProject('Vis', PATH_A);
        const W = wsIdByName('Vis');

        await openAddSensorWindow();
        await createFormulaSensor('SP2', '$TAG2 + 0', 'Speed copy');
        await settle(300);
        // plot TAG1 as well (scatter needs two sensors)
        await openSensorTab();
        await searchSensors('TAG1');
        await act(async () => { fireEvent.click(document.querySelector('[id="sensor-TAG1"]') as HTMLElement); });
        await searchSensors('');
        await settle(300);
        expect(lastChartFilter().sensors).toEqual(expect.arrayContaining(['SP2', 'TAG1']));

        // Filter tab: SP2 > 30, applied.
        dataTab('Filter');
        await settle();
        await act(async () => { fireEvent.click(app().getByText('Add condition')); });
        const row = document.querySelector('.filter-row') as HTMLElement;
        fireEvent.change(row.querySelector('select')!, { target: { value: 'SP2' } });
        fireEvent.click(within(row).getByText('>'));
        fireEvent.change(row.querySelector('input[type="number"]')!, { target: { value: '30' } });
        await settle();
        expect(app().getByText('Changes not applied yet')).toBeTruthy();
        await act(async () => { fireEvent.click(app().getByText('Apply filter')); });
        await settle(400);
        expect(lastChartFilter().value_filters).toEqual([expect.objectContaining({ sensor: 'SP2', operation: 'greater_than', value1: 30 })]);

        // Highlights (Scatter): colour by SP2, one range, open its colour popover.
        await act(async () => { fireEvent.click(chartBtn('Scatter')); });
        await settle(200);
        dataTab('Highlights');
        await settle();
        const hlSelect = () => Array.from(document.querySelectorAll<HTMLSelectElement>('select.highlights-field--full')).pop()!;
        fireEvent.change(hlSelect(), { target: { value: 'SP2' } });
        await settle();
        fireEvent.change(app().getByPlaceholderText('min'), { target: { value: '0' } });
        fireEvent.change(app().getByPlaceholderText('max'), { target: { value: '20' } });
        await act(async () => { fireEvent.click(app().getAllByText('+ Add').pop()!); });
        await settle();
        fireEvent.click(app().getAllByTitle('Change colour').pop()!);
        expect(openPopovers()).toHaveLength(1);
        // VIS-5: Scatter -> Line closes it and it does not come back on Line -> Scatter.
        await act(async () => { fireEvent.click(chartBtn('Line')); });
        await settle(100);
        expect(openPopovers()).toHaveLength(0);
        await act(async () => { fireEvent.click(chartBtn('Scatter')); });
        await settle(100);
        expect(openPopovers()).toHaveLength(0);

        // Rename SP2 -> SP2B (no model uses it, so the editor allows it).
        await renameSpecialSensor('SP2', 'SP2B');
        expect(be.session.has('SP2B')).toBe(true);
        expect(be.session.has('SP2')).toBe(false);
        expect(hlSelect().value, 'value highlight follows the rename').toBe('SP2B');
        dataTab('Filter');
        await settle(200);
        expect((document.querySelector('.filter-row select') as HTMLSelectElement).value, 'Filter tab follows the rename').toBe('SP2B');
        await settle(400);
        expect(lastChartFilter().value_filters.map((f: any) => f.sensor)).toEqual(['SP2B']);
        expect(lastChartFilter().sensors).toContain('SP2B');
        expect(lastChartFilter().sensors).not.toContain('SP2');
        await settle(400); // autosave
        const saved = disk(W);
        expect(saved.filters.sensorFilters.map((f: any) => f.sensor)).toEqual(['SP2B']);
        expect(saved.valueHighlight.sensor).toBe('SP2B');
        expect(saved.specialSensorRecipes.map((r: any) => r.tag)).toEqual(['SP2B']);
        expect(saved.selectedSensors).toEqual(expect.arrayContaining(['SP2B', 'TAG1']));

        // VIS-7: an unapplied draft condition survives "Reset period".
        await act(async () => { fireEvent.click(app().getByText('Add condition')); });
        const rows = document.querySelectorAll('.filter-row');
        fireEvent.change(rows[rows.length - 1].querySelector('input[type="number"]')!, { target: { value: '7' } });
        await settle();
        await act(async () => { fireEvent.click(app().getByText('Reset period')); });
        await settle(300);
        expect(document.querySelectorAll('.filter-row')).toHaveLength(2);
        expect((document.querySelectorAll('.filter-row')[1].querySelector('input[type="number"]') as HTMLInputElement).value).toBe('7');
        expect(app().getByText('Changes not applied yet')).toBeTruthy();

        expect(reactWarnings(), 'React warnings').toEqual([]);
        expect(logged.map(l => `[${l.level}] ${l.text.slice(0, 200)}`), 'console.error / console.warn').toEqual([]);
        expect(rejections, 'unhandled rejections').toEqual([]);
    });

    it('the special-sensor lock is released when the model that used it is deleted from the FG sheet (Undo not used)', async () => {
        await renderApp();
        await importProject('Lock', PATH_A);
        const L = wsIdByName('Lock');
        await openAddSensorWindow();
        await createFormulaSensor('SP1', '$TAG1 * 2', 'Special one');
        await inSheet('SP1', async sheet => {
            fireEvent.change(sheet.getByLabelText('New failure group name'), { target: { value: 'FG-A' } });
            await act(async () => { fireEvent.click(sheet.getByText('Create')); });
            await settle(400);
        });
        expect(disk(L).failureGroupState.models.map((m: any) => m.targetSensor)).toEqual(['SP1']);
        await goManage();
        await settle(200);
        expect((ASW().getByLabelText('Delete SP1') as HTMLButtonElement).disabled).toBe(true);

        await inSheet('SP1', async sheet => { await clickCell(sheet, 'Individual · FG-A'); });
        expect(disk(L).failureGroupState.models).toEqual([]);
        expect(screen.getAllByTestId('fg-undo-toast')).toHaveLength(1);
        await settle(300);
        await waitFor(() => expect((ASW().getByLabelText('Delete SP1') as HTMLButtonElement).disabled, 'lock released').toBe(false));

        expect(reactWarnings(), 'React warnings').toEqual([]);
        expect(rejections, 'unhandled rejections').toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Leaving the workspace while a Relationship "Mark complete" is still saving
// ═════════════════════════════════════════════════════════════════════════

/** Workspace A with a Relationship model (target TAG1, predictor = special sensor SP1)
 *  that is trained, has valid set points, and is one click away from Mark complete. */
async function relationshipReadyToComplete(): Promise<{ A: string; mid: string }> {
    await renderApp();
    await importProject('Alpha', PATH_A);
    const A = wsIdByName('Alpha');
    await openAddSensorWindow();
    await createFormulaSensor('SP1', '$TAG3 * 2', 'Special one');
    await inSheet('TAG1', async sheet => {
        fireEvent.change(sheet.getByLabelText('New failure group name'), { target: { value: 'FG-A' } });
        await act(async () => { fireEvent.click(sheet.getByText('Create')); });
        await settle(400);
        await clickCell(sheet, 'Relationship · FG-A');
        await clickCell(sheet, 'Individual · FG-A');
    });
    const mid = disk(A).failureGroupState.models[0].id as string;
    await openBuildModel();
    await setRunningCondition();
    selectSensor('tag1');
    await settle(100);
    await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
    await settle(50);
    await PLANS.relationship.configure();
    await train();
    await openHealth();
    await PLANS.relationship.setPoints();
    await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy(), { timeout: 4000 });
    return { A, mid };
}

describe('leaving the workspace while a Relationship Mark complete is still saving (sidecar running)', () => {
    it('Back to Import while saving: the Build Model window refuses to close until the save lands, then closes; A ends Complete with its files', async () => {
        const { A, mid } = await relationshipReadyToComplete();
        wins.selfClose = 'build-model';
        const gate = be.health.gate('sidecar:export_model_files');
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-complete')); });
        await settle(30);
        expect(bmw().getByTestId('save-running')).toBeTruthy();

        await backToImport();
        expect(roots.has('build-model'), 'window kept open while the export runs').toBe(true);
        gate.release();
        await settle(300);
        await processClosedWindows();
        expect(roots.has('build-model'), 'window closes itself once saved').toBe(false);
        expect(env.files.has(`workspaces/${A}/output/TAG1/REL_INFO_SP1_TAG1.json`)).toBe(true);
        const m = disk(A).failureGroupState.models.find((x: any) => x.id === mid);
        expect(m.status).toBe(true);
        expect(m.healthExport?.outputDir).toBeTruthy();
        expect(reactWarnings(), 'React warnings').toEqual([]);
        expect(rejections, 'unhandled rejections').toEqual([]);
    });

    // Regression (fixed 2026-10-04): `runMarkComplete` used to bail out with
    // 'The workspace changed.' AFTER `completeModel` had already written the model
    // files, so a window re-pointed at workspace B mid-export dropped A's Complete.
    // The save now always goes to the workspace id captured at click time; only the
    // window's own state is left alone once it points elsewhere.
    it('re-pointing the still-open window at workspace B before the export finishes must not drop A\'s Complete', async () => {
        const { A, mid } = await relationshipReadyToComplete();
        wins.selfClose = 'build-model';
        const gate = be.health.gate('sidecar:export_model_files');
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-complete')); });
        await settle(30);

        await backToImport();
        expect(roots.has('build-model')).toBe(true);
        await importProject('Beta', PATH_B);
        await openFgTab();
        await act(async () => { fireEvent.click(app().getByText(/Build Model →/)); }); // focuses + re-points the open window
        await settle(300);
        gate.release();
        await settle(500);

        expect(env.files.has(`workspaces/${A}/output/TAG1/REL_INFO_SP1_TAG1.json`), 'files were written into A').toBe(true);
        const m = disk(A).failureGroupState.models.find((x: any) => x.id === mid);
        expect({ status: m.status, exported: !!m.healthExport }).toEqual({ status: true, exported: true });
    });
});

describe('two undo windows at once: the FG-sheet model Undo vs the special-sensor delete Undo', () => {
    it('model deleted -> its special sensor deleted (8 s undo window) -> model Undo within 7 s: the pending sensor delete is CANCELLED at commit and the restored model keeps a real column', async () => {
        await renderApp();
        await importProject('Lock', PATH_A);
        const L = wsIdByName('Lock');
        await openAddSensorWindow();
        await createFormulaSensor('SP1', '$TAG1 * 2', 'Special one');
        await inSheet('SP1', async sheet => {
            fireEvent.change(sheet.getByLabelText('New failure group name'), { target: { value: 'FG-A' } });
            await act(async () => { fireEvent.click(sheet.getByText('Create')); });
            await settle(400);
        });
        const model = disk(L).failureGroupState.models[0];
        await goManage();
        await inSheet('SP1', async sheet => { await clickCell(sheet, 'Individual · FG-A'); });
        await settle(300);
        await waitFor(() => expect((ASW().getByLabelText('Delete SP1') as HTMLButtonElement).disabled).toBe(false));
        await act(async () => { fireEvent.click(ASW().getByLabelText('Delete SP1')); });
        await settle(200);
        // Undo the MODEL deletion while the sensor deletion is still inside its own undo window.
        const toast = screen.getAllByTestId('fg-undo-toast')[0];
        await act(async () => { fireEvent.click(within(toast).getByText('Undo')); });
        await settle(400);
        expect(disk(L).failureGroupState.models).toEqual([model]);
        // Let the sensor's 8 s undo window run out: its commit re-reads the models and refuses.
        await settle(8500);
        await settle(500);
        expect(be.session.has('SP1'), 'column kept for the restored model').toBe(true);
        expect((disk(L).specialSensorRecipes ?? []).map((r: any) => r.tag)).toEqual(['SP1']);
        expect(screen.getByTestId('add-sensor-window').textContent).toMatch(/Didn't delete SP1/);
        expect(reactWarnings(), 'React warnings').toEqual([]);
        expect(rejections, 'unhandled rejections').toEqual([]);
    });
});
