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
    trainMenuStateLine,
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
 * Train sensor / Train all with a queue —
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
    { id: 'r1', kind: 'relationship', tag: 'TAG1', groupNos: [1, 2], plan: { kind: 'missing', reason: 'Add at least 1 predictor (+1 more)', fix: 'settings' } },
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

// The ▾ menu's copy:
// "Re-train" is only said about a model that has been trained before; the all-row says it
// only when EVERY model of the sensor has. Every model row carries a small state line.
describe('sensorTrainMenuCopy', () => {
    const READY = { kind: 'ready' } as const;
    const UP = { kind: 'upToDate', reason: 'up to date', complete: false } as const;
    const DONE = { kind: 'upToDate', reason: 'Complete, up to date', complete: true } as const;
    const MISSING = { kind: 'missing', reason: 'Pick a Y sensor', fix: 'settings' } as const;
    const m = (kind: SensorTrainMenuModel['kind'], plan: SensorTrainMenuModel['plan'], trainedBefore: boolean, over: Partial<SensorTrainMenuModel> = {}): SensorTrainMenuModel => ({ kind, plan, trainedBefore, ...over });

    it('a never-trained sensor: "Train all N models" and "<Kind> only" — no "Re-train" anywhere; rows say "Not trained yet · ≈ …"', () => {
        const copy = sensorTrainMenuCopy([m('individual', READY, false), m('relationship', READY, false), m('clustering', MISSING, false)]);
        expect(copy.all!.label).toBe('Train all 3 models');
        // The kind reads as on its tab: "Relation model", never "Relationship".
        expect(copy.only.map(o => o.label)).toEqual(['Individual only', 'Relation model only', 'Clustering only']);
        // "≈ 15 s" only for the Relation model; a model that can't train says WHY (the missing setting).
        expect(copy.only.map(o => o.small)).toEqual(['Not trained yet · ≈ 1 s', 'Not trained yet · ≈ 15 s', 'Pick a Y sensor']);
        expect(JSON.stringify(copy)).not.toMatch(/re-train/i);
    });

    it('the all-row of a never-trained sensor does NOT say "Includes up-to-date ones": it gives the time, and how many are skipped', () => {
        const copy = sensorTrainMenuCopy([m('individual', READY, false), m('relationship', READY, false), m('clustering', MISSING, false)]);
        expect(copy.all!.small).toBe("≈ 16 s · 1 can't train, skipped");
        expect(sensorTrainMenuCopy([m('individual', READY, false), m('relationship', READY, false)]).all!.small).toBe('≈ 16 s');
        expect(JSON.stringify(copy)).not.toMatch(/up[- ]to[- ]date/i);
    });

    it('mixed: only the trained model says "Re-train … only"; the all-row stays "Train all N models" and counts the up-to-date one', () => {
        const copy = sensorTrainMenuCopy([m('individual', UP, true), m('relationship', READY, false)]);
        expect(copy.all!.label).toBe('Train all 2 models');
        expect(copy.all!.small).toBe('Includes the 1 up to date');
        expect(copy.only.map(o => o.label)).toEqual(['Re-train Individual only', 'Relation model only']);
        expect(copy.only[0].small).toBe('Up to date · trains anyway');
        expect(copy.only[1].small).toBe('Not trained yet · ≈ 15 s');
    });

    it('every model trained before: "Re-train all N models" and "Re-train <Kind> only" (a stale one included)', () => {
        const copy = sensorTrainMenuCopy([m('individual', DONE, true), m('relationship', READY, true), m('clustering', UP, true)]);
        expect(copy.all!.label).toBe('Re-train all 3 models');
        expect(copy.all!.small).toBe('Includes the 2 up to date · a Complete model becomes Incomplete and needs Mark complete again');
        expect(copy.only.map(o => o.label)).toEqual(['Re-train Individual only', 'Re-train Relation model only', 'Re-train Clustering only']);
        // A Complete model that is trained anyway becomes Incomplete: said on its own row too.
        expect(copy.only[0].small).toBe('Up to date · trains anyway · it becomes Incomplete');
        expect(copy.only[1].small).toBe('Settings changed since it was trained · ≈ 15 s');
        expect(copy.only[2].small).toBe('Up to date · trains anyway');
    });

    it('state lines of a model that needs training: failed last run, fit no longer in memory (which wins), settings changed', () => {
        const copy = sensorTrainMenuCopy([
            m('individual', READY, true, { failedLastRun: true }),
            m('relationship', READY, true, { fitGone: true, failedLastRun: true }),
            m('clustering', READY, false, { failedLastRun: true }),
        ]);
        expect(copy.only.map(o => o.small)).toEqual([
            'Failed last run · ≈ 1 s',
            'Fit no longer in memory · ≈ 15 s',
            'Failed last run · ≈ 2 s',
        ]);
        // the flags never override "up to date" or a can't-train reason
        expect(trainMenuStateLine(m('relationship', DONE, true, { fitGone: true }))).toBe('Up to date · trains anyway · it becomes Incomplete');
        expect(trainMenuStateLine(m('relationship', MISSING, true, { failedLastRun: true }))).toBe('Pick a Y sensor');
    });

    it('when no model of the sensor can train, the all-row says so', () => {
        const copy = sensorTrainMenuCopy([m('individual', MISSING, false), m('clustering', MISSING, true)]);
        expect(copy.all!.small).toBe('None of them can train yet');
        expect(copy.only[1]).toEqual({ label: 'Re-train Clustering only', small: 'Pick a Y sensor' });
    });

    // A sensor with ONE model never reads "Train all 1 model": there is no all-row, and its
    // own row is a whole sentence ("… only" would have nothing to be the only one of).
    it('one model: NO all-row; its row reads "Train the Individual model" / "Re-train the Relation model"', () => {
        const fresh = sensorTrainMenuCopy([m('individual', READY, false)]);
        expect(fresh.all).toBeNull();
        expect(fresh.only).toEqual([{ label: 'Train the Individual model', small: 'Not trained yet · ≈ 1 s' }]);
        const trained = sensorTrainMenuCopy([m('relationship', UP, true)]);
        expect(trained.all).toBeNull();
        expect(trained.only).toEqual([{ label: 'Re-train the Relation model', small: 'Up to date · trains anyway' }]);
        expect(sensorTrainMenuCopy([m('clustering', MISSING, true)]).only[0]).toEqual({ label: 'Re-train the Clustering model', small: 'Pick a Y sensor' });
        expect(JSON.stringify([fresh, trained])).not.toMatch(/all 1 model| only/);
    });

    it('a model marked Complete with NO train record (legacy) is never said to be "re-trained"', () => {
        const copy = sensorTrainMenuCopy([m('individual', DONE, false)]);
        expect(copy.all).toBeNull();
        expect(copy.only[0]).toEqual({ label: 'Train the Individual model', small: 'Up to date · trains anyway · it becomes Incomplete' });
        const two = sensorTrainMenuCopy([m('individual', DONE, false), m('relationship', READY, false)]);
        expect(two.all!.label).toBe('Train all 2 models');
        expect(two.only[0].label).toBe('Individual only');
    });
});

