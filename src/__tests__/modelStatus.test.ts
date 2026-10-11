// @vitest-environment node
/**
 * `savedResultsUseEarlierScoring` — the read-only hint for a model that was
 * marked Complete before the health score moved to 1-hour averages
 * (2026-10-11). User decision: such a model STAYS Complete; the Health score
 * page footer only says its saved results use the earlier row-by-row scoring
 * and offers "Mark complete again".
 *
 * (The rest of `utils/modelStatus.ts` — stale / complete / dot / set-point
 * flag — is covered in `incompleteRule.test.ts`.)
 */
import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, HealthExportRecord, HealthSetPoints, SpecialSensorRecipe } from '../types';
import {
    EARLIER_SCORING_HINT_TEXT,
    isModelComplete,
    isModelStale,
    modelDotState,
    modelSetPointFlag,
    savedResultsUseEarlierScoring,
} from '../utils/modelStatus';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const fg: FailureGroupStateSlice = {
    groups: [], models: [],
    runningConditionFilters: [], runningConditionCombine: 'and',
    runningConditionTimePeriods: [{ id: 'tr', start: '2025-01-01T00:00', end: '2025-12-31T23:59' }],
    runningConditionTestPeriods: [{ id: 't1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }],
    runningConditionNoneConfirmed: true,
};
const sp: HealthSetPoints = { kind: 'individual', lower: 1, upper: 9 };
/** A record as Mark complete wrote it BEFORE the change: no scoring interval. */
const OLD_RECORD: HealthExportRecord = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: sp };
/** A record written since: the results were computed on 1-hour averages. */
const HOURLY_RECORD: HealthExportRecord = { ...OLD_RECORD, at: '2026-10-11T09:00:00.000Z', scoringIntervalSecs: 3600 };

const ind = (over: Partial<FailureModel> = {}) => mk({ id: 'i1', kind: 'individual', targetSensor: 'T', category: 'condition', healthSetPoints: sp, ...over });
const trained = (m: FailureModel): FailureModel => ({ ...m, lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: computeTrainFingerprint(m, fg) });
const complete = (over: Partial<FailureModel> = {}) => trained(ind({ status: true, healthVerdict: 'valid', ...over }));

describe('savedResultsUseEarlierScoring', () => {
    it('Complete, export record WITHOUT a scoring interval -> true (its files were scored row by row)', () => {
        expect(savedResultsUseEarlierScoring(complete({ healthExport: OLD_RECORD }), fg)).toBe(true);
    });

    it('Complete, export record WITH the interval -> false', () => {
        expect(savedResultsUseEarlierScoring(complete({ healthExport: HOURLY_RECORD }), fg)).toBe(false);
        // any recorded interval counts as "saved with interval scoring", not only 3600
        expect(savedResultsUseEarlierScoring(complete({ healthExport: { ...OLD_RECORD, scoringIntervalSecs: 900 } }), fg)).toBe(false);
    });

    it('Incomplete -> false, with or without the interval (the footer already asks for Mark complete)', () => {
        expect(savedResultsUseEarlierScoring(trained(ind({ status: false, healthExport: OLD_RECORD })), fg)).toBe(false);
        expect(savedResultsUseEarlierScoring(trained(ind({ status: false, healthExport: HOURLY_RECORD })), fg)).toBe(false);
        expect(savedResultsUseEarlierScoring(ind({ status: false }), fg)).toBe(false);
    });

    it('Complete with NO export record at all -> false (nothing was saved that could be out of date)', () => {
        const m = complete();
        expect(m.healthExport).toBeUndefined();
        expect(savedResultsUseEarlierScoring(m, fg)).toBe(false);
    });

    it('Complete on disk but OUT OF DATE (inputs changed since the train) -> false: it needs a re-train, not a second Mark complete', () => {
        const stale = { ...complete({ healthExport: OLD_RECORD }), targetSensor: 'T2' };
        expect(isModelStale(stale, fg)).toBe(true);
        expect(savedResultsUseEarlierScoring(stale, fg)).toBe(false);
    });

    it('the special-sensor recipes are honoured when passed: a formula changed since the train makes the model stale, so no hint', () => {
        // The target `T` is a special sensor whose formula differs from the one it was trained with.
        const recipes = [{ tag: 'T', kind: 'formula', formula: '[A] + 1' }] as unknown as SpecialSensorRecipe[];
        const m = complete({ healthExport: OLD_RECORD, trainedFormulas: { t: 'signature-of-the-old-formula' } });
        expect(isModelStale(m, fg, recipes)).toBe(true);
        expect(savedResultsUseEarlierScoring(m, fg, recipes)).toBe(false);
        // Without the recipes that half is not judged here (same rule as every status reader).
        expect(savedResultsUseEarlierScoring(m, fg)).toBe(true);
    });

    it('a Complete model from before train records existed (no lastTrainedAt) still gets the hint - it reads as Complete', () => {
        const legacy = ind({ status: true, healthExport: OLD_RECORD });
        expect(isModelComplete(legacy, fg)).toBe(true);
        expect(savedResultsUseEarlierScoring(legacy, fg)).toBe(true);
    });

    it('a JSON round trip keeps both answers (an absent key stays absent; a stored one stays a number)', () => {
        const round = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
        expect(savedResultsUseEarlierScoring(round(complete({ healthExport: OLD_RECORD })), fg)).toBe(true);
        expect(savedResultsUseEarlierScoring(round(complete({ healthExport: HOURLY_RECORD })), fg)).toBe(false);
        // a hand-edited / corrupt value that is not a number is "no interval recorded"
        const corrupt = complete({ healthExport: { ...OLD_RECORD, scoringIntervalSecs: null as unknown as number } });
        expect(savedResultsUseEarlierScoring(corrupt, fg)).toBe(true);
    });

    it('is READ-ONLY: it changes nothing on the model, and the model stays Complete everywhere else', () => {
        const m = complete({ healthExport: OLD_RECORD });
        const snapshot = JSON.stringify(m);
        const frozen = Object.freeze({ ...m, healthExport: Object.freeze({ ...OLD_RECORD }) }) as FailureModel;
        expect(savedResultsUseEarlierScoring(frozen, fg)).toBe(true); // would throw on a write
        expect(JSON.stringify(m)).toBe(snapshot);
        // status, the train fingerprint and the saved verdict are what they were
        expect(m.status).toBe(true);
        expect(m.trainedFingerprint).toBe(computeTrainFingerprint(m, fg));
        expect(m.healthVerdict).toBe('valid');
        // every other status reader still says Complete - the hint is not a status
        expect(isModelStale(m, fg)).toBe(false);
        expect(isModelComplete(m, fg)).toBe(true);
        expect(modelDotState(m, fg)).toBe('complete');
        expect(modelSetPointFlag(m, fg)).toBeNull();
    });

    it('the scoring interval is not a training input: recording it does not change the train fingerprint', () => {
        const before = complete({ healthExport: OLD_RECORD });
        const after = { ...before, healthExport: HOURLY_RECORD };
        expect(computeTrainFingerprint(after, fg)).toBe(computeTrainFingerprint(before, fg));
        expect(isModelStale(after, fg)).toBe(false);
    });
});

describe('EARLIER_SCORING_HINT_TEXT', () => {
    it('is the exact footer sentence of the spec', () => {
        expect(EARLIER_SCORING_HINT_TEXT).toBe('Saved results use the earlier row-by-row scoring — Mark complete again to update the files');
    });
});
