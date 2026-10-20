import { describe, it, expect } from 'vitest';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import {
    COMPLETE_UP_TO_DATE_REASON,
    DUPLICATE_NAME_BLOCK_REASON,
    REQUIRED_FIELDS_BLOCK_REASON,
    TRAIN_NEEDS_RUNNING_CONDITION,
    TRAIN_NOTHING_READY,
    TRAIN_STALE_MESSAGE,
    UP_TO_DATE_REASON,
    classifyTrainPlan,
    countTrainPlans,
    estimateTimeLeftMs,
    formatTrainSeconds,
    isStaleTrainError,
    missingSettingsText,
    planTrainRun,
    preflightReason,
    queuePosition,
    roughTrainSeconds,
    summarizeTrainRun,
    trainButtonsBlockedReason,
} from '../utils/trainQueue';
import {
    CATEGORY_BLOCK_REASON,
    NO_RUNNING_CONDITION_REASON,
    NO_TRAIN_PERIOD_REASON,
    NO_TRAIN_PERIOD_REASON_CUSTOM,
} from '../utils/runningCondition';
import { testPeriodsError, validatePeriods } from '../utils/timePeriods';
import type { TrainCandidate, TrainQueueItem, TrainRun } from '../types/trainQueue';

const run = (items: TrainQueueItem[], over: Partial<TrainRun> = {}): TrainRun => ({
    runId: 1, source: 'all', phase: 'running', items, currentId: null, stopRequested: null, startedAt: 0, ...over,
});
const it_ = (id: string, state: TrainQueueItem['state'], over: Partial<TrainQueueItem> = {}): TrainQueueItem => ({
    id, kind: 'individual', state, ...over,
});

describe('preflightReason', () => {
    // SPEC workbench-redesign §6: a can't-train reason NAMES the missing setting and
    // stands on a line of its own (under "Skipped", or as a menu row's state line).
    it('replaces the generic "required fields above" text with the NAME of the missing setting, then "(+N more)"', () => {
        expect(preflightReason(REQUIRED_FIELDS_BLOCK_REASON, { missing: ['Add at least 1 predictor'] }))
            .toEqual({ text: 'Add at least 1 predictor', fix: 'settings' });
        expect(preflightReason(REQUIRED_FIELDS_BLOCK_REASON, { missing: ['Model name is required', 'Add at least 1 predictor'] }).text)
            .toBe('Model name is required (+1 more)');
        expect(preflightReason(REQUIRED_FIELDS_BLOCK_REASON, { missing: ['Model name is required', 'Pick a Y sensor', 'Fill in the cluster ranges'] }).text)
            .toBe('Model name is required (+2 more)');
    });

    it('never says "above" and falls back to a neutral sentence when nothing specific is known', () => {
        const r = preflightReason(REQUIRED_FIELDS_BLOCK_REASON, { missing: [] });
        expect(r.text).toBe('Model settings are incomplete');
        expect(r.text).not.toMatch(/above/);
        expect(r.text).not.toBe(REQUIRED_FIELDS_BLOCK_REASON);
    });

    it('the category is its own reason: it is not counted among the missing settings', () => {
        expect(missingSettingsText(['Pick a category', 'Add at least 1 predictor'])).toBe('Add at least 1 predictor');
        expect(missingSettingsText(['Pick a category'])).toBe('Model settings are incomplete');
        expect(missingSettingsText([])).toBe('Model settings are incomplete');
    });

    it('turns an unknown missing item (a Custom scoring period error) into a sentence without its full stop', () => {
        expect(preflightReason(REQUIRED_FIELDS_BLOCK_REASON, { missing: ['S1 needs a start date.'] }).text)
            .toBe('Scoring period S1 needs a start date');
        // the real text `validateTestPeriods` produces, end to end
        const reason = testPeriodsError([{ id: 't', start: '2026-02-01T00:00', end: '2026-01-01T00:00' }])!;
        expect(preflightReason(REQUIRED_FIELDS_BLOCK_REASON, { missing: [reason] }).text).toBe('Scoring period S1 ends before it starts');
        expect(preflightReason(REQUIRED_FIELDS_BLOCK_REASON, { missing: [reason] }).text).not.toMatch(/test period/i);
    });

    it('category → its own reason and the sensor header as the fix target', () => {
        expect(preflightReason(CATEGORY_BLOCK_REASON)).toEqual({ text: 'No category (Performance or Condition) on the sensor', fix: 'category' });
    });

    it('duplicate model name', () => {
        expect(preflightReason(DUPLICATE_NAME_BLOCK_REASON).text).toBe('Model name already used by another model of this sensor');
    });

    it('running condition / train period: workspace → Running condition, Custom → its own settings', () => {
        expect(preflightReason(NO_RUNNING_CONDITION_REASON)).toEqual({ text: 'No running condition', fix: 'runningCondition' });
        expect(preflightReason(NO_RUNNING_CONDITION_REASON, { customMode: true }))
            .toEqual({ text: 'No running condition in its own training data', fix: 'settings' });
        expect(preflightReason(NO_TRAIN_PERIOD_REASON)).toEqual({ text: 'No train period', fix: 'runningCondition' });
        expect(preflightReason(NO_TRAIN_PERIOD_REASON_CUSTOM)).toEqual({ text: 'No train period in its own training data', fix: 'settings' });
    });

    it('an invalid train period keeps its specifics', () => {
        expect(preflightReason('P2 ends before it starts.')).toEqual({ text: 'Train period P2 ends before it starts', fix: 'runningCondition' });
        expect(preflightReason('P1 has an invalid start date.', { customMode: true }).fix).toBe('settings');
        // the real text `validatePeriods` produces, end to end (never "Period 2")
        const real = validatePeriods([{ id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }, { id: 'b', start: '2026-03-01T00:00', end: '2026-02-01T00:00' }])[1].reason!;
        expect(preflightReason(real)).toEqual({ text: 'Train period P2 ends before it starts', fix: 'runningCondition' });
    });

    it('anything else: no trailing full stop, a capital first letter (it stands on its own line)', () => {
        expect(preflightReason('Something odd happened.')).toEqual({ text: 'Something odd happened', fix: 'settings' });
        expect(preflightReason('its files are being saved').text).toBe('Its files are being saved');
    });
});

