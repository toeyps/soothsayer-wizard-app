import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import {
    CloseRunDialog,
    LockedSettingsHeader,
    QueuedCard,
    RunSetPointsBanner,
    RunStrip,
    SensorTrainButton,
    sensorTrainMenuCopy,
    shortTrainError,
    TrainAllBar,
    TrainAllModal,
    type SensorTrainMenuModel,
    type TrainGroupInfo,
    type TrainRowModel,
} from '../components/windows/workbench/TrainQueueParts';
import { SensorMetaContext, buildSensorLookup } from '../components/sensor/sensorInfo';
import { summarizeTrainRun, TRAIN_NEEDS_RUNNING_CONDITION, TRAIN_STALE_MESSAGE } from '../utils/trainQueue';
import type { TrainQueueItem, TrainRun } from '../types/trainQueue';
import { sameModelFitProps, type ModelFitPageProps } from '../components/windows/workbench/ModelFitPage';

/*
 * Train sensor / Train all with a queue (customer batch 2026-10, items 8 + 9) —
 * the presentational parts on their own. The wiring (the queue driving the
 * window's train, locks, the close dialog, STALE) is covered in
 * BuildModelWindow.test.tsx's "train queue" block.
 */

afterEach(() => cleanup());

const LOOKUP = buildSensorLookup(null, [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
] as never);
const withMeta = (ui: React.ReactElement) => render(<SensorMetaContext.Provider value={LOOKUP}>{ui}</SensorMetaContext.Provider>);

const ROWS: TrainRowModel[] = [
    { id: 'i1', kind: 'individual', tag: 'TAG1', groupNos: [1], plan: { kind: 'ready' } },
    { id: 'r1', kind: 'relationship', tag: 'TAG1', groupNos: [1, 2], plan: { kind: 'missing', reason: 'no predictor sensor', fix: 'settings' } },
    { id: 'i2', kind: 'individual', tag: 'TAG2', groupNos: [2], plan: { kind: 'upToDate', reason: 'Complete, up to date', complete: true } },
    { id: 'c3', kind: 'clustering', tag: 'TAG3', groupNos: [0], plan: { kind: 'upToDate', reason: 'up to date', complete: false } },
];
const ROW_MAP = new Map(ROWS.map(r => [r.id, r]));
const GROUPS: TrainGroupInfo[] = [
    { no: 1, name: 'Bearing', color: 'red' },
    { no: 2, name: 'Seal', color: 'blue' },
    { no: 0, name: '', color: 'grey' },
];

function makeRun(items: TrainQueueItem[], over: Partial<TrainRun> = {}): TrainRun {
    return { runId: 1, source: 'all', phase: 'running', items, currentId: null, stopRequested: null, startedAt: 0, ...over };
}

