import { expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Dashboard from '../../components/dashboard/Dashboard';
import BuildModelWindow from '../../components/windows/BuildModelWindow';
import type { WorkspaceState } from '../../types';
import { computeTrainFingerprint } from '../../utils/trainFingerprint';
import { env } from './healthEnv';
import { PLANT_META, plantDataset, createFakeHealthRust, type HealthDataset } from './fakeHealthRust';
import { ALL_TIME_TRAIN, ONE_TEST } from './trainTestFixture';
import { rowTag } from './sensorPicker';

/**
 * Drivers for the health-score integration tests: mount the
 * REAL Dashboard and the REAL Build Model window side by side over the shared
 * environment of `healthEnv.tsx`, seed workspaces on the in-memory disk, and
 * drive the Workbench's two pages the way a user does.
 */

export const WS = 'ws1';
export const wsFile = (id = WS) => `workspaces/${id}.json`;
export const HEADERS = plantDataset().headers;

export const COND = { id: 'rc1', sensor: 'TAG2', operation: 'greater_than', value1: '10', value2: '' };

export const BASE_FG = {
    groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }, { no: 2, name: 'FG-B' }],
    runningConditionCombine: 'and',
    // Train/Test validation: a train period is required to Train,
    // a test period to Mark complete.
    runningConditionTimePeriods: ALL_TIME_TRAIN,
    runningConditionTestPeriods: ONE_TEST,
    runningConditionFilters: [COND],
    runningConditionNoneConfirmed: false,
    rcLegacyNotice: null,
    categoryNormalisationNotice: null,
};

/** A model as Dashboard's `makeDefaultModelForKind` would build it, plus overrides. */
export function model(o: Record<string, unknown>): Record<string, any> {
    const kind = (o.kind as string) ?? 'individual';
    return {
        id: 'x', groupNos: [1], name: 'QA model', kind, category: 'performance', notes: '', status: false,
        targetSensor: kind === 'clustering' ? '' : 'TAG1', predictorSensors: [], xSensor: kind === 'clustering' ? 'TAG3' : '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100_000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [{ min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 }],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [],
        customRunningConditionCombine: 'and', customRunningConditionNoneConfirmed: false,
        ...o,
    };
}

export function wsState(fg: Record<string, unknown>, id = WS, name = 'QA WS'): WorkspaceState {
    return {
        id, name, lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: { ...BASE_FG, ...fg } as any,
    } as WorkspaceState;
}

/** A workspace whose models carry a train stamp that is fresh against the slice. */
export function wsTrained(fg: Record<string, unknown>, models: Record<string, unknown>[], id = WS): WorkspaceState {
    const slice = { ...BASE_FG, ...fg, models } as any;
    const stamped = models.map(m => ({ ...m, lastTrainedAt: '2026-10-01T10:00:00.000Z', trainedFingerprint: computeTrainFingerprint(m as any, slice) }));
    return wsState({ ...fg, models: stamped }, id);
}

export const writeDisk = (s: unknown, id = WS) => env.files.set(wsFile(id), JSON.stringify(s));
export const readDisk = (id = WS) => JSON.parse(env.files.get(wsFile(id))!);
export const diskModel = (mid: string, id = WS) => readDisk(id).failureGroupState.models.find((m: any) => m.id === mid);
/** How many times the workspace file was written with a given model's set points changed. */

export async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

export function newBackend(datasets: Record<string, HealthDataset> = { plant: plantDataset() }, initial?: string) {
    env.backend = createFakeHealthRust({ datasets, initial, files: env.files });
    return env.backend;
}

export const dash = () => within(screen.getByTestId('dashboard-window'));
export const bmw = () => within(screen.getByTestId('build-model-window'));
export const bmwEl = () => screen.getByTestId('build-model-window');

export interface MountOpts { dashboard?: boolean; meta?: any[] | null; headers?: string[]; generation?: number }

