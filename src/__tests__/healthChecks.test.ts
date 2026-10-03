import { describe, it, expect } from 'vitest';
import {
    buildCheckLines,
    fieldState,
    formatSetPointText,
    healthVerdict,
    hoverIndexFromAxisEvent,
    nearestIndex,
    readoutAt,
    readoutText,
    RING_QUICK,
    sameSetPoints,
    stepRing,
    verdictOfIssues,
} from '../components/windows/workbench/healthChecks';
import type { HealthIssue } from '../types/health';
import { makeHealthPreview, makeSetPointAwarePreview } from './helpers/healthPreviewFixture';

const issue = (code: string, field: string, message = `${code} ${field}`, severity: 'error' | 'warning' = 'error'): HealthIssue => ({ code, field, message, severity });

describe('healthVerdict / verdictOfIssues', () => {
    it('valid when Rust says so', () => {
        expect(healthVerdict(makeSetPointAwarePreview({ kind: 'individual', set_points: { lower: 1, upper: 9 } }))).toBe('valid');
    });

    it('"needs" when every issue is an empty field, "bad" as soon as one entered value is rejected', () => {
        expect(healthVerdict(makeSetPointAwarePreview({ kind: 'individual', set_points: {} }))).toBe('needs');
        expect(healthVerdict(makeSetPointAwarePreview({ kind: 'individual', set_points: { lower: 3, upper: 9 } }))).toBe('bad');
        expect(verdictOfIssues([issue('required', 'lower'), issue('ordering', 'lower')])).toBe('bad');
    });

    it('null when there is nothing to judge (no data, or not-valid with no issue to explain it)', () => {
        expect(healthVerdict(null)).toBeNull();
        expect(healthVerdict(undefined)).toBeNull();
        expect(healthVerdict(makeHealthPreview({ kind: 'individual' }))).toBeNull(); // valid:false, validation: []
        expect(verdictOfIssues([])).toBeNull();
    });
});

describe('buildCheckLines', () => {
    it('shows one line per Rust issue, with Rust\'s own message; empty = amber, rejected = red', () => {
        const lines = buildCheckLines('individual', [issue('required', 'upper', 'Enter H'), issue('lower_inside_3sd', 'lower', 'L is inside 3σ')]);
        expect(lines.map(l => [l.tone, l.text])).toEqual([['need', 'Enter H'], ['bad', 'L is inside 3σ']]);
    });

    it('Relationship: two or more empty points collapse into ONE line listing them in ladder order', () => {
        const lines = buildCheckLines('relationship', [
            issue('required', 'residual_at_0_upper'),
            issue('required', 'residual_at_80_lower'),
            issue('required', 'residual_at_80_upper'),
            issue('required', 'residual_at_0_lower'),
        ]);
        expect(lines).toHaveLength(1);
        expect(lines[0].tone).toBe('need');
        expect(lines[0].text).toBe('Enter 4 empty points: lower 80, upper 80, lower 0, upper 0');
    });

    it('Relationship: a single empty point keeps Rust\'s message; other issues stay next to the collapsed line', () => {
        expect(buildCheckLines('relationship', [issue('required', 'residual_at_80_lower', 'Enter the lower 80-point')])[0].text).toBe('Enter the lower 80-point');
        const lines = buildCheckLines('relationship', [
            issue('required', 'residual_at_0_lower'),
            issue('point80_inside_band', 'residual_at_80_upper', 'upper 80 is inside ±2RMSE'),
            issue('required', 'residual_at_0_upper'),
        ]);
        expect(lines.map(l => l.text)).toEqual(['Enter 2 empty points: lower 0, upper 0', 'upper 80 is inside ±2RMSE']);
    });

    it('the collapse is Relationship-only', () => {
        const lines = buildCheckLines('individual', [issue('required', 'lower'), issue('required', 'upper')]);
        expect(lines).toHaveLength(2);
    });

    it('a warning-severity issue is amber, not red', () => {
        expect(buildCheckLines('individual', [issue('x', 'lower', 'careful', 'warning')])[0].tone).toBe('need');
    });

    it('no issues -> no lines', () => {
        expect(buildCheckLines('individual', [])).toEqual([]);
    });
});

describe('fieldState', () => {
    const issues = [issue('required', 'upper'), issue('lower_inside_3sd', 'lower'), issue('ordering', 'lower')];

    it('required for an empty field, error for a rejected one, null for a fine one', () => {
        expect(fieldState(issues, 'upper')).toBe('required');
        expect(fieldState(issues, 'lower')).toBe('error');
        expect(fieldState(issues, 'sd')).toBeNull();
        expect(fieldState([], 'lower')).toBeNull();
    });

    it('accepts several field names', () => {
        expect(fieldState(issues, 'sd', 'upper')).toBe('required');
    });
});