describe('the reason texts mapped above still exist in the Build Model window', () => {
    // The mapping matches on exact text; if a wording changes there, update the map here.
    const src: string = readFileSync('src/components/windows/BuildModelWindow.tsx', 'utf8');
    // The generic "required fields" text is no longer a second literal there: the window
    // uses THIS module's constant (and names the missing setting away from the form).
    it('the window uses the shared REQUIRED_FIELDS_BLOCK_REASON, not its own copy of the text', () => {
        expect(src).toContain('return REQUIRED_FIELDS_BLOCK_REASON;');
        expect(src).not.toContain(REQUIRED_FIELDS_BLOCK_REASON);
        expect(src).toContain('missingSettingsText(missingItems(m))');
    });
    // 2026-10-20: model names are unique across the PROJECT; the window uses the shared
    // `WORKSPACE_DUPLICATE_NAME_REASON` (utils/modelNames.ts), not a copy of its text.
    it('the window blocks a duplicate name with the shared WORKSPACE_DUPLICATE_NAME_REASON', () => {
        expect(src).toContain('WORKSPACE_DUPLICATE_NAME_REASON');
        expect(src).not.toContain(`'${DUPLICATE_NAME_BLOCK_REASON}'`);
    });
    it.each([
        'Pick a category',
        'Model name is required',
        'Add at least 1 predictor',
        'Pick a Y sensor',
        'Fill in the cluster ranges',
        'Fix the duplicate model name',
        TRAIN_STALE_MESSAGE,
    ])('%s', text => {
        expect(src).toContain(`'${text}'`);
    });
});

describe('classifyTrainPlan', () => {
    it('a block reason wins: missing (amber) with the rewritten reason and fix target', () => {
        expect(classifyTrainPlan({ blockReason: CATEGORY_BLOCK_REASON, dotState: 'complete' }))
            .toEqual({ kind: 'missing', reason: 'No category (Performance or Condition) on the sensor', fix: 'category' });
    });
    it('complete → up to date (complete)', () => {
        expect(classifyTrainPlan({ blockReason: null, dotState: 'complete' }))
            .toEqual({ kind: 'upToDate', reason: COMPLETE_UP_TO_DATE_REASON, complete: true });
    });
    it('trained and fresh → up to date; a failed run this session makes it ready again', () => {
        expect(classifyTrainPlan({ blockReason: null, dotState: 'trained' }))
            .toEqual({ kind: 'upToDate', reason: UP_TO_DATE_REASON, complete: false });
        expect(classifyTrainPlan({ blockReason: null, dotState: 'trained', hasSessionError: true })).toEqual({ kind: 'ready' });
    });
    it.each(['none', 'stale', 'blocked'] as const)('%s with no block reason → ready', dotState => {
        expect(classifyTrainPlan({ blockReason: null, dotState })).toEqual({ kind: 'ready' });
    });
});