describe('SensorTrainButton', () => {
    const menu = (onA = vi.fn(), onB = vi.fn()) => [
        { key: 'retrain-all', label: 'Train all 2 models', small: 'Includes the 1 up to date', onClick: onA },
        { key: 'only-relationship', label: 'Relation model only', small: 'Add at least 1 predictor', disabled: true, onClick: onB },
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
        // Every row: its name, then its small state line.
        expect(screen.getByTestId('train-menu-only-relationship').querySelector('small')!.textContent).toBe('Add at least 1 predictor');
        expect(screen.getByTestId('train-menu-retrain-all').querySelector('small')!.textContent).toBe('Includes the 1 up to date');
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
        rerender(<SensorMetaContext.Provider value={LOOKUP}><SensorTrainButton filled={false} label="▶ Train sensor" disabled why="" whyTone="neutral" onTrain={() => {}} menu={menu()} /></SensorMetaContext.Provider>);
        expect(screen.getByTestId('train-sensor').className).not.toContain('rcx-btn--pri');
        expect(screen.getByTestId('train-sensor-menu-toggle').className).not.toContain('rcx-btn--pri');
        expect(screen.getByTestId('train-sensor').className).toContain('rcx-btn');
    });

    it('never prints "Step 1" — in the line under the button or in its tooltip', () => {
        withMeta(<SensorTrainButton filled={false} label="▶ Train sensor" disabled title={TRAIN_NEEDS_RUNNING_CONDITION} why={TRAIN_NEEDS_RUNNING_CONDITION} whyTone="warn" onTrain={() => {}} menu={menu()} />);
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

// CLAUDE.md naming rule: the tabs and the Train menu said
// "Relation model" while the run strip, the Train-all rows and the close dialog still
// said "Relationship".
describe('a Relation model is named "Relation model" everywhere in the run UI', () => {
    const REL: TrainRowModel = { id: 'r9', kind: 'relationship', tag: 'TAG2', groupNos: [2], plan: { kind: 'ready' } };
    const rows = new Map([...ROW_MAP, [REL.id, REL]]);
    const run = makeRun([
        { id: 'i1', kind: 'individual', state: 'trained', durationMs: 1000 },
        { id: 'r9', kind: 'relationship', state: 'running' },
    ], { currentId: 'r9' });

    it('the run strip (current model + segment tooltip)', () => {
        withMeta(<RunStrip run={run} summary={summarizeTrainRun(run)} timeLeftMs={null} rows={rows} onDetails={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} onCloseWindow={vi.fn()} onTrainNotStarted={vi.fn()} />);
        const strip = screen.getByTestId('train-run-strip');
        expect(strip.querySelector('.tq-who')!.textContent).toMatch(/ · Relation model$/);
        const segs = screen.getByTestId('train-run-segments').querySelectorAll('i');
        expect(segs[1].getAttribute('title')).toBe('2. Pump Temp · TAG2 · Relation model — training now');
        expect(strip.innerHTML).not.toMatch(/Relationship/);
    });

    it('the Train-all pre-flight row sub-line and the run details', () => {
        const props = {
            rows: [...ROWS, REL], groups: GROUPS, includeUpToDate: false,
            onIncludeUpToDate: vi.fn(), onClose: vi.fn(), onStart: vi.fn(), onCancelRun: vi.fn(), onFix: vi.fn(),
            onOpenModel: vi.fn(), onRetry: vi.fn(), onTrainNotStarted: vi.fn(), onRemoveFromRun: vi.fn(),
        };
        const view = withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...props} />);
        const subs = [...screen.getByTestId('train-all-modal').querySelectorAll('.tq-sub')].map(e => e.textContent);
        expect(subs).toContain('Relation model · ≈ 15 s');
        expect(screen.getByTestId('train-all-modal').innerHTML).not.toMatch(/Relationship/);
        view.unmount();
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} {...props} />);
        expect(screen.getByTestId('train-all-modal').textContent).toContain('Relation model');
        expect(screen.getByTestId('train-all-modal').innerHTML).not.toMatch(/Relationship/);
    });

    it('the close-during-run dialog', () => {
        withMeta(<CloseRunDialog run={run} summary={summarizeTrainRun(run)} current={REL} onKeep={vi.fn()} onStopAndClose={vi.fn()} onClose={vi.fn()} />);
        const dlg = screen.getByRole('alertdialog');
        expect(dlg.textContent).toContain(' · Relation model');
        expect(dlg.innerHTML).not.toMatch(/Relationship/);
    });
});

