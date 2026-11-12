import { convertLegacyRoundStandIn } from './helpers/legacyRoundStandIn';
import { describe, it, expect } from 'vitest';
import {
    hasUnpairedBracket, roundExpression, splitRoundResult, withRoundResult,
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

describe('legacy rounding text: withRoundResult / splitRoundResult (replay + describe)', () => {
    it('rounds the trimmed body; null decimals keeps it as is', () => {
        expect(withRoundResult('  $A + $B ', 2)).toBe('round(($A + $B) * 100) / 100');
        expect(withRoundResult('$A', 1)).toBe('round($A * 10) / 10');
        expect(withRoundResult('$A + 1', null)).toBe('$A + 1');
        expect(withRoundResult('', 2)).toBe('');
    });

    it('never wraps a body with an unpaired bracket (the wrapper could pair with it and hide the mistake)', () => {
        for (const body of ['$A) + ($B', '(($A + $B)', '$A + $B)', 'max($A, $B', '[$A + 1', '$A ] + 1']) {
            expect(hasUnpairedBracket(body), body).toBe(true);
            for (const d of [0, 2]) {
                expect(withRoundResult(body, d), `${body} @${d}`).toBe(body.trim());
            }
        }
        expect(withRoundResult('  $A) + ($B', 2)).toBe('$A) + ($B');
        expect(hasUnpairedBracket('($A + $B) * max($A, $B)')).toBe(false);
        expect(withRoundResult('($A + $B) * 2', 2)).toBe('round((($A + $B) * 2) * 100) / 100');
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
            const stored = withRoundResult(body, d);
            expect(splitRoundResult(stored)).toEqual({ body, decimals: d });
        }
    });
});

describe('the test stand-in: the same output as Rust convert_legacy_round (its test table)', () => {
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
        it(from, () => expect(convertLegacyRoundStandIn(from)).toBe(to));
    }

    it('leaves everything else alone and is idempotent', () => {
        for (const f of ['$A + $B', 'round($A)', 'round(0.01, $A)', 'round($B, $A)', 'round(1.5, 2) + $A', 'round($A, 0.5)', '${x round($A, 2)} * 2', '$round + round']) {
            expect(convertLegacyRoundStandIn(f), f).toBe(f);
        }
        for (const f of ['round($A, 2)', 'round(round($A, 2) + $B, 1)', '2 ^ round($A, 1)']) {
            const once = convertLegacyRoundStandIn(f);
            expect(convertLegacyRoundStandIn(once)).toBe(once);
        }
    });
});
