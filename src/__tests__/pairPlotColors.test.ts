import { describe, it, expect } from 'vitest';
import { CANVAS_BG, CANVAS_BG_HEX, correlationGradientHex, hexToRgba, hexToRgbaCss, rgbaToHex } from '../components/charts/pairPlotColors';

describe('hexToRgba', () => {
    it('converts a hex colour to 0..1 RGBA, defaulting alpha to 1', () => {
        expect(hexToRgba('#6366f1')).toEqual([0x63 / 255, 0x66 / 255, 0xf1 / 255, 1]);
    });

    it('applies a custom alpha', () => {
        expect(hexToRgba('#000000', 0.55)).toEqual([0, 0, 0, 0.55]);
    });
});

describe('rgbaToHex', () => {
    it('round-trips a known colour back to its hex string', () => {
        expect(rgbaToHex([0.39, 0.58, 0.98, 0.55])).toBe('#6394fa');
    });

    it('rounds fractional channel values', () => {
        expect(rgbaToHex([1, 0, 0, 1])).toBe('#ff0000');
    });
});

describe('hexToRgbaCss', () => {
    it('produces a CSS rgba() string at the given alpha', () => {
        expect(hexToRgbaCss('#10b981', 0.4)).toBe('rgba(16, 185, 129, 0.4)');
    });
});

describe('CANVAS_BG / CANVAS_BG_HEX', () => {
    it('dark is pure black, light is pure white, and the two stay in sync', () => {
        expect(CANVAS_BG_HEX.dark).toBe('#000000');
        expect(CANVAS_BG_HEX.light).toBe('#ffffff');
        expect(CANVAS_BG.dark).toEqual([0, 0, 0, 1]);
        expect(CANVAS_BG.light).toEqual([1, 1, 1, 1]);
    });
});

describe('correlationGradientHex', () => {
    it('is red at t=0 (no correlation)', () => {
        expect(correlationGradientHex(0)).toBe('#ef4444');
    });

    it('is amber at t=0.5 (the midpoint)', () => {
        expect(correlationGradientHex(0.5)).toBe('#f59e0b');
    });

    it('is green at t=1 (a perfect correlation, either direction)', () => {
        expect(correlationGradientHex(1)).toBe('#10b981');
    });

    it('interpolates between red and amber below the midpoint', () => {
        expect(correlationGradientHex(0.25)).toBe('#f27128');
    });

    it('interpolates between amber and green above the midpoint', () => {
        expect(correlationGradientHex(0.75)).toBe('#83ac46');
    });

    it('clamps values below 0 to the red endpoint', () => {
        expect(correlationGradientHex(-0.3)).toBe('#ef4444');
    });

    it('clamps values above 1 to the green endpoint', () => {
        expect(correlationGradientHex(1.5)).toBe('#10b981');
    });
});