describe('TrainAllModal', () => {
    const base = () => ({
        rows: ROWS, groups: GROUPS, includeUpToDate: false,
        onIncludeUpToDate: vi.fn(), onClose: vi.fn(), onStart: vi.fn(), onCancelRun: vi.fn(), onFix: vi.fn(),
        onOpenModel: vi.fn(), onRetry: vi.fn(), onTrainNotStarted: vi.fn(), onRemoveFromRun: vi.fn(),
    });

    // SPEC workbench-redesign §6: rows say "Ready", amber "Skipped" + Fix → with the long
    // reason on a second line under the row, or grey "Skipped — up to date".
    it('preflight: grouped by failure group (each model once), Ready / amber Skipped + reason line + Fix → / grey Skipped — up to date', () => {
        const p = base();
        withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...p} />);
        const modal = screen.getByTestId('train-all-modal');
        expect(modal.getAttribute('data-view')).toBe('preflight');
        expect(within(screen.getByTestId('train-group-1')).getByTestId('train-row-status-i1').textContent).toBe('Ready');
        expect(screen.getByTestId('train-row-status-r1').textContent).toBe('Skipped');
        expect(screen.getByTestId('train-row-status-r1').className).toContain('tq-st--cant');
        // the long reason: its own line under the row, naming the missing setting
        const note = screen.getByTestId('train-row-note-r1');
        expect(note.textContent).toBe('Add at least 1 predictor (+1 more)');
        expect(note.className).toContain('tq-note');
        expect(screen.getByTestId('train-row-r1').contains(note)).toBe(true);
        expect(screen.getByTestId('train-all-modal').textContent).not.toMatch(/Can't train —|Fill in the required fields/);
        // a row that will train, and a grey skipped one, have no second line
        expect(screen.queryByTestId('train-row-note-i1')).toBeNull();
        expect(screen.queryByTestId('train-row-note-i2')).toBeNull();
        // r1 is in FG-1 and FG-2: listed once, under FG-1.
        expect(screen.getAllByTestId('train-row-r1')).toHaveLength(1);
        expect(within(screen.getByTestId('train-group-2')).queryByTestId('train-row-r1')).toBeNull();
        expect(screen.getByTestId('train-row-status-i2').textContent).toBe('Skipped — Complete, up to date');
        expect(screen.getByTestId('train-row-status-i2').className).toContain('tq-st--up');
        expect(within(screen.getByTestId('train-group-0')).getByText('Not in Group')).toBeTruthy();
        expect(screen.getByTestId('train-all-summary').textContent).toContain('1 will train');
        expect(screen.getByTestId('train-all-start').textContent).toBe('▶ Start · 1');
        expect(screen.getByTestId('train-all-foot').textContent).toBe("Trains 1 model; the 1 that can't train stays as it is");
        // the counts that are there are said …
        expect(screen.getByTestId('train-all-sum-up').textContent).toBe('· 2 up to date, skipped');
        expect(screen.getByTestId('train-all-sum-cant').textContent).toBe("· 1 can't train — fix, then run again");
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

    it('preflight: zero counts are hidden, and the footer follows the numbers ("Trains 3 models; the 2 that can\'t train stay as they are")', () => {
        const ready = (id: string, kind: TrainRowModel['kind']): TrainRowModel => ({ id, kind, tag: 'TAG1', groupNos: [1], plan: { kind: 'ready' } });
        const cant = (id: string): TrainRowModel => ({ id, kind: 'relationship', tag: 'TAG2', groupNos: [2], plan: { kind: 'missing', reason: 'No running condition', fix: 'runningCondition' } });
        // only ready models: neither "0 up to date" nor "0 can't train" is printed
        const { unmount } = withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...base()} rows={[ready('a', 'individual'), ready('b', 'relationship')]} />);
        expect(screen.getByTestId('train-all-summary').textContent).toBe('2 will train· ≈ 16 s');
        expect(screen.queryByTestId('train-all-sum-up')).toBeNull();
        expect(screen.queryByTestId('train-all-sum-cant')).toBeNull();
        expect(screen.getByTestId('train-all-foot').textContent).toBe('Trains 2 models');
        unmount();
        withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...base()} rows={[ready('a', 'individual'), ready('b', 'individual'), ready('c', 'clustering'), cant('x'), cant('y')]} />);
        expect(screen.getByTestId('train-all-foot').textContent).toBe("Trains 3 models; the 2 that can't train stay as they are");
        expect(screen.queryByTestId('train-all-sum-up')).toBeNull();
        expect(screen.getByTestId('train-all-sum-cant').textContent).toBe("· 2 can't train — fix, then run again");
        expect(screen.getByTestId('train-row-note-x').textContent).toBe('No running condition');
    });

    it('preflight: with "also re-train the up-to-date ones" ticked, the "up to date, skipped" count goes (it would be 0)', () => {
        withMeta(<TrainAllModal view="preflight" run={null} summary={null} {...base()} includeUpToDate />);
        expect(screen.queryByTestId('train-all-sum-up')).toBeNull();
        expect(screen.getByTestId('train-all-summary').textContent).not.toMatch(/\b0\b/);
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
            { id: 'r1', kind: 'relationship', state: 'skipped', skip: { kind: 'missing', reason: 'Add at least 1 predictor' } },
            { id: 'i2', kind: 'individual', state: 'queued' },
        ], { currentId: 'i1' });
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} {...p} />);
        expect(screen.getByTestId('train-all-modal').getAttribute('data-view')).toBe('running');
        expect(screen.getByTestId('train-row-status-i1').textContent).toBe('Training…');
        // skipped because it can't train: amber "Skipped", the reason on its own line
        expect(screen.getByTestId('train-row-status-r1').textContent).toBe('Skipped');
        expect(screen.getByTestId('train-row-status-r1').className).toContain('tq-st--cant');
        expect(screen.getByTestId('train-row-note-r1').textContent).toBe('Add at least 1 predictor');
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
            { id: 'i2', kind: 'individual', state: 'failed', error: 'stats exploded' },
            { id: 'c3', kind: 'clustering', state: 'notStarted' },
        ], { phase: 'stopped' });
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} {...p} />);
        expect(screen.getByTestId('train-all-modal').getAttribute('data-view')).toBe('done');
        expect(screen.getByTestId('train-row-status-i1').textContent).toBe('✓ Trained · set points needed');
        expect(screen.getByTestId('train-row-i2').textContent).toContain('stats exploded');
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

    // SPEC workbench-redesign §6: focus "Keep training" on open; Esc = Keep training; trap Tab.
    it('traps Tab inside the dialog (both ways), and gives the focus back to where it was on close', () => {
        const run = makeRun([
            { id: 'r1', kind: 'relationship', state: 'running' },
            { id: 'i2', kind: 'individual', state: 'queued' },
        ], { currentId: 'r1' });
        const outside = document.createElement('button');
        outside.textContent = 'outside';
        document.body.appendChild(outside);
        outside.focus();
        const onKeep = vi.fn(), onStop = vi.fn(), onClose = vi.fn();
        const { unmount } = withMeta(<CloseRunDialog run={run} summary={summarizeTrainRun(run)} current={ROW_MAP.get('r1')} onKeep={onKeep} onStopAndClose={onStop} onClose={onClose} />);
        const keep = screen.getByTestId('close-run-keep');
        const stop = screen.getByTestId('close-run-stop');
        // opens on the safe choice, not on the first button of the dialog
        expect(document.activeElement).toBe(keep);
        // Tab on the last button wraps to the first; Shift+Tab on the first wraps to the last
        const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey });
        tab();
        expect(document.activeElement).toBe(stop);
        tab(true);
        expect(document.activeElement).toBe(keep);
        // the focus never escapes to the page behind: from outside, Tab comes back in
        outside.focus();
        tab();
        expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true);
        // Esc keeps training — it never stops the run or closes the window
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onKeep).toHaveBeenCalledTimes(1);
        expect(onStop).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        unmount();
        expect(document.activeElement).toBe(outside);
        outside.remove();
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

