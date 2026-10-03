import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

/*
 * Health score QA sweep (2026-10-04) — "Incomplete immediately" end to end, and
 * the ONE status truth across the Dashboard Failure Groups panel, the Build
 * Model list dot, the kind tab pill, the page switch and the step bar.
 *
 * Every trigger the SPEC lists (training period, Running condition Workspace /
 * Custom, condition edit, AND/OR, "no condition", periods, predictors, Y /
 * criteria sensor, cluster count, stiffness) is driven through the REAL UI on a
 * Complete model: the model must go Incomplete in the SAME write, keep its set
 * points / lastTrainedAt / trainedFingerprint / healthExport, the Dashboard dot
 * must follow (cross-window), the Health score page must close ("Re-train
 * first"), the charts must say "Out of date", and Re-train must bring it back.
 * The non-triggers (set points, name, notes, category, FG membership, the
 * Relationship scatter X) must leave it Complete.
 */

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./helpers/healthEnv')).fsModule());
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => (await import('./helpers/healthEnv')).windowModule());
vi.mock('../components/charts/ResponsiveECharts', async () => (await import('./helpers/healthEnv')).chartModule());
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class { static getByLabel = vi.fn().mockResolvedValue(null); once = vi.fn(); },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn().mockResolvedValue(undefined) }));
vi.mock('split.js', () => ({ default: () => ({ destroy: vi.fn() }) }));
vi.mock('../errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../components/charts', () => ({
    Chart: () => <div data-testid="chart-mock" />,
    defaultSensorColor: (tag: string) => `default-${tag}`,
    LINE_CHART_COLORS: ['c0', 'c1', 'c2', 'c3'],
    MAX_PAIR_PLOT_SENSORS: 4,
    RANGE_PALETTE: [[0.99, 0.75, 0.18, 1.0], [0.20, 0.83, 0.60, 1.0]],
}));
vi.mock('../components/dashboard/FilterPanel', () => ({ default: () => <div data-testid="filter-panel" /> }));
vi.mock('../components/dashboard/HighlightsPanel', () => ({ default: () => <div /> }));
vi.mock('../components/dashboard/ColorPlatePicker', () => ({ default: () => <div /> }));
vi.mock('../hooks/useChartData', () => ({ useChartData: () => ({ view: null, loading: false, error: null }) }));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: () => ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null }),
}));
vi.mock('../components/charts/LineChart', () => ({ default: () => <div /> }));

import { env, resetEnv } from './helpers/healthEnv';
import {
    COND, WS, applyWorkspaceRc, bmw, bmwDot, bmwEl, dash, dashDot, diskModel, enterSp, model, mountWindows, newBackend,
    openDashFgTab, openDashSensorTab, openHealth, openSettings, pickInModal, pill, readDisk, saveChanges, selectKindTab,
    selectSensor, settle, train, waitForCharts, writeDisk, wsTrained,
} from './helpers/healthWorkbench';
import { updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from '../utils/failureGroupState';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const IND_SP = { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 };
const REL_SP = { kind: 'relationship', residualAt80Lower: -5, residualAt80Upper: 5, residualAt0Lower: -10, residualAt0Upper: 10 };
const CLU_SP = { kind: 'clustering', outerSd: 5 };
const EXPORT = (sp: unknown) => ({ at: '2026-10-02T10:00:00.000Z', outputDir: 'C:/x/workspaces/ws1/output', setPoints: sp });

/** Four Complete, fresh models: three follow the WORKSPACE condition, one has its own (Custom). */
function completeWorkspace(fgOver: Record<string, unknown> = {}, extra: Record<string, unknown>[] = [], relPredictors = ['TAG3']) {
    return wsTrained(fgOver, [
        model({ id: 'i1', kind: 'individual', status: true, healthSetPoints: IND_SP, healthExport: EXPORT(IND_SP) }),
        model({ id: 'r1', kind: 'relationship', predictorSensors: relPredictors, status: true, healthSetPoints: REL_SP, healthExport: EXPORT(REL_SP) }),
        model({
            id: 'c1', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG5', criteriaSensor: 'TAG4', numClusters: 2,
            clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }], status: true, healthSetPoints: CLU_SP, healthExport: EXPORT(CLU_SP),
        }),
        model({
            id: 'u1', kind: 'individual', targetSensor: 'TAG5', groupNos: [2], status: true, healthSetPoints: { kind: 'individual', lower: 0, upper: 99, masterLower: null, masterUpper: null },
            runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
        }),
        ...extra,
    ]);
}

