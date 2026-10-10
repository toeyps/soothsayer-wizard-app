// @vitest-environment node
/**
 * The TypeScript mirror of Rust's set-point validation messages
 * (`helpers/fakeHealthRust.ts`) must print numbers the way Rust does, or every
 * integration test built on it pins text the real app never shows.
 *
 * Rust (`health_score.rs`, commit a3c854d): a set point the USER typed is echoed
 * exactly (`fmt_typed`: the shortest text that reads back as the same number —
 * "-2", never "-2.000"; "4.61234", never "4.612"; "-0" as "0"); only values Rust
 * COMPUTED (SD, 2RMSE, band edges) keep the INFO-file rounding (`fmt_num`).
 * The vectors below are the ones of Rust's own
 * `fmt_typed_is_the_shortest_exact_text` test.
 */
import { describe, it, expect } from 'vitest';
import { fmtTyped, validateClustering, validateIndividual, validateRelationship } from './helpers/fakeHealthRust';

const BAND = { mean: 5, sd: 1, l1: 4, u1: 6, l3: 2.00049, u3: 8.00051 };
const msg = (issues: { code: string; message: string }[], code: string) => issues.find(i => i.code === code)?.message;

describe('fakeHealthRust — fmtTyped mirrors Rust\'s fmt_typed', () => {
    it.each([
        [-2, '-2'],
        [4.6, '4.6'],
        [0.05, '0.05'],
        [4.61234, '4.61234'],
        [0.000123456, '0.000123456'],
        [1234.56789, '1234.56789'],
        [150, '150'],
        [0, '0'],
        [-0, '0'],
        [1e-7, '0.0000001'],
        [2.5e6, '2500000'],
    ])('%s -> "%s", and it reads back as the same number', (x, text) => {
        expect(fmtTyped(x)).toBe(text);
        expect(Number(fmtTyped(x))).toBe(x + 0);
    });

    it('never an exponent (Rust\'s `{}` has none), for very small and very large values alike', () => {
        expect(fmtTyped(1.5e-9)).toBe('0.0000000015');
        expect(fmtTyped(-4e-7)).toBe('-0.0000004');
        expect(fmtTyped(2.5e21)).toBe('2500000000000000000000');
        expect(fmtTyped(-1.2345e22)).toBe('-12345000000000000000000');
        for (const x of [1.5e-9, -4e-7, 2.5e21, -1.2345e22, 123456789.125]) {
            expect(fmtTyped(x)).not.toMatch(/e/i);
            expect(Number(fmtTyped(x))).toBe(x);
        }
    });
});

describe('fakeHealthRust — messages echo a typed set point exactly; computed values stay rounded', () => {
    it('Individual: L / H as typed, the 3σ boundary rounded', () => {
        const ordering = msg(validateIndividual(BAND, { lower: 9.25, upper: -2 }), 'ordering');
        expect(ordering).toBe('The lower set point (L = 9.25) must be below the upper set point (H = -2).');
        const inside = validateIndividual(BAND, { lower: 4.61234, upper: 4.75 });
        // typed 4.61234 stays (it used to come back as "4.612"); the band edge keeps its rounding
        expect(msg(inside, 'lower_inside_3sd')).toBe('The lower set point (L = 4.61234) must be below the lower 3σ boundary (2).');
        expect(msg(inside, 'upper_inside_3sd')).toBe('The upper set point (H = 4.75) must be above the upper 3σ boundary (8.001).');
        expect(msg(validateIndividual(BAND, { lower: -0, upper: 9 }), 'lower_inside_3sd')).toBeUndefined(); // -0 is below 2
        const equal = validateIndividual({ ...BAND, l3: 2, u3: 8 }, { lower: 2, upper: 8 });
        expect(msg(equal, 'lower_equals_3sd')).toMatch(/^The lower set point \(L = 2\) equals the lower 3σ boundary.* Set L below 2\.$/);
        expect(msg(equal, 'upper_equals_3sd')).toMatch(/^The upper set point \(H = 8\) equals the upper 3σ boundary.* Set H above 8\.$/);
    });

    it('Relation model: the user reported "-2.000" — a typed residual point is "-2"; 2RMSE keeps its rounding', () => {
        const sign = validateRelationship(1.23456, { residual_at_80_lower: 2, residual_at_80_upper: -2, residual_at_0_lower: -0, residual_at_0_upper: 0.05 });
        expect(sign.filter(i => i.code === 'must_be_negative').map(i => i.message)).toEqual([
            'The lower 80-point must be negative (residual = actual − predicted); got 2.',
            'The lower 0-point must be negative (residual = actual − predicted); got 0.',
        ]);
        expect(msg(sign, 'must_be_positive')).toBe('The upper 80-point must be positive (residual = actual − predicted); got -2.');
        const band = validateRelationship(1.23456, { residual_at_80_lower: -0.5, residual_at_80_upper: 1.23456, residual_at_0_lower: -3, residual_at_0_upper: 3 });
        expect(msg(band, 'point80_inside_band')).toBe('The lower 80-point (-0.5) must be further from zero than the ±2RMSE band edge (1.235).');
        expect(msg(band, 'point80_equals_band')).toBe('The upper 80-point (1.23456) sits exactly on the ±2RMSE band edge (1.235), so the 100 and the 80 point would coincide. Move it further from zero.');
        const order = validateRelationship(1, { residual_at_80_lower: -2, residual_at_80_upper: 4.61234, residual_at_0_lower: -2, residual_at_0_upper: 4.5 });
        expect(msg(order, 'point0_equals_point80')).toBe('The lower 0-point (-2) equals the lower 80-point, so the score would drop from 80 to 0 instantly. Move the 0-point further from zero.');
        expect(msg(order, 'point0_inside_point80')).toBe('The upper 0-point (4.5) must be further from zero than the upper 80-point (4.61234).');
        for (const i of [...sign, ...band, ...order]) expect(i.message).not.toMatch(/\d\.\d*0\b|-2\.0/); // nothing padded
    });

    it('Clustering: N as typed', () => {
        const c = [{ cluster_id: 1, x_center: 0, y_center: 0, x_sd: 1, y_sd: 1, angle_deg: 0 }];
        expect(msg(validateClustering(c, { outer_sd: 2.5 }), 'outer_sd_not_above_3')).toBe('The outer ring (2.5× SD) must be more than 3× SD (the 80 point).');
        expect(msg(validateClustering(c, { outer_sd: 2 }), 'outer_sd_not_above_3')).toBe('The outer ring (2× SD) must be more than 3× SD (the 80 point).');
        expect(msg(validateClustering(c, { outer_sd: 2.99999 }), 'outer_sd_not_above_3')).toBe('The outer ring (2.99999× SD) must be more than 3× SD (the 80 point).');
    });
});
