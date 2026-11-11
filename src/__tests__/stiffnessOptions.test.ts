import { describe, it, expect } from 'vitest';
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, STIFFNESS_LEGACY_DEFAULT, snapStiffness, stiffnessLabel } from '../components/reports/pmReportTypes';

describe('Relation model stiffness steps', () => {
    it('seven steps, one per decade from 0.1 to 100 000, loosest first', () => {
        expect(STIFFNESS_OPTIONS.map(o => o.value)).toEqual([0.1, 1, 10, 100, 1_000, 10_000, 100_000]);
        expect(STIFFNESS_OPTIONS.map(o => o.label)).toEqual(['Very loose', 'Loose', 'Slightly loose', 'Standard', 'Slightly strict', 'Strict', 'Very strict']);
        expect(stiffnessLabel(STIFFNESS_DEFAULT)).toBe('Standard');
    });

    it('keeps a step; snaps anything else to the nearest step on a log scale', () => {
        expect(snapStiffness(10)).toBe(10);
        expect(snapStiffness(1_000_000)).toBe(100_000); // the old "Strict"
        expect(snapStiffness(0.01)).toBe(0.1);
        expect(snapStiffness(250)).toBe(100);
        expect(snapStiffness(400)).toBe(1_000);
        expect(snapStiffness(0)).toBe(STIFFNESS_DEFAULT);
        expect(snapStiffness(Number.NaN)).toBe(STIFFNESS_DEFAULT);
    });

    it('a model saved without a stiffness still reads as the old default, so it does not go stale', () => {
        expect(STIFFNESS_LEGACY_DEFAULT).toBe(100_000);
        expect(stiffnessLabel(STIFFNESS_LEGACY_DEFAULT)).toBe('Very strict');
    });
});
