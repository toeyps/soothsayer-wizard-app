import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, FailureModel, SpecialSensorRecipe, TestPeriod, TimePeriod, WorkspaceSensorFilter, WorkspaceState } from '../types';
import { mk } from './helpers/failureModelFixture';
import { LEGACY_TESTS } from './helpers/trainTestFixture';
import {
    runningConditionImpact, runningConditionDraftOf, modelsStillNeedingTraining,
    retrainImpactText, remarkImpactText, retrainNoticeParts, retrainNoticeText,
    NO_IMPACT_TEXT, SCORED_WHEN_TRAINED_TEXT, type RunningConditionDraft,
} from '../utils/runningConditionImpact';
import { applyIncompleteRule } from '../utils/incompleteRule';
import { withFailureGroupState } from '../utils/failureGroupState';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { isModelComplete, isModelStale } from '../utils/modelStatus';
import { testsChangedNotice } from '../utils/trainTestValidation';

const cond = (v: string, id = 'f1'): WorkspaceSensorFilter => ({ id, sensor: 'SPEED', operation: 'greater_than', value1: v, value2: '' });
const TRAIN: TimePeriod[] = [{ id: 'tr', start: '2025-01-01T00:00', end: '2025-06-30T23:59' }];
const SCORE: TestPeriod[] = [{ id: 'sc', start: '2025-07-01T00:00', end: '2025-07-31T23:59' }];

