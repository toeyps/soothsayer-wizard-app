import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ScoreRuler, {
    MARKER_MIN_GAP,
    REL_RULER_POINTS,
    bandGradient,
    consistentAnchors,
    markerRows,
    positionAmong,
    rejectedMarker,
    rulerModel,
    type RulerAnchor,
    type RulerModel,
} from '../components/windows/workbench/ScoreRuler';
import type { HealthSetPoints } from '../types';
import type { HealthIssue, HealthStats } from '../types/health';
import { makeHealthPreview } from './helpers/healthPreviewFixture';

/*
 * The score ruler of the Health score page ("Workbench detail pages v2" §6): the
 * geometry is pure and tested here without layout — where a rejected value's marker
 * sits, that it never lands on the wrong side of another valid point, the arrow
 * beyond the ruler's end, the rows of colliding labels — plus the states the band
 * renders (rejected = red, empty = dashed amber, not checked = grey) and its a11y
 * wiring. The page around it is covered in HealthScorePage.test.tsx.
 *
 * Fixture numbers: Individual ±3SD = 2 / 8, ±1SD = 4 / 6; Relation 2RMSE = 0.9134.
 */

afterEach(cleanup);

const statsOf = (kind: 'individual' | 'relationship' | 'clustering'): HealthStats => makeHealthPreview({ kind, n_clusters: 2 } as never).stats;
const IND = statsOf('individual');
const REL = statsOf('relationship');
const CLU = statsOf('clustering');
const W = (REL as Extract<HealthStats, { kind: 'relationship' }>).two_rmse;

const bad = (field: string, code = 'rejected'): HealthIssue => ({ code, severity: 'error', field, message: `${field} is not accepted` });
const empty = (field: string): HealthIssue => ({ code: 'required', severity: 'error', field, message: `Enter ${field}` });

const ind = (lower: number | null, upper: number | null): HealthSetPoints => ({ kind: 'individual', lower, upper });
const rel = (p: Partial<Record<'l0' | 'l80' | 'u80' | 'u0', number | null>>): HealthSetPoints => ({
    kind: 'relationship', residualAt0Lower: p.l0 ?? null, residualAt80Lower: p.l80 ?? null, residualAt80Upper: p.u80 ?? null, residualAt0Upper: p.u0 ?? null,
});
const clu = (outerSd: number | null): HealthSetPoints => ({ kind: 'clustering', outerSd });

const model = (stats: HealthStats, sp: HealthSetPoints, issues: HealthIssue[] = [], unchecked = false): RulerModel => rulerModel(stats, sp, issues, unchecked)!;
const stateOf = (m: RulerModel, key: string) => m.ticks.find(t => t.key === key)!.state;
const marker = (m: RulerModel, key: string) => m.markers.find(x => x.key === key);

describe('positionAmong — where a value sits between ticks whose values are known', () => {
    const anchors: RulerAnchor[] = [[2, 1], [4, 2], [6, 3], [8, 4]];

    it('is linear between two anchors', () => {
        expect(positionAmong(3, anchors)).toBe(1.5);
        expect(positionAmong(4.5, anchors)).toBe(2.25);
        expect(positionAmong(7, anchors)).toBe(3.5);
    });

    it('sits exactly on a tick when the value equals it', () => {
        expect(positionAmong(2, anchors)).toBe(1);
        expect(positionAmong(6, anchors)).toBe(3);
        expect(positionAmong(8, anchors)).toBe(4);
    });

    it('is half a tick outside the first / the last anchor, however far the value is', () => {
        expect(positionAmong(1.9, anchors)).toBe(0.5);
        expect(positionAmong(-1e9, anchors)).toBe(0.5);
        expect(positionAmong(8.1, anchors)).toBe(4.5);
        expect(positionAmong(1e9, anchors)).toBe(4.5);
    });

    it('two anchors with the same value (SD = 0): no division by zero', () => {
        const flat: RulerAnchor[] = [[5, 1], [5, 2], [5, 3], [5, 4]];
        expect(positionAmong(4, flat)).toBe(0.5);
        expect(Number.isFinite(positionAmong(5, flat)!)).toBe(true);
        expect(positionAmong(6, flat)).toBe(4.5);
    });

    it('nothing to place it by: null (no marker is drawn)', () => {
        expect(positionAmong(3, [])).toBeNull();
        expect(positionAmong(5, [[5, 2]])).toBe(2); // one anchor: on it, or half a tick either side
        expect(positionAmong(4, [[5, 2]])).toBe(1.5);
        expect(positionAmong(6, [[5, 2]])).toBe(2.5);
    });
});

