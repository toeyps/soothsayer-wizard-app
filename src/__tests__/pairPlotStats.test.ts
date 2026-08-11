import { describe, it, expect } from 'vitest';
import { pearsonCorrelation } from '../components/charts/pairPlotStats';

describe('pearsonCorrelation', () => {
    it('returns 1 for a perfect positive linear relationship', () => {
        const xs = [1, 2, 3, 4, 5];
        const ys = [2, 4, 6, 8, 10];
        expect(pearsonCorrelation(xs, ys)).toBeCloseTo(1, 10);
    });

    it('returns -1 for a perfect negative linear relationship', () => {
        const xs = [1, 2, 3, 4, 5];
        const ys = [10, 8, 6, 4, 2];
        expect(pearsonCorrelation(xs, ys)).toBeCloseTo(-1, 10);
    });

    it('returns a value close to 0 for uncorrelated data', () => {
        const xs = [1, 2, 3, 4, 5, 6];
        const ys = [3, 5, 2, 6, 1, 4];
        const r = pearsonCorrelation(xs, ys)!;
        expect(Math.abs(r)).toBeLessThan(0.3);
    });

    it('ignores rows where either series is NaN (pairwise-complete)', () => {
        const xs = [1, 2, NaN, 4, 5];
        const ys = [2, 4, 999, 8, 10];
        expect(pearsonCorrelation(xs, ys)).toBeCloseTo(1, 10);
    });

    it('ignores rows where either series is non-finite (Infinity)', () => {
        const xs = [1, 2, 3, 4, 5];
        const ys = [2, 4, Infinity, 8, 10];
        expect(pearsonCorrelation(xs, ys)).toBeCloseTo(1, 10);
    });

    it('returns null with fewer than 2 valid pairs', () => {
        expect(pearsonCorrelation([1], [2])).toBeNull();
        expect(pearsonCorrelation([], [])).toBeNull();
        expect(pearsonCorrelation([1, NaN, NaN], [2, 3, 4])).toBeNull();
    });

    it('returns null when one series has zero variance (constant)', () => {
        const xs = [5, 5, 5, 5];
        const ys = [1, 2, 3, 4];
        expect(pearsonCorrelation(xs, ys)).toBeNull();
    });

    it('handles mismatched-length arrays by comparing only the overlapping prefix', () => {
        const xs = [1, 2, 3];
        const ys = [2, 4, 6, 999, 999];
        expect(pearsonCorrelation(xs, ys)).toBeCloseTo(1, 10);
    });
});