const cands: TrainCandidate[] = [
    { id: 'a', kind: 'individual', plan: { kind: 'ready' } },
    { id: 'b', kind: 'relationship', plan: { kind: 'upToDate', reason: UP_TO_DATE_REASON, complete: false } },
    { id: 'c', kind: 'clustering', plan: { kind: 'missing', reason: 'no Y sensor', fix: 'settings' } },
    { id: 'd', kind: 'individual', plan: { kind: 'upToDate', reason: COMPLETE_UP_TO_DATE_REASON, complete: true } },
];

describe('countTrainPlans / planTrainRun', () => {
    it('counts the Train all line', () => {
        expect(countTrainPlans(cands)).toEqual({ ready: 1, upToDate: 2, missing: 1, completeUpToDate: 1 });
    });
    it('queues ready only, skips the rest with grey/amber reasons, in order', () => {
        expect(planTrainRun(cands, false)).toEqual([
            { id: 'a', kind: 'individual', state: 'queued' },
            { id: 'b', kind: 'relationship', state: 'skipped', skip: { kind: 'upToDate', reason: UP_TO_DATE_REASON } },
            { id: 'c', kind: 'clustering', state: 'skipped', skip: { kind: 'missing', reason: 'no Y sensor' } },
            { id: 'd', kind: 'individual', state: 'skipped', skip: { kind: 'upToDate', reason: COMPLETE_UP_TO_DATE_REASON } },
        ]);
    });
    it('includeUpToDate queues up-to-date models too, never missing ones', () => {
        expect(planTrainRun(cands, true).map(i => i.state)).toEqual(['queued', 'queued', 'skipped', 'queued']);
    });
    it('a model listed twice (sensor in two failure groups) is planned once', () => {
        expect(planTrainRun([cands[0], cands[0]], false)).toHaveLength(1);
    });
});

describe('summarizeTrainRun', () => {
    it('running: "Training i of n" — removed and preflight skips do not count', () => {
        const s = summarizeTrainRun(run([
            it_('a', 'trained'), it_('b', 'running'), it_('c', 'queued'), it_('d', 'removed'),
            it_('e', 'skipped', { skip: { kind: 'upToDate', reason: 'up to date' } }),
        ]));
        expect(s.text).toBe('Training 2 of 3');
        expect(s.position).toEqual({ index: 2, of: 3 });
        expect(s.tone).toBe('neutral');
    });
    it('a model skipped at its turn counts as planned', () => {
        const s = summarizeTrainRun(run([
            it_('a', 'skipped', { skip: { kind: 'missing', reason: 'x', atTurn: true } }), it_('b', 'running'),
        ]));
        expect(s.text).toBe('Training 2 of 2');
    });
    it('done, all trained → success', () => {
        const s = summarizeTrainRun(run([it_('a', 'trained'), it_('b', 'trained')], { phase: 'done' }));
        expect(s.text).toBe('Done · 2 trained');
        expect(s).toMatchObject({ outcome: 'done', tone: 'success' });
    });
    it('done with a partial failure → amber', () => {
        const s = summarizeTrainRun(run([
            ...['a', 'b', 'c', 'd', 'e', 'f'].map(id => it_(id, 'trained')),
            it_('g', 'failed', { error: 'boom' }),
            it_('h', 'skipped', { skip: { kind: 'missing', reason: 'x' } }),
            it_('i', 'skipped', { skip: { kind: 'upToDate', reason: 'up to date' } }),
        ], { phase: 'done' }));
        expect(s.text).toBe('Done · 6 trained · 1 failed · 2 skipped');
        expect(s).toMatchObject({ outcome: 'partial', tone: 'warning', failedIds: ['g'] });
        expect(s.counts).toMatchObject({ skippedMissing: 1, skippedUpToDate: 1 });
    });
    it('done, nothing trained and something failed → red', () => {
        const s = summarizeTrainRun(run([it_('a', 'failed', { error: 'x' })], { phase: 'done' }));
        expect(s).toMatchObject({ outcome: 'failed', tone: 'danger', text: 'Done · 0 trained · 1 failed' });
    });
    it('done with removed models mentions them', () => {
        expect(summarizeTrainRun(run([it_('a', 'trained'), it_('b', 'removed')], { phase: 'done' })).text).toBe('Done · 1 trained · 1 removed');
    });
    it('stopped → "Stopped · n trained · k not started"', () => {
        const s = summarizeTrainRun(run([it_('a', 'trained'), it_('b', 'notStarted'), it_('c', 'notStarted')], { phase: 'stopped' }));
        expect(s).toMatchObject({ text: 'Stopped · 1 trained · 2 not started', outcome: 'stopped', tone: 'neutral', notStartedIds: ['b', 'c'] });
    });
    it('stale → danger', () => {
        const s = summarizeTrainRun(run([it_('a', 'trained'), it_('b', 'notStarted')], { phase: 'stale' }));
        expect(s).toMatchObject({ outcome: 'stale', tone: 'danger', text: 'Stopped · 1 trained · 1 not started' });
    });
});