describe('consistentAnchors — the program ticks plus the user\'s OTHER valid points', () => {
    const program: RulerAnchor[] = [[2, 1], [4, 2], [6, 3], [8, 4]];

    it('a valid user point joins the anchors, in tick order', () => {
        expect(consistentAnchors(program, [[9, 5]])).toEqual([[2, 1], [4, 2], [6, 3], [8, 4], [9, 5]]);
        expect(consistentAnchors(program, [[9, 5], [1, 0]])).toEqual([[1, 0], [2, 1], [4, 2], [6, 3], [8, 4], [9, 5]]);
    });

    it('a user point whose value disagrees with the order of the ticks is left out (it could put a marker on the wrong side)', () => {
        expect(consistentAnchors(program, [[5, 5]])).toEqual(program); // "H" below +3SD
        expect(consistentAnchors(program, [[3, 0]])).toEqual(program); // "L" above −3SD
        expect(consistentAnchors(program, [[8, 5]])).toEqual(program); // equal to a program tick: not strictly beyond it
        // two user points that contradict each other: the first (lower tick) is kept
        expect(consistentAnchors([[0, 3]], [[5, 5], [4, 6]])).toEqual([[0, 3], [5, 5]]);
    });

    it('values that are not finite are never anchors', () => {
        expect(consistentAnchors([[NaN, 1], [4, 2]], [[Infinity, 5]])).toEqual([[4, 2]]);
    });

    it('the result always ascends in value AND in tick', () => {
        const out = consistentAnchors([[-W, 2], [0, 3], [W, 4]], [[3, 6], [-3, 0], [2.5, 5], [-1.5, 1]]);
        expect(out.map(a => a[1])).toEqual([0, 1, 2, 3, 4, 5, 6]);
        for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThan(out[i - 1][0]);
    });
});

describe('rejectedMarker — the red mark of a rejected value', () => {
    const anchors: RulerAnchor[] = [[2, 1], [4, 2], [6, 3], [8, 4]];

    it('inside the ruler: at its true place, labelled as given', () => {
        expect(rejectedMarker('lower', 3, 'L = 3', anchors, 5)).toEqual({ key: 'lower', pos: 1.5, label: 'L = 3' });
    });

    it('past the last PROGRAM tick but with no user point there: between that tick and the end, no arrow', () => {
        expect(rejectedMarker('lower', 90, 'L = 90', anchors, 5)).toEqual({ key: 'lower', pos: 4.5, label: 'L = 90' });
        expect(rejectedMarker('upper', -5, 'H = −5', anchors, 5)).toEqual({ key: 'upper', pos: 0.5, label: 'H = −5' });
    });

    it('beyond the user\'s own point at an end: AT that end, with an arrow pointing outwards', () => {
        expect(rejectedMarker('lower', 90, 'L = 90', [...anchors, [85, 5]], 5)).toEqual({ key: 'lower', pos: 5, label: 'L = 90 →', beyond: 'right' });
        expect(rejectedMarker('upper', -5, 'H = −5', [[1, 0], ...anchors], 5)).toEqual({ key: 'upper', pos: 0, label: '← H = −5', beyond: 'left' });
    });

    it('never outside the band: 0 ≤ pos ≤ last, whatever the value', () => {
        for (const v of [-1e12, -5, 0, 1, 2, 5, 8, 85, 86, 1e12]) {
            const m = rejectedMarker('x', v, 'x', [[1, 0], ...anchors, [85, 5]], 5)!;
            expect(m.pos).toBeGreaterThanOrEqual(0);
            expect(m.pos).toBeLessThanOrEqual(5);
        }
    });

    it('no anchors: no marker', () => {
        expect(rejectedMarker('lower', 3, 'L = 3', [], 5)).toBeNull();
    });
});