describe('TrainAllBar', () => {
    it('shows the counts and opens the preflight', () => {
        const onOpen = vi.fn();
        withMeta(<TrainAllBar counts={{ ready: 9, upToDate: 0, missing: 1 }} running={false} reason={null} reasonTone="neutral" onOpen={onOpen} />);
        expect(screen.getByTestId('train-all-counts').textContent).toBe("9 ready0 up to date1 can't train");
        expect(screen.getByTestId('train-all').textContent).toBe('▶ Train all');
        expect(screen.queryByTestId('train-all-reason')).toBeNull();
        fireEvent.click(screen.getByTestId('train-all'));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('is disabled with its reason as text (amber for the running condition, red for STALE)', () => {
        const { rerender } = withMeta(<TrainAllBar counts={{ ready: 0, upToDate: 0, missing: 3 }} running={false} reason={TRAIN_NEEDS_RUNNING_CONDITION} reasonTone="warn" onOpen={() => {}} />);
        expect((screen.getByTestId('train-all') as HTMLButtonElement).disabled).toBe(true);
        // The step bar is gone: no text on screen may say "Step 1" (the shared reason constant still does).
        expect(screen.getByTestId('train-all-reason').textContent).toBe('Set the running condition first.');
        expect((screen.getByTestId('train-all') as HTMLButtonElement).title).toBe('Set the running condition first.');
        expect(screen.getByTestId('train-all-reason').className).toContain('tq-why--warn');
        rerender(<SensorMetaContext.Provider value={LOOKUP}><TrainAllBar counts={{ ready: 2, upToDate: 0, missing: 0 }} running={false} reason={TRAIN_STALE_MESSAGE} reasonTone="danger" onOpen={() => {}} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('train-all-reason').className).toContain('tq-why--danger');
        expect(screen.getByTestId('train-all-reason').getAttribute('role')).toBe('alert');
    });

    it('says "Training…" and stays disabled while a run is active', () => {
        withMeta(<TrainAllBar counts={{ ready: 2, upToDate: 0, missing: 0 }} running reason={null} reasonTone="neutral" onOpen={() => {}} />);
        expect(screen.getByTestId('train-all').textContent).toContain('Training…');
        expect((screen.getByTestId('train-all') as HTMLButtonElement).disabled).toBe(true);
    });
});

// The ▾ menu's copy (user decision 2026-10-10): "Re-train" is only said about a model that
// has been trained before; the all-row says it only when EVERY model of the sensor has.
describe('sensorTrainMenuCopy', () => {
    const READY = { kind: 'ready' } as const;
    const UP = { kind: 'upToDate', reason: 'up to date', complete: false } as const;
    const DONE = { kind: 'upToDate', reason: 'Complete, up to date', complete: true } as const;
    const MISSING = { kind: 'missing', reason: 'no Y sensor', fix: 'settings' } as const;
    const m = (kind: SensorTrainMenuModel['kind'], plan: SensorTrainMenuModel['plan'], trainedBefore: boolean): SensorTrainMenuModel => ({ kind, plan, trainedBefore });

    it('a never-trained sensor: "Train all N models" and "<Kind> only" — no "Re-train" anywhere', () => {
        const copy = sensorTrainMenuCopy([m('individual', READY, false), m('relationship', READY, false), m('clustering', MISSING, false)]);
        expect(copy.all.label).toBe('Train all 3 models');
        expect(copy.only.map(o => o.label)).toEqual(['Individual only', 'Relationship only', 'Clustering only']);
        expect(copy.only.map(o => o.small)).toEqual(['≈ 1 s', '≈ 15 s', "Can't train — no Y sensor"]);
        expect(JSON.stringify(copy)).not.toMatch(/re-train/i);
    });

    it('mixed: only the trained model says "Re-train … only"; the all-row stays "Train all N models"', () => {
        const copy = sensorTrainMenuCopy([m('individual', UP, true), m('relationship', READY, false)]);
        expect(copy.all.label).toBe('Train all 2 models');
        expect(copy.only.map(o => o.label)).toEqual(['Re-train Individual only', 'Relationship only']);
        expect(copy.only[0].small).toBe('Re-trains it even though it is up to date');
        expect(copy.only[1].small).toBe('≈ 15 s');
    });

    it('every model trained before: "Re-train all N models" and "Re-train <Kind> only" (a stale one included)', () => {
        const copy = sensorTrainMenuCopy([m('individual', DONE, true), m('relationship', READY, true), m('clustering', UP, true)]);
        expect(copy.all.label).toBe('Re-train all 3 models');
        expect(copy.all.small).toBe('Includes up-to-date ones · a Complete model becomes Incomplete and needs Mark complete again');
        expect(copy.only.map(o => o.label)).toEqual(['Re-train Individual only', 'Re-train Relationship only', 'Re-train Clustering only']);
        expect(copy.only[0].small).toBe('Re-trains it even though it is up to date · it becomes Incomplete');
        expect(copy.only[1].small).toBe('≈ 15 s');
        expect(copy.only[2].small).toBe('Re-trains it even though it is up to date');
    });

    it('a trained model that can\'t train now keeps "Re-train … only" with its reason', () => {
        const copy = sensorTrainMenuCopy([m('clustering', MISSING, true)]);
        expect(copy.only[0]).toEqual({ label: 'Re-train Clustering only', small: "Can't train — no Y sensor" });
    });

    it('a model marked Complete with NO train record (legacy) is never said to be "re-trained"', () => {
        const copy = sensorTrainMenuCopy([m('individual', DONE, false)]);
        expect(copy.all.label).toBe('Train all 1 model');
        expect(copy.only[0]).toEqual({ label: 'Individual only', small: 'Trains it even though it is up to date · it becomes Incomplete' });
    });

    it('one model: the count reads "1 model" (singular)', () => {
        expect(sensorTrainMenuCopy([m('individual', READY, false)]).all.label).toBe('Train all 1 model');
        expect(sensorTrainMenuCopy([m('individual', UP, true)]).all.label).toBe('Re-train all 1 model');
    });
});

describe('SensorTrainButton', () => {
    const menu = (onA = vi.fn(), onB = vi.fn()) => [
        { key: 'retrain-all', label: 'Train all 2 models', small: 'Includes up-to-date ones', onClick: onA },
        { key: 'only-relationship', label: 'Relationship only', small: "Can't train — no predictor sensor", disabled: true, onClick: onB },
    ];

    it('the main button trains; the line under it says what it does', () => {
        const onTrain = vi.fn();
        withMeta(<SensorTrainButton filled label="▶ Train sensor · 1 of 2" disabled={false} why="Trains Individual · Relation model can't train, skipped" whyTone="warn" onTrain={onTrain} menu={menu()} />);
        expect(screen.getByTestId('train-sensor').textContent).toBe('▶ Train sensor · 1 of 2');
        expect(screen.getByTestId('train-sensor-why').textContent).toBe("Trains Individual · Relation model can't train, skipped");
        expect(screen.getByTestId('train-sensor-why').className).toContain('tq-why--warn');
        fireEvent.click(screen.getByTestId('train-sensor'));
        expect(onTrain).toHaveBeenCalledTimes(1);
    });

    it('the ▾ menu runs an item, keeps a disabled one disabled, and closes on Esc / outside click', () => {
        const onA = vi.fn();
        withMeta(<SensorTrainButton filled={false} label="▶ Train sensor" disabled why="" whyTone="neutral" onTrain={() => {}} menu={menu(onA)} />);
        // The main button can be disabled while the menu still offers a re-train.
        expect((screen.getByTestId('train-sensor') as HTMLButtonElement).disabled).toBe(true);
        const toggle = screen.getByTestId('train-sensor-menu-toggle');
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect((screen.getByTestId('train-menu-only-relationship') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('train-sensor-menu')).toBeNull();
        fireEvent.click(toggle);
        fireEvent.mouseDown(document.body);
        expect(screen.queryByTestId('train-sensor-menu')).toBeNull();
        fireEvent.click(toggle);
        fireEvent.click(screen.getByTestId('train-menu-retrain-all'));
        expect(onA).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('train-sensor-menu')).toBeNull();
    });

    it('the ▾ toggle is disabled when every menu item is', () => {
        withMeta(<SensorTrainButton filled={false} label="x" disabled why="" whyTone="neutral" onTrain={() => {}} menu={menu().map(m => ({ ...m, disabled: true }))} />);
        expect((screen.getByTestId('train-sensor-menu-toggle') as HTMLButtonElement).disabled).toBe(true);
    });

    // Workbench redesign §1: at most one filled button on screen — the button is filled
    // (primary) only while it is the next action, a ghost otherwise. Both halves follow.
    it('filled = primary on the button AND its ▾; not filled = a ghost on both', () => {
        const { rerender } = withMeta(<SensorTrainButton filled label="▶ Train sensor · 1 of 2" disabled={false} why="" whyTone="neutral" onTrain={() => {}} menu={menu()} />);
        expect(screen.getByTestId('train-sensor').className).toContain('rcx-btn--pri');
        expect(screen.getByTestId('train-sensor-menu-toggle').className).toContain('rcx-btn--pri');
        rerender(<SensorMetaContext.Provider value={LOOKUP}><SensorTrainButton filled={false} label="▶ Train sensor · 0 of 2" disabled why="" whyTone="neutral" onTrain={() => {}} menu={menu()} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('train-sensor').className).not.toContain('rcx-btn--pri');
        expect(screen.getByTestId('train-sensor-menu-toggle').className).not.toContain('rcx-btn--pri');
        expect(screen.getByTestId('train-sensor').className).toContain('rcx-btn');
    });

    it('never prints "Step 1" — in the line under the button or in its tooltip', () => {
        withMeta(<SensorTrainButton filled={false} label="▶ Train sensor · 0 of 1" disabled title={TRAIN_NEEDS_RUNNING_CONDITION} why={TRAIN_NEEDS_RUNNING_CONDITION} whyTone="warn" onTrain={() => {}} menu={menu()} />);
        expect(screen.getByTestId('train-sensor-why').textContent).toBe('Set the running condition first.');
        expect((screen.getByTestId('train-sensor') as HTMLButtonElement).title).toBe('Set the running condition first.');
    });
});

describe('RunStrip', () => {
    const handlers = () => ({ onDetails: vi.fn(), onCancel: vi.fn(), onDismiss: vi.fn(), onCloseWindow: vi.fn(), onTrainNotStarted: vi.fn() });

    it('running: "Training i of n", the current model, time left, one titled segment per planned model, Details and Cancel', () => {
        const run = makeRun([
            { id: 'i1', kind: 'individual', state: 'trained', durationMs: 1000 },
            { id: 'r1', kind: 'relationship', state: 'skipped', skip: { kind: 'missing', reason: 'no predictor sensor' } },
            { id: 'i2', kind: 'individual', state: 'running' },
            { id: 'c3', kind: 'clustering', state: 'queued' },
        ], { currentId: 'i2' });
        const h = handlers();
        withMeta(<RunStrip run={run} summary={summarizeTrainRun(run)} timeLeftMs={null} rows={ROW_MAP} {...h} />);
        const strip = screen.getByTestId('train-run-strip');
        expect(strip.getAttribute('data-phase')).toBe('running');
        expect(screen.getByTestId('train-run-text').textContent).toBe('Training 2 of 3');
        expect(strip.textContent).toContain('Pump Temp');
        // Rough time before an estimate exists: I (1 s) + C (2 s).
        expect(screen.getByTestId('train-run-eta').textContent).toBe('≈ 3 s left');
        const segs = screen.getByTestId('train-run-segments').querySelectorAll('i');
        expect(segs).toHaveLength(3); // the preflight-skipped model has no segment
        expect(segs[0].getAttribute('title')).toBe('1. Pump Pressure · TAG1 · Individual — trained');
        expect(segs[1].getAttribute('title')).toBe('2. Pump Temp · TAG2 · Individual — training now');
        expect(segs[2].getAttribute('data-state')).toBe('queued');
        fireEvent.click(screen.getByTestId('train-run-cancel'));
        expect(h.onCancel).toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('train-run-details'));
        expect(h.onDetails).toHaveBeenCalled();
    });

    it('uses the measured estimate once a model finished, and says "Stopping…" / "Closing…" after a stop', () => {
        const items: TrainQueueItem[] = [{ id: 'i1', kind: 'individual', state: 'running' }];
        const run = makeRun(items, { currentId: 'i1', stopRequested: 'cancel' });
        const { rerender } = withMeta(<RunStrip run={run} summary={summarizeTrainRun(run)} timeLeftMs={65_000} rows={ROW_MAP} {...handlers()} />);
        expect(screen.getByTestId('train-run-eta').textContent).toBe('≈ 1 min 5 s left');
        expect(screen.getByTestId('train-run-text').textContent).toBe('Stopping after this model…');
        expect((screen.getByTestId('train-run-cancel') as HTMLButtonElement).disabled).toBe(true);
        const closing = makeRun(items, { currentId: 'i1', stopRequested: 'close' });
        rerender(<SensorMetaContext.Provider value={LOOKUP}><RunStrip run={closing} summary={summarizeTrainRun(closing)} timeLeftMs={null} rows={ROW_MAP} {...handlers()} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('train-run-text').textContent).toBe('Closing after this model…');
    });

    it('finished: green when all trained, amber for a partial failure, red only when nothing trained', () => {
        const done = (states: TrainQueueItem['state'][]) => makeRun(states.map((st, i) => ({ id: `m${i}`, kind: 'individual' as const, state: st, ...(st === 'failed' ? { error: 'boom' } : {}) })), { phase: 'done' });
        const ok = done(['trained', 'trained']);
        const { rerender } = withMeta(<RunStrip run={ok} summary={summarizeTrainRun(ok)} timeLeftMs={null} rows={ROW_MAP} {...handlers()} />);
        expect(screen.getByTestId('train-run-strip').getAttribute('data-tone')).toBe('success');
        expect(screen.getByTestId('train-run-text').textContent).toBe('Done · 2 trained');
        expect(screen.getByTestId('train-run-strip').textContent).toContain('Trained models still need their health set points, then Mark complete.');
        const partial = done(['trained', 'failed']);
        rerender(<SensorMetaContext.Provider value={LOOKUP}><RunStrip run={partial} summary={summarizeTrainRun(partial)} timeLeftMs={null} rows={ROW_MAP} {...handlers()} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('train-run-strip').getAttribute('data-tone')).toBe('warning');
        expect(screen.getByTestId('train-run-text').textContent).toBe('Done · 1 trained · 1 failed');
        const failed = done(['failed']);
        rerender(<SensorMetaContext.Provider value={LOOKUP}><RunStrip run={failed} summary={summarizeTrainRun(failed)} timeLeftMs={null} rows={ROW_MAP} {...handlers()} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('train-run-strip').getAttribute('data-tone')).toBe('danger');
    });

    it('stopped: offers "Train the k not started"; Dismiss hides it', () => {
        const run = makeRun([
            { id: 'i1', kind: 'individual', state: 'trained' },
            { id: 'i2', kind: 'individual', state: 'notStarted' },
        ], { phase: 'stopped' });
        const h = handlers();
        withMeta(<RunStrip run={run} summary={summarizeTrainRun(run)} timeLeftMs={null} rows={ROW_MAP} {...h} />);
        expect(screen.getByTestId('train-run-text').textContent).toBe('Stopped · 1 trained · 1 not started');
        fireEvent.click(screen.getByTestId('train-run-not-started'));
        expect(h.onTrainNotStarted).toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('train-run-dismiss'));
        expect(h.onDismiss).toHaveBeenCalled();
    });

    it('STALE: red, the shipped wording, no "not started" re-run, a Close window button', () => {
        const run = makeRun([
            { id: 'i1', kind: 'individual', state: 'trained' },
            { id: 'i2', kind: 'individual', state: 'notStarted' },
        ], { phase: 'stale', staleError: 'x' });
        const h = handlers();
        withMeta(<RunStrip run={run} summary={summarizeTrainRun(run)} timeLeftMs={null} rows={ROW_MAP} {...h} />);
        const strip = screen.getByTestId('train-run-strip');
        expect(strip.getAttribute('data-tone')).toBe('danger');
        expect(strip.getAttribute('role')).toBe('alert');
        expect(screen.getByTestId('train-run-text').textContent).toBe('Run stopped: the data changed');
        expect(screen.getByTestId('train-run-stale').textContent).toContain(TRAIN_STALE_MESSAGE);
        expect(screen.getByTestId('train-run-stale').textContent).toContain('The 1 trained before the change is kept; 1 not started.');
        expect(screen.queryByTestId('train-run-not-started')).toBeNull();
        fireEvent.click(screen.getByTestId('train-run-close-window'));
        expect(h.onCloseWindow).toHaveBeenCalled();
    });
});