describe('sameSetPoints', () => {
    const ind = (lower: number | null, upper: number | null, masterLower?: number | null) => ({ kind: 'individual' as const, lower, upper, masterLower });

    it('compares the entered numbers only - the master snapshot is bookkeeping', () => {
        expect(sameSetPoints(ind(1, 9, 5), ind(1, 9, 7))).toBe(true);
        expect(sameSetPoints(ind(1, 9), ind(1, 10))).toBe(false);
        expect(sameSetPoints(ind(1, null), ind(1, 9))).toBe(false);
    });

    it('different kinds are never the same; null/undefined only equal each other', () => {
        expect(sameSetPoints(ind(1, 9), { kind: 'clustering', outerSd: 5 })).toBe(false);
        expect(sameSetPoints(null, undefined)).toBe(true);
        expect(sameSetPoints(ind(1, 9), null)).toBe(false);
    });

    it('Relationship and Clustering numbers are compared too', () => {
        const rel = (a: number | null) => ({ kind: 'relationship' as const, residualAt80Lower: a, residualAt80Upper: 2, residualAt0Lower: -3, residualAt0Upper: 3 });
        expect(sameSetPoints(rel(-2), rel(-2))).toBe(true);
        expect(sameSetPoints(rel(-2), rel(-2.5))).toBe(false);
        expect(sameSetPoints({ kind: 'clustering', outerSd: 5 }, { kind: 'clustering', outerSd: 5 })).toBe(true);
        expect(sameSetPoints({ kind: 'clustering', outerSd: 5 }, { kind: 'clustering', outerSd: null })).toBe(false);
    });
});

describe('hover: nearestIndex / hoverIndexFromAxisEvent / readout', () => {
    const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00', '2026-01-01 04:00:00'];
    const ms = TS.map(t => new Date(t).getTime());

    it('nearestIndex picks the closest point', () => {
        expect(nearestIndex(ms, ms[2] + 10)).toBe(2);
        expect(nearestIndex(ms, ms[2] - 10)).toBe(2);
        expect(nearestIndex(ms, ms[1] + 3000_000)).toBe(2); // 50 min after point 1: closer to point 2
        expect(nearestIndex(ms, ms[0] - 1e9)).toBe(0);
        expect(nearestIndex(ms, ms[4] + 1e9)).toBe(4);
        expect(nearestIndex([], 5)).toBe(-1);
    });

    it('turns an ECharts updateAxisPointer event on a time axis into a series index', () => {
        expect(hoverIndexFromAxisEvent({ axesInfo: [{ axisDim: 'x', value: ms[3] }] }, TS)).toBe(3);
    });

    it('null for an event without an X value (pointer left the chart) or garbage', () => {
        expect(hoverIndexFromAxisEvent({ axesInfo: [] }, TS)).toBeNull();
        expect(hoverIndexFromAxisEvent({}, TS)).toBeNull();
        expect(hoverIndexFromAxisEvent(null, TS)).toBeNull();
        expect(hoverIndexFromAxisEvent({ axesInfo: [{ axisDim: 'x', value: 'Mon' }] }, TS)).toBeNull();
    });

    it('a category axis (timestamps that do not parse) gives the category index', () => {
        expect(hoverIndexFromAxisEvent({ axesInfo: [{ axisDim: 'x', value: 2 }] }, ['a', 'b', 'c'])).toBe(2);
        expect(hoverIndexFromAxisEvent({ axesInfo: [{ axisDim: 'x', value: 9 }] }, ['a', 'b', 'c'])).toBeNull();
    });

    it('readoutAt: time, raw value / residual and score of one point; null outside the series', () => {
        const ind = makeSetPointAwarePreview({ kind: 'individual', set_points: { lower: 1, upper: 9 } }).series;
        expect(readoutAt(ind, 3)).toEqual({ time: TS[3], valueLabel: 'value', value: 6.2, score: 60 });
        const rel = makeSetPointAwarePreview({ kind: 'relationship', set_points: { residual_at_80_lower: -1, residual_at_80_upper: 1, residual_at_0_lower: -2, residual_at_0_upper: 2 } }).series;
        expect(readoutAt(rel, 0)).toEqual({ time: TS[0], valueLabel: 'residual', value: -0.1, score: 100 });
        const clu = makeSetPointAwarePreview({ kind: 'clustering', n_clusters: 2, set_points: { outer_sd: 5 } }).series;
        expect(readoutAt(clu, 4)).toEqual({ time: TS[4], valueLabel: null, value: null, score: 30 });
        expect(readoutAt(ind, null)).toBeNull();
        expect(readoutAt(ind, 99)).toBeNull();
    });

    it('readoutText: "time · value · score", "not running" for a row without a score, "" for nothing', () => {
        const ind = makeSetPointAwarePreview({ kind: 'individual', set_points: { lower: 1, upper: 9 } }).series;
        expect(readoutText(readoutAt(ind, 3), 'bar')).toBe(`${TS[3]} · value 6.20 bar · score 60`);
        expect(readoutText(readoutAt(ind, 3), '')).toBe(`${TS[3]} · value 6.20 · score 60`);
        const noScore = makeHealthPreview({ kind: 'individual' }).series;
        expect(readoutText(readoutAt(noScore, 1), 'bar')).toBe(`${TS[1]} · not running`);
        expect(readoutText(null, 'bar')).toBe('');
    });
});

