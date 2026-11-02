import { describe, expect, it } from 'vitest';
import {
    axisNamePatch,
    fitAxisName,
    getAxisNames,
    scatterAxisTitle,
    withAxisNames,
    wrapAxisName,
} from '../utils/axisName';

/** 6 px per character, whatever the font. */
const measure = (t: string) => t.length * 6;
const FONT = '10px x';
const chars = (n: number) => n * 6;
const fits = (lines: string[], n: number) => lines.forEach(l => expect(l.length).toBeLessThanOrEqual(n));

const LONG = { tag: 'T1', description: 'Crosshead (P-P Trend) - Vibration crosshead slide 11A - Segment No 1 - avg', unit: 'mm/s' };

describe('wrapAxisName', () => {
    it('prints a title that fits unchanged, on one line', () => {
        expect(wrapAxisName({ tag: 'T', description: 'Pump A', unit: 'bar' }, chars(30), FONT, measure))
            .toEqual({ lines: ['Pump A · bar'], cut: false });
    });
    it('falls back to the tag when there is no description', () => {
        expect(wrapAxisName({ tag: 'T1', unit: 'bar' }, chars(30), FONT, measure).lines).toEqual(['T1 · bar']);
    });
    it('takes a " - " break first, even when a word break would be more even', () => {
        const { lines, cut } = wrapAxisName({ tag: 'T', description: 'Short head - a much longer second part of the name here' }, chars(46), FONT, measure);
        expect(lines).toEqual(['Short head -', 'a much longer second part of the name here']);
        expect(cut).toBe(false);
    });
    it('never starts line 2 with a separator', () => {
        for (const room of [30, 36, 40, 44, 50, 60]) {
            const { lines } = wrapAxisName(LONG, chars(room), FONT, measure);
            if (lines[1]) expect(lines[1]).not.toMatch(/^(… )?[-–—·|/] /);
        }
    });
    it('keeps the unit with the last word', () => {
        const { lines } = wrapAxisName(LONG, chars(48), FONT, measure);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatch(/avg · mm\/s$/);
        fits(lines, 48);
    });
    it('breaks a name with no spaces after _ . -', () => {
        const name = 'VIBRATION_CROSSHEAD_SLIDE.SEGMENT-1';
        const { lines, cut } = wrapAxisName({ tag: name }, chars(26), FONT, measure);
        expect(lines).toHaveLength(2);
        expect(cut).toBe(false);
        expect(lines[0] + lines[1]).toBe(name);
        expect(lines[0]).toMatch(/[_.-]$/);
    });
    it('overflow: line 1 keeps the start, line 2 reads "… end · unit" in whole words', () => {
        const { lines, cut } = wrapAxisName(LONG, chars(30), FONT, measure);
        expect(cut).toBe(true);
        expect(lines).toHaveLength(2);
        expect(LONG.description.startsWith(lines[0])).toBe(true);
        expect(lines[1].startsWith('… ')).toBe(true);
        expect(lines[1].endsWith('avg · mm/s')).toBe(true);
        const end = lines[1].slice(2).replace(' · mm/s', '');
        expect(LONG.description.endsWith(` ${end}`)).toBe(true);
        fits(lines, 30);
    });
    it('overflow never leaves the unit alone on line 2', () => {
        const { lines } = wrapAxisName({ tag: 'T', description: 'aaaa bbbb cccc dddd eeee ffff gggg', unit: 'mm/s' }, chars(16), FONT, measure);
        expect(lines[1]).toBe('… gggg · mm/s');
    });
    it('overflow of a no-space name keeps whole parts too', () => {
        const { lines, cut } = wrapAxisName({ tag: 'AAAAAAAA_BBBBBBBB_CCCCCCCC_DDDDDDDD', unit: 'bar' }, chars(18), FONT, measure);
        expect(cut).toBe(true);
        expect(lines).toEqual(['AAAAAAAA_BBBBBBBB_', '… DDDDDDDD · bar']);
    });
    it('falls back to one fitted line when not even the first word fits', () => {
        const { lines, cut } = wrapAxisName({ tag: 'T', description: 'Supercalifragilistic word', unit: 'x' }, chars(12), FONT, measure);
        expect(lines).toHaveLength(1);
        expect(cut).toBe(true);
    });
    it('no room known: the whole title', () => {
        expect(wrapAxisName(LONG, 0, FONT, measure).lines).toHaveLength(1);
    });
});

