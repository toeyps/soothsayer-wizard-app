import { describe, expect, it } from 'vitest';
import { TOOLTIP_ROW_MAX_PX, layoutTooltipRow, tooltipDistinctEnds } from '../utils/tooltipLayout';

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
    it('a `distinct` end follows the name and takes the place of the tag', () => {
        const r = layoutTooltipRow({ tag: `${LONG} - avg`, description: LONG, distinct: 'avg' }, opts);
        expect(r.name).toBe(`${LONG} · avg`);
        expect(r.tagShown).toBe(false);
    });
    it('a name that fits two lines prints whole', () => {
        const r = layoutTooltipRow({ tag: 'T', description: LONG, valueText: '1.5' }, opts);
        expect(r.wraps).toBe(true);
        expect(r.name).toBe(LONG);
    });
    it('a name too long for two lines keeps its start and its end, cut in the middle at a word', () => {
        const name = `${'Lube oil system main header supply pressure transmitter '.repeat(4)}- Segment No 7 - avg`;
        const r = layoutTooltipRow({ tag: name, valueText: '1.5' }, opts);
        expect(r.name.startsWith('Lube oil system')).toBe(true);
        expect(r.name.endsWith(' … Segment No 7 - avg')).toBe(true);
        expect(r.name.length).toBeLessThan(name.length);
    });
    it('a `distinct` end survives the cut', () => {
        const name = 'Lube oil system main header supply pressure transmitter '.repeat(4).trim();
        const r = layoutTooltipRow({ tag: `${name} - max`, description: name, distinct: 'max', valueText: '1.5' }, opts);
        expect(r.name).toContain(' … ');
        expect(r.name.endsWith('max')).toBe(true);
    });
});

describe('tooltipDistinctEnds', () => {
    const same = ['avg', 'max', 'min'].map(end => ({ tag: `${LONG} - ${end}`, description: LONG }));
    it('real data: same description, tags that differ at the end: each row gets its end', () => {
        const ends = tooltipDistinctEnds(same, opts);
        expect(same.map(r => ends.get(r.tag))).toEqual(['avg', 'max', 'min']);
    });
    it('the end starts at a word break, never inside a word', () => {
        const ends = tooltipDistinctEnds([
            { tag: 'A_LONG_TAG_NAME_THAT_HAS_NO_ROOM_IN_THE_ROW_AT_ALL_TE101', description: LONG },
            { tag: 'A_LONG_TAG_NAME_THAT_HAS_NO_ROOM_IN_THE_ROW_AT_ALL_TE102', description: LONG },
        ], opts);
        expect(ends.get('A_LONG_TAG_NAME_THAT_HAS_NO_ROOM_IN_THE_ROW_AT_ALL_TE101')).toBe('TE101');
    });
    it('tags that fit change nothing, even with the same description', () => {
        expect(tooltipDistinctEnds([{ tag: 'T1', description: 'Pump' }, { tag: 'T2', description: 'Pump' }], opts).size).toBe(0);
    });
    it('different descriptions and rule 3b rows change nothing', () => {
        expect(tooltipDistinctEnds([{ tag: `${LONG} - a`, description: `${LONG} A` }, { tag: `${LONG} - b`, description: `${LONG} B` }], opts).size).toBe(0);
        expect(tooltipDistinctEnds([{ tag: `${LONG} - a`, description: LONG, tagHidden: true }, { tag: `${LONG} - b`, description: LONG, tagHidden: true }], opts).size).toBe(0);
    });
});
