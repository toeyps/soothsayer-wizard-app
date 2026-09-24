import { describe, it, expect } from 'vitest';
import { findSameSensorNameConflict, suggestDistinctModelName } from '../utils/modelNames';
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

describe('suggestDistinctModelName', () => {
    it('appends the kind, then a counter if that is taken too', () => {
        const ind = mk({ id: 'i', name: 'TAG1' });
        const rel = mk({ id: 'r', kind: 'relationship', name: 'TAG1' });
        expect(suggestDistinctModelName([ind, rel], rel, 'TAG1')).toBe('TAG1 (Relationship)');
        const taken = mk({ id: 't', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', name: 'tag1 (relationship)' });
        expect(suggestDistinctModelName([ind, rel, taken], rel, 'TAG1')).toBe('TAG1 (Relationship) 2');
    });
});
