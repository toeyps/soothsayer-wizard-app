import { describe, it, expect } from 'vitest';
import { nameProblem, sameTag, sensorRef } from '../utils/specialSensorNaming';
import { useCalculationEngine } from '../hooks/useCalculationEngine';
import { renderHook } from '@testing-library/react';

/**
 * `sensorRef` is the TypeScript twin of Rust's `sensor_ref_token`
 * (`src-tauri/src/lib.rs`): a bare `$Name` only when the name is non-empty and
 * every character is alphanumeric or `_`, `${Name}` for everything else. The
 * two tables below are the same names the Rust tests
 * (`token_is_bare_only_for_alphanumeric_underscore_names`,
 * `token_round_trips_through_extract_sensor_refs`) use, so a change to either
 * side that makes them disagree fails here.
 */
describe('sensorRef (twin of Rust sensor_ref_token)', () => {
    const bare = [
        'plain_1',
        'Temp',
        '11PT1214A', // digits first
        'Pressure2',
        '_leading',
        'ไทย', // letters in another script
        'อุณหภูมิ', // Thai vowel marks are Alphabetic -- Rust leaves this bare too
        'ºC',
        'Café',
    ];
    const braced = [
        'Total-Power', // hyphen
        'A/B', // slash
        'Eff%', // percent
        '(x)', // parentheses
        'Sum All', // space
        'a.b', // dot
        '11PT1214A.PV', // a real pair of names: one is a prefix of the other
        'a+b',
        'x*y',
        '50%',
        'อุณหภูมิ่', // Thai tone mark (not alphabetic)
        '',
    ];

    it.each(bare)('writes %j bare', (name) => {
        expect(sensorRef(name)).toBe(`$${name}`);
    });

    it.each(braced)('braces %j', (name) => {
        expect(sensorRef(name)).toBe(`\${${name}}`);
    });

    it('a name that is a prefix of another (`11PT1214A` vs `11PT1214A.PV`) never collides: the longer one is braced', () => {
        expect(sensorRef('11PT1214A')).toBe('$11PT1214A');
        expect(sensorRef('11PT1214A.PV')).toBe('${11PT1214A.PV}');
    });

    it('is what the button builder actually writes into a formula (one implementation, not two)', () => {
        const names = ['Total-Power', 'A/B', 'plain_1'];
        const { result } = renderHook(() => useCalculationEngine(names));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '${Total-Power} + ${A/B} + $plain_1',
        });
    });
});

describe('sameTag', () => {
    it('ignores case and surrounding whitespace', () => {
        expect(sameTag('Total Power', '  total power ')).toBe(true);
        expect(sameTag('A', 'B')).toBe(false);
    });
});

describe('nameProblem', () => {
    const taken = ['TAG1', 'Total Power', 'special A'];

    it('is silent for an empty name (the missing-fields check owns that message)', () => {
        expect(nameProblem('', taken)).toBeNull();
        expect(nameProblem('   ', taken)).toBeNull();
    });

    it('accepts a free name', () => {
        expect(nameProblem('Brand new', taken)).toBeNull();
    });

    it('flags an exact clash', () => {
        expect(nameProblem('TAG1', taken)).toMatch(/already exists/);
    });

    it('flags a clash that differs only in case or surrounding spaces', () => {
        expect(nameProblem('tag1', taken)).toMatch(/already exists/);
        expect(nameProblem('  TOTAL POWER  ', taken)).toMatch(/already exists/);
    });

    it('names the existing sensor as it is spelled, not as typed', () => {
        expect(nameProblem('tag1', taken)).toContain('"TAG1"');
    });

    it('refuses a name containing "}" -- neither reference form can express it', () => {
        expect(nameProblem('a}b', taken)).toMatch(/can't contain "}"/);
    });

    it('refuses the names the time column goes by', () => {
        expect(nameProblem('Timestamp', taken)).toMatch(/reserved/);
        expect(nameProblem('time', taken)).toMatch(/reserved/);
    });

    it('accepts any iterable of taken tags', () => {
        expect(nameProblem('x', new Set(['X']))).toMatch(/already exists/);
    });
});