describe('queuePosition', () => {
    it('1 = next among queued models, 0 otherwise', () => {
        const r = run([it_('a', 'running'), it_('b', 'removed'), it_('c', 'queued'), it_('d', 'queued')]);
        expect(queuePosition(r, 'c')).toBe(1);
        expect(queuePosition(r, 'd')).toBe(2);
        expect(queuePosition(r, 'a')).toBe(0);
        expect(queuePosition(run(r.items, { phase: 'done' }), 'c')).toBe(0);
        expect(queuePosition(null, 'c')).toBe(0);
    });
});

describe('estimateTimeLeftMs', () => {
    it('null until a model finished', () => {
        expect(estimateTimeLeftMs(run([it_('a', 'running'), it_('b', 'queued')]))).toBeNull();
        expect(estimateTimeLeftMs(null)).toBeNull();
    });
    it('uses the per-kind average when that kind finished, else the overall average', () => {
        const r = run([
            it_('a', 'trained', { kind: 'individual', durationMs: 1000 }),
            it_('b', 'failed', { kind: 'individual', durationMs: 3000 }),
            it_('c', 'trained', { kind: 'relationship', durationMs: 14000 }),
            it_('d', 'running', { kind: 'individual' }),   // 2000
            it_('e', 'queued', { kind: 'relationship' }),  // 14000
            it_('f', 'queued', { kind: 'clustering' }),    // overall (1000+3000+14000)/3 = 6000
            it_('g', 'removed', { kind: 'relationship' }),
        ]);
        expect(estimateTimeLeftMs(r)).toBe(22000);
    });
    it('null once the run is over', () => {
        expect(estimateTimeLeftMs(run([it_('a', 'trained', { durationMs: 5 })], { phase: 'done' }))).toBeNull();
    });
});

describe('rough times + formatting', () => {
    it('roughTrainSeconds sums the per-kind guesses', () => {
        expect(roughTrainSeconds(['individual', 'relationship', 'clustering'])).toBe(18);
    });
    it('formatTrainSeconds', () => {
        expect(formatTrainSeconds(0.2)).toBe('1 s');
        expect(formatTrainSeconds(44.1)).toBe('45 s');
        expect(formatTrainSeconds(120)).toBe('2 min');
        expect(formatTrainSeconds(130)).toBe('2 min 10 s');
    });
});

describe('trainButtonsBlockedReason', () => {
    const base = { stale: false, runningConditionSet: true, running: false, readyCount: 3 };
    it('stale first, then running condition, then nothing ready', () => {
        expect(trainButtonsBlockedReason({ ...base, stale: true, runningConditionSet: false })).toBe(TRAIN_STALE_MESSAGE);
        expect(trainButtonsBlockedReason({ ...base, runningConditionSet: false })).toBe(TRAIN_NEEDS_RUNNING_CONDITION);
        // the step bar is gone: the reason no longer ends "(Step 1)"
        expect(TRAIN_NEEDS_RUNNING_CONDITION).toBe('Set the running condition first.');
        expect(trainButtonsBlockedReason({ ...base, readyCount: 0 })).toBe(TRAIN_NOTHING_READY);
        expect(trainButtonsBlockedReason(base)).toBeNull();
    });
    it('no text while a run is active', () => {
        expect(trainButtonsBlockedReason({ ...base, running: true, readyCount: 0 })).toBeNull();
    });
});

describe('isStaleTrainError', () => {
    it('matches the STALE_SESSION prefix only', () => {
        expect(isStaleTrainError('STALE_SESSION: dataset changed')).toBe(true);
        expect(isStaleTrainError('NO_DATA: nothing')).toBe(false);
    });
});