describe('markerRows — labels that would overlap are stacked', () => {
    it('one marker, or markers far apart: one row', () => {
        expect(markerRows([], 5)).toEqual({ rows: 1, rowOf: [] });
        expect(markerRows([{ pos: 1.5 }], 5)).toEqual({ rows: 1, rowOf: [0] });
        expect(markerRows([{ pos: 0.5 }, { pos: 4.5 }], 5)).toEqual({ rows: 1, rowOf: [0, 0] });
    });

    it('two close markers: two rows (row 0 = the top one, the leftmost label)', () => {
        expect(markerRows([{ pos: 2.25 }, { pos: 2.75 }], 5)).toEqual({ rows: 2, rowOf: [0, 1] });
        // the order they are given in does not matter: the leftmost takes the top row
        expect(markerRows([{ pos: 2.75 }, { pos: 2.25 }], 5)).toEqual({ rows: 2, rowOf: [1, 0] });
        // the same place: still two rows
        expect(markerRows([{ pos: 4.5 }, { pos: 4.5 }], 5)).toEqual({ rows: 2, rowOf: [0, 1] });
    });

    it('the gap is a share of the band\'s width (MARKER_MIN_GAP), so it scales with the number of ticks', () => {
        const gap = 5 * MARKER_MIN_GAP; // in ticks, on a 6-tick ruler
        expect(markerRows([{ pos: 1 }, { pos: 1 + gap + 0.01 }], 5).rows).toBe(1);
        expect(markerRows([{ pos: 1 }, { pos: 1 + gap - 0.01 }], 5).rows).toBe(2);
        // the same distance in ticks is a smaller share of a 7-tick ruler
        expect(markerRows([{ pos: 1 }, { pos: 1 + gap + 0.01 }], 6).rows).toBe(2);
    });

    it('a third marker reuses a row once it is clear of that row\'s last label; four in one place = four rows', () => {
        expect(markerRows([{ pos: 0.2 }, { pos: 0.6 }, { pos: 2.4 }], 5)).toEqual({ rows: 2, rowOf: [0, 1, 0] });
        expect(markerRows([{ pos: 3 }, { pos: 3 }, { pos: 3 }, { pos: 3 }], 6)).toEqual({ rows: 4, rowOf: [0, 1, 2, 3] });
    });
});

describe('bandGradient — the band is coloured by the scores of its ticks', () => {
    it('one stop per tick, at its evenly spaced place, in the score\'s token colour', () => {
        const g = bandGradient(model(IND, ind(1, 9)).ticks);
        expect(g).toBe('linear-gradient(90deg, '
            + 'color-mix(in srgb, var(--danger) 85%, transparent) 0%, '
            + 'color-mix(in srgb, var(--warn) 85%, transparent) 20%, '
            + 'color-mix(in srgb, var(--ok) 85%, transparent) 40%, '
            + 'color-mix(in srgb, var(--ok) 85%, transparent) 60%, '
            + 'color-mix(in srgb, var(--warn) 85%, transparent) 80%, '
            + 'color-mix(in srgb, var(--danger) 85%, transparent) 100%)');
    });

    it('a user point that is empty, rejected or not checked has NO score colour (grey) — the band never shows a score the model does not give', () => {
        const grey = 'color-mix(in srgb, var(--text-secondary) 35%, transparent)';
        for (const m of [model(IND, ind(null, 9), [empty('lower')]), model(IND, ind(3, 9), [bad('lower')]), model(IND, ind(1, 9), [], true)]) {
            const g = bandGradient(m.ticks);
            expect(g.startsWith(`linear-gradient(90deg, ${grey} 0%, `)).toBe(true);
            expect(g).toContain('var(--warn) 85%, transparent) 20%'); // the program's ticks keep theirs
        }
        // not checked: BOTH ends grey, no red anywhere
        expect(bandGradient(model(IND, ind(1, 9), [], true).ticks)).not.toContain('var(--danger)');
    });
});