/** Mounts Dashboard (optional) + Build Model, waits for hydration. */
export async function mountWindows(o: MountOpts = {}) {
    const headers = o.headers ?? HEADERS;
    const meta = o.meta === undefined ? PLANT_META : o.meta;
    const generation = o.generation ?? env.backend?.generation() ?? 1;
    const dashboard = o.dashboard ?? true;
    const ui = render(
        <>
            {dashboard && (
                <div data-testid="dashboard-window">
                    <Dashboard
                        metadata={{ headers, total_rows: 60, generation } as any}
                        sensorMetadata={meta as any}
                        onBack={vi.fn()}
                        initialState={readDisk()}
                    />
                </div>
            )}
            <div data-testid="build-model-window"><BuildModelWindow /></div>
        </>,
    );
    if (!dashboard) {
        // Nobody answers `request-build-model-data`: hand the window its payload.
        await act(async () => {
            for (const cb of [...(env.listeners['build-model-data'] ?? [])]) {
                cb({ event: 'build-model-data', payload: { workspaceId: WS, sensorHeaders: headers.slice(1), sensorMetadata: meta, metadata: { headers, total_rows: 60, generation } }, id: 0 });
            }
        });
    }
    await waitFor(() => expect(bmw().getByTestId('rc-card')).toBeTruthy());
    await settle(350);
    return ui;
}

/** "Close the app and open it again": every window unmounts, the next launch
 *  loads the CSV again (a NEW Rust session: generation + 1, fit cache empty),
 *  and both windows re-hydrate from the workspace file on disk. */
export async function restartApp(o: MountOpts = {}) {
    cleanup();
    env.charts.length = 0;
    env.closeHandlers.length = 0;
    for (const k of Object.keys(env.listeners)) delete env.listeners[k];
    env.backend!.loadDataset(env.backend!.datasetName());
    return mountWindows(o);
}

/** Re-point the open Build Model window (Dashboard's `emitBuildModelData`). */
export async function sendBuildModelData(workspaceId: string, o: { meta?: any[] | null; headers?: string[]; generation?: number } = {}) {
    const headers = o.headers ?? HEADERS;
    await act(async () => {
        for (const cb of [...(env.listeners['build-model-data'] ?? [])]) {
            cb({ event: 'build-model-data', payload: { workspaceId, sensorHeaders: headers.slice(1), sensorMetadata: o.meta === undefined ? PLANT_META : o.meta, metadata: { headers, total_rows: 60, generation: o.generation ?? env.backend?.generation() } }, id: 0 });
        }
    });
    await settle(50);
}

export const selectSensor = (key: string, g = 1) => fireEvent.click(bmw().getByTestId(`sensor-list-row-fg:${g}-${key}`));
export const selectKindTab = (label: 'Individual' | 'Relation model' | 'Clustering') =>
    fireEvent.click(bmw().getAllByRole('tab').find(t => t.textContent?.includes(label))!);

export const pill = () => bmwEl().querySelector('.f4-foot .model-status-pill')!.textContent;

/** Wait until the active model's Model fit charts are on screen (a preview landed). */
export async function waitForCharts() {
    await waitFor(() => expect(bmw().getByTestId('results-chart')).toBeTruthy(), { timeout: 4000 });
}

/** Train exactly the ACTIVE model (the old per-model Train / Re-train): the header's
 *  Train sensor ▾ menu → "Train only the <kind> model" (
 *  items 8 + 9 — the footer button is gone; every train goes through the queue). */
export async function train() {
    const tab = bmw().getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true');
    // The tabs read Individual / Relation model / Clustering.
    const label = tab?.textContent?.toLowerCase() ?? '';
    const kind = (['individual', 'relationship', 'clustering'] as const).find(k => label.includes(k === 'relationship' ? 'relation model' : k));
    expect(kind, 'an active kind tab').toBeTruthy();
    fireEvent.click(bmw().getByTestId('train-sensor-menu-toggle'));
    const item = bmw().getByTestId(`train-menu-only-${kind}`) as HTMLButtonElement;
    expect(item.disabled, `Train only the ${kind} model is disabled`).toBe(false);
    await act(async () => { fireEvent.click(item); });
    await settle(30);
    await settle(300); // health preview debounce
}

export async function openHealth() {
    const b = bmw().getByTestId('next-health-score') as HTMLButtonElement;
    expect(b.disabled, `Health page disabled: ${b.title}`).toBe(false);
    fireEvent.click(b);
    await settle(300);
    await waitFor(() => expect(bmw().getByTestId('set-points-card')).toBeTruthy());
}

