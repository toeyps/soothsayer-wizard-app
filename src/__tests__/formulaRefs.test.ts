import { describe, it, expect } from 'vitest';
import { formulaRefNames } from '../utils/formulaRefs';

/**
 * `formulaRefNames` must read a formula exactly like Rust's `scan_sensor_refs`
 * (src-tauri/src/lib.rs). Each row: formula -> the names Rust extracts.
 */
const TABLE: [string, string[]][] = [
    ['$A + $B', ['A', 'B']],
    ['$11PT1214A.PV - $11PT1214A', ['11PT1214A.PV', '11PT1214A']],
    ['$อุณหภูมิ * 2', ['อุณหภูมิ']],
    ['${Flow (m3/h)} / $A', ['Flow (m3/h)', 'A']],
    ['$Total-Power', ['Total']], // bare names stop at "-"
    ['$_x1 + $A.', ['_x1', 'A.']], // "_" may start a name; a trailing "." is part of it
    ['${} + ${unclosed', []], // empty / unclosed braces name nothing
    ['${ $A', ['A']], // ...and scanning resumes after them
    ['$$A + $ B + 5', ['A']],
    ['${A$B} + $A + $A', ['A$B', 'A']], // braced runs to the first "}", de-duplicated
    ['$.A', []], // a bare name cannot start with "."
    ['', []],
];

describe('formulaRefNames follows the Rust scan_sensor_refs grammar', () => {
    for (const [formula, names] of TABLE) {
        it(JSON.stringify(formula), () => {
            expect(formulaRefNames(formula)).toEqual(names);
        });
    }
});
