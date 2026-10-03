import { describe, it, expect } from 'vitest';
import {
    buildCheckLines,
    fieldState,
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
