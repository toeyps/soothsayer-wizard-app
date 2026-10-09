import { describe, it, expect } from 'vitest';
import {
    convertLegacyRoundLocal, hasUnpairedBracket, rangeToBody, roundExpression, roundPlaces, splitRoundResult, withRoundResult,
} from '../utils/formulaRounding';

describe('roundExpression: the engine form round(X * 10^N) / 10^N, never round(0.01, X)', () => {
    it('brackets X unless it is one operand; 0 decimals is round(X)', () => {
        expect(roundExpression('$A', 2)).toBe('round($A * 100) / 100');
        expect(roundExpression('$A + $B', 1)).toBe('round(($A + $B) * 10) / 10');
        expect(roundExpression('abs($A - $B)', 3)).toBe('round(abs($A - $B) * 1000) / 1000');
        expect(roundExpression(' $A ', 0)).toBe('round($A)');
        expect(roundExpression('$A + 1', 0)).toBe('round($A + 1)');
        expect(() => roundExpression('$A', -1)).toThrow();
        expect(() => roundExpression('$A', 1.5)).toThrow();
    });
});

describe('"Round the result": withRoundResult / splitRoundResult / rangeToBody', () => {
    it('applies the setting and reports where the body sits in the stored text', () => {
        expect(withRoundResult('  $A + $B ', 2)).toEqual({ formula: 'round(($A + $B) * 100) / 100', bodyStart: 7, bodyLead: 2, bodyLength: 7 });
        expect(withRoundResult('$A', 1)).toMatchObject({ formula: 'round($A * 10) / 10', bodyStart: 6 });
        expect(withRoundResult('$A + 1', null)).toMatchObject({ formula: '$A + 1', bodyStart: 0 });
        expect(withRoundResult('', 2).formula).toBe('');
    });

    it('never wraps a body with an unpaired bracket (the wrapper could pair with it and hide the mistake)', () => {
        for (const body of ['$A) + ($B', '(($A + $B)', '$A + $B)', 'max($A, $B', '[$A + 1', '$A ] + 1']) {
            expect(hasUnpairedBracket(body), body).toBe(true);
            for (const d of [0, 2]) {
                expect(withRoundResult(body, d), `${body} @${d}`).toEqual({ formula: body.trim(), bodyStart: 0, bodyLead: 0, bodyLength: body.trim().length });
            }
        }
        expect(withRoundResult('  $A) + ($B', 2)).toEqual({ formula: '$A) + ($B', bodyStart: 0, bodyLead: 2, bodyLength: 9 });
        expect(hasUnpairedBracket('($A + $B) * max($A, $B)')).toBe(false);
        expect(withRoundResult('($A + $B) * 2', 2).formula).toBe('round((($A + $B) * 2) * 100) / 100');
    });

    it('maps a Rust range on the stored text back into the textarea, clamped to the body', () => {
        const r = withRoundResult(' $A + $Nope', 2); // stored: round(($A + $Nope) * 100) / 100
        const stored = r.formula;
        const at = stored.indexOf('$Nope');
        expect(rangeToBody([at, at + 5], r)).toEqual([6, 11]);
        expect(' $A + $Nope'.slice(6, 11)).toBe('$Nope');
        expect(rangeToBody([0, stored.length], r)).toEqual([1, 11]); // the whole call -> the whole body
        expect(rangeToBody([stored.length - 3, stored.length], r)).toBeUndefined(); // only the wrapper
        expect(rangeToBody(undefined, r)).toBeUndefined();
    });

    it('splits only what re-applies to EXACTLY the stored text (opening + saving never rewrites a formula)', () => {
        expect(splitRoundResult('round($A * 100) / 100')).toEqual({ body: '$A', decimals: 2 });
        expect(splitRoundResult('round(($A + $B) * 10) / 10')).toEqual({ body: '$A + $B', decimals: 1 });
        expect(splitRoundResult('round(($A) * 100) / 100')).toEqual({ body: '($A)', decimals: 2 });
        expect(splitRoundResult('round($A)')).toEqual({ body: '$A', decimals: 0 });
        expect(splitRoundResult('round(abs($A - $B) * 1000) / 1000')).toEqual({ body: 'abs($A - $B)', decimals: 3 });
        for (const f of [
            '$A + 1', 'round($A * $B * 100) / 100', 'round($A * 100) / 10', 'round( $A )', 'round($A * 100) / 100 + 1',
            'round(0.01, $A)', 'round($A, 2)', '2 * round($A)', 'round($A * 50) / 50',
        ]) {
            expect(splitRoundResult(f), f).toEqual({ body: f, decimals: null });
        }
        for (const [body, d] of [['$A', 2], ['$A + $B', 3], ['max($A, $B) - min($A, $B)', 1], ['$A', 0]] as const) {
            const stored = withRoundResult(body, d).formula;
            expect(splitRoundResult(stored)).toEqual({ body, decimals: d });
        }
    });
});

describe('roundPlaces', () => {
    it('a plain whole number 0..15 only', () => {
        expect(roundPlaces(' 2 ')).toBe(2);
        expect(roundPlaces('0')).toBe(0);
        expect(roundPlaces('2.0')).toBe(2);
        expect(roundPlaces('16')).toBeNull();
        expect(roundPlaces('0.5')).toBeNull();
        expect(roundPlaces('$A')).toBeNull();
    });
});

describe('convertLegacyRoundLocal: the same output as Rust convert_legacy_round (its test table)', () => {
    const table: Array<[string, string]> = [
        ['round($A, 2)', 'round($A * 100) / 100'],
        ['round($A, 0)', 'round($A)'],
        ['round($A + $B, 1)', 'round(($A + $B) * 10) / 10'],
        ['round(${Flow (m3/h)}, 3)', 'round(${Flow (m3/h)} * 1000) / 1000'],
        ['round [ $A ; 3 ]', 'round($A * 1000) / 1000'],
        ['round(min($A, $B), 2)', 'round(min($A, $B) * 100) / 100'],
        ['round(-$A, 2)', 'round((-$A) * 100) / 100'],
        ['round($A, 1) + round($B, 2)', 'round($A * 10) / 10 + round($B * 100) / 100'],
        ['round(round($A, 2) + $B, 1)', 'round((round($A * 100) / 100 + $B) * 10) / 10'],
        ['2 ^ round($A, 1)', '2 ^ (round($A * 10) / 10)'],
        ['3 / round($A, 1)', '3 / (round($A * 10) / 10)'],
        ['round($A, 1) ^ 2', '(round($A * 10) / 10) ^ 2'],
        ['$B - round($A, 1) * 3', '$B - round($A * 10) / 10 * 3'],
        ['-round($A, 1)', '-(round($A * 10) / 10)'],
        ['max(round($A, 1), 0)', 'max(round($A * 10) / 10, 0)'],
        ['round(round($A, 2), 0.5)', 'round(round($A * 100) / 100, 0.5)'],
    ];
    for (const [from, to] of table) {
        it(from, () => expect(convertLegacyRoundLocal(from)).toBe(to));
    }

    it('leaves everything else alone and is idempotent', () => {
        for (const f of ['$A + $B', 'round($A)', 'round(0.01, $A)', 'round($B, $A)', 'round(1.5, 2) + $A', 'round($A, 0.5)', '${x round($A, 2)} * 2', '$round + round']) {
            expect(convertLegacyRoundLocal(f), f).toBe(f);
        }
        for (const f of ['round($A, 2)', 'round(round($A, 2) + $B, 1)', '2 ^ round($A, 1)']) {
            const once = convertLegacyRoundLocal(f);
            expect(convertLegacyRoundLocal(once)).toBe(once);
        }
    });
});