describe('rulerModel — Individual: 0 · 80 · 100 · 100 · 80 · 0 on L · −3SD · −1SD · +1SD · +3SD · H', () => {
    it('ticks: the two user points at the ends, the program\'s four between them, with their values as text', () => {
        const m = model(IND, ind(1, 9));
        expect(m.kind).toBe('individual');
        expect(m.ticks.map(t => [t.key, t.score, t.name, t.user, t.text])).toEqual([
            ['lower', 0, 'L', true, undefined],
            ['m3sd', 80, '−3SD', false, '2'],
            ['m1sd', 100, '−1SD', false, '4'],
            ['p1sd', 100, '+1SD', false, '6'],
            ['p3sd', 80, '+3SD', false, '8'],
            ['upper', 0, 'H', true, undefined],
        ]);
        expect(m.ticks.every(t => t.state === null)).toBe(true);
        expect(m.markers).toEqual([]);
    });

    it('the state of a user point is Rust\'s: empty = required, anything else that names the field = error — this file never decides', () => {
        expect(stateOf(model(IND, ind(null, 9), [empty('lower')]), 'lower')).toBe('required');
        expect(stateOf(model(IND, ind(3, 9), [bad('lower')]), 'lower')).toBe('error');
        // a value that LOOKS wrong but that Rust did not reject is not marked
        const quiet = model(IND, ind(5, 5));
        expect(quiet.ticks.every(t => t.state === null)).toBe(true);
        expect(quiet.markers).toEqual([]);
        // ...and one that looks fine but that Rust rejected IS
        expect(marker(model(IND, ind(1, 9), [bad('lower')]), 'lower')).toEqual({ key: 'lower', pos: 0.5, label: 'L = 1' });
    });

    it('a rejected L is marked where it really sits, labelled as typed', () => {
        expect(marker(model(IND, ind(3, 9), [bad('lower')]), 'lower')).toEqual({ key: 'lower', pos: 1.5, label: 'L = 3' });
        expect(marker(model(IND, ind(2, 9), [bad('lower', 'lower_equals_3sd')]), 'lower')).toEqual({ key: 'lower', pos: 1, label: 'L = 2' }); // ON the −3SD tick
        expect(marker(model(IND, ind(2.61234, 9), [bad('lower')]), 'lower')!.label).toBe('L = 2.61234'); // never rounded
        expect(marker(model(IND, ind(1, -0.5), [bad('upper')]), 'upper')!.label).toBe('← H = −0.5'); // a real minus sign; beyond L (below)
    });

    it('an empty point has NO marker (there is no value to mark)', () => {
        const m = model(IND, ind(null, null), [empty('lower'), empty('upper')]);
        expect(m.markers).toEqual([]);
        expect([stateOf(m, 'lower'), stateOf(m, 'upper')]).toEqual(['required', 'required']);
    });

    it('the other VALID user point is an anchor: L = 90 with H = 85 sits beyond H — at the end, with an arrow — never left of H', () => {
        const m = marker(model(IND, ind(90, 85), [bad('lower')]), 'lower')!;
        expect(m).toEqual({ key: 'lower', pos: 5, label: 'L = 90 →', beyond: 'right' });
        // L = 50 with H = 85: between +3SD (8, tick 4) and H (85, tick 5) — left of H, where it truly is
        const inside = marker(model(IND, ind(50, 85), [bad('lower')]), 'lower')!;
        expect(inside.pos).toBeCloseTo(4 + (50 - 8) / (85 - 8), 10);
        expect(inside.pos).toBeLessThan(5);
        expect(inside.beyond).toBeUndefined();
        // the mirror: H = −5 with L = 1 valid
        expect(marker(model(IND, ind(1, -5), [bad('upper')]), 'upper')).toEqual({ key: 'upper', pos: 0, label: '← H = −5', beyond: 'left' });
        // H = 1.5 with L = 1: right of L (between L and −3SD), no arrow
        expect(marker(model(IND, ind(1, 1.5), [bad('upper')]), 'upper')).toEqual({ key: 'upper', pos: 0.5, label: 'H = 1.5' });
    });

    it('a point that is itself empty or rejected is NOT an anchor for the other one', () => {
        // H empty: L = 90 is past +3SD, but there is no H to be beyond — no arrow
        expect(marker(model(IND, ind(90, null), [bad('lower'), empty('upper')]), 'lower')).toEqual({ key: 'lower', pos: 4.5, label: 'L = 90' });
        // both rejected: each is placed by the program's ticks alone
        const both = model(IND, ind(4.5, 5.5), [bad('lower'), bad('upper')]);
        expect(both.markers).toEqual([{ key: 'lower', pos: 2.25, label: 'L = 4.5' }, { key: 'upper', pos: 2.75, label: 'H = 5.5' }]);
        expect(markerRows(both.markers, 5)).toEqual({ rows: 2, rowOf: [0, 1] }); // and their labels are stacked
    });

    it('not checked (the health score did not load): every user tick is "unchecked", no marker — even with issues from an old answer', () => {
        const m = model(IND, ind(3, null), [bad('lower'), empty('upper')], true);
        expect([stateOf(m, 'lower'), stateOf(m, 'upper')]).toEqual(['unchecked', 'unchecked']);
        expect(m.ticks.filter(t => !t.user).every(t => t.state === null)).toBe(true);
        expect(m.markers).toEqual([]);
    });

    it('a warning that names no set-point field marks nothing', () => {
        const m = model(IND, ind(1, 9), [{ code: 'unsafe_file_name', severity: 'warning', field: 'name', message: 'x' }]);
        expect(m.ticks.every(t => t.state === null)).toBe(true);
    });
});

