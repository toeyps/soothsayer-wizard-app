import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/*
 * Customer batch 2026-10 phase 3 (item 5: Failure groups = Import step 3) —
 * qa-agent closing sweep, 2026-10-09.
 *
 * The workers' unit tests each stop at their own seam: `DataUploadPage.test`
 * mocks `workspaceManager` (so the chip never sees a real recent entry),
 * `workspaceManager.test` checks the metadata fields on a hand-made state, and
 * `Dashboard.test` / `FailureGroupsPanel.test` / `SensorSelection.test` drive
 * the landing and assign mode from a hand-made `initialState`. Nothing ran the
 * whole loop: the groups named on step 3 -> the REAL `saveWorkspaceData` ->
 * the Dashboard's FG-tab landing + summary -> assign mode writing through the
 * Dashboard's on-disk read-modify-write -> `writeWorkspaceFile` refreshing the
 * recent entry -> the Import page's chip reading that entry back.
 *
 * Only Tauri is faked (in-memory plugin-fs / plugin-store / event bus from
 * `helpers/healthEnv`, the dataset session from `helpers/crossFeatureBackend`);
 * App, DataUploadPage, Dashboard, SensorSelection, the assignment sheet,
 * FailureGroupsPanel, RecentProjectCard and workspaceManager are all real.
 */

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./helpers/healthEnv')).fsModule());
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => {
    const base = (await import('./helpers/healthEnv')).windowModule();
    return {
        getCurrentWindow: () => ({
            ...base.getCurrentWindow(),
            onFocusChanged: async () => () => {},
            destroy: async () => {}, hide: async () => {}, setFocus: async () => {},
            minimize: async () => {}, toggleMaximize: async () => {},
        }),
    };
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class {
        once() { return Promise.resolve(() => {}); }
        static getByLabel() { return Promise.resolve(null); }
    },
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('0.9.0') }));
vi.mock('../components/upload/MachineMorphCanvas', () => ({ default: () => null }));
const dialog = vi.hoisted(() => ({ open: null as unknown }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: vi.fn().mockResolvedValue(undefined),
    ask: vi.fn().mockResolvedValue(true),
    open: () => Promise.resolve(dialog.open),
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
import { createCrossFeatureBackend } from './helpers/crossFeatureBackend';
import { plantDataset } from './helpers/fakeHealthRust';
import { settle } from './helpers/healthWorkbench';
import App from '../App';
import '../components/dashboard'; // warm App's lazy chunk
import { dismissAllErrors } from '../errorReporter';

vi.setConfig({ testTimeout: 60_000 });

const PATH = 'C:/data/plant-a.csv';

// ── console / rejection recorder (same rule as CrossFeatureSmoke) ─────────────
const logged: string[] = [];
const rejections: string[] = [];
const onRejection = (e: PromiseRejectionEvent) => { rejections.push(String((e as any).reason)); };
const nodeProcess = (globalThis as any).process as { on: (e: string, f: (r: unknown) => void) => void; off: (e: string, f: (r: unknown) => void) => void };
const onNodeRejection = (r: unknown) => { rejections.push(String(r)); };
const fmt = (args: unknown[]) => args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');

beforeEach(() => {
    resetEnv();
    dialog.open = null;
    logged.length = 0;
    rejections.length = 0;
    dismissAllErrors();
    env.backend = createCrossFeatureBackend({ datasets: { [PATH]: plantDataset() }, files: env.files }) as any;
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(`[error] ${fmt(a)}`); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logged.push(`[warn] ${fmt(a)}`); });
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

// ── helpers ───────────────────────────────────────────────────────────────────

const app = () => within(screen.getByTestId('app-root'));
const onDashboard = () => !!document.querySelector('button[title="Back to Import"]');
const recent = () => ((env.store.get('recent_workspaces') as any[]) ?? []);
const entry = (name: string) => recent().find(w => w.name === name);
const disk = (id: string) => JSON.parse(env.files.get(`workspaces/${id}.json`)!);
const fgTabShowing = () => !!screen.queryByTestId('fg-summary');

async function renderApp() {
    await act(async () => { render(<div data-testid="app-root"><App /></div>); });
    await settle(50);
}

/** Import steps 1-2 (name, one CSV, Parse, Continue) -> lands on step 3. */
async function toStep3(name: string) {
    await act(async () => { fireEvent.click(app().getByRole('button', { name: /New project/ })); });
    await settle();
    fireEvent.change(app().getByPlaceholderText('e.g. Compressor Line 3 — Q3 Baseline'), { target: { value: name } });
    await act(async () => { fireEvent.click(app().getByText('Continue')); });
    await settle();
    dialog.open = [PATH];
    await act(async () => { fireEvent.click(app().getByText('browse').closest('button')!); });
    await settle(20);
    await act(async () => { fireEvent.click(app().getByText('Parse files')); });
    await settle(50);
    await act(async () => { fireEvent.click(app().getByText('Continue')); });
    await settle();
    expect(screen.getByTestId('failure-groups-step')).toBeTruthy();
}

/** Step 3 quick-add: type + Enter (the field keeps focus for the next one). */
async function quickAdd(name: string) {
    const input = app().getByLabelText('New failure group name');
    fireEvent.change(input, { target: { value: name } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
}

async function waitDashboard() {
    await settle(700);
    await waitFor(() => expect(onDashboard()).toBe(true), { timeout: 5000 });
    await settle(400);
}

async function backToImport() {
    await act(async () => { fireEvent.click(document.querySelector('button[title="Back to Import"]') as HTMLElement); });
    await settle(400);
    await waitFor(() => expect(onDashboard()).toBe(false));
    await settle(100);
}

async function openRecent(name: string) {
    await act(async () => { fireEvent.click(app().getAllByText(name)[0]); });
    await settle(900);
    await waitFor(() => expect(onDashboard()).toBe(true), { timeout: 5000 });
    await settle(400);
}

/** The Recent-projects card of `name` and its FG chip (null = no chip). */
function cardChip(name: string): HTMLElement | null {
    const card = app().getAllByTestId('project-card').find(c => c.textContent?.includes(name));
    expect(card, `recent card ${name}`).toBeTruthy();
    return within(card!).queryByTestId('project-fg-chip');
}
const swatchClasses = (chip: HTMLElement) => Array.from(chip.querySelectorAll('.fg-count-chip-sw i')).map(i => i.className);

const summaryText = () => screen.getByTestId('fg-summary').textContent!.replace(/\s+/g, ' ').trim();

function sensorRow(tag: string): HTMLElement {
    const el = document.querySelector(`[id="sensor-${tag}"]`) as HTMLElement | null;
    expect(el, `sensor row ${tag}`).toBeTruthy();
    return el!.closest('.sensor-list-row') as HTMLElement;
}

async function searchSensors(q: string) {
    fireEvent.change(app().getByPlaceholderText('Search description, tag, unit or component…'), { target: { value: q } });
    await settle();
}

async function openFgTab() {
    await act(async () => { fireEvent.click(app().getByRole('button', { name: 'Failure Groups' })); });
    await settle(100);
}

function groupCard(name: string): HTMLElement {
    const card = Array.from(document.querySelectorAll<HTMLElement>('.fg-group-card'))
        .find(c => c.querySelector('.fg-row-name')?.textContent?.trim() === name);
    expect(card, `FG card ${name}`).toBeTruthy();
    return card!;
}

function expectClean() {
    expect(logged, 'console.error / console.warn').toEqual([]);
    expect(rejections, 'unhandled rejections').toEqual([]);
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Import step 3 -> Dashboard -> Recent-project chip, through the real workspaceManager', () => {
    it('two groups named on step 3 land on the FG tab with the right summary; Assign sensors -> sheet -> Done writes the model; the chip shows 2 groups in their colours and follows a group added / deleted on the Dashboard', async () => {
        await renderApp();
        await toStep3('Alpha');

        // Step 3: two groups, the first with a description (Open Dashboard is the primary).
        await quickAdd('Bearing overheating');
        await quickAdd('Oil pressure low');
        expect(screen.getAllByTestId('fg-step-card')).toHaveLength(2);
        fireEvent.change(within(screen.getAllByTestId('fg-step-card')[0]).getByLabelText('Description'), { target: { value: 'NDE bearing runs hot' } });
        await act(async () => { fireEvent.click(app().getByRole('button', { name: 'Open Dashboard' })); });
        await waitDashboard();

        // Saved through the REAL saveWorkspaceData: groups shaped by failureGroupOps, recent entry carries the chip fields.
        const A = entry('Alpha')?.id as string;
        expect(A).toBeTruthy();
        expect(disk(A).failureGroupState.groups).toEqual([
            { no: 0, name: 'Not in Group' },
            { no: 1, name: 'Bearing overheating', description: 'NDE bearing runs hot', recommendation: '' },
            { no: 2, name: 'Oil pressure low' },
        ]);
        expect(disk(A).failureGroupState.models ?? []).toEqual([]);
        expect(entry('Alpha')).toMatchObject({ failureGroupCount: 2, failureGroupNos: [1, 2] });

        // Landing: FG tab, summary, "ready" callout, Assign sensors on both empty groups, Build Model disabled.
        expect(fgTabShowing(), 'lands on the Failure Groups tab').toBe(true);
        expect(summaryText()).toBe('2 groups · 0 sensors assigned · 0 of 0 models complete');
        expect(screen.getByTestId('fg-callout').textContent).toMatch(/Your failure groups are ready/);
        expect(screen.getByTestId('fg-callout').textContent).not.toMatch(/📁/);
        expect(app().getByRole('button', { name: 'Assign sensors to Bearing overheating' })).toBeTruthy();
        expect(app().getByRole('button', { name: 'Assign sensors to Oil pressure low' })).toBeTruthy();
        const build = app().getByRole('button', { name: /Build Model →/ }) as HTMLButtonElement;
        expect(build.disabled).toBe(true);
        expect(build.title).toBe('No models yet — assign sensors to a failure group first');

        // Assign mode: "Assign sensors →" on FG-1 -> Sensor tab with the bar.
        await act(async () => { fireEvent.click(app().getByRole('button', { name: 'Assign sensors to Bearing overheating' })); });
        await settle(100);
        const bar = screen.getByTestId('fg-assignbar');
        expect(bar.textContent).toMatch(/Assigning to FG-1 · Bearing overheating/);
        expect(bar.className).toContain('fg-group-color-amber');
        await searchSensors('TAG1');
        const counts = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="assign-count-"]')).map(e => e.textContent!.replace(/\s+/g, ''));
        expect(counts()[0]).toMatch(/^0\/\d+$/);

        // The row's Failure groups button opens the sheet with FG-1 pinned first, tagged "Assigning".
        const fgBtn = within(sensorRow('TAG1')).getByTitle('Add to failure group');
        await act(async () => { fireEvent.click(fgBtn); });
        const sheet = within(await screen.findByTestId('fg-sheet'));
        const rows = Array.from(screen.getByTestId('fg-sheet').querySelectorAll('[data-testid^="fg-sheet-row-"]')).filter(r => r.getAttribute('data-testid') !== 'fg-sheet-row-0');
        expect(rows[0].getAttribute('data-testid')).toBe('fg-sheet-row-1');
        expect(rows[0].className).toContain('fg-sheet-row--pinned');
        expect(rows[0].textContent).toMatch(/Assigning/);
        await act(async () => { fireEvent.click(sheet.getByRole('button', { name: 'Individual · Bearing overheating' })); });
        await settle(400);
        expect(counts()[0]).toMatch(/^1\/\d+$/);
        await act(async () => { fireEvent.click(sheet.getByText('Done')); });
        await settle(50);
        expect(screen.queryByTestId('fg-sheet')).toBeNull();
        expect(document.activeElement, 'focus back on the row\'s Failure groups button').toBe(fgBtn);

        // The model went to disk through the Dashboard's read-modify-write, sibling groups kept.
        const models = disk(A).failureGroupState.models;
        expect(models).toHaveLength(1);
        expect(models[0]).toMatchObject({ kind: 'individual', targetSensor: 'TAG1', groupNos: [1] });
        expect(disk(A).failureGroupState.groups).toHaveLength(3);

        // Bar's Done -> back on the FG tab; summary follows; Build Model enabled.
        await searchSensors('');
        await act(async () => { fireEvent.click(within(screen.getByTestId('fg-assignbar')).getByText('Done')); });
        await settle(100);
        expect(fgTabShowing()).toBe(true);
        expect(screen.queryByTestId('fg-assignbar')).toBeNull();
        expect(summaryText()).toBe('2 groups · 1 sensor assigned · 0 of 1 models complete');
        expect((app().getByRole('button', { name: /Build Model →/ }) as HTMLButtonElement).disabled).toBe(false);
        // FG-2 is still empty -> its Assign link (and the callout) stay.
        expect(app().queryByRole('button', { name: 'Assign sensors to Bearing overheating' })).toBeNull();
        expect(app().getByRole('button', { name: 'Assign sensors to Oil pressure low' })).toBeTruthy();

        // Back to Import: the chip reads the entry workspaceManager refreshed.
        await settle(400); // autosave
        await backToImport();
        let chip = cardChip('Alpha')!;
        expect(chip, 'chip on Alpha').toBeTruthy();
        expect(chip.textContent).toBe('2 failure groups');
        expect(chip.className).not.toContain('fg-count-chip--zero');
        expect(swatchClasses(chip)).toEqual(['fg-group-color-amber', 'fg-group-color-violet']);

        // Reopen (it has groups now) -> add FG-3 on the Dashboard -> entry follows at once.
        // A project WITH groups reopens on the Sensor tab (the step-3 lastRoute was replaced by the autosave).
        await openRecent('Alpha');
        expect(disk(A).lastRoute).toBe('dashboard');
        expect(fgTabShowing(), 'a project with groups reopens on the Sensor tab').toBe(false);
        await openFgTab();
        await act(async () => { fireEvent.click(app().getByText('Add failure group')); });
        const nameInput = app().getByPlaceholderText('New group name');
        fireEvent.change(nameInput, { target: { value: 'Cooling loss' } });
        await act(async () => { fireEvent.keyDown(nameInput, { key: 'Enter' }); });
        await settle(400);
        expect(disk(A).failureGroupState.groups.map((g: any) => g.no)).toEqual([0, 1, 2, 3]);
        expect(entry('Alpha')).toMatchObject({ failureGroupCount: 3, failureGroupNos: [1, 2, 3] });
        expect(summaryText()).toMatch(/^3 groups · 1 sensor assigned/);

        // Delete FG-2 (no confirmation in this app) -> count 2, swatches FG-1 + FG-3.
        await act(async () => { fireEvent.click(within(groupCard('Oil pressure low')).getByTitle('Delete group')); });
        await settle(400);
        expect(disk(A).failureGroupState.groups.map((g: any) => g.no)).toEqual([0, 1, 3]);
        expect(disk(A).failureGroupState.models).toHaveLength(1); // the TAG1 model is untouched
        expect(entry('Alpha')).toMatchObject({ failureGroupCount: 2, failureGroupNos: [1, 3] });

        await settle(400);
        await backToImport();
        chip = cardChip('Alpha')!;
        expect(chip.textContent).toBe('2 failure groups');
        expect(swatchClasses(chip)).toEqual(['fg-group-color-amber', 'fg-group-color-green']);

        expectClean();
    });

    it('Skip for now -> the dashed "No failure groups" chip (typed groups not saved); a recent entry saved before this change shows no chip until its next save', async () => {
        // A project saved before the chip fields existed: recent entry + workspace file, no FG fields at all.
        const OLD = 'ws_old';
        env.files.set(`workspaces/${OLD}.json`, JSON.stringify({
            id: OLD, name: 'Legacy', lastRoute: 'dashboard', dataFilePaths: [PATH], metadataFilePath: null,
            selectedSensors: [], visibleSensors: [], operationConfig: null,
        }));
        env.store.set('recent_workspaces', [{ id: OLD, name: 'Legacy', lastModified: Date.now() - 60_000, filePath: `workspaces/${OLD}.json` }]);

        await renderApp();
        expect(cardChip('Legacy'), 'pre-change entry: no chip (not "No failure groups")').toBeNull();

        // New project, a group typed on step 3, then Skip.
        await toStep3('Skipper');
        await quickAdd('Never saved');
        await act(async () => { fireEvent.click(app().getByRole('button', { name: 'Skip for now' })); });
        await waitDashboard();
        const S = entry('Skipper')?.id as string;
        expect(disk(S).failureGroupState.groups).toEqual([{ no: 0, name: 'Not in Group' }]);
        expect(entry('Skipper')).toMatchObject({ failureGroupCount: 0, failureGroupNos: [] });
        expect(fgTabShowing()).toBe(true);
        expect(summaryText()).toBe('0 groups · 0 sensors assigned · 0 of 0 models complete');
        expect(screen.getByTestId('fg-callout').textContent).toMatch(/No failure groups yet/);

        await settle(400);
        await backToImport();
        const chip = cardChip('Skipper')!;
        expect(chip.textContent).toBe('No failure groups');
        expect(chip.className).toContain('fg-count-chip--zero');
        expect(swatchClasses(chip)).toEqual([]);
        expect(cardChip('Legacy'), 'the old entry is still chip-less').toBeNull();

        // Opening the old project (no groups -> FG tab) and coming back saves it: now it has a real chip.
        await openRecent('Legacy');
        expect(fgTabShowing()).toBe(true);
        await settle(400);
        await backToImport();
        expect(entry('Legacy')).toMatchObject({ failureGroupCount: 0, failureGroupNos: [] });
        expect(cardChip('Legacy')!.textContent).toBe('No failure groups');

        expectClean();
    });
});
