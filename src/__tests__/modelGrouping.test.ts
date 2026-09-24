import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import { modelSensorKey, groupModelsBySensor, sensorCategory, setSensorCategory, normalizeSensorCategories } from '../utils/modelGrouping';

describe('modelSensorKey', () => {
    it('keys individual/relationship by target, normalised', () => {
        expect(modelSensorKey(mk({ id: 'a', targetSensor: ' Temp_1 ' }))).toBe('temp_1');
        expect(modelSensorKey(mk({ id: 'a', kind: 'relationship', targetSensor: 'TEMP_1' }))).toBe('temp_1');
    });
    it('keys clustering by X, never Y', () => {
        const c = mk({ id: 'c', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', targetSensor: 'Y1' });
        expect(modelSensorKey(c)).toBe('x1');
        const moved = mk({ id: 'c', kind: 'clustering', xSensor: 'X1', ySensor: 'Other' });
        expect(modelSensorKey(moved)).toBe('x1');
    });
    it('empty sensor gives empty key', () => {
        expect(modelSensorKey(mk({ id: 'a' }))).toBe('');
    });
});

describe('groupModelsBySensor', () => {
    it('returns [] for empty input and for a group with no models', () => {
        expect(groupModelsBySensor([], 1)).toEqual([]);
        expect(groupModelsBySensor([mk({ id: 'a', targetSensor: 'T', groupNos: [2] })], 1)).toEqual([]);
    });
    it('merges I/R/C of one sensor into one row, in first-seen order', () => {
        const ms = [
            mk({ id: 'i', targetSensor: 'T1' }),
            mk({ id: 'o', targetSensor: 'T2' }),
            mk({ id: 'r', kind: 'relationship', targetSensor: 't1' }),
            mk({ id: 'c', kind: 'clustering', xSensor: 'T1', ySensor: 'Z' }),
        ];
        const g = groupModelsBySensor(ms, 1);
        expect(g.map((x) => x.key)).toEqual(['t1', 't2']);
        expect(g[0].models.map((m) => m.id)).toEqual(['i', 'r', 'c']);
    });
    it('clustering stays on its X row after Y changes', () => {
        const c = mk({ id: 'c', kind: 'clustering', xSensor: 'X', ySensor: 'A' });
        const before = groupModelsBySensor([c], 1)[0].key;
        const after = groupModelsBySensor([{ ...c, ySensor: 'B' }], 1)[0].key;
        expect(before).toBe(after);
    });
    it('only includes models in the requested group; multi-FG model appears in each', () => {
        const ms = [mk({ id: 'a', targetSensor: 'T', groupNos: [1, 2] }), mk({ id: 'b', targetSensor: 'T', groupNos: [2] })];
        expect(groupModelsBySensor(ms, 1)[0].models.map((m) => m.id)).toEqual(['a']);
        expect(groupModelsBySensor(ms, 2)[0].models.map((m) => m.id)).toEqual(['a', 'b']);
    });
    it('models without a key sensor share the empty-key group', () => {
        expect(groupModelsBySensor([mk({ id: 'a' }), mk({ id: 'b' })], 1)).toHaveLength(1);
    });
});

describe('sensorCategory / setSensorCategory', () => {
    it('null when nothing set; precedence Individual > Relationship > Clustering', () => {
        const ms = [
            mk({ id: 'c', kind: 'clustering', xSensor: 'T', category: 'condition' }),
            mk({ id: 'r', kind: 'relationship', targetSensor: 'T', category: 'performance' }),
        ];
        expect(sensorCategory(ms, 'zzz')).toBeNull();
        expect(sensorCategory([mk({ id: 'a', targetSensor: 'T' })], 't')).toBeNull();
        expect(sensorCategory(ms, 't')).toBe('performance');
        expect(sensorCategory([...ms, mk({ id: 'i', targetSensor: 'T', category: 'condition' })], 't')).toBe('condition');
    });
    it('reads across all FGs, not one', () => {
        const ms = [mk({ id: 'a', targetSensor: 'T', groupNos: [5], category: 'condition' })];
        expect(sensorCategory(ms, 't')).toBe('condition');
    });
    it('setSensorCategory writes every model of the key in every FG and nothing else', () => {
        const other = mk({ id: 'o', targetSensor: 'Other', category: 'condition' });
        const ms = [
            mk({ id: 'a', targetSensor: 'T', groupNos: [1] }),
            mk({ id: 'b', kind: 'clustering', xSensor: 't', groupNos: [2, 3] }),
            other,
        ];
        const next = setSensorCategory(ms, 't', 'performance');
        expect(next[0].category).toBe('performance');
        expect(next[1].category).toBe('performance');
        expect(next[2]).toBe(other);
        expect(ms[0].category).toBeNull(); // input untouched
    });
    it('returns the same array when nothing changes; can clear to null', () => {
        const ms = [mk({ id: 'a', targetSensor: 'T', category: 'condition' })];
        expect(setSensorCategory(ms, 't', 'condition')).toBe(ms);
        expect(setSensorCategory(ms, 't', null)[0].category).toBeNull();
        expect(setSensorCategory([], 't', 'condition')).toEqual([]);
    });
});

describe('normalizeSensorCategories', () => {
    it('no changes on empty / consistent / all-null input (same array returned)', () => {
        expect(normalizeSensorCategories([]).changes).toEqual([]);
        const ms = [mk({ id: 'a', targetSensor: 'T' }), mk({ id: 'b', kind: 'relationship', targetSensor: 'T' })];
        const r = normalizeSensorCategories(ms);
        expect(r.changes).toEqual([]);
        expect(r.models).toBe(ms);
        const ok = [mk({ id: 'a', targetSensor: 'T', category: 'condition' }), mk({ id: 'b', kind: 'relationship', targetSensor: 'T', category: 'condition' })];
        expect(normalizeSensorCategories(ok).models).toBe(ok);
    });
    it('resolves conflicts by I > R > C and reports each change', () => {
        const ms = [
            mk({ id: 'c', kind: 'clustering', xSensor: 'T', category: 'condition' }),
            mk({ id: 'r', kind: 'relationship', targetSensor: 'T', category: 'performance' }),
            mk({ id: 'i', targetSensor: 'T', category: null }),
        ];
        const { models, changes } = normalizeSensorCategories(ms);
        // Individual is null, so Relationship wins.
        expect(models.map((m) => m.category)).toEqual(['performance', 'performance', 'performance']);
        expect(changes).toEqual([
            { modelId: 'c', kind: 'clustering', sensorKey: 't', from: 'condition', to: 'performance' },
            { modelId: 'i', kind: 'individual', sensorKey: 't', from: null, to: 'performance' },
        ]);
    });
    it('groups clustering by X, so a clustering model does not affect its Y sensor row', () => {
        const ms = [
            mk({ id: 'i', targetSensor: 'Y', category: 'performance' }),
            mk({ id: 'c', kind: 'clustering', xSensor: 'X', ySensor: 'Y', category: 'condition' }),
        ];
        expect(normalizeSensorCategories(ms).changes).toEqual([]);
    });
    it('is idempotent', () => {
        const ms = [mk({ id: 'a', targetSensor: 'T', category: 'condition' }), mk({ id: 'b', kind: 'relationship', targetSensor: 'T' })];
        const once = normalizeSensorCategories(ms);
        const twice = normalizeSensorCategories(once.models);
        expect(twice.changes).toEqual([]);
        expect(twice.models).toEqual(once.models);
    });
    it('does not mutate its input and keeps other fields', () => {
        const a = mk({ id: 'a', targetSensor: 'T', category: 'condition', notes: 'n' });
        const b = mk({ id: 'b', kind: 'relationship', targetSensor: 'T', notes: 'keep' });
        const { models } = normalizeSensorCategories([a, b]);
        expect(b.category).toBeNull();
        expect(models[1]).toMatchObject({ id: 'b', notes: 'keep', category: 'condition' });
    });
});