describe('rulerModel — Relation model: 0 low · 80 low · −2RMSE · no residual · +2RMSE · 80 high · 0 high', () => {
    it('ticks in ruler order, ONE name per point', () => {
        const m = model(REL, rel({ l0: -3, l80: -1.5, u80: 1.5, u0: 3 }));
        expect(m.kind).toBe('relationship');
        expect(m.ticks.map(t => [t.key, t.score, t.name, t.user])).toEqual([
            ['residual_at_0_lower', 0, '0 low', true],
            ['residual_at_80_lower', 80, '80 low', true],
            ['m2rmse', 100, '−2RMSE', false],
            ['zero', 100, 'no residual', false],
            ['p2rmse', 100, '+2RMSE', false],
            ['residual_at_80_upper', 80, '80 high', true],
            ['residual_at_0_upper', 0, '0 high', true],
        ]);
        expect(m.ticks.filter(t => !t.user).map(t => t.text)).toEqual(['−0.913', '0', '+0.913']);
        expect(m.markers).toEqual([]);
        expect(REL_RULER_POINTS.map(p => [p.key, p.tick])).toEqual([['residual_at_0_lower', 0], ['residual_at_80_lower', 1], ['residual_at_80_upper', 5], ['residual_at_0_upper', 6]]);
    });

    it('four empty points: four "required" ticks, no marker', () => {
        const m = model(REL, rel({}), REL_RULER_POINTS.map(p => empty(p.key)));
        expect(m.ticks.filter(t => t.user).map(t => t.state)).toEqual(['required', 'required', 'required', 'required']);
        expect(m.markers).toEqual([]);
    });

    it('a positive "80 low" is marked on the HIGH side where it really is, by the point\'s ruler name', () => {
        // 80 low = 2 (must be negative); 80 high = 2.5 is valid: the marker is between +2RMSE and 80 high
        const m = marker(model(REL, rel({ l0: -3, l80: 2, u80: 2.5, u0: 4 }), [bad('residual_at_80_lower', 'must_be_negative')]), 'residual_at_80_lower')!;
        expect(m.label).toBe('80 low = 2');
        expect(m.pos).toBeCloseTo(4 + (2 - W) / (2.5 - W), 10);
        expect(m.pos).toBeGreaterThan(4);
        expect(m.pos).toBeLessThan(5); // never on the wrong side of the valid 80 high
    });

    it('a 0 point inside its 80 point sits between the band edge and that 80 point', () => {
        const hi = marker(model(REL, rel({ l0: -3, l80: -1.5, u80: 2.5, u0: 1.2 }), [bad('residual_at_0_upper', 'point0_inside_point80')]), 'residual_at_0_upper')!;
        expect(hi.label).toBe('0 high = 1.2');
        expect(hi.pos).toBeCloseTo(4 + (1.2 - W) / (2.5 - W), 10);
        const lo = marker(model(REL, rel({ l0: -1, l80: -2, u80: 1.5, u0: 3 }), [bad('residual_at_0_lower', 'point0_inside_point80')]), 'residual_at_0_lower')!;
        expect(lo.label).toBe('0 low = −1');
        expect(lo.pos).toBeCloseTo(1 + (-1 - -2) / (-W - -2), 10); // right of the valid 80 low (tick 1), left of −2RMSE (tick 2)
        expect(lo.pos).toBeGreaterThan(1);
        expect(lo.pos).toBeLessThan(2);
    });

    it('an 80 point inside the ±2RMSE band is marked inside the green part', () => {
        const m = marker(model(REL, rel({ l0: -3, l80: -0.5, u80: 1.5, u0: 3 }), [bad('residual_at_80_lower', 'point80_inside_band')]), 'residual_at_80_lower')!;
        expect(m.pos).toBeCloseTo(2 + (-0.5 + W) / W, 10);
        expect(m.pos).toBeGreaterThan(2);
        expect(m.pos).toBeLessThan(3);
    });

    it('beyond the valid 0 point of its side: at that end with an arrow', () => {
        expect(marker(model(REL, rel({ l0: -3, l80: -1.5, u80: 9, u0: 3 }), [bad('residual_at_80_upper')]), 'residual_at_80_upper'))
            .toEqual({ key: 'residual_at_80_upper', pos: 6, label: '80 high = 9 →', beyond: 'right' });
        expect(marker(model(REL, rel({ l0: -3, l80: -9, u80: 1.5, u0: 3 }), [bad('residual_at_80_lower')]), 'residual_at_80_lower'))
            .toEqual({ key: 'residual_at_80_lower', pos: 0, label: '← 80 low = −9', beyond: 'left' });
    });

    it('two rejected points near each other stack their labels', () => {
        const m = model(REL, rel({ l0: -3, l80: 2, u80: 2.5, u0: 1.2 }), [bad('residual_at_80_lower'), bad('residual_at_0_upper')]);
        expect(m.markers.map(x => x.label)).toEqual(['80 low = 2', '0 high = 1.2']);
        const { rows, rowOf } = markerRows(m.markers, 6);
        expect(rows).toBe(2);
        expect(rowOf).toEqual([1, 0]); // "0 high = 1.2" is the leftmost: the top row
    });
});

