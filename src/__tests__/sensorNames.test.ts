import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    afterPrefix,
    commonPrefix,
    compactName,
    displayedName,
    familyPrefix,
    namesAfterPrefix,
    sameNameLoosely,
    splitInSet,
    splitKey,
    splitName,
    widerTailForms,
    withWiderTail,
} from '../utils/sensorNames';

const rebuilt = (s: { pre?: string; head: string; tail: string }) => (s.pre ?? '') + s.head + s.tail;

/** The visible text of every row of a set at its narrowest allowed form. */
function visibleRows(names: string[], extra: string[] = []): string[] {
    const set = [...names, ...extra];
    return names.map(n => compactName(splitInSet(n, set)));
}
const expectAllDifferent = (rows: string[]) => expect(new Set(rows).size).toBe(rows.length);

const CROSSHEAD = 'Crosshead (P-P Trend) - Vibration crosshead slide';
const MEDIUM = ['A', 'B'].flatMap(p => ['DE', 'NDE'].map(d => `Boiler feed pump ${p} - Motor bearing ${d} temperature`));
const LONG = ['11A', '11B'].flatMap(s => ['1', '2'].map(n => `${CROSSHEAD} ${s} - Segment No ${n} - avg`));

describe('displayedName', () => {
    it('is the description, or the tag when there is none', () => {
        expect(displayedName({ tag: 'T1', description: 'Pump' })).toBe('Pump');
        expect(displayedName({ tag: 'T1' })).toBe('T1');
        expect(displayedName({ tag: 'T1', description: '' })).toBe('T1');
    });
});

describe('sameNameLoosely (rule 3b)', () => {
    it('ignores spaces, punctuation and case', () => {
        expect(sameNameLoosely('SegmentNo 1', 'Segment No 1')).toBe(true);
        expect(sameNameLoosely('PUMP_A-01', 'pump a 01')).toBe(true);
    });
    it('keeps names that really differ apart', () => {
        expect(sameNameLoosely('Segment No 1', 'Segment No 2')).toBe(false);
        expect(sameNameLoosely('Pump A', undefined)).toBe(false);
        expect(sameNameLoosely('', '')).toBe(false);
        expect(sameNameLoosely('---', '...')).toBe(false);
    });
    it('does not treat Thai tone marks as punctuation', () => {
        expect(sameNameLoosely('ปั๊ม', 'ปั้ม')).toBe(false);
        expect(sameNameLoosely('ปั๊ม 1', 'ปั๊ม1')).toBe(true);
    });
});

describe('splitName (rule 1)', () => {
    it('never splits a name of 28 characters or fewer', () => {
        const name = 'Pump A - bearing - DE temp 1';
        expect(name).toHaveLength(28);
        expect(splitName(name)).toEqual({ head: '', tail: name, shared: false });
    });
    it('keeps the longest run of trailing segments up to 28 characters', () => {
        const sp = splitName(`${CROSSHEAD} 11A - Segment No 1 - avg`);
        expect(sp.tail.trimStart()).toBe('Segment No 1 - avg');
        expect(sp.head).toBe(`${CROSSHEAD} 11A -`);
    });
    it('cuts a name with no separator at a word boundary, never mid-word', () => {
        const name = 'Lube oil supply header pressure after the duplex filter';
        const sp = splitName(name);
        expect(sp.tail.trimStart().length).toBeLessThanOrEqual(28);
        expect(name.endsWith(` ${sp.tail.trimStart()}`)).toBe(true);
        expect(rebuilt(sp)).toBe(name);
    });
    it('end-cuts a name with no spaces (no split at all)', () => {
        const name = 'VIBRATION_CROSSHEAD_SLIDE_11A_SEGMENT_NO_1_AVG';
        expect(splitName(name).head).toBe('');
    });
    it("uses the name's own separator for a shared prefix", () => {
        const sp = splitName('Long shared start / the rest of it', 'Long shared start');
        expect(sp).toEqual({ head: 'Long shared start /', tail: ' the rest of it', shared: true });
    });
    it('reproduces the name exactly (a name that fits prints as is)', () => {
        for (const n of [...MEDIUM, ...LONG, 'Short']) expect(rebuilt(splitName(n))).toBe(n);
    });
});

