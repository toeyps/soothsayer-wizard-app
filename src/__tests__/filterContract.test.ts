import { describe, it, expect } from 'vitest';
import contract from '../../src-tauri/tests/fixtures/filter_contract.json';
import { toFilterRanges, validatePeriods } from '../utils/timePeriods';
import type { TimePeriod } from '../types';

/*
 * Feature 4 QA — TS half of the timestamp_ranges contract. The SAME fixture is
 * read by src-tauri/tests/filter_contract_tests.rs, which checks that Rust
 * accepts every shape below and that its struct field names equal the
 * `*_fields` lists. What the PM page actually puts on the wire is checked
 * against the same fixture in Feature4BuildFlow.integration.test.tsx.
 */

/** What Tauri's IPC actually transmits: JSON (undefined keys vanish). */
const wire = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe('toFilterRanges <-> Rust timestamp_ranges contract', () => {
    for (const c of contract.range_cases) {
        it(`${c.name}`, () => {
            expect(wire(toFilterRanges(c.periods as TimePeriod[]))).toEqual(c.ranges);
        });
    }

    it('every range object carries exactly the fields Rust declares on TimeRangeArg (no camelCase, no extras)', () => {
        const allowed = new Set(contract.time_range_fields);
        for (const c of contract.range_cases) {
            for (const r of toFilterRanges(c.periods as TimePeriod[])) {
                expect(Object.keys(r).sort()).toEqual([...allowed].sort());
            }
        }
    });

    it('open bounds are sent as JSON null (never "" and never omitted), which Rust reads as an open side', () => {
        const [first, last] = toFilterRanges([
            { id: 'a', start: '', end: '2026-01-31T23:59' },
            { id: 'b', start: '2026-03-01T00:00', end: '   ' },
        ]);
        expect(JSON.stringify(first)).toBe('{"start":null,"end":"2026-01-31T23:59"}');
        expect(JSON.stringify(last)).toBe('{"start":"2026-03-01T00:00","end":null}');
    });

    it('a range is dropped from the wire exactly when validatePeriods (the Build/Finish gate) calls it invalid', () => {
        for (const c of contract.range_cases) {
            const periods = c.periods as TimePeriod[];
            const valid = validatePeriods(periods).filter(s => !s.invalid).length;
            expect(toFilterRanges(periods)).toHaveLength(valid);
        }
    });
});