describe('rulerModel — Clustering: one-sided, centre · 1× · 3× · N×', () => {
    it('ticks: three program levels as text, N is the user\'s', () => {
        const m = model(CLU, clu(5));
        expect(m.kind).toBe('clustering');
        expect(m.ticks.map(t => [t.key, t.score, t.name, t.user, t.text])).toEqual([
            ['centre', 100, 'centre', false, '0× SD'],
            ['ring1', 100, '1× SD', false, '1×'],
            ['ring3', 80, '3× SD', false, '3×'],
            ['outer_sd', 0, 'N× SD', true, undefined],
        ]);
        expect(m.markers).toEqual([]);
    });

    it('a rejected N is marked between the rings where it sits, labelled as typed', () => {
        const at = (n: number) => marker(model(CLU, clu(n), [bad('outer_sd', 'outer_sd_not_above_3')]), 'outer_sd')!;
        expect(at(2.5)).toEqual({ key: 'outer_sd', pos: 1.75, label: 'N = 2.5×' });
        expect(at(3)).toEqual({ key: 'outer_sd', pos: 2, label: 'N = 3×' }); // ON the 3× tick
        expect(at(0.5)).toEqual({ key: 'outer_sd', pos: 0.5, label: 'N = 0.5×' });
        // a distance is never negative: marked at the centre, the label still says what was typed
        expect(at(-2)).toEqual({ key: 'outer_sd', pos: 0, label: 'N = −2×' });
    });

    it('empty N: required, no marker; not checked: unchecked', () => {
        expect(model(CLU, clu(null), [empty('outer_sd')]).ticks[3].state).toBe('required');
        expect(model(CLU, clu(null), [empty('outer_sd')]).markers).toEqual([]);
        expect(model(CLU, clu(2), [bad('outer_sd')], true).ticks[3].state).toBe('unchecked');
        expect(model(CLU, clu(2), [bad('outer_sd')], true).markers).toEqual([]);
    });
});

describe('rulerModel — set points of another kind than the model', () => {
    it('null: nothing is drawn rather than a wrong ruler', () => {
        expect(rulerModel(IND, clu(5), [])).toBeNull();
        expect(rulerModel(REL, ind(1, 9), [])).toBeNull();
        expect(rulerModel(CLU, rel({}), [])).toBeNull();
    });
});