/** Type into a set-point input WITHOUT committing (no blur). */
export const typeSp = (id: string, value: string) => fireEvent.change(bmw().getByTestId(id), { target: { value } });
export const blurSp = (id: string) => fireEvent.blur(bmw().getByTestId(id));
export async function enterSp(values: Record<string, string>) {
    for (const [id, v] of Object.entries(values)) { typeSp(id, v); blurSp(id); }
    await settle(30);
    await settle(300);
}

export const markBtn = () => bmw().getByTestId('mark-complete') as HTMLButtonElement;
export async function markComplete() {
    await waitFor(() => expect(markBtn().disabled, bmw().queryByTestId('mark-block-reason')?.textContent ?? '').toBe(false));
    await act(async () => { fireEvent.click(markBtn()); });
    await settle(30);
}

/** Dashboard Failure Groups dot: 'none' | 'trained' | 'complete' | other class suffix. */
export function dashDot(groupNo: number, key: string, kind: string): string {
    expect(dash().getByTestId(`fg-sensor-row-${groupNo}:${key}`)).toBeTruthy();
    const el = screen.getByTestId('dashboard-window').querySelector(`[data-testid="fg-kind-badge-dot-${groupNo}-${key}-${kind}"]`);
    if (!el) return 'none';
    return el.className.match(/f4-kb-dot--(\w+)/)?.[1] ?? '?';
}

/** Build Model left-list dot(s) of a model: its raw `data-state` + its colour class. */
export function bmwDot(modelId: string): { state: string; colour: string } {
    const dots = [...bmwEl().querySelectorAll(`[data-testid="sensor-kind-badge-dot-${modelId}"]`)];
    if (dots.length === 0) return { state: 'none', colour: 'none' };
    const states = new Set(dots.map(d => `${d.getAttribute('data-state')}|${d.className.match(/f4-kb-dot--(\w+)/)?.[1]}`));
    expect(states.size, 'every bucket of the same model shows the same dot').toBe(1);
    const [state, colour] = [...states][0].split('|');
    return { state, colour };
}

export const openDashFgTab = () => fireEvent.click(dash().getByRole('button', { name: 'Failure Groups' }));
export const openDashSensorTab = () => fireEvent.click(dash().getByRole('button', { name: /^Sensor \(/ }));

/** The workspace Running condition modal: change the first condition's value and Apply. */
export async function applyWorkspaceRc(edit: (modal: ReturnType<typeof within>) => void | Promise<void>) {
    fireEvent.click(bmw().getByTestId('rc-card-open'));
    const modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
    await act(async () => { await edit(modal); });
    await settle(30);
    await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); });
    await settle(50);
}

/** Opens the Model settings section of the active model (collapsed once trained). */
export function openSettings() {
    if (bmwEl().querySelector('.bmw-sets--open')) return;
    fireEvent.click(bmw().getByText('Model settings', { selector: 'b' }));
}

export async function saveChanges() {
    await act(async () => { fireEvent.click(bmw().getByText('Save changes')); });
    await settle(50);
}

/** Pick sensors in an open shared sensor picker:
 *  multi = the "Select {noun}" modal (tick rows + OK); single = the anchored popover named
 *  after the field (one click picks and closes). */
export async function pickInModal(noun: string, tags: string[], single = false) {
    const dialog = () => screen.getByRole('dialog', { name: single ? noun : `Select ${noun}` });
    for (const tag of tags) {
        fireEvent.change(within(dialog()).getByRole('combobox'), { target: { value: tag } });
        const item = [...dialog().querySelectorAll('[role="option"]')].find(el => rowTag(el) === tag) as HTMLElement;
        expect(item, `picker item ${tag}`).toBeTruthy();
        if (single) { fireEvent.click(item); await settle(); return; }
        fireEvent.click(item);
    }
    const ok = [...dialog().querySelectorAll('.pk-foot button')].pop() as HTMLElement;
    fireEvent.click(ok);
    await settle();
}

/** Latest chart options drawn whose series include `name`. */
export const chartsWithSeries = (name: string | RegExp) =>
    env.charts.filter(c => ((c.option?.series ?? []) as any[]).some(s => (typeof name === 'string' ? s?.name === name : name.test(s?.name ?? ''))));