const KEEP = (m: any) => ({ hsp: m.healthSetPoints, at: m.lastTrainedAt, fp: m.trainedFingerprint, exp: m.healthExport });

/** The model went Incomplete in the same write, kept everything, and every view agrees. */
async function expectDemoted(id: string, before: any, o: { group?: number; key?: string; kind?: string } = {}) {
    const m = diskModel(id);
    expect(m.status, `${id} status`).toBe(false);
    expect(KEEP(m), `${id} keeps set points / train record / export record`).toEqual(KEEP(before));
    if (o.key) {
        openDashFgTab();
        await waitFor(() => expect(dashDot(o.group ?? 1, o.key!, o.kind!)).toBe('none'));
    }
}

/** Build Model shows the active (demoted) model as stale everywhere. */
function expectStaleUi() {
    expect(pill()).toBe('Incomplete');
    const h = bmw().getByTestId('page-health') as HTMLButtonElement;
    expect(h.disabled).toBe(true);
    expect(h.title).toBe('Re-train first');
    expect(bmw().getByTestId('stale-banner')).toBeTruthy();
    expect((bmw().getByTestId('wb-step-health-set-points') as HTMLButtonElement).disabled).toBe(true);
}

describe('workspace Running condition triggers (Apply in the modal)', () => {
    const cases: { name: string; fg?: Record<string, unknown>; edit: (m: ReturnType<typeof within>) => void }[] = [
        { name: 'condition value edit', edit: m => { fireEvent.change(m.getByPlaceholderText('value'), { target: { value: '20' } }); } },
        { name: 'switch to "Use all rows" (no-condition choice)', edit: m => { fireEvent.click(m.getByTestId('rc-mode-none')); } },
        {
            name: 'AND -> OR',
            fg: { runningConditionFilters: [COND, { id: 'rc2', sensor: 'TAG3', operation: 'greater_than', value1: '45', value2: '' }] },
            edit: m => { fireEvent.click(m.getByTestId('rc-combine')); },
        },
        { name: 'condition removed', edit: m => { fireEvent.click(m.getByRole('button', { name: 'Remove condition' })); } },
        {
            name: 'training period removed',
            fg: { runningConditionTimePeriods: [{ id: 'p1', start: '2026-01-01T05:00', end: '2026-01-03T00:00' }] },
            edit: m => { fireEvent.click(m.getByRole('button', { name: 'Remove period 1' })); },
        },
    ];
    for (const c of cases) {
        it(`${c.name}: every Workspace-mode Complete model (all 3 kinds, any sensor) goes Incomplete; the Custom one stays Complete`, async () => {
            writeDisk(completeWorkspace(c.fg));
            const before = Object.fromEntries(readDisk().failureGroupState.models.map((m: any) => [m.id, m]));
            await mountWindows();
            selectSensor('tag1');
            await settle(400);
            expect(pill()).toBe('Complete');
            openDashFgTab();
            expect(dashDot(1, 'tag1', 'individual')).toBe('complete');
            expect(dashDot(2, 'tag5', 'individual')).toBe('complete');

            await applyWorkspaceRc(c.edit);

            await expectDemoted('i1', before.i1, { key: 'tag1', kind: 'individual' });
            await expectDemoted('r1', before.r1, { key: 'tag1', kind: 'relationship' });
            await expectDemoted('c1', before.c1, { key: 'tag3', kind: 'clustering' });
            expect(diskModel('u1').status).toBe(true);
            expect(dashDot(2, 'tag5', 'individual')).toBe('complete');
            expectStaleUi();
        });
    }
});