describe('splitInSet (rule 3)', () => {
    it('A/B × DE/NDE: every visible row reads differently', () => {
        const rows = visibleRows(MEDIUM);
        expectAllDifferent(rows);
        expect(rows[0]).toBe('Boiler feed pump A … DE temperature');
        expect(rows[3]).toBe('Boiler feed pump B … NDE temperature');
    });
    it('11A/11B × Seg 1/2: every visible row reads differently and shows both differences', () => {
        const rows = visibleRows(LONG);
        expectAllDifferent(rows);
        expect(rows[0]).toContain('11A');
        expect(rows[0]).toContain('Segment No 1');
        expect(rows[3]).toContain('11B');
        expect(rows[3]).toContain('Segment No 2');
    });
    it('11A/11B × Seg 1/2 × avg/max/min stays unique', () => {
        const names = ['11A', '11B'].flatMap(s => ['1', '2'].flatMap(n => ['avg', 'max', 'min'].map(a => `${CROSSHEAD} ${s} - Segment No ${n} - ${a}`)));
        expectAllDifferent(visibleRows(names));
    });
    it('a model target in the set: a chip can never read like the target', () => {
        const target = `${CROSSHEAD} 11A - Segment No 1 - max`;
        const chips = [`${CROSSHEAD} 11A - Segment No 1 - avg`, `${CROSSHEAD} 11B - Segment No 1 - max`];
        const rows = visibleRows(chips, [target]);
        const targetRow = compactName(splitInSet(target, [...chips, target]));
        expectAllDifferent([...rows, targetRow]);
        // The second chip differs from the target only at 11A/11B, so it must show it.
        expect(rows[1]).toContain('11B');
    });
    it('a tail alone carrying the difference starts at its segment up to 40 characters', () => {
        const a = 'Turbine lube oil cooler - Cooling water outlet temperature A';
        const b = 'Turbine lube oil cooler - Cooling water outlet temperature B';
        expect(compactName(splitInSet(a, [a, b]))).toBe('… Cooling water outlet temperature A');
    });
    it('reproduces the name exactly and never splits a short name', () => {
        for (const n of [...MEDIUM, ...LONG]) expect(rebuilt(splitInSet(n, MEDIUM.concat(LONG)))).toBe(n);
        expect(splitInSet('Pump A', ['Pump A', 'Pump B']).head).toBe('');
    });
    it('gives a two-line form: start on line 1, distinguishing end on line 2', () => {
        const sp = splitInSet(MEDIUM[0], MEDIUM);
        expect(sp.pre).toBe('Boiler feed pump A');
        expect(sp.tail2).toContain('DE temperature');
        expect((sp.pre ?? '') + sp.head2 + ' ' + sp.tail2).toBe(MEDIUM[0]);
    });
    it('a set with no other names behaves like rule 1', () => {
        expect(splitInSet(LONG[0], [])).toEqual(splitName(LONG[0]));
        expect(splitInSet(LONG[0], [LONG[0]])).toEqual(splitName(LONG[0]));
    });
});

describe('splitInSet cache', () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const SET = [...MEDIUM, ...LONG, `${CROSSHEAD} 11C - Segment No 3 - min`];

    it('splits the other names into words once per names array', () => {
        const names = [...SET];
        const split = vi.spyOn(String.prototype, 'split');
        splitInSet(names[0], names);
        const first = split.mock.calls.length;
        expect(first).toBe(names.length);
        for (const n of names) splitInSet(n, names);
        expect(split.mock.calls.length).toBe(first);
    });
    it('gives the same object back for the same name, array and prefix', () => {
        const names = [...SET];
        expect(splitInSet(names[0], names)).toBe(splitInSet(names[0], names));
    });
    it('a shared array gives exactly what a fresh array gives, in any order', () => {
        const shared = [...SET];
        const reversed = [...SET].reverse();
        for (const n of reversed) {
            expect(splitInSet(n, shared)).toEqual(splitInSet(n, [...SET]));
            expect(splitInSet(n, reversed)).toEqual(splitInSet(n, [...SET]));
        }
    });
    it('a different prefix on the same array cannot return the other prefix\'s result', () => {
        const names = [...SET];
        const prefix = `${CROSSHEAD} 11A`;
        const name = `${prefix} - Segment No 1 - avg`;
        const plain = splitInSet(name, names);
        const shared = splitInSet(name, names, prefix);
        expect(shared.shared).toBe(true);
        expect(plain.shared).toBe(false);
        expect(splitInSet(name, names)).toBe(plain);
        // A prefix this name does not start with: not shared, but stored under its own key.
        const other = splitInSet(name, names, 'Some other start');
        expect(other).toEqual(splitInSet(name, [...names], 'Some other start'));
    });
    it('another array with the same names is computed for itself', () => {
        const a = [LONG[0], LONG[1]];
        const b = [LONG[0], LONG[2]];
        expect(splitInSet(LONG[0], a)).toEqual(splitInSet(LONG[0], [...a]));
        expect(compactName(splitInSet(LONG[0], b))).toContain('11A');
    });
    it('duplicates and empty names in the set change nothing', () => {
        const name = LONG[0];
        expect(splitInSet(name, [name, '', LONG[1], LONG[1], LONG[2], LONG[3], name]))
            .toEqual(splitInSet(name, [LONG[1], LONG[2], LONG[3]]));
    });
});

