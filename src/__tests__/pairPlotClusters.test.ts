import { describe, it, expect } from 'vitest';
import {
    CLUSTER_NAME_MAX, CLUSTER_PALETTE, CLUSTER_PALETTE_HEX,
    cleanClusterName, nextClusterColour, nextClusterName,
} from '../components/charts/pairPlotClusters';
import { COLOUR_PALETTE } from '../components/sensor/ColourPicker';
import { hexToRgba, rgbaToHex } from '../components/charts/pairPlotColors';

const named = (...labels: string[]) => labels.map(label => ({ label }));
const coloured = (...hexes: string[]) => hexes.map(h => ({ color: hexToRgba(h) }));

describe('pairPlotClusters', () => {
    it('every default cluster colour is a swatch of the shared ColourPicker palette, in the old hue order', () => {
        for (const h of CLUSTER_PALETTE_HEX) expect(COLOUR_PALETTE as readonly string[]).toContain(h);
        expect(CLUSTER_PALETTE_HEX).toEqual(['#f59e0b', '#10b981', '#d946ef', '#f43f5e', '#06b6d4', '#f97316', '#84cc16', '#8b5cf6']);
        // Round-trips exactly, so the picker can mark the current colour.
        expect(CLUSTER_PALETTE.map(rgbaToHex)).toEqual([...CLUSTER_PALETTE_HEX]);
    });

    describe('nextClusterName', () => {
        it('starts at "Cluster 1"', () => {
            expect(nextClusterName([])).toBe('Cluster 1');
        });
        it('takes the smallest free number', () => {
            expect(nextClusterName(named('Cluster 1', 'Cluster 3'))).toBe('Cluster 2');
            expect(nextClusterName(named('Cluster 2'))).toBe('Cluster 1');
        });
        it('counts only names that are still exactly "Cluster N"', () => {
            expect(nextClusterName(named('Pump trip', 'cluster 1', 'Cluster 1 (old)'))).toBe('Cluster 1');
        });
    });

    describe('nextClusterColour', () => {
        it('takes the first palette colour no cluster uses', () => {
            expect(rgbaToHex(nextClusterColour([]))).toBe('#f59e0b');
            expect(rgbaToHex(nextClusterColour(coloured('#f59e0b', '#d946ef')))).toBe('#10b981');
            expect(rgbaToHex(nextClusterColour(coloured('#3b82f6')))).toBe('#f59e0b'); // a custom colour frees nothing
        });
        it('cycles by count once all eight are in use, and returns a fresh tuple', () => {
            const all = coloured(...CLUSTER_PALETTE_HEX);
            const c = nextClusterColour(all);
            expect(rgbaToHex(c)).toBe(CLUSTER_PALETTE_HEX[0]);
            expect(c).not.toBe(CLUSTER_PALETTE[0]);
        });
    });

    describe('cleanClusterName', () => {
        it('trims and caps at CLUSTER_NAME_MAX (40)', () => {
            expect(CLUSTER_NAME_MAX).toBe(40);
            expect(cleanClusterName('  Pump trip  ')).toBe('Pump trip');
            expect(cleanClusterName('y'.repeat(60))).toBe('y'.repeat(40));
            // A cut that lands on a space does not leave a trailing space.
            expect(cleanClusterName(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
        });
        it('empty or whitespace-only → null (keep the old name)', () => {
            expect(cleanClusterName('')).toBeNull();
            expect(cleanClusterName(' \t ')).toBeNull();
        });
    });
});