describe('TrainAllModal', () => {
    const base = () => ({
        rows: ROWS, groups: GROUPS, includeUpToDate: false,
        onIncludeUpToDate: vi.fn(), onClose: vi.fn(), onStart: vi.fn(), onCancelRun: vi.fn(), onFix: vi.fn(),
        onOpenModel: vi.fn(), onRetry: vi.fn(), onTrainNotStarted: vi.fn(), onRemoveFromRun: vi.fn(),
    });

    it('preflight: grouped by failure group (each model once), Ready / Can\'t train — reason + Fix → / grey Skipped — up to date', () => {
        const p = base();
        withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...p} />);
        const modal = screen.getByTestId('train-all-modal');
        expect(modal.getAttribute('data-view')).toBe('preflight');
        expect(within(screen.getByTestId('train-group-1')).getByTestId('train-row-status-i1').textContent).toBe('Ready');
        expect(screen.getByTestId('train-row-status-r1').textContent).toBe("Can't train — no predictor sensor");
        expect(screen.getByTestId('train-row-status-r1').className).toContain('tq-st--cant');
        // r1 is in FG-1 and FG-2: listed once, under FG-1.
        expect(screen.getAllByTestId('train-row-r1')).toHaveLength(1);
        expect(within(screen.getByTestId('train-group-2')).queryByTestId('train-row-r1')).toBeNull();
        expect(screen.getByTestId('train-row-status-i2').textContent).toBe('Skipped — Complete, up to date');
        expect(screen.getByTestId('train-row-status-i2').className).toContain('tq-st--up');
        expect(within(screen.getByTestId('train-group-0')).getByText('Not in Group')).toBeTruthy();
        expect(screen.getByTestId('train-all-summary').textContent).toContain('1 will train');
        expect(screen.getByTestId('train-all-start').textContent).toBe('▶ Start · 1');
        expect(screen.getByTestId('train-all-foot').textContent).toBe('Trains 1 model; the 1 with missing settings stay as they are.');
        fireEvent.click(screen.getByTestId('train-fix-r1'));
        expect(p.onFix).toHaveBeenCalledWith('r1', 'settings');
        fireEvent.click(screen.getByTestId('train-all-start'));
        expect(p.onStart).toHaveBeenCalled();
    });

    it('preflight: the up-to-date checkbox adds them and warns in amber how many Complete models become Incomplete', () => {
        const p = { ...base(), includeUpToDate: true };
        withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...p} />);
        expect(screen.getByTestId('train-all-start').textContent).toBe('▶ Start · 3');
        expect(screen.getByTestId('train-row-status-i2').textContent).toBe('Re-train');
        expect(screen.getByTestId('train-complete-warning').textContent).toBe(' 1 Complete model will become Incomplete and need Mark complete again.');
        fireEvent.click(screen.getByTestId('train-include-up-to-date'));
        expect(p.onIncludeUpToDate).toHaveBeenCalledWith(false);
    });

    it('preflight with nothing ready: Start disabled, amber footer reason', () => {
        const rows = ROWS.filter(r => r.plan.kind !== 'ready');
        withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...base()} rows={rows} />);
        expect((screen.getByTestId('train-all-start') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('train-all-foot').className).toContain('tq-reason--warn');
    });

    it('running: queued rows offer "Remove from run"; Hide closes; Cancel run stops after the current model', () => {
        const p = base();
        const run = makeRun([
            { id: 'i1', kind: 'individual', state: 'running' },
            { id: 'r1', kind: 'relationship', state: 'skipped', skip: { kind: 'missing', reason: 'no predictor sensor' } },
            { id: 'i2', kind: 'individual', state: 'queued' },
        ], { currentId: 'i1' });
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} {...p} />);
        expect(screen.getByTestId('train-all-modal').getAttribute('data-view')).toBe('running');
        expect(screen.getByTestId('train-row-status-i1').textContent).toBe('Training…');
        expect(screen.getByTestId('train-row-status-r1').textContent).toBe('Skipped — no predictor sensor');
        expect(screen.queryByTestId('train-row-c3')).toBeNull(); // not in this run
        fireEvent.click(screen.getByTestId('train-remove-i2'));
        expect(p.onRemoveFromRun).toHaveBeenCalledWith('i2');
        fireEvent.click(screen.getByTestId('train-all-cancel-run'));
        expect(p.onCancelRun).toHaveBeenCalled();
        expect(screen.getByTestId('train-all-close').textContent).toBe('Hide');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(p.onClose).toHaveBeenCalled();
    });

    it('done: Trained rows open the model, failed rows offer Try again (with the error), not-started can be trained', () => {
        const p = base();
        const run = makeRun([
            { id: 'i1', kind: 'individual', state: 'trained' },
            { id: 'i2', kind: 'individual', state: 'failed', error: 'sidecar exploded' },
            { id: 'c3', kind: 'clustering', state: 'notStarted' },
        ], { phase: 'stopped' });
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} {...p} />);
        expect(screen.getByTestId('train-all-modal').getAttribute('data-view')).toBe('done');
        expect(screen.getByTestId('train-row-status-i1').textContent).toBe('✓ Trained · set points needed');
        expect(screen.getByTestId('train-row-i2').textContent).toContain('sidecar exploded');
        fireEvent.click(screen.getByTestId('train-open-i1'));
        expect(p.onOpenModel).toHaveBeenCalledWith('i1');
        fireEvent.click(screen.getByTestId('train-retry-i2'));
        expect(p.onRetry).toHaveBeenCalledWith('i2');
        fireEvent.click(screen.getByTestId('train-all-not-started'));
        expect(p.onTrainNotStarted).toHaveBeenCalled();
    });

    it('done after STALE: the shipped wording in red, no Try again / not-started', () => {
        const run = makeRun([
            { id: 'i1', kind: 'individual', state: 'trained' },
            { id: 'i2', kind: 'individual', state: 'notStarted' },
        ], { phase: 'stale' });
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} {...base()} />);
        expect(screen.getByTestId('train-all-modal').textContent).toContain('Run stopped: the data changed');
        expect(screen.getByTestId('train-all-modal').textContent).toContain(TRAIN_STALE_MESSAGE);
        expect(screen.queryByTestId('train-all-not-started')).toBeNull();
        expect(screen.queryByTestId('train-open-i1')).toBeNull();
    });
});