describe('shortTrainError (run details show ONE line, never a raw multi-line dump)', () => {
    const NL = String.fromCharCode(10);
    it('first non-empty line, the app wording for a known code, capped at 200 characters', () => {
        // What Rust sends for a failed Relation model fit (the engine's own text goes to the error log, never here).
        const ENGINE = 'The Relation model engine could not fit this model. The details are in the error log.';
        expect(shortTrainError(ENGINE)).toBe(ENGINE);
        expect(shortTrainError([ENGINE, '  second line', 'third line'].join(NL))).toBe(ENGINE);
        expect(shortTrainError(['', '  stats exploded  ', 'more'].join(NL))).toBe('stats exploded');
        expect(shortTrainError('SIDECAR_OUTDATED: raw')).toContain('reinstall or update the app');
        const long = shortTrainError('x'.repeat(500));
        expect(long).toHaveLength(200);
        expect(long.endsWith('…')).toBe(true);
    });

    it('the details row shows the short form, the full text in its title', () => {
        const full = ['boom', 'second line'].join(NL);
        const run = makeRun([{ id: 'i1', kind: 'individual', state: 'failed', error: full }], { phase: 'done' });
        withMeta(<TrainAllModal view="run" run={run} summary={summarizeTrainRun(run)} rows={ROWS} groups={GROUPS} includeUpToDate={false}
            onIncludeUpToDate={() => {}} onClose={() => {}} onStart={() => {}} onCancelRun={() => {}} onFix={() => {}}
            onOpenModel={() => {}} onRetry={() => {}} onTrainNotStarted={() => {}} onRemoveFromRun={() => {}} />);
        const err = screen.getByTestId('train-row-i1').querySelector('.tq-err')!;
        expect(err.textContent).toBe('boom');
        expect(err.getAttribute('title')).toBe(full);
    });
});