describe('stepRing (Clustering outer ring stepper)', () => {
    it('steps by half an SD', () => {
        expect(stepRing(5, 1)).toBe(5.5);
        expect(stepRing(5, -1)).toBe(4.5);
    });

    it('an empty field starts at 4 (the first quick button) from either button', () => {
        expect(stepRing(null, 1)).toBe(4);
        expect(stepRing(null, -1)).toBe(4);
    });

    it('"-" never goes to 3 or below (Rust needs more than 3)', () => {
        expect(stepRing(3.5, -1)).toBe(3.5);
        expect(stepRing(4, -1)).toBe(3.5);
        expect(stepRing(2, 1)).toBe(2.5); // an invalid value is still just stepped up
    });

    it('quick buttons are 4x to 7x', () => {
        expect([...RING_QUICK]).toEqual([4, 5, 6, 7]);
    });
});

describe('formatSetPointText - the input shows the stored value at full precision (QA 2026-10-04)', () => {
    it('plain numbers are unchanged', () => {
        expect(formatSetPointText(0)).toBe('0');
        expect(formatSetPointText(12)).toBe('12');
        expect(formatSetPointText(-3.5)).toBe('-3.5');
        expect(formatSetPointText(10.123456789)).toBe('10.123456789');
    });

    it('a tiny value is not rounded to 0 (it used to be: 4e-7 re-opened as "0")', () => {
        expect(formatSetPointText(4e-7)).toBe('0.0000004');
        expect(formatSetPointText(0.00012345)).toBe('0.00012345');
        expect(formatSetPointText(-1.6e-6)).toBe('-0.0000016');
    });

    it('a value that has no plain-decimal form that round-trips keeps the exact exponent form', () => {
        expect(Number(formatSetPointText(1.2345e-25))).toBe(1.2345e-25);
        expect(Number(formatSetPointText(5e-324))).toBe(5e-324);
        expect(Number(formatSetPointText(1e300))).toBe(1e300);
    });

    it('round trip: Number(format(x)) === x for any finite x (property test over many magnitudes)', () => {
        // small deterministic PRNG (mulberry32), so a failure is reproducible
        let a = 0x9e3779b9;
        const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        for (let i = 0; i < 5000; i++) {
            const x = (rnd() < 0.5 ? -1 : 1) * rnd() * 10 ** Math.floor(rnd() * 60 - 30);
            expect(Number(formatSetPointText(x)), String(x)).toBe(x);
        }
        for (const x of [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, 0.1 + 0.2, 1 / 3, 123456789.123456789, 4e-7, 1e21, 1e-7]) {
            expect(Number(formatSetPointText(x)), String(x)).toBe(x);
        }
    });
});

describe('warning-severity issues never block (Rust: unsafe_file_name; QA/coordinator 2026-10-04)', () => {
    const warn = issue('unsafe_file_name', 'name', 'The model name has characters that are not allowed in a file name; they are replaced.', 'warning');

    it('required + a warning is still "needs" (Incomplete), never "bad"', () => {
        expect(verdictOfIssues([issue('required', 'lower'), warn])).toBe('needs');
        expect(verdictOfIssues([warn, issue('required', 'lower')])).toBe('needs');
    });

    it('a warning alone judges nothing (null) - and a preview that is valid with a warning stays "valid"', () => {
        expect(verdictOfIssues([warn])).toBeNull();
        const valid = { ...makeSetPointAwarePreview({ kind: 'individual', set_points: { lower: 1, upper: 9 } }), validation: [warn] };
        expect(valid.valid).toBe(true);
        expect(healthVerdict(valid)).toBe('valid');
    });

    it('an error next to a warning is "bad"; not_finite is an error -> "bad"', () => {
        expect(verdictOfIssues([warn, issue('lower_inside_3sd', 'lower')])).toBe('bad');
        expect(verdictOfIssues([issue('not_finite', 'lower', 'The lower set point must be a finite number.')])).toBe('bad');
        expect(verdictOfIssues([issue('required', 'lower'), issue('not_finite', 'upper')])).toBe('bad');
    });

    it('a not-valid preview whose only blocking issues are required + a warning reads "needs"', () => {
        const data = { ...makeSetPointAwarePreview({ kind: 'individual', set_points: {} }), validation: [issue('required', 'lower'), issue('required', 'upper'), warn] };
        expect(data.valid).toBe(false);
        expect(healthVerdict(data)).toBe('needs');
    });

    it('buildCheckLines marks warning lines (amber, flagged) and keeps errors unflagged', () => {
        const lines = buildCheckLines('individual', [warn, issue('lower_inside_3sd', 'lower')]);
        expect(lines[0]).toMatchObject({ tone: 'need', warning: true });
        expect(lines[1].warning).toBeUndefined();
    });
});