describe('model-setting triggers (Save changes)', () => {
    it('Individual: Workspace -> Custom switch', async () => {
        writeDisk(completeWorkspace());
        const before = diskModel('i1');
        await mountWindows();
        selectSensor('tag1');
        await settle(400);
        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Custom' }));
        // An unsaved draft already reads as out of date (draft-aware): Health page closed.
        expect((bmw().getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true);
        expect(diskModel('i1').status).toBe(true); // nothing written yet
        await saveChanges();
        await expectDemoted('i1', before, { key: 'tag1', kind: 'individual' });
        expectStaleUi();
        // Re-train brings it back to Trained (not silently Complete), set points intact and valid.
        await train();
        expect(pill()).toBe('Trained');
        expect(diskModel('i1').status).toBe(false);
        expect(diskModel('i1').healthSetPoints).toEqual(IND_SP);
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('trained'));
    });

    it('Relationship: predictor added, then removed, and stiffness changed — each Save demotes in the same write', async () => {
        writeDisk(completeWorkspace());
        const before = diskModel('r1');
        await mountWindows();
        selectSensor('tag1');
        selectKindTab('Relationship');
        await waitForCharts();
        expect(pill()).toBe('Complete');
        openSettings();
        fireEvent.click(bmwEl().querySelector('button.predictor-picker-trigger') as HTMLElement);
        await pickInModal('predictors', ['TAG2']);
        await saveChanges();
        await expectDemoted('r1', before, { key: 'tag1', kind: 'relationship' });
        expect(diskModel('r1').predictorSensors).toEqual(['TAG3', 'TAG2']);
        expectStaleUi();
        // "Out of date" overlay on the last charts
        expect(bmwEl().querySelectorAll('[data-testid="chart-outdated"]').length).toBeGreaterThan(0);
    });

    it('Relationship: stiffness change demotes', async () => {
        writeDisk(completeWorkspace());
        const before = diskModel('r1');
        await mountWindows();
        selectSensor('tag1');
        selectKindTab('Relationship');
        await settle(500);
        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Strict' }));
        await saveChanges();
        await expectDemoted('r1', before, { key: 'tag1', kind: 'relationship' });
    });

    it('Clustering: cluster count, Y sensor and criteria sensor each demote', async () => {
        for (const step of ['count', 'y', 'criteria'] as const) {
            cleanup();
            resetEnv();
            newBackend();
            writeDisk(completeWorkspace());
            const before = diskModel('c1');
            await mountWindows();
            selectSensor('tag3');
            await settle(400);
            expect(pill()).toBe('Complete');
            openSettings();
            if (step === 'count') fireEvent.click(bmw().getByRole('button', { name: 'More clusters' }));
            if (step === 'y') { fireEvent.click(bmwEl().querySelectorAll('button.sensor-picker-trigger-single')[0]); await pickInModal('Y sensor', ['TAG1'], true); }
            if (step === 'criteria') { fireEvent.click(bmwEl().querySelectorAll('button.sensor-picker-trigger-single')[1]); await pickInModal('criteria sensor', ['TAG2'], true); }
            await settle(200);
            await saveChanges();
            await expectDemoted('c1', before, { key: 'tag3', kind: 'clustering' });
        }
    });

    it('Custom model: its own condition edited and its own period removed — demotes ONLY that model', async () => {
        writeDisk(completeWorkspace({}, [
            model({
                id: 'u2', kind: 'individual', targetSensor: 'TAG4', groupNos: [2], status: true,
                healthSetPoints: { kind: 'individual', lower: -500, upper: 500, masterLower: null, masterUpper: null },
                runningConditionMode: 'custom', customRunningConditionFilters: [{ id: 'c9', sensor: 'TAG2', operation: 'greater_than', value1: '5', value2: '' }],
                filterTimePeriods: [{ id: 'p9', start: '2026-01-01T02:00', end: '2026-01-03T00:00' }],
            }),
        ]));
        const before = diskModel('u2');
        await mountWindows();
        selectSensor('tag4', 2);
        await settle(400);
        expect(pill()).toBe('Complete');
        openSettings();
        fireEvent.change(bmwEl().querySelector('.f4-cond-v') as HTMLElement, { target: { value: '7' } });
        await saveChanges();
        await expectDemoted('u2', before, { group: 2, key: 'tag4', kind: 'individual' });
        expect(['i1', 'r1', 'c1', 'u1'].map(id => diskModel(id).status)).toEqual([true, true, true, true]);
    });
});

