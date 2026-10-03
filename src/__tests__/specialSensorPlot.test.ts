import { describe, it, expect } from 'vitest';
import { mergeIntoPlot } from '../utils/specialSensorPlot';

describe('mergeIntoPlot', () => {
    it('appends new tags after the current selection, keeping its order', () => {
        expect(mergeIntoPlot(['B', 'A'], ['C'])).toEqual({ next: ['B', 'A', 'C'], added: ['C'], blocked: [] });
    });

    it('does not touch the current selection when there is nothing to add', () => {
        const current = ['A', 'B'];
        const { next, added } = mergeIntoPlot(current, []);
        expect(next).toEqual(['A', 'B']);
        expect(added).toEqual([]);
    });

    it('dedupes case-insensitively against the current selection and within the delta', () => {
        const { next, added } = mergeIntoPlot(['TAG1'], ['tag1', 'Calc', 'CALC', ' calc ']);
        expect(next).toEqual(['TAG1', 'Calc']);
        expect(added).toEqual(['Calc']);
    });

    it('ignores blank tags', () => {
        expect(mergeIntoPlot([], ['', '  ']).next).toEqual([]);
    });

    it('with no cap, adds everything', () => {
        expect(mergeIntoPlot(['A', 'B', 'C', 'D'], ['E', 'F']).next).toHaveLength(6);
    });

    it('stops at the cap and reports the overflow in `blocked`, in the order given', () => {
        const r = mergeIntoPlot(['A', 'B', 'C'], ['D', 'E', 'F'], 4);
        expect(r.next).toEqual(['A', 'B', 'C', 'D']);
        expect(r.added).toEqual(['D']);
        expect(r.blocked).toEqual(['E', 'F']);
    });

    it('blocks everything when the selection is already at the cap', () => {
        const r = mergeIntoPlot(['A', 'B', 'C', 'D'], ['E'], 4);
        expect(r.next).toEqual(['A', 'B', 'C', 'D']);
        expect(r.blocked).toEqual(['E']);
    });

    it('a tag that is already plotted is neither added nor "blocked" when the cap is full', () => {
        const r = mergeIntoPlot(['A', 'B', 'C', 'D'], ['a'], 4);
        expect(r.blocked).toEqual([]);
        expect(r.added).toEqual([]);
    });

    it('does not mutate its input', () => {
        const current = ['A'];
        mergeIntoPlot(current, ['B']);
        expect(current).toEqual(['A']);
    });
});