describe('CloseRunDialog', () => {
    it('running: alertdialog with live numbers, "Keep training" is focused by default; Esc keeps training', () => {
        const run = makeRun([
            { id: 'i1', kind: 'individual', state: 'trained' },
            { id: 'r1', kind: 'relationship', state: 'running' },
            { id: 'i2', kind: 'individual', state: 'queued' },
        ], { currentId: 'r1' });
        const onKeep = vi.fn(), onStop = vi.fn();
        withMeta(<CloseRunDialog run={run} summary={summarizeTrainRun(run)} current={ROW_MAP.get('r1')} onKeep={onKeep} onStopAndClose={onStop} onClose={() => {}} />);
        const dlg = screen.getByRole('alertdialog');
        expect(dlg.textContent).toContain('Training is still running');
        expect(screen.getByTestId('close-run-numbers').textContent).toContain('Training 2 of 3');
        expect(screen.getByTestId('close-run-numbers').textContent).toContain('up to about 15 s on this model');
        expect(dlg.textContent).toContain('the 1 not started stay as they are');
        expect(document.activeElement).toBe(screen.getByTestId('close-run-keep'));
        fireEvent.click(screen.getByTestId('close-run-stop'));
        expect(onStop).toHaveBeenCalled();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onKeep).toHaveBeenCalled();
    });

    it('finished while open: becomes "Run finished — close?" with one Close', () => {
        const run = makeRun([{ id: 'i1', kind: 'individual', state: 'trained' }], { phase: 'done' });
        const onClose = vi.fn();
        withMeta(<CloseRunDialog run={run} summary={summarizeTrainRun(run)} onKeep={() => {}} onStopAndClose={() => {}} onClose={onClose} />);
        expect(screen.getByRole('alertdialog').textContent).toContain('Run finished — close?');
        expect(screen.queryByTestId('close-run-keep')).toBeNull();
        expect(screen.getByTestId('close-run-numbers').textContent).toBe('1 trained. Trained models keep their results.');
        fireEvent.click(screen.getByTestId('close-run-close'));
        expect(onClose).toHaveBeenCalled();
    });
});