describe('<ScoreRuler> — what the band renders', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const mount = (kind: 'individual' | 'relationship' | 'clustering', sp: HealthSetPoints, issues: HealthIssue[] = [], over: Partial<Parameters<typeof ScoreRuler>[0]> = {}) => render(
        <ScoreRuler
            data={makeHealthPreview({ kind, n_clusters: 2 } as never)}
            setPoints={sp}
            unit="bar"
            issues={issues}
            verdict={issues.length === 0 ? 'valid' : issues.every(i => i.code === 'required') ? 'needs' : 'bad'}
            onChange={onChange}
            onCommit={onCommit}
            {...over}
        >
            <div data-testid="the-checks">checks</div>
        </ScoreRuler>,
    );
    const part = (p: 'tick' | 'name' | 'value', key: string) => screen.getByTestId('score-ruler').querySelector(`[data-testid="ruler-${p}"][data-tick="${key}"]`) as HTMLElement;
    const box = (id: string) => screen.getByTestId(id).closest('.hs-num') as HTMLElement;

    it('ticks, score labels and the marker are placed in percent of the band, evenly spaced', () => {
        mount('individual', ind(3, 9), [bad('lower')]);
        expect(['lower', 'm3sd', 'm1sd', 'p1sd', 'p3sd', 'upper'].map(k => part('tick', k).style.left)).toEqual(['0%', '20%', '40%', '60%', '80%', '100%']);
        expect(part('name', 'm1sd').style.left).toBe('40%');
        expect(part('value', 'p3sd').style.left).toBe('80%');
        const m = screen.getByTestId('ruler-marker');
        expect(m.style.left).toBe('30%');
        expect(m.textContent).toBe('L = 3');
        expect(m.title).toBe('Where the value you typed sits — it is not accepted there');
        // one stem per marker, at the same place, ending on the band
        const stems = screen.getByTestId('ruler-band').querySelectorAll('.wb3-ruler-stem');
        expect(stems).toHaveLength(1);
        expect((stems[0] as HTMLElement).style.left).toBe('30%');
    });

    it('rejected = red (tick, name, input, score greyed); empty = dashed amber; fine = none of them', () => {
        mount('individual', ind(3, null), [bad('lower'), empty('upper')]);
        expect(part('tick', 'lower').className).toBe('wb3-ruler-tick wb3-ruler-tick--user wb3-ruler-tick--bad');
        expect(part('name', 'lower').className).toBe('wb3-ruler-nm wb3-ruler-nm--user wb3-ruler-nm--bad');
        expect(box('sp-lower').className).toBe('hs-num hs-num--big hs-num--err');
        expect(screen.getByTestId('sp-lower').getAttribute('aria-invalid')).toBe('true');
        expect(part('tick', 'upper').className).toBe('wb3-ruler-tick wb3-ruler-tick--user wb3-ruler-tick--req');
        expect(part('name', 'upper').className).toBe('wb3-ruler-nm wb3-ruler-nm--user wb3-ruler-nm--req');
        expect(box('sp-upper').className).toBe('hs-num hs-num--big hs-num--req');
        expect(screen.getByTestId('sp-upper').getAttribute('aria-required')).toBe('true');
        expect(part('tick', 'm3sd').className).toBe('wb3-ruler-tick');
        const scores = [...screen.getByTestId('score-ruler').querySelectorAll('.wb3-ruler-scores > span')].map(e => e.className);
        expect(scores).toEqual([
            'wb3-ruler-sc wb3-ruler-sc--bad wb3-ruler-sc--off', 'wb3-ruler-sc wb3-ruler-sc--warn', 'wb3-ruler-sc wb3-ruler-sc--ok',
            'wb3-ruler-sc wb3-ruler-sc--ok', 'wb3-ruler-sc wb3-ruler-sc--warn', 'wb3-ruler-sc wb3-ruler-sc--bad wb3-ruler-sc--off',
        ]);
        cleanup();
        mount('individual', ind(1, 9));
        expect(part('tick', 'lower').className).toBe('wb3-ruler-tick wb3-ruler-tick--user');
        expect(box('sp-lower').className).toBe('hs-num hs-num--big');
        expect(screen.queryByTestId('ruler-markers')).toBeNull();
    });

    it('not checked: dashed grey ticks, plain inputs, no marker — whatever the issues passed in say', () => {
        mount('individual', ind(3, null), [bad('lower'), empty('upper')], { unchecked: true, verdict: null });
        for (const k of ['lower', 'upper']) {
            expect(part('tick', k).className).toBe('wb3-ruler-tick wb3-ruler-tick--user wb3-ruler-tick--unk');
            expect(part('tick', k).dataset.state).toBe('unchecked');
            expect(part('name', k).className).toBe('wb3-ruler-nm wb3-ruler-nm--user');
        }
        expect(box('sp-lower').className).toBe('hs-num hs-num--big');
        expect(box('sp-upper').className).toBe('hs-num hs-num--big');
        expect(screen.getByTestId('sp-lower').getAttribute('aria-invalid')).toBeNull();
        expect(screen.queryByTestId('ruler-marker')).toBeNull();
        expect(screen.queryByTestId('hs-verdict')).toBeNull();
        expect(screen.getByTestId('ruler-band').style.background).not.toContain('var(--danger)');
    });

    it('colliding marker labels are stacked: each on its own row, the block as tall as its rows, the stems reach their own label', () => {
        mount('individual', ind(4.5, 5.5), [bad('lower'), bad('upper')]);
        const ms = screen.getAllByTestId('ruler-marker');
        expect(ms.map(m => [m.dataset.point, m.dataset.row, m.style.top, m.style.left])).toEqual([['lower', '0', '0px', '45%'], ['upper', '1', '22px', '55%']]);
        expect(screen.getByTestId('ruler-markers').style.height).toBe('44px');
        const stems = [...screen.getByTestId('ruler-band').querySelectorAll('.wb3-ruler-stem')] as HTMLElement[];
        expect(stems.map(s => s.style.top)).toEqual(['-48px', '-26px']); // the top row's stem is one row longer
    });

    it('beyond the end: the label hugs that end (its own class) and carries the arrow', () => {
        mount('individual', ind(90, 85), [bad('lower')]);
        const m = screen.getByTestId('ruler-marker');
        expect(m.textContent).toBe('L = 90 →');
        expect(m.className).toBe('wb3-ruler-mark wb3-ruler-mark--right');
        expect(m.style.left).toBe('100%');
        cleanup();
        mount('individual', ind(1, -5), [bad('upper')]);
        expect(screen.getByTestId('ruler-marker').className).toBe('wb3-ruler-mark wb3-ruler-mark--left');
        expect(screen.getByTestId('ruler-marker').textContent).toBe('← H = −5');
        expect(screen.getByTestId('ruler-marker').style.left).toBe('0%');
    });

    it('every input is described by the Checks under the ruler (aria-describedby -> the element that holds them), in every state and kind', () => {
        const check = (ids: string[]) => {
            for (const id of ids) {
                const ref = screen.getByTestId(id).getAttribute('aria-describedby');
                expect(ref, id).toBeTruthy();
                const target = document.getElementById(ref!)!;
                expect(target.className).toBe('wb3-ruler-checks');
                expect(target.contains(screen.getByTestId('the-checks'))).toBe(true);
            }
        };
        mount('individual', ind(3, null), [bad('lower'), empty('upper')]);
        check(['sp-lower', 'sp-upper']);
        cleanup();
        mount('individual', ind(1, 9), [], { unchecked: true });
        check(['sp-lower', 'sp-upper']);
        cleanup();
        mount('relationship', rel({ l0: -3, l80: -1.5, u80: 1.5, u0: 3 }));
        check(REL_RULER_POINTS.map(p => `sp-${p.key}`));
        cleanup();
        mount('clustering', clu(5));
        check(['sp-outer_sd']);
    });

    it('without Checks there is nothing to point at: no dangling aria-describedby', () => {
        render(<ScoreRuler data={makeHealthPreview({ kind: 'individual' } as never)} setPoints={ind(1, 9)} unit="bar" issues={[]} verdict="valid" onChange={onChange} onCommit={onCommit} />);
        expect(screen.getByTestId('sp-lower').getAttribute('aria-describedby')).toBeNull();
        expect(document.querySelector('.wb3-ruler-checks')).toBeNull();
    });

    it('Relation model: the point names are the same under the band, on the inputs\' own labels, in the accessible names and in the markers', () => {
        mount('relationship', rel({ l0: -3, l80: 2, u80: 2.5, u0: 4 }), [bad('residual_at_80_lower')]);
        const names = ['0 low', '80 low', '80 high', '0 high'];
        expect(REL_RULER_POINTS.map(p => part('name', p.key).childNodes[0].textContent)).toEqual(names);
        expect(REL_RULER_POINTS.map(p => part('value', p.key).querySelector('.wb3-ruler-vl')!.textContent)).toEqual(names);
        expect(REL_RULER_POINTS.map(p => screen.getByTestId(`sp-${p.key}`).getAttribute('aria-label')!.split(' — ')[0])).toEqual(names);
        expect(screen.getByTestId('ruler-marker').textContent).toBe('80 low = 2');
        // the rejected point's own label (the narrow layout's row) takes its colour too
        expect(part('value', 'residual_at_80_lower').className).toBe('wb3-ruler-v wb3-ruler-v--user wb3-ruler-v--bad');
        expect(part('value', 'residual_at_0_lower').className).toBe('wb3-ruler-v wb3-ruler-v--user');
        expect(document.body.textContent).not.toMatch(/lower 80|upper 80|lower 0|upper 0/i);
    });

    it('the verdict dot says the state in words; typing reports the draft, blur / Enter commit, a preset commits at once', () => {
        onChange.mockClear();
        onCommit.mockClear();
        mount('clustering', clu(null), [empty('outer_sd')]);
        expect(screen.getByRole('img', { name: 'Set points still empty' })).toBe(screen.getByTestId('hs-verdict'));
        fireEvent.change(screen.getByTestId('sp-outer_sd'), { target: { value: '5.5' } });
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clustering', outerSd: 5.5 }, undefined);
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.blur(screen.getByTestId('sp-outer_sd'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId('ring-quick-6'));
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clustering', outerSd: 6 }, true);
        fireEvent.click(screen.getByTestId('ring-inc'));
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clustering', outerSd: 4 }, true); // the draft prop is still empty: starts at 4
    });
});