const slice = (models: FailureModel[], over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({
    groups: [], models,
    runningConditionFilters: [cond('10')], runningConditionCombine: 'and',
    runningConditionTimePeriods: TRAIN, runningConditionNoneConfirmed: false,
    runningConditionTestPeriods: SCORE, rcLegacyNotice: null,
    ...over,
});

/** A model with a train record that matches `fg` (Trained and fresh). */
const trained = (m: FailureModel, fg: FailureGroupStateSlice): FailureModel =>
    ({ ...m, lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: computeTrainFingerprint(m, fg) });

/** A workspace of `models`, every one of them trained against it (unless it says otherwise). */
function workspace(models: FailureModel[], over: Partial<FailureGroupStateSlice> = {}, opts: { train?: (m: FailureModel) => boolean } = {}): FailureGroupStateSlice {
    const bare = slice(models, over);
    return { ...bare, models: models.map(m => ((opts.train ?? (() => true))(m) ? trained(m, bare) : m)) };
}

const draft = (fg: FailureGroupStateSlice, over: Partial<RunningConditionDraft> = {}): RunningConditionDraft => ({ ...runningConditionDraftOf(fg), ...over });

const ind = (id: string, over: Partial<FailureModel> = {}) => mk({ id, kind: 'individual', targetSensor: `T-${id}`, category: 'condition', ...over });
const customOf = (id: string, over: Partial<FailureModel> = {}) => ind(id, {
    runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
    filterTimePeriods: [{ id: 'own', start: '2025-01-01T00:00', end: '2025-03-31T23:59' }],
    customTestPeriods: [{ id: 'own-s', start: '2025-04-01T00:00', end: '2025-04-30T23:59' }],
    ...over,
});

/** What the REAL write does with the same draft (`persistRunningCondition` -> `applyIncompleteRule`). */
function applyForReal(fg: FailureGroupStateSlice, d: RunningConditionDraft): FailureGroupStateSlice {
    const prev = { id: 'ws', name: 'W', failureGroupState: fg } as unknown as WorkspaceState;
    const next = withFailureGroupState(prev, {
        runningConditionFilters: d.filters, runningConditionCombine: d.combine, runningConditionTimePeriods: d.periods,
        runningConditionNoneConfirmed: d.noneConfirmed, runningConditionTestPeriods: d.testPeriods,
    });
    return applyIncompleteRule(prev, next, { now: '2026-10-10T00:00:00Z' }).failureGroupState!;
}

describe('runningConditionDraftOf', () => {
    it('the persisted workspace running condition in draft shape; missing fields read as their defaults', () => {
        const fg = slice([]);
        expect(runningConditionDraftOf(fg)).toEqual({ filters: fg.runningConditionFilters, combine: 'and', periods: TRAIN, noneConfirmed: false, testPeriods: SCORE });
        expect(runningConditionDraftOf({ groups: [], models: [] })).toEqual({ filters: [], combine: 'and', periods: [], noneConfirmed: false, testPeriods: [] });
        expect(runningConditionDraftOf(null)).toEqual({ filters: [], combine: 'and', periods: [], noneConfirmed: false, testPeriods: [] });
    });
});

describe('runningConditionImpact — the line next to Apply (SPEC §5 "Before Apply")', () => {
    it('the train periods changed: amber "Applying sets N models back to Incomplete — they need training again"', () => {
        const fg = workspace([ind('a', { status: true }), ind('b', { status: true }), ind('c')]);
        const impact = runningConditionImpact(fg, draft(fg, { periods: [{ ...TRAIN[0], end: '2025-05-31T23:59' }] }));
        expect(impact).toEqual({
            tone: 'amber', text: 'Applying sets 3 models back to Incomplete — they need training again', quiet: null,
            retrainIds: ['a', 'b', 'c'], remarkIds: [], trainChanged: true, scoringChanged: false,
        });
    });

    it('each part of the condition counts: a value, a new condition, AND/OR, "Use all rows", a period added', () => {
        const fg = workspace([ind('a', { status: true })], { runningConditionFilters: [cond('10'), cond('20', 'f2')] });
        const changes: Partial<RunningConditionDraft>[] = [
            { filters: [cond('11'), cond('20', 'f2')] },
            { filters: [cond('10')] },
            { combine: 'or' },
            { noneConfirmed: true },
            { periods: [...TRAIN, { id: 'tr2', start: '2025-08-01T00:00', end: '2025-08-31T23:59' }] },
        ];
        for (const over of changes) {
            const impact = runningConditionImpact(fg, draft(fg, over));
            expect(impact, JSON.stringify(over)).toMatchObject({ tone: 'amber', text: 'Applying sets 1 model back to Incomplete — it needs training again', retrainIds: ['a'], trainChanged: true });
        }
    });

    it('singular and plural', () => {
        expect(retrainImpactText(1)).toBe('Applying sets 1 model back to Incomplete — it needs training again');
        expect(retrainImpactText(7)).toBe('Applying sets 7 models back to Incomplete — they need training again');
        expect(remarkImpactText(1)).toBe('1 complete model will need Mark complete again (re-score, no training)');
        expect(remarkImpactText(4)).toBe('4 complete models will need Mark complete again (re-score, no training)');
    });

    it('N counts only models that are trained and fresh (or Complete) today — a never-trained model and one that is already out of date have nothing to lose', () => {
        const never = ind('never');
        const stale = { ...ind('stale'), lastTrainedAt: '2026-09-01T00:00:00Z', trainedFingerprint: 'an older fingerprint' };
        const fg = workspace([ind('fresh'), never, stale, ind('done', { status: true })], {}, { train: m => m.id === 'fresh' || m.id === 'done' });
        const withStale = { ...fg, models: fg.models.map(m => (m.id === 'stale' ? stale : m)) };
        expect(isModelStale(withStale.models[2], withStale)).toBe(true);
        const impact = runningConditionImpact(withStale, draft(withStale, { combine: 'or' }));
        expect(impact.retrainIds).toEqual(['fresh', 'done']);
        expect(impact.text).toBe('Applying sets 2 models back to Incomplete — they need training again');
    });

    it('a model marked complete before train records existed (no fingerprint) goes back to Incomplete too, so it is counted', () => {
        const legacy = ind('legacy', { status: true }); // status true, never "trained" on record
        const fg = slice([legacy]);
        expect(isModelComplete(legacy, fg)).toBe(true);
        const d = draft(fg, { noneConfirmed: true });
        expect(runningConditionImpact(fg, d).retrainIds).toEqual(['legacy']);
        expect(applyForReal(fg, d).models[0].status).toBe(false); // ... which is what the write does
    });

    it('Custom-mode models are never counted — whatever the workspace draft changes', () => {
        const fg = workspace([ind('ws', { status: true }), customOf('own', { status: true }), customOf('own2')]);
        const both = draft(fg, { combine: 'or', testPeriods: [{ ...SCORE[0], end: '2025-07-15T23:59' }] });
        const impact = runningConditionImpact(fg, both);
        expect(impact.retrainIds).toEqual(['ws']);
        expect(impact.remarkIds).toEqual([]);
        // only Custom models in the workspace: nothing is affected, grey
        const onlyCustom = workspace([customOf('own', { status: true })]);
        expect(runningConditionImpact(onlyCustom, draft(onlyCustom, { combine: 'or', testPeriods: [] }))).toMatchObject({ tone: 'grey', text: NO_IMPACT_TEXT, retrainIds: [], remarkIds: [], trainChanged: false });
    });

    it('ONLY the scoring periods changed: "N complete models will need Mark complete again (re-score, no training)" — trained-but-not-complete models are not counted', () => {
        const fg = workspace([ind('a', { status: true }), ind('b', { status: true }), ind('c')]);
        const d = draft(fg, { testPeriods: [...SCORE, { id: 'sc2', start: '2025-08-01T00:00', end: '2025-08-31T23:59' }] });
        expect(runningConditionImpact(fg, d)).toEqual({
            tone: 'amber', text: '2 complete models will need Mark complete again (re-score, no training)', quiet: null,
            retrainIds: [], remarkIds: ['a', 'b'], trainChanged: false, scoringChanged: true,
        });
        // removing every scoring period is a scoring change too
        expect(runningConditionImpact(fg, draft(fg, { testPeriods: [] })).remarkIds).toEqual(['a', 'b']);
    });

    it('BOTH changed: the train line, plus the quiet line "The new scoring periods are scored when they are trained again"', () => {
        const fg = workspace([ind('a', { status: true }), ind('b')]);
        const impact = runningConditionImpact(fg, draft(fg, { combine: 'or', testPeriods: [{ ...SCORE[0], start: '2025-07-05T00:00' }] }));
        expect(impact).toMatchObject({
            tone: 'amber', text: 'Applying sets 2 models back to Incomplete — they need training again',
            quiet: 'The new scoring periods are scored when they are trained again',
            retrainIds: ['a', 'b'], remarkIds: [], trainChanged: true, scoringChanged: true,
        });
        expect(impact.quiet).toBe(SCORED_WHEN_TRAINED_TEXT);
    });

    it('nothing affected: grey "No trained or complete model is affected by this change" — with a change and N = 0, and with no change at all', () => {
        const untrained = slice([ind('a'), ind('b')]);
        for (const over of [{ combine: 'or' as const }, { testPeriods: [] }, { combine: 'or' as const, testPeriods: [] }, {}]) {
            expect(runningConditionImpact(untrained, draft(untrained, over))).toMatchObject({ tone: 'grey', text: 'No trained or complete model is affected by this change', quiet: null, retrainIds: [], remarkIds: [] });
        }
        // the flags still say what changed, even though nobody is affected
        expect(runningConditionImpact(untrained, draft(untrained, { combine: 'or' }))).toMatchObject({ trainChanged: true, scoringChanged: false });
        expect(runningConditionImpact(untrained, draft(untrained, { testPeriods: [] }))).toMatchObject({ trainChanged: false, scoringChanged: true });
        // an unchanged draft over trained models: nothing
        const fg = workspace([ind('a', { status: true })]);
        expect(runningConditionImpact(fg, draft(fg))).toMatchObject({ tone: 'grey', text: NO_IMPACT_TEXT, trainChanged: false, scoringChanged: false });
        // no models, no slice
        expect(runningConditionImpact(slice([]), draft(slice([]), { combine: 'or' })).tone).toBe('grey');
        expect(runningConditionImpact(null, runningConditionDraftOf(null)).text).toBe(NO_IMPACT_TEXT);
    });

    it('edits that do not change what is trained are not "a change": a blank condition row, new ids, legacy keys falling off the scoring periods', () => {
        const fg = workspace([ind('a', { status: true })], { runningConditionTestPeriods: LEGACY_TESTS });
        const cosmetic = draft(fg, {
            filters: [{ ...cond('10'), id: 'new-id' }, { id: 'blank', sensor: 'SPEED', operation: 'greater_than', value1: '', value2: '' }],
            periods: TRAIN.map(p => ({ ...p, id: 'new-period-id' })),
            testPeriods: LEGACY_TESTS.map(t => ({ id: `${t.id}-x`, start: t.start, end: t.end })),
        });
        expect(runningConditionImpact(fg, cosmetic)).toMatchObject({ tone: 'grey', retrainIds: [], remarkIds: [], trainChanged: false, scoringChanged: false });
    });

    it('a stale Complete model (status true on disk, inputs already changed) is not promised "Mark complete again"', () => {
        const done = ind('a', { status: true });
        const fg = { ...slice([done]), models: [{ ...done, lastTrainedAt: '2026-09-01T00:00:00Z', trainedFingerprint: 'older' }] };
        expect(isModelComplete(fg.models[0], fg)).toBe(false);
        expect(runningConditionImpact(fg, draft(fg, { testPeriods: [] })).remarkIds).toEqual([]);
    });

    it('with the special-sensor recipes: a model whose trained formula has changed since is not "fresh" and is not counted', () => {
        // The model's target IS a special sensor ("T-a"); it was trained while the formula was something else.
        const recipes: SpecialSensorRecipe[] = [{ kind: 'formula', tag: 'T-a', formula: '$RAW + 1' }];
        const fg = workspace([ind('a')]);
        const withSnapshot = { ...fg, models: fg.models.map(m => ({ ...m, trainedFormulas: { 't-a': 'the signature it was trained with' } })) };
        expect(isModelStale(withSnapshot.models[0], withSnapshot, recipes)).toBe(true);
        expect(runningConditionImpact(withSnapshot, draft(withSnapshot, { combine: 'or' })).retrainIds).toEqual(['a']); // not judged without recipes
        expect(runningConditionImpact(withSnapshot, draft(withSnapshot, { combine: 'or' }), { recipes }).retrainIds).toEqual([]);
    });

    it('never throws on a malformed model record — the footer falls back to the grey line', () => {
        const broken = { ...ind('a', { status: true }), predictorSensors: null } as unknown as FailureModel;
        const fg = slice([broken]);
        expect(() => runningConditionImpact(fg, draft(fg, { combine: 'or' }))).not.toThrow();
    });
});

/*
 * The helper predicts a write; these check the prediction against the write
 * itself (`applyIncompleteRule` — what `persistRunningCondition` runs), so the
 * count in the footer is the count the user then sees.
 */
describe('runningConditionImpact agrees with what Apply really does', () => {
    const models = () => [
        ind('complete', { status: true }), ind('trained'), ind('never'),
        customOf('custom-complete', { status: true }), customOf('custom-trained'),
    ];
    const fresh = () => workspace(models(), {}, { train: m => m.id !== 'never' });

    it('a train-side change: exactly the predicted models are out of date afterwards, and the Complete ones are Incomplete', () => {
        const fg = fresh();
        const d = draft(fg, { periods: [{ ...TRAIN[0], start: '2025-02-01T00:00' }] });
        const impact = runningConditionImpact(fg, d);
        const after = applyForReal(fg, d);
        const nowStale = after.models.filter(m => isModelStale(m, after)).map(m => m.id);
        expect(nowStale).toEqual(impact.retrainIds);
        expect(impact.retrainIds).toEqual(['complete', 'trained']);
        expect(after.models.find(m => m.id === 'complete')!.status).toBe(false);
        // Custom models: untouched by the write, uncounted by the line
        expect(after.models.find(m => m.id === 'custom-complete')).toBe(fg.models.find(m => m.id === 'custom-complete'));
        // ... and the after-Apply notice counts the same models
        expect(modelsStillNeedingTraining(impact.retrainIds, after.models, after)).toEqual(impact.retrainIds);
    });

    it('a scoring-only change: exactly the predicted models get "Mark complete again" (testsChangedAt), nobody goes out of date', () => {
        const fg = fresh();
        const d = draft(fg, { testPeriods: [{ ...SCORE[0], end: '2025-07-20T23:59' }] });
        const impact = runningConditionImpact(fg, d);
        const after = applyForReal(fg, d);
        expect(after.models.filter(m => m.testsChangedAt).map(m => m.id)).toEqual(impact.remarkIds);
        expect(impact.remarkIds).toEqual(['complete']);
        expect(after.models.some(m => isModelStale(m, after))).toBe(false);
        expect(testsChangedNotice(after.models, after)).toEqual({ count: impact.remarkIds.length, allRemoved: false });
        expect(impact.retrainIds).toEqual([]);
    });

    it('both: the train rule wins in the write (no testsChangedAt) — and in the line (no "Mark complete again" count)', () => {
        const fg = fresh();
        const d = draft(fg, { noneConfirmed: true, testPeriods: [] });
        const impact = runningConditionImpact(fg, d);
        const after = applyForReal(fg, d);
        expect(after.models.some(m => m.testsChangedAt)).toBe(false);
        expect(impact.remarkIds).toEqual([]);
        expect(after.models.filter(m => isModelStale(m, after)).map(m => m.id)).toEqual(impact.retrainIds);
        expect(impact.quiet).toBe(SCORED_WHEN_TRAINED_TEXT);
    });

    it('an unchanged draft: the write changes nothing and the line counts nobody', () => {
        const fg = fresh();
        expect(applyForReal(fg, draft(fg)).models).toBe(fg.models); // not one model object was replaced
        expect(runningConditionImpact(fg, draft(fg))).toMatchObject({ retrainIds: [], remarkIds: [] });
    });
});

describe('after Apply: the session-only "need training again" notice', () => {
    it('counts the models of the Apply that are still not trained again; one that was trained since, or deleted, drops out', () => {
        const fg = workspace([ind('a', { status: true }), ind('b'), ind('c')]);
        const d = draft(fg, { combine: 'or' });
        const ids = runningConditionImpact(fg, d).retrainIds;
        const after = applyForReal(fg, d);
        expect(modelsStillNeedingTraining(ids, after.models, after)).toEqual(['a', 'b', 'c']);
        // "b" is trained again; "c" is deleted
        const later = { ...after, models: after.models.filter(m => m.id !== 'c').map(m => (m.id === 'b' ? trained(m, after) : m)) };
        expect(modelsStillNeedingTraining(ids, later.models, later)).toEqual(['a']);
        const done = { ...later, models: later.models.map(m => trained(m, later)) };
        expect(modelsStillNeedingTraining(ids, done.models, done)).toEqual([]);
        expect(modelsStillNeedingTraining([], after.models, after)).toEqual([]);
    });

    it('the text, in two parts and as one string — singular and plural', () => {
        expect(retrainNoticeText(3)).toBe('Running condition changed — 3 models need training again. Use Train all, or Train sensor on each one; the amber dots in the list show which.');
        expect(retrainNoticeParts(3)).toEqual({
            headline: 'Running condition changed — 3 models need training again',
            rest: 'Use Train all, or Train sensor on each one; the amber dots in the list show which.',
        });
        expect(retrainNoticeText(1)).toBe('Running condition changed — 1 model needs training again. Use Train all, or Train sensor on it; the amber dot in the list shows which.');
        for (const n of [1, 2, 12]) {
            const parts = retrainNoticeParts(n);
            expect(retrainNoticeText(n)).toBe(`${parts.headline}. ${parts.rest}`);
        }
    });
});
