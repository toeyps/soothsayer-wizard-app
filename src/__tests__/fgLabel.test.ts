import { describe, expect, it } from 'vitest';
import { fgLabel } from '../utils/fgLabel';

describe('fgLabel', () => {
    it('shows the number and the name', () => {
        expect(fgLabel(2, 'Bearing wear')).toBe('FG-2 · Bearing wear');
    });
    it('does not repeat a default name that is only the number', () => {
        expect(fgLabel(1, 'FG-1')).toBe('FG-1');
        expect(fgLabel(1, ' fg-1 ')).toBe('FG-1');
    });
    it('keeps a name that only looks like another group number', () => {
        expect(fgLabel(1, 'FG-2')).toBe('FG-1 · FG-2');
    });
    it('falls back to the number when there is no name, and group 0 is Not in Group', () => {
        expect(fgLabel(3, '')).toBe('FG-3');
        expect(fgLabel(3, undefined)).toBe('FG-3');
        expect(fgLabel(0, 'anything')).toBe('Not in Group');
    });
});
