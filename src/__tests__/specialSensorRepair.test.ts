import { describe, it, expect } from 'vitest';
import type { FailureModel, WorkspaceSensorFilter } from '../types';
import { demoteModelsTrainedOnSensors, modelTrainsOnSensors } from '../utils/specialSensorRepair';
import { isModelComplete, isModelStale } from '../utils/modelStatus';
import { isModelTrainedFresh, computeTrainFingerprint } from '../utils/trainFingerprint';
import { mk } from './helpers/failureModelFixture';

// 2026-10-08 (review MUST-FIX 2): fixing a special sensor that could not be
// restored gives it NEW values, but no train fingerprint covers special-sensor
// recipes -- so the models trained on it are demoted explicitly.

const cond = (sensor: string): WorkspaceSensorFilter => ({ id: `c-${sensor}`, sensor, operation: 'greater_than', value1: '1', value2: '' });
const fg = { runningConditionFilters: [cond('RC_SENSOR')] };

/** A Complete, trained-and-fresh model with a saved verdict. */
function complete(over: Partial<FailureModel> & { id: string }): FailureModel {
    const base = mk({ status: true, healthVerdict: 'valid', healthSetPoints: { kind: 'individual', lower: 1, upper: 9 } as FailureModel['healthSetPoints'], ...over });
    return { ...base, lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: computeTrainFingerprint(base, fg) };
}

describe('modelTrainsOnSensors', () => {
    it('counts every training input, case-insensitively', () => {
        expect(modelTrainsOnSensors(mk({ id: 't', targetSensor: 'A' }), fg, ['a'])).toBe(true);
        expect(modelTrainsOnSensors(mk({ id: 'p', predictorSensors: ['X', ' A '] }), fg, ['A'])).toBe(true);
        expect(modelTrainsOnSensors(mk({ id: 'x', kind: 'clustering', xSensor: 'A' }), fg, ['A'])).toBe(true);
        expect(modelTrainsOnSensors(mk({ id: 'y', kind: 'clustering', ySensor: 'A' }), fg, ['A'])).toBe(true);
        expect(modelTrainsOnSensors(mk({ id: 'c', criteriaSensor: 'A' }), fg, ['A'])).toBe(true);
    });

    it('the EFFECTIVE running condition counts: the workspace one for a Workspace-mode model, its own for a Custom one', () => {
        expect(modelTrainsOnSensors(mk({ id: 'w' }), fg, ['RC_SENSOR'])).toBe(true);
        const custom = mk({ id: 'cu', runningConditionMode: 'custom', customRunningConditionFilters: [cond('OWN')] });
        expect(modelTrainsOnSensors(custom, fg, ['RC_SENSOR'])).toBe(false);
        expect(modelTrainsOnSensors(custom, fg, ['OWN'])).toBe(true);
        // A Workspace-mode model's parked custom list does not count.
        expect(modelTrainsOnSensors(mk({ id: 'parked', customRunningConditionFilters: [cond('OWN')] }), fg, ['OWN'])).toBe(false);
    });

    it('display-only fields do not count', () => {
        expect(modelTrainsOnSensors(mk({ id: 's', scatterXSensor: 'A' }), fg, ['A'])).toBe(false);
        expect(modelTrainsOnSensors(mk({ id: 'n', targetSensor: 'B' }), fg, ['A'])).toBe(false);
        expect(modelTrainsOnSensors(mk({ id: 'e', targetSensor: 'A' }), fg, [])).toBe(false);
    });
});

describe('demoteModelsTrainedOnSensors', () => {
    it('a Complete model on a repaired sensor becomes Incomplete AND stale (re-train required), keeping set points and lastTrainedAt', () => {
        const m = complete({ id: 'm1', targetSensor: 'A' });
        expect(isModelComplete(m, fg)).toBe(true);
        const { models, retrain } = demoteModelsTrainedOnSensors([m], fg, ['A']);
        const d = models[0];
        expect(retrain).toEqual(['m1']);
        expect(d.status).toBe(false);
        expect(d.lastTrainedAt).toBe(m.lastTrainedAt);
        expect(d.healthSetPoints).toEqual(m.healthSetPoints);
        expect(d.trainedFingerprint).toBeUndefined();
        expect(d.healthVerdict).toBeUndefined();
        expect(isModelStale(d, fg)).toBe(true);
        expect(isModelTrainedFresh(d, fg)).toBe(false); // Mark complete's trained-and-fresh check fails

    });

    it('a model downstream (trains on a sensor built on the repaired one) is demoted too, when its tag is in the list', () => {
        const m = complete({ id: 'm2', predictorSensors: ['B'] });
        expect(demoteModelsTrainedOnSensors([m], fg, ['A', 'B']).models[0].status).toBe(false);
    });

    it('a trained-but-not-Complete model goes stale; an untouched model is returned as the same object', () => {
        const trained = { ...complete({ id: 't', targetSensor: 'A' }), status: false };
        const other = complete({ id: 'o', targetSensor: 'Z' });
        const { models, retrain } = demoteModelsTrainedOnSensors([trained, other], fg, ['A']);
        expect(retrain).toEqual(['t']);
        expect(isModelStale(models[0], fg)).toBe(true);
        expect(models[1]).toBe(other);
    });

    it('drops a testsChangedAt stamp (the model needs a re-train, not just Mark complete again)', () => {
        const m = { ...complete({ id: 's', targetSensor: 'A' }), testsChangedAt: '2026-10-07T00:00:00Z' };
        expect(demoteModelsTrainedOnSensors([m], fg, ['A']).models[0].testsChangedAt).toBeUndefined();
    });

    it('nothing affected: the SAME array comes back (no needless write content)', () => {
        const list = [complete({ id: 'x', targetSensor: 'Z' }), mk({ id: 'never', targetSensor: 'A' })];
        const out = demoteModelsTrainedOnSensors(list, fg, ['A']);
        expect(out.models).toBe(list); // never-trained, not Complete: nothing to change
        expect(out.retrain).toEqual([]);
    });

    it('is idempotent', () => {
        const once = demoteModelsTrainedOnSensors([complete({ id: 'm1', targetSensor: 'A' })], fg, ['A']).models;
        const twice = demoteModelsTrainedOnSensors(once, fg, ['A']);
        expect(twice.models).toBe(once);
    });
});
