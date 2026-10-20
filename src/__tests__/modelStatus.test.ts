// @vitest-environment node
/**
 * The deprecated `FailureModel.healthExport` record (written by the old Mark
 * complete before 2026-10-20, when Mark complete stopped writing files) is
 * read by NOTHING: an old record on disk changes no status, no dot and no
 * fingerprint, and the "saved results use the earlier scoring" hint is gone.
 *
 * (The rest of `utils/modelStatus.ts` — stale / complete / dot / set-point
 * flag — is covered in `incompleteRule.test.ts`.)
 */
import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, HealthExportRecord, HealthSetPoints } from '../types';
import * as modelStatus from '../utils/modelStatus';
import { isModelComplete, isModelStale, modelDotState, modelSetPointFlag } from '../utils/modelStatus';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const fg: FailureGroupStateSlice = {
    groups: [], models: [],
    runningConditionFilters: [], runningConditionCombine: 'and',
    runningConditionTimePeriods: [{ id: 'tr', start: '2025-01-01T00:00', end: '2025-12-31T23:59' }],
    runningConditionTestPeriods: [{ id: 't1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }],
    runningConditionNoneConfirmed: true,
};
const sp: HealthSetPoints = { kind: 'individual', lower: 1, upper: 9 };
/** An old record without a scoring interval (written before 2026-10-11). */
const OLD_RECORD: HealthExportRecord = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: sp };
/** An old record with one (written 2026-10-11 .. 2026-10-20). */
const HOURLY_RECORD: HealthExportRecord = { ...OLD_RECORD, at: '2026-10-11T09:00:00.000Z', scoringIntervalSecs: 3600 };

const ind = (over: Partial<FailureModel> = {}) => mk({ id: 'i1', kind: 'individual', targetSensor: 'T', category: 'condition', healthSetPoints: sp, ...over });
const trained = (m: FailureModel): FailureModel => ({ ...m, lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: computeTrainFingerprint(m, fg) });
const complete = (over: Partial<FailureModel> = {}) => trained(ind({ status: true, healthVerdict: 'valid', ...over }));

describe('the deprecated healthExport record is read by nothing', () => {
    it.each([['no record', undefined], ['an old record', OLD_RECORD], ['an hourly record', HOURLY_RECORD]] as const)(
        'a Complete model with %s reads Complete everywhere', (_label, record) => {
            const m = complete(record ? { healthExport: record } : {});
            expect(isModelStale(m, fg)).toBe(false);
            expect(isModelComplete(m, fg)).toBe(true);
            expect(modelDotState(m, fg)).toBe('complete');
            expect(modelSetPointFlag(m, fg)).toBeNull();
        });

    it('the record is not a training input: it does not change the train fingerprint', () => {
        const without = complete();
        expect(computeTrainFingerprint({ ...without, healthExport: OLD_RECORD }, fg)).toBe(computeTrainFingerprint(without, fg));
        expect(computeTrainFingerprint({ ...without, healthExport: HOURLY_RECORD }, fg)).toBe(computeTrainFingerprint(without, fg));
    });

    it('the "earlier scoring" hint and its text are removed', () => {
        const mod = modelStatus as Record<string, unknown>;
        expect(mod.savedResultsUseEarlierScoring).toBeUndefined();
        expect(mod.EARLIER_SCORING_HINT_TEXT).toBeUndefined();
    });
});