describe('locked settings, queued card, Health score banner', () => {
    it('LockedSettingsHeader: the lock sentence, "Remove from run" only while queued', () => {
        const onRemove = vi.fn();
        const { rerender } = withMeta(<LockedSettingsHeader summary="Model One · 1σ + 3σ" queued onRemove={onRemove} />);
        expect(screen.getByTestId('settings-locked').textContent).toContain('Locked while this model is in the run');
        fireEvent.click(screen.getByTestId('remove-from-run'));
        expect(onRemove).toHaveBeenCalled();
        rerender(<SensorMetaContext.Provider value={LOOKUP}><LockedSettingsHeader summary="x" queued={false} onRemove={onRemove} /></SensorMetaContext.Provider>);
        expect(screen.queryByTestId('remove-from-run')).toBeNull();
    });

    it('QueuedCard: position and the rough wait', () => {
        const { rerender } = withMeta(<QueuedCard kind="relationship" position={1} waitSeconds={15} current={ROW_MAP.get('i1')} />);
        expect(screen.getByTestId('queued-card').textContent).toContain('Queued · next');
        expect(screen.getByTestId('queued-card').textContent).toContain('≈ 15 s until it starts');
        expect(screen.getByTestId('queued-card').textContent).toContain('Training now: Pump Pressure');
        rerender(<SensorMetaContext.Provider value={LOOKUP}><QueuedCard kind="individual" position={3} waitSeconds={31} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('queued-card').textContent).toContain('Queued · #3 in line');
    });

    // workbench-redesign SPEC §4: ONE line.
    it('RunSetPointsBanner is one line: "Trained in the run 14:05 · 3 need set points · this is 2 of 3" + the Next link', () => {
        const onNext = vi.fn();
        const { rerender } = withMeta(<RunSetPointsBanner at={new Date(2026, 9, 9, 14, 5).getTime()} inRun={3} position={2} nextDisabled={false} onNext={onNext} />);
        const banner = screen.getByTestId('run-setpoints-banner');
        expect(banner.textContent).toBe('✓Trained in the run 14:05 · 3 need set points · this is 2 of 3Next needing set points ›');
        expect(screen.getByTestId('run-setpoints-line').textContent).toBe('Trained in the run 14:05 · 3 need set points · this is 2 of 3');
        expect(screen.getByTestId('run-setpoints-text').textContent).toBe('3 need set points');
        expect(banner.querySelector('.wbx-dt')!.textContent).toBe('14:05');
        // the old sentences are gone
        expect(banner.textContent).not.toMatch(/in total|Set them here|trained in this run| at 14:05/);
        // a text link, not a second button-shaped control
        const next = screen.getByTestId('next-needing-set-points');
        expect(next.className).toContain('tq-inline-link');
        expect(next.className).not.toContain('rcx-btn');
        fireEvent.click(next);
        expect(onNext).toHaveBeenCalled();
        // one model; the open model is not one of them -> no "this is …"; nothing next -> disabled
        rerender(<SensorMetaContext.Provider value={LOOKUP}><RunSetPointsBanner at={new Date(2026, 9, 9, 9, 3).getTime()} inRun={1} position={0} nextDisabled onNext={onNext} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('run-setpoints-line').textContent).toBe('Trained in the run 09:03 · 1 needs set points');
        expect((screen.getByTestId('next-needing-set-points') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('ModelFitPage memo comparator (charts do not re-render on queue progress)', () => {
    const fn = () => {};
    const preview = { retry: fn, retryTestScoring: fn } as unknown as ModelFitPageProps['preview'];
    const props = (over: Partial<ModelFitPageProps> = {}): ModelFitPageProps => ({
        data: {} as ModelFitPageProps['data'], model: {} as ModelFitPageProps['model'], stale: false, preview, unit: 'bar',
        testNumbers: [1, 2], onXPredictorChange: fn, onCompare: fn, ...over,
    });

    it('equal for a fresh-but-equal testNumbers array, a new preview object with the same callbacks, and the same model re-read from disk', () => {
        const a = props({ model: { id: 'm1', kind: 'individual' } as unknown as ModelFitPageProps['model'] });
        expect(sameModelFitProps(a, { ...a, testNumbers: [1, 2], preview: { ...preview }, model: { id: 'm1', kind: 'individual' } as unknown as ModelFitPageProps['model'] })).toBe(true);
        expect(sameModelFitProps(a, { ...a, model: { id: 'm1', kind: 'relationship' } as unknown as ModelFitPageProps['model'] })).toBe(false);
    });

    it('not equal when anything drawn changes', () => {
        const a = props();
        expect(sameModelFitProps(a, { ...a, data: {} as ModelFitPageProps['data'] })).toBe(false);
        expect(sameModelFitProps(a, { ...a, stale: true })).toBe(false);
        expect(sameModelFitProps(a, { ...a, testNumbers: [1] })).toBe(false);
        expect(sameModelFitProps(a, { ...a, onCompare: () => {} })).toBe(false);
        // complete: a prop the comparator was never told about still counts
        expect(sameModelFitProps(a, { ...a, compareDisabledReason: 'Wait for the training run to finish' })).toBe(false);
    });
});

describe('shortTrainError (run details never show a raw traceback)', () => {
    const NL = String.fromCharCode(10);
    it('first non-empty line, the app wording for a known code, capped at 200 characters', () => {
        expect(shortTrainError(['Traceback (most recent call last):', '  File "backend.py", line 3', 'ValueError: x'].join(NL))).toBe('Traceback (most recent call last):');
        expect(shortTrainError(['', '  sidecar exploded  ', 'more'].join(NL))).toBe('sidecar exploded');
        expect(shortTrainError('SIDECAR_OUTDATED: raw')).toContain('reinstall or update the app');
        const long = shortTrainError('x'.repeat(500));
        expect(long).toHaveLength(200);
        expect(long.endsWith('…')).toBe(true);
    });

    it('the details row shows the short form, the full text in its title', () => {
        const full = ['boom', 'Traceback line'].join(NL);
        const run = makeRun([{ id: 'i1', kind: 'individual', state: 'failed', error: full }], { phase: 'done' });
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} rows={ROWS} groups={GROUPS} includeUpToDate={false}
            onIncludeUpToDate={() => {}} onClose={() => {}} onStart={() => {}} onCancelRun={() => {}} onFix={() => {}}
            onOpenModel={() => {}} onRetry={() => {}} onTrainNotStarted={() => {}} onRemoveFromRun={() => {}} />);
        const err = screen.getByTestId('train-row-i1').querySelector('.tq-err')!;
        expect(err.textContent).toBe('boom');
        expect(err.getAttribute('title')).toBe(full);
    });
});