describe('namesAfterPrefix', () => {
    const prefix = `${CROSSHEAD} 11A`;
    const names = [`${prefix} - Segment No 1 - avg`, `${prefix} - Segment No 2 - avg`, 'Other'];
    it('is afterPrefix over the set', () => {
        expect(namesAfterPrefix(names, prefix)).toEqual(names.map(n => afterPrefix(n, prefix)));
    });
    it('rows of a set share one array, so the split cache works for them', () => {
        const a = namesAfterPrefix(names, prefix);
        expect(namesAfterPrefix(names, prefix)).toBe(a);
        expect(namesAfterPrefix(names, 'Other')).not.toBe(a);
        expect(namesAfterPrefix([...names], prefix)).not.toBe(a);
    });
});

describe('widerTailForms / withWiderTail', () => {
    const sp = splitInSet(LONG[0], LONG);
    const { forms, starts } = widerTailForms(sp);
    it('form 0 is the compact text; later forms pull whole words back', () => {
        expect(forms[0]).toBe(compactName(sp));
        for (let i = 1; i < forms.length; i++) expect(forms[i].length).toBeGreaterThan(forms[i - 1].length);
        expect(forms[1]).toBe(`… slide ${LONG[0].slice(LONG[0].indexOf('11A'))}`);
    });
    it('no form starts its tail at a bare separator', () => {
        for (const f of forms) expect(f).not.toMatch(/^… [-–—·|/] /);
    });
    it('stops at the kept start', () => {
        const m = splitInSet(MEDIUM[0], MEDIUM);
        const f = widerTailForms(m).forms;
        expect(f[f.length - 1]).toBe('Boiler feed pump A … Motor bearing DE temperature');
    });
    it('withWiderTail prints the same text as its form and still rebuilds the name', () => {
        const wide = withWiderTail(sp, starts, 1);
        expect(compactName(wide)).toBe(forms[1]);
        expect(rebuilt(wide)).toBe(LONG[0]);
        expect(withWiderTail(sp, starts, 0)).toBe(sp);
    });
});

describe('commonPrefix / afterPrefix (rule 2)', () => {
    const names = ['avg', 'max', 'min'].map(a => `${CROSSHEAD} 11A - SegmentNo 1 - ${a}`);
    it('leaves each row a readable rest', () => {
        const p = commonPrefix(names);
        expect(p).toBe(`${CROSSHEAD} 11A`);
        expect(afterPrefix(names[0], p)).toBe('SegmentNo 1 - avg');
    });
    it('is empty for short names, a single name, or nothing shared', () => {
        expect(commonPrefix(['Pump A - in', 'Pump A - out'])).toBe('');
        expect(commonPrefix([names[0]])).toBe('');
        expect(commonPrefix([names[0], 'Totally different name that is quite long here'])).toBe('');
    });
    it('afterPrefix leaves a name without that prefix alone', () => {
        expect(afterPrefix('Other', 'Prefix')).toBe('Other');
        expect(afterPrefix('Other', '')).toBe('Other');
    });
    it("familyPrefix uses only the names in the first name's family", () => {
        expect(familyPrefix([...names, 'Generator active power output of the unit'])).toBe(`${CROSSHEAD} 11A`);
        expect(familyPrefix(['Generator active power output of the unit', ...names])).toBe('');
    });
});

describe('splitKey (rule 1, export keys)', () => {
    it('keeps the kind suffix and extension, cuts at a sanitized separator', () => {
        const sp = splitKey('Crosshead_P-P_Trend_-_Vibration_slide_11A_-_Segment_No_1_-_avg-R1', '.json');
        expect(sp.tail.endsWith('-R1.json')).toBe(true);
        expect(sp.tail.startsWith('Segment_No_1_-_avg')).toBe(true);
        expect(sp.head + sp.tail).toBe('Crosshead_P-P_Trend_-_Vibration_slide_11A_-_Segment_No_1_-_avg-R1.json');
    });
    it('treats _ as a word boundary when there is no separator', () => {
        const sp = splitKey('Lube_oil_supply_header_pressure_after_the_duplex_filter-I2');
        expect(sp.tail).toBe('after_the_duplex_filter-I2');
    });
    it('does not split a short key or one with no boundary', () => {
        expect(splitKey('PT101-R1', '.csv')).toEqual({ head: '', tail: 'PT101-R1.csv' });
        const noBoundary = 'A'.repeat(50);
        expect(splitKey(`${noBoundary}-C1`)).toEqual({ head: '', tail: `${noBoundary}-C1` });
    });
});
