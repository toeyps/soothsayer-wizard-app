import { describe, expect, it } from 'vitest';
import { TOOLTIP_ROW_MAX_PX, layoutTooltipRow, tooltipSharedPrefix } from '../utils/tooltipLayout';

const opts = { measure: (t: string) => t.length * 6, uiFamily: 'ui', monoFamily: 'mono' };
const LONG = 'Crosshead (P-P Trend) - Vibration crosshead slide 11A - SegmentNo 1';

describe('layoutTooltipRow', () => {
    it('a short row does not wrap and shows the whole tag', () => {
        const r = layoutTooltipRow({ tag: 'PT101', description: 'Pump A', valueText: '1.5' }, opts);
        expect(r.wraps).toBe(false);
        expect(r.tagShown).toBe(true);
        expect(r.tagRoomPx).toBe(30);
    });
    it('the description gets the room first; the tag takes what is left', () => {
        const r = layoutTooltipRow({ tag: 'A_VERY_LONG_TAG_NAME_THAT_SPENDS_ROOM', description: 'A description of fair length', valueText: '1.5' }, opts);
        expect(r.wraps).toBe(true);
        expect(r.nameRoomPx).toBeCloseTo(28 * 6 * 1.03);
        expect(r.tagRoomPx).toBeLessThan(37 * 6);
        expect(r.tagShown).toBe(true);
    });
    it('no room left: the tag is dropped, never run under the value', () => {
        const r = layoutTooltipRow({ tag: 'T-100', description: LONG, valueText: '1.5' }, opts);
        expect(r.tagShown).toBe(false);
        expect(r.tagRoomPx).toBe(0);
        // Swatch + name room + gap + value stay inside the row limit.
        expect(16 + r.nameRoomPx + 18 + 18).toBeLessThanOrEqual(TOOLTIP_ROW_MAX_PX);
    });
    it('a tag printed as the name is measured in mono and has no tag line', () => {
        const fonts: string[] = [];
        const r = layoutTooltipRow({ tag: 'PT101', valueText: '1' }, { ...opts, measure: (t, f) => { fonts.push(f); return t.length; } });
        expect(fonts[0]).toContain('mono');
        expect(r.tagShown).toBe(false);
        expect(r.name).toBe('PT101');
    });
    it('a hidden tag (rule 3b) is not printed', () => {
        expect(layoutTooltipRow({ tag: 'Pump A', description: 'PumpA', tagHidden: true }, opts).tagShown).toBe(false);
    });
    it('under a shared prefix the row prints the rest', () => {
        const r = layoutTooltipRow({ tag: 'T', description: `${LONG} - avg`, prefix: LONG }, opts);
        expect(r.name).toBe('avg');
    });
});

describe('tooltipSharedPrefix', () => {
    const rows = ['avg', 'max', 'min'].map(a => ({ tag: `${LONG} - ${a}` }));
    it('prints the prefix once only when a row would pass the limit', () => {
        expect(tooltipSharedPrefix(rows, opts)).toBe('Crosshead (P-P Trend) - Vibration crosshead slide 11A');
        const small = { ...opts, measure: (t: string) => t.length };
        expect(tooltipSharedPrefix(rows, small)).toBe('');
    });
    it('is empty for short names', () => {
        expect(tooltipSharedPrefix([{ tag: 'A1' }, { tag: 'A2' }], opts)).toBe('');
    });
});
