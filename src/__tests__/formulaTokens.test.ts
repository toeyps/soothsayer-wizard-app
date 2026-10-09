import { describe, it, expect } from 'vitest';
import {
    bracketPairAt, excelRoundCalls, formulaSensorRefs, hasTopLevelOperator, isFormulaAtom,
    referencedSensors, tokenAt, tokenizeFormula,
} from '../utils/formulaTokens';
import { formulaRefNames } from '../utils/formulaRefs';

const kinds = (f: string) => tokenizeFormula(f).map(t => [t.kind, t.text]);

describe('tokenizeFormula (twin of Rust formula_diagnostics::tokenize + scan_sensor_refs)', () => {
    it('keeps references, numbers and two-character operators whole (Rust test table)', () => {
        expect(kinds('${อุณหภูมิ ถัง} >= 2.5e-3*$A.PV && !$B')).toEqual([
            ['sensor', '${อุณหภูมิ ถัง}'],
            ['op', '>='],
            ['number', '2.5e-3'],
            ['op', '*'],
            ['sensor', '$A.PV'],
            ['op', '&&'],
            ['op', '!'],
            ['sensor', '$B'],
        ]);
    });

    it('reads sensor names exactly like Rust: dotted, Thai, braced, `-` ends a bare name', () => {
        const t = tokenizeFormula('$11PT1214A.PV + $อุณหภูมิ - ${Flow (m3/h)} + $Total-Power');
        const names = t.filter(x => x.kind === 'sensor').map(x => [x.name, x.braced]);
        expect(names).toEqual([['11PT1214A.PV', false], ['อุณหภูมิ', false], ['Flow (m3/h)', true], ['Total', false]]);
        // `-Power` after `$Total` is an operator and a word.
        expect(t.slice(-2).map(x => [x.kind, x.text])).toEqual([['op', '-'], ['word', 'Power']]);
    });

    it('agrees with formulaRefs.ts on the names referenced', () => {
        for (const f of ['$A + ${B c} * $A', '${x}${y}', '$_a.b.c + 1', '${} + $', '${unclosed + $Z']) {
            expect(formulaSensorRefs(f).map(r => r.name).filter((n, i, a) => a.indexOf(n) === i)).toEqual(formulaRefNames(f));
        }
    });

    it('an empty ${} or an unclosed ${ names nothing; its characters are bad tokens like in Rust', () => {
        expect(kinds('${} + 1')).toEqual([['bad', '$'], ['bad', '{'], ['bad', '}'], ['op', '+'], ['number', '1']]);
        expect(kinds('${ab')).toEqual([['bad', '$'], ['bad', '{'], ['word', 'ab']]);
        expect(kinds('$ + 1')[0]).toEqual(['bad', '$']);
    });

    it('numbers take an exponent or one SI suffix; anything else is a separate token', () => {
        expect(kinds('5k')).toEqual([['number', '5k']]);
        expect(kinds('2m')).toEqual([['number', '2m']]);
        expect(kinds('1e5k')).toEqual([['number', '1e5'], ['word', 'k']]);
        expect(kinds('2e')).toEqual([['number', '2'], ['word', 'e']]);
        expect(kinds('.5 1.2.3')).toEqual([['number', '.5'], ['number', '1.2.3']]);
    });

    it('a lone = & | is bad; == != <= && || ! are operators; ; separates like ,', () => {
        expect(kinds('= & | == != <= && || ! ;').map(k => k[0])).toEqual(
            ['bad', 'bad', 'bad', 'op', 'op', 'op', 'op', 'op', 'op', 'comma'],
        );
    });

    it('ranges are UTF-16 offsets (an emoji counts two, Thai one per character)', () => {
        const f = '${a😀} + $x';
        const t = tokenizeFormula(f);
        expect(t.map(x => [x.start, x.end])).toEqual([[0, 6], [7, 8], [9, 11]]);
        expect(f.slice(9, 11)).toBe('$x');
        expect(tokenizeFormula('${ถัง} + $x').map(x => [x.start, x.end])).toEqual([[0, 6], [7, 8], [9, 11]]);
    });

    it('annotates bracket depth and pairs; a wrong-kind or unmatched close is left unpaired', () => {
        const t = tokenizeFormula('max(($A + 1), [$B])');
        const br = t.filter(x => x.kind === 'open' || x.kind === 'close').map(x => [x.text, x.depth, x.pair]);
        // tokens: 0 max, 1 (, 2 (, 3 $A, 4 +, 5 1, 6 ), 7 ",", 8 [, 9 $B, 10 ], 11 )
        expect(br).toEqual([
            ['(', 0, 11], ['(', 1, 6], [')', 1, 2], ['[', 1, 10], [']', 1, 8], [')', 0, 1],
        ]);
        const bad = tokenizeFormula('($A]');
        expect(bad[0].pair).toBe(-1);
        expect(bad[2]).toMatchObject({ kind: 'close', pair: -1, depth: -1 });
    });

    it('marks a word followed by a bracket as a call (whitespace between allowed)', () => {
        const t = tokenizeFormula('abs ($A) + pi');
        expect(t[0]).toMatchObject({ kind: 'word', call: true });
        expect(t[t.length - 1]).toMatchObject({ kind: 'word', text: 'pi', call: false });
    });

    it('never throws on odd input', () => {
        for (const f of ['', '   ', '$', '${', '}}}', '((((', '\u0000', '$A'.repeat(500)]) {
            expect(() => tokenizeFormula(f)).not.toThrow();
        }
    });
});