describe('fitAxisName', () => {
    it('is unchanged when it fits', () => {
        expect(fitAxisName({ tag: 'T', description: 'Pump A', unit: 'bar' }, chars(30), FONT, measure)).toBe('Pump A · bar');
    });
    it('cuts the middle: tail and unit stay, the head ends at a whole word, one space after "…"', () => {
        const out = fitAxisName(LONG, chars(50), FONT, measure);
        expect(out).toBe('Crosshead (P-P Trend)… Segment No 1 - avg · mm/s');
        expect(out.length).toBeLessThanOrEqual(50);
    });
    it('drops a head under 8 characters', () => {
        const out = fitAxisName(LONG, chars(32), FONT, measure);
        expect(out).toBe('… Segment No 1 - avg · mm/s');
    });
    it('end-cuts a name with no spaces; the unit stays', () => {
        const out = fitAxisName({ tag: 'VIBRATION_CROSSHEAD_SLIDE_11A_SEGMENT_1', unit: 'mm' }, chars(20), FONT, measure);
        expect(out.endsWith('… · mm')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(20);
    });
});

describe('scatterAxisTitle', () => {
    const opts = { fontFamily: 'Inter', monoFamily: 'mono', measure };
    it('null when the name fits: the normal markup stays', () => {
        expect(scatterAxisTitle({ tag: 'T1', description: 'Pump A', unit: 'bar' }, 300, opts))
            .toEqual({ wrapped: null, cut: false, tagLine: true });
        expect(scatterAxisTitle({ tag: 'T1', unit: 'bar' }, 300, opts).wrapped).toBeNull();
    });
    it('a tag that only re-spells the description: no tag line, the unit joins the title', () => {
        const t = scatterAxisTitle({ tag: 'Pump A', description: 'PumpA', tagHidden: true, unit: 'bar' }, 300, opts);
        expect(t.tagLine).toBe(false);
        expect(t.wrapped).toEqual(['PumpA · bar']);
    });
    it('one line in the free column keeps the tag line and the unit beside the tag', () => {
        const info = { tag: 'T1', description: 'd'.repeat(60), unit: 'bar' };
        const t = scatterAxisTitle(info, 200, { ...opts, chartRoom: 400 });
        expect(t).toEqual({ wrapped: [info.description], cut: false, tagLine: true, unitOnTagLine: true });
    });
    it('wraps a long title to two lines', () => {
        const t = scatterAxisTitle(LONG, 200, { ...opts, chartRoom: 300 });
        expect(t.tagLine).toBe(true);
        expect(t.wrapped).toHaveLength(2);
    });
});

describe('axisNamePatch', () => {
    const option = { grid: { left: 58, right: 18, top: 14, bottom: 40 }, yAxis: {}, xAxis: {} };
    it('a Y title that fits: no line height, no grid change', () => {
        const { patch, wrapped } = axisNamePatch({ y: { tag: 'T', description: 'Pump A' } }, option, 600, 400, false, measure);
        expect(wrapped).toBe(false);
        expect(patch).toEqual({ yAxis: { name: 'Pump A' } });
    });
    it('a wrapped Y title joins with \\n, sets line height, and the plot gives up one line', () => {
        const { patch, wrapped } = axisNamePatch({ y: LONG }, option, 600, 300, false, measure);
        expect(wrapped).toBe(true);
        const y = patch.yAxis as { name: string; nameTextStyle: { lineHeight: number } };
        expect(y.name.split('\n')).toHaveLength(2);
        expect(y.nameTextStyle.lineHeight).toBe(13);
        expect(patch.grid).toEqual({ left: 71 });
    });
    it('resets line height when the title returns to one line', () => {
        const { patch } = axisNamePatch({ y: { tag: 'T' } }, option, 600, 300, true, measure);
        expect(patch.yAxis).toEqual({ name: 'T', nameTextStyle: { lineHeight: null } });
        expect(patch.grid).toEqual({ left: 58 });
    });
    it('the X title keeps one line', () => {
        const { patch } = axisNamePatch({ x: LONG }, option, 400, 300, false, measure);
        expect((patch.xAxis as { name: string }).name).not.toContain('\n');
    });
});

describe('withAxisNames / getAxisNames', () => {
    it('marks an option without changing what it serialises to', () => {
        const opt = withAxisNames({ a: 1 }, { y: { tag: 'T' } });
        expect(getAxisNames(opt)).toEqual({ y: { tag: 'T' } });
        expect(JSON.stringify(opt)).toBe('{"a":1}');
        expect(getAxisNames({})).toBeNull();
        expect(getAxisNames(null)).toBeNull();
    });
});