describe('NOT triggers: the model stays Complete', () => {
    it('set points, model name, category, notes (another window), FG membership (Dashboard sheet), scatter X', async () => {
        writeDisk(completeWorkspace({}, [], ['TAG3', 'TAG2']));
        await mountWindows();
        selectSensor('tag1');
        await settle(400);

        // set points (Health page, blur-committed)
        await openHealth();
        await enterSp({ 'sp-upper': '81' });
        expect(diskModel('i1').healthSetPoints.upper).toBe(81);
        expect(diskModel('i1').status).toBe(true);
        expect(bmw().getByTestId('files-out-of-date')).toBeTruthy();
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));

        // model name
        openSettings();
        fireEvent.change(bmw().getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
        await saveChanges();
        expect(diskModel('i1').name).toBe('Renamed');
        expect(diskModel('i1').status).toBe(true);

        // category
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Condition/ })); });
        await settle(50);
        expect(diskModel('i1').category).toBe('condition');
        expect(diskModel('i1').status).toBe(true);

        // notes, written by another window
        await act(async () => {
            const next = await updateWorkspaceData(WS, prev => withFailureGroupState(prev, {
                models: prev.failureGroupState!.models.map(m => (m.id === 'i1' ? { ...m, notes: 'seal leak' } : m)),
            }));
            const { emit } = await import('@tauri-apps/api/event');
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: WS, origin: 'dashboard' });
        });
        await settle(50);
        expect(diskModel('i1').status).toBe(true);

        // FG membership: the Dashboard sheet adds TAG1's Individual model to FG-B
        openDashSensorTab();
        fireEvent.change(dash().getByPlaceholderText('Search sensors...'), { target: { value: 'TAG1' } });
        await settle();
        const row = (screen.getByTestId('dashboard-window').querySelector('#sensor-TAG1') as HTMLElement).closest('.sensor-list-row') as HTMLElement;
        fireEvent.click(within(row).getByTitle('Add to failure group'));
        const sheet = within(await screen.findByTestId('fg-sheet'));
        await act(async () => { fireEvent.click(sheet.getByRole('button', { name: 'Individual · FG-B' })); });
        await settle(400);
        expect(diskModel('i1').groupNos).toEqual([1, 2]);
        expect(diskModel('i1').status).toBe(true);

        // Relationship scatter X selector writes scatterXSensor immediately, no demotion
        selectKindTab('Relationship');
        await waitForCharts();
        expect(pill()).toBe('Complete');
        const xs = within(bmw().getByTestId('fit-x-selector'));
        const input = xs.getByRole('textbox');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'TAG2' } });
        await settle();
        const opt = [...bmwEl().querySelectorAll('.sensor-autocomplete-item')].find(el => el.textContent?.includes('TAG2')) as HTMLElement;
        expect(opt).toBeTruthy();
        fireEvent.click(opt);
        await settle(100);
        expect(diskModel('r1').scatterXSensor).toBe('TAG2');
        expect(diskModel('r1').status).toBe(true);
        // the preview now asks for the new X axis (no re-train, no demotion)
        await settle(350);
        expect(env.backend!.cmds('compute_health_preview').pop()!.args.request.x_predictor).toBe('TAG2');
        expect(pill()).toBe('Complete');
        expect(['i1', 'r1', 'c1', 'u1'].map(id => diskModel(id).status)).toEqual([true, true, true, true]);
        openDashFgTab();
        expect(dashDot(1, 'tag1', 'individual')).toBe('complete');
        expect(dashDot(2, 'tag1', 'individual')).toBe('complete');
    });

    it('re-applying the SAME workspace condition keeps every model Complete', async () => {
        writeDisk(completeWorkspace());
        await mountWindows();
        selectSensor('tag1');
        await applyWorkspaceRc(m => { fireEvent.change(m.getByPlaceholderText('value'), { target: { value: '10' } }); });
        expect(['i1', 'r1', 'c1', 'u1'].map(id => diskModel(id).status)).toEqual([true, true, true, true]);
    });
});