describe('token helpers', () => {
    it('tokenAt finds the token under a position', () => {
        const t = tokenizeFormula('$A + 10');
        expect(t[tokenAt(t, 1)].text).toBe('$A');
        expect(tokenAt(t, 2)).toBe(-1); // the space
        expect(t[tokenAt(t, 6)].text).toBe('10');
    });

    it('bracketPairAt: a caret before / after either bracket, or a selection covering the pair', () => {
        const f = 'abs(($A + 1) * 2)';
        const t = tokenizeFormula(f);
        const at = (s: number, e = s) => bracketPairAt(t, s, e)?.map(k => t[k].start);
        expect(at(4)).toEqual([4, 11]);   // caret before the inner (
        expect(at(12)).toEqual([4, 11]);  // caret after the inner )
        expect(at(3)).toEqual([3, 16]);   // caret before the outer (
        expect(at(4, 12)).toEqual([4, 11]); // selection = ( … )
        expect(at(5, 12)).toBeUndefined();
        expect(at(7)).toBeUndefined();
    });

    it('referencedSensors: distinct names with the first occurrence', () => {
        expect(referencedSensors(tokenizeFormula('$B + $A * $B'))).toEqual([
            { name: 'B', start: 0, end: 2 }, { name: 'A', start: 5, end: 7 },
        ]);
    });

    it('hasTopLevelOperator ignores what is inside brackets', () => {
        expect(hasTopLevelOperator('$A + $B')).toBe(true);
        expect(hasTopLevelOperator('abs($A - $B)')).toBe(false);
        expect(hasTopLevelOperator('($A / $B) * 100')).toBe(true);
        expect(hasTopLevelOperator('-$A')).toBe(true);
        expect(hasTopLevelOperator('max($A, $B)')).toBe(false);
    });

    it('isFormulaAtom matches Rust is_formula_atom', () => {
        for (const f of ['$A', '${A b}', '2.5', 'abc', 'min($A, $B)', '($A + 1)', ' $A ', 'round[$A]', '2($A)']) {
            expect(isFormulaAtom(f), f).toBe(true);
        }
        for (const f of ['', '$A + 1', '-$A', '1e-3', 'abs($A) + 1', '(1) (2)', '$A(']) {
            expect(isFormulaAtom(f), f).toBe(false);
        }
    });

    it('excelRoundCalls: round(<expr with a sensor>, <expr without one>), outer first; names are never calls', () => {
        const f = 'round(round($A, 2) + $B, 1)';
        expect(excelRoundCalls(f).map(c => [f.slice(c.start, c.end), f.slice(c.x[0], c.x[1]), f.slice(c.n[0], c.n[1])])).toEqual([
            [f, 'round($A, 2) + $B', ' 1'],
            ['round($A, 2)', '$A', ' 2'],
        ]);
        expect(excelRoundCalls('round [ $A ; 3 ]')).toHaveLength(1);
        for (const f2 of ['round($A)', 'round(0.01, $A)', 'round($B, $A)', '${x round($A, 2)} * 2', '$round + round', 'around($A, 2)']) {
            expect(excelRoundCalls(f2), f2).toEqual([]);
        }
    });
});
