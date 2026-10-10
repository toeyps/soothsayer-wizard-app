import { describe, it, expect } from 'vitest';
import { findSameSensorNameConflict, kindModelName, MODEL_KIND_LABEL, suggestDistinctModelName } from '../utils/modelNames';
import type { FailureModel } from '../types';

const mk = (o: Partial<FailureModel>): FailureModel => ({
    id: 'x', name: 'n', kind: 'individual', targetSensor: 'TAG1', xSensor: '', groupNos: [1], ...o,
} as FailureModel);

describe('findSameSensorNameConflict', () => {
    const ind = mk({ id: 'i', name: 'Temp_1' });
    const rel = mk({ id: 'r', kind: 'relationship', name: 'Other' });
    it('matches same sensor, trimmed and case-insensitive', () => {
        expect(findSameSensorNameConflict([ind, rel], rel, '  temp_1 ')?.id).toBe('i');
    });
    it('ignores itself, other sensors, empty names and unset key sensor', () => {
        expect(findSameSensorNameConflict([ind], ind, 'Temp_1')).toBeNull();
        expect(findSameSensorNameConflict([ind, mk({ id: 'o', targetSensor: 'TAG2' })], mk({ id: 'o', targetSensor: 'TAG2' }), 'Temp_1')).toBeNull();
        expect(findSameSensorNameConflict([ind], rel, '   ')).toBeNull();
        expect(findSameSensorNameConflict([mk({ id: 'e', targetSensor: '', name: '' })], mk({ id: 'z', targetSensor: '' }), 'a')).toBeNull();
    });
    it('keys clustering by its X sensor', () => {
        const clu = mk({ id: 'c', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', name: 'Same' });
        expect(findSameSensorNameConflict([clu], ind, 'same')?.id).toBe('c');
    });
});

describe('kind names (user decision 2026-10-10: "Relation model" in the whole app)', () => {
    it('MODEL_KIND_LABEL says Individual / Relation model / Clustering', () => {
        expect(MODEL_KIND_LABEL).toEqual({ individual: 'Individual', relationship: 'Relation model', clustering: 'Clustering' });
    });
    it('kindModelName reads as a noun in a sentence, never "Relation model model"', () => {
        expect(kindModelName('individual')).toBe('Individual model');
        expect(kindModelName('relationship')).toBe('Relation model');
        expect(kindModelName('clustering')).toBe('Clustering model');
    });
});

describe('suggestDistinctModelName', () => {
    it('appends the kind, then a counter if that is taken too', () => {
        const ind = mk({ id: 'i', name: 'TAG1' });
        const rel = mk({ id: 'r', kind: 'relationship', name: 'TAG1' });
        expect(suggestDistinctModelName([ind, rel], rel, 'TAG1')).toBe('TAG1 (Relation model)');
        const taken = mk({ id: 't', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', name: 'tag1 (relation model)' });
        expect(suggestDistinctModelName([ind, rel, taken], rel, 'TAG1')).toBe('TAG1 (Relation model) 2');
        // the other kinds keep their word
        expect(suggestDistinctModelName([ind, rel], ind, 'TAG1')).toBe('TAG1 (Individual)');
        const clu = mk({ id: 'c', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', name: 'TAG1' });
        expect(suggestDistinctModelName([ind, rel, clu], clu, 'TAG1')).toBe('TAG1 (Clustering)');
    });

    describe('a workspace saved before the wording change (names ending "(Relationship)")', () => {
        const ind = mk({ id: 'i', name: 'TAG1' });
        const rel = mk({ id: 'r', kind: 'relationship', name: 'TAG1' });
        // Saved back then by accepting the old suggestion on another model of the same sensor.
        const legacy = mk({ id: 'l', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', name: 'TAG1 (Relationship)' });

        it('never proposes the twin of a legacy name: "TAG1 (Relationship)" taken -> "TAG1 (Relation model) 2"', () => {
            expect(suggestDistinctModelName([ind, rel, legacy], rel, 'TAG1')).toBe('TAG1 (Relation model) 2');
        });
        it('counts through both spellings, case-insensitively', () => {
            const legacy2 = mk({ id: 'l2', name: 'tag1 (relationship) 2' });
            const new3 = mk({ id: 'n3', name: 'TAG1 (Relation model) 3' });
            expect(suggestDistinctModelName([ind, rel, legacy, legacy2, new3], rel, 'TAG1')).toBe('TAG1 (Relation model) 4');
        });
        it('a legacy name on ANOTHER sensor, or on the model itself, does not move the counter', () => {
            const other = mk({ id: 'o', targetSensor: 'TAG2', name: 'TAG1 (Relationship)' });
            expect(suggestDistinctModelName([ind, rel, other], rel, 'TAG1')).toBe('TAG1 (Relation model)');
            const self = mk({ id: 'r', kind: 'relationship', name: 'TAG1 (Relationship)' });
            expect(suggestDistinctModelName([ind, self], self, 'TAG1')).toBe('TAG1 (Relation model)');
        });
        it('the legacy word is only the Relation model\'s: an Individual suggestion ignores it', () => {
            expect(suggestDistinctModelName([ind, rel, legacy], ind, 'TAG1')).toBe('TAG1 (Individual)');
        });
        it('the duplicate-name check stays exact text: the two spellings are different names, so nothing saved starts being blocked', () => {
            expect(findSameSensorNameConflict([ind, rel, legacy], rel, 'TAG1 (Relation model)')).toBeNull();
            expect(findSameSensorNameConflict([ind, rel, legacy], rel, 'TAG1 (Relationship)')?.id).toBe('l');
        });
        it('reads the models without changing them (a saved name is the user\'s data)', () => {
            const models = [ind, rel, legacy];
            const before = JSON.stringify(models);
            suggestDistinctModelName(models, rel, 'TAG1');
            findSameSensorNameConflict(models, rel, 'TAG1 (Relation model)');
            expect(JSON.stringify(models)).toBe(before);
        });
    });
});