describe('ONE truth: Dashboard dot, Build Model dot, tab pill, page switch, step bar', () => {
    it('never trained -> trained (needs set points) -> invalid set point -> valid -> complete -> complete-but-changed -> stale', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } })]));
        // strip the train record: "never trained"
        const s = readDisk();
        delete s.failureGroupState.models[0].lastTrainedAt;
        delete s.failureGroupState.models[0].trainedFingerprint;
        writeDisk(s);
        await mountWindows();
        selectSensor('tag1');
        openDashFgTab();
        const step = (k: string) => bmw().getByTestId(`wb-step-${k}`).getAttribute('data-look');

        // never trained
        expect(dashDot(1, 'tag1', 'individual')).toBe('none');
        expect(bmwDot('i1').state).toBe('none');
        expect((bmw().getByTestId('page-health') as HTMLButtonElement).title).toBe('Train the model first');
        expect(step('train')).not.toBe('done');

        // trained, set points empty
        await train();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('tab-status-i1').textContent).toBe('Set points needed'));
        expect(bmwDot('i1')).toEqual({ state: 'trained', colour: expect.any(String) });
        const trainedColour = bmwDot('i1').colour;
        // 2026-10-04: the Dashboard dot reads the persisted verdict too - "Set points needed" is
        // the yellow "need" dot there, same colour as the Build Model list (it used to be the
        // plain "trained" dot because the verdict only lived in the Build Model window).
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('need'));
        expect(step('train')).toBe('done');

        // an invalid set point -> "Fix set point" (red) in Build Model
        await enterSp({ 'sp-lower': '49', 'sp-upper': '90' });
        await waitFor(() => expect(bmw().getByTestId('tab-status-i1').textContent).toBe('Fix set point'));
        expect(bmwDot('i1').colour).not.toBe(trainedColour);
        expect(step('health-set-points')).toBe('bad');

        // valid
        await enterSp({ 'sp-lower': '10' });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(step('health-set-points')).toBe('done');
        expect(bmwDot('i1').colour).toBe(trainedColour);

        // complete
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-complete')); });
        await settle(50);
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(bmwDot('i1').state).toBe('complete');
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('complete'));
        expect(step('complete')).toBe('done');
        expect(bmw().getByTestId('page-health-done')).toBeTruthy();

        // complete but changed after saving: still Complete everywhere + the hint
        await enterSp({ 'sp-lower': '11' });
        expect(bmw().getByTestId('files-out-of-date')).toBeTruthy();
        expect(bmw().getByTestId('mark-complete-again')).toBeTruthy();
        expect(bmwDot('i1').state).toBe('complete');
        expect(dashDot(1, 'tag1', 'individual')).toBe('complete');
        // revert -> hint gone
        await enterSp({ 'sp-lower': '10' });
        expect(bmwEl().querySelector('[data-testid="files-out-of-date"]')).toBeNull();

        // stale
        await applyWorkspaceRc(m => { fireEvent.change(m.getByPlaceholderText('value'), { target: { value: '30' } }); });
        expect(bmwDot('i1').state).toBe('stale');
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('none'));
        expect(step('train')).not.toBe('done');
    });

    // Was a KNOWN GAP (LOW, "not done" in the 3b-2 handover entry): Build Model showed a
    // trained model whose set points Rust rejects as RED ("Fix set point") but the Dashboard's
    // Failure Groups panel kept drawing the plain "trained" dot, because the verdict was
    // session-only state of the Build Model window. Fixed 2026-10-04: the verdict is persisted
    // on the model (`healthVerdict`) and every surface reads it through `modelSetPointFlag`.
    it('the Dashboard Failure Groups dot shows "Fix set point" (red) like the Build Model list when the saved set points are rejected', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 49, upper: 90, masterLower: null, masterUpper: null } })]));
        await mountWindows();
        selectSensor('tag1');
        await settle(300);
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('tab-status-i1').textContent).toBe('Fix set point'));
        openDashFgTab();
        expect(bmwDot('i1').colour).toBe('bad');
        expect(dashDot(1, 'tag1', 'individual')).toBe('bad');
    });
});

describe('the saved validation verdict (healthVerdict) end to end - 2026-10-04', () => {
    const BAD = { kind: 'individual', lower: 49, upper: 90, masterLower: null, masterUpper: null };

    it('Dashboard dot follows it without the Health page being opened: invalid -> red; fixed -> valid; stale -> dropped; re-train -> judged again', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: BAD })]));
        await mountWindows();
        openDashFgTab();
        // the active model's preview lands on the Model fit page already and is saved
        await waitFor(() => expect(diskModel('i1').healthVerdict).toBe('invalid'));
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('bad'));
        expect(bmwDot('i1').colour).toBe('bad');

        // fixing the set point: the write drops the old verdict, the new one is saved after the preview
        selectSensor('tag1');
        await openHealth();
        await enterSp({ 'sp-lower': '10' });
        await waitFor(() => expect(diskModel('i1').healthVerdict).toBe('valid'));
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('trained'));

        // a training input changes: the model is stale and the verdict is gone from disk (same write)
        await applyWorkspaceRc(m => { fireEvent.change(m.getByPlaceholderText('value'), { target: { value: '30' } }); });
        expect(diskModel('i1')).not.toHaveProperty('healthVerdict');
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('none'));

        // re-train: a new fit, judged again
        await train();
        await waitFor(() => expect(diskModel('i1').healthVerdict).toBe('valid'));
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('trained'));
    });

    it('empty set points are saved as "incomplete" and drawn yellow on the Dashboard (Set points needed)', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null } })]));
        await mountWindows();
        openDashFgTab();
        await waitFor(() => expect(diskModel('r1').healthVerdict).toBe('incomplete'));
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).toBe('need'));
    });

    it('a Complete model keeps its green dot whatever the verdict says', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', status: true, healthVerdict: 'invalid', healthSetPoints: IND_SP })]));
        await mountWindows();
        openDashFgTab();
        await settle(400);
        expect(dashDot(1, 'tag1', 'individual')).toBe('complete');
    });
});

void env; void COND;
