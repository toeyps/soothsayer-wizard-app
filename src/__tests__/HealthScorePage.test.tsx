import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';

// ECharts is not drawn in jsdom: every chart is a stand-in that records its props, so the tests can read the
// option it was given and fire the events a real chart would (hover).
const charts: any[] = [];
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => { charts.push(props); return <div data-testid="echarts-mock" data-y-name={props.option?.yAxis?.name ?? ''} />; },
}));

import HealthScorePage from '../components/windows/workbench/HealthScorePage';
import type { HealthScorePageProps, SaveInfo } from '../components/windows/workbench/workbenchTypes';
import type { HealthSetPoints } from '../types';
import type { HealthIssue, HealthPreview } from '../types/health';
import { makeHealthPreview, makeSetPointAwarePreview } from './helpers/healthPreviewFixture';

const IND_VALID = { kind: 'individual', lower: 1, upper: 9, masterLower: 1, masterUpper: 9 } as const;
const REL_VALID = { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 } as const;
const REL_EMPTY = { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null } as const;

/** The wire form of the set points (what the preview request carries) - the fixture answers from it. */
function wire(sp: HealthSetPoints): Record<string, number | null> {
    if (sp.kind === 'individual') return { lower: sp.lower, upper: sp.upper };
    if (sp.kind === 'relationship') return { residual_at_80_lower: sp.residualAt80Lower, residual_at_80_upper: sp.residualAt80Upper, residual_at_0_lower: sp.residualAt0Lower, residual_at_0_upper: sp.residualAt0Upper };
    return { outer_sd: sp.outerSd };
}
const previewFor = (kind: 'individual' | 'relationship' | 'clustering', sp: HealthSetPoints): HealthPreview =>
    makeSetPointAwarePreview({ kind, n_clusters: 2, set_points: wire(sp) as any });

interface Opts extends Partial<HealthScorePageProps> {
    kind?: 'individual' | 'relationship' | 'clustering';
    sp?: HealthSetPoints;
    data?: HealthPreview | null;
}

const onChange = vi.fn();
const onCommit = vi.fn();
const onRetrain = vi.fn();

/** The page, with the set points held in state like the container holds its draft, plus spies. */
function Harness({ kind = 'individual', sp, data, ...rest }: Opts) {
    const [points, setPoints] = useState<HealthSetPoints>(sp ?? (kind === 'individual' ? { kind, lower: null, upper: null } : kind === 'relationship' ? { ...REL_EMPTY } : { kind, outerSd: null }));
    const preview = data === undefined ? previewFor(kind, points) : data;
    return (
        <HealthScorePage
            model={{ id: 'm1', kind, targetSensor: 'TAG1', xSensor: 'TAG1', ySensor: 'TAG2', predictorSensors: ['TAG2'] } as any}
            stale={false}
            preview={{ data: preview, loading: false, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: null }}
            unit="bar"
            sensorLabel={t => t}
            getDesc={t => t}
            setPoints={points}
            onSetPointsChange={(next, commit) => { setPoints(next); onChange(next, commit); }}
            onSetPointsCommit={onCommit}
            attemptIssues={null}
            save={{ phase: 'idle' }}
            filesOutOfDate={false}
            onRetrain={onRetrain}
            {...rest}
        />
    );
}
const mount = (o: Opts = {}) => render(<Harness {...o} />);

const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });
const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const field = (id: string) => input(id).closest('.hs-num') as HTMLElement;
const scoreChart = () => charts.filter(c => c.option?.yAxis?.name === 'Score').pop();
const setChart = () => charts.filter(c => c.option?.yAxis?.name !== 'Score' || c.option?.series?.[0]?.name === 'Points').pop();

beforeEach(() => {
    charts.length = 0;
    onChange.mockClear();
    onCommit.mockClear();
    onRetrain.mockClear();
});
afterEach(cleanup);

describe('Individual: the 100 / 80 / 0 ladder', () => {
    it('has three rungs; the values the program computes are read-only (lock), only L and H are inputs', () => {
        mount({ sp: IND_VALID });
        const card = screen.getByTestId('set-points-card');
        expect(within(card).getByTestId('rung-100').textContent).toMatch(/Within ±1SD/);
        expect(within(card).getByTestId('rung-100').textContent).toMatch(/auto/);
        expect(within(card).getByTestId('rung-80').textContent).toMatch(/At ±3SD/);
        expect(within(card).getByTestId('rung-0').textContent).toMatch(/At setpoint L \/ H/);
        // read-only: not inputs
        expect(screen.getByTestId('ro-l1').tagName).toBe('SPAN');
        expect([screen.getByTestId('ro-l1'), screen.getByTestId('ro-u1'), screen.getByTestId('ro-l3'), screen.getByTestId('ro-u3')].map(e => e.textContent)).toEqual(['4.00', '6.00', '2.00', '8.00']);
        expect(card.querySelectorAll('input')).toHaveLength(2);
        expect(card.querySelectorAll('svg.lucide-lock').length).toBe(2);
        expect(input('sp-lower').value).toBe('1');
        expect(input('sp-upper').value).toBe('9');
    });

    it('the inputs show the unit', () => {
        mount({ sp: IND_VALID });
        expect(field('sp-lower').textContent).toContain('bar');
        expect(field('sp-upper').textContent).toContain('bar');
    });

    it('typing reports each change (the draft) without committing; blur or Enter commits', () => {
        mount({ sp: IND_VALID });
        type('sp-upper', '12');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'individual', lower: 1, upper: 12 }), undefined);
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.blur(input('sp-upper'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(input('sp-lower'), { key: 'Enter' });
        expect(onCommit).toHaveBeenCalledTimes(2);
        fireEvent.keyDown(input('sp-lower'), { key: 'a' });
        expect(onCommit).toHaveBeenCalledTimes(2);
    });

    it('clearing a field reports null; half-typed text ("-", "1.") never wipes what the user is typing', () => {
        mount({ sp: IND_VALID });
        type('sp-lower', '');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lower: null }), undefined);
        type('sp-lower', '-');
        expect(input('sp-lower').value).toBe('-');
        type('sp-lower', '-1.');
        expect(input('sp-lower').value).toBe('-1.');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lower: -1 }), undefined);
        type('sp-lower', '-1.5');
        expect(input('sp-lower').value).toBe('-1.5');
    });

    describe('source chips + "use <master value>"', () => {
        it('master data: the value equals the snapshot; no reset link', () => {
            mount({ sp: IND_VALID });
            expect(screen.getByTestId('sp-lower-source').textContent).toBe('master data');
            expect(screen.queryByTestId('sp-lower-reset')).toBeNull();
        });

        it('this model: the value differs from the snapshot; the link offers the master value and restores it with an immediate commit', () => {
            mount({ sp: { ...IND_VALID, upper: 12 } });
            expect(screen.getByTestId('sp-upper-source').textContent).toBe('this model');
            const reset = screen.getByTestId('sp-upper-reset');
            expect(reset.textContent).toBe('use 9.00');
            fireEvent.click(reset);
            expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'individual', upper: 9, masterUpper: 9 }), true);
            expect(input('sp-upper').value).toBe('9');
            expect(screen.getByTestId('sp-upper-source').textContent).toBe('master data');
            expect(screen.queryByTestId('sp-upper-reset')).toBeNull();
        });

        it('typing a value over a master one flips the chip live', () => {
            mount({ sp: IND_VALID });
            type('sp-lower', '0.5');
            expect(screen.getByTestId('sp-lower-source').textContent).toBe('this model');
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('use 1.00');
        });

        it('not in master: master has no value (special sensor / no alarm): the chip says so and there is nothing to restore', () => {
            mount({ sp: { kind: 'individual', lower: null, upper: 20, masterLower: null, masterUpper: null } });
            expect(screen.getByTestId('sp-lower-source').textContent).toBe('not in master');
            expect(screen.getByTestId('sp-upper-source').textContent).toBe('this model');
            expect(screen.queryByTestId('sp-lower-reset')).toBeNull();
            expect(screen.queryByTestId('sp-upper-reset')).toBeNull();
        });

        it('a value that master has but the user cleared is "this model" with a link to bring it back', () => {
            mount({ sp: { kind: 'individual', lower: null, upper: 9, masterLower: 5, masterUpper: 9 } });
            expect(screen.getByTestId('sp-lower-source').textContent).toBe('this model');
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('use 5.00');
        });
    });

    describe('field state comes from Rust\'s issues', () => {
        it('an empty field is "required" (dashed, "Required" placeholder); a rejected one is "error"; a fine one is neither', () => {
            mount({ sp: { kind: 'individual', lower: 3, upper: null, masterLower: null, masterUpper: null } });
            expect(field('sp-upper').className).toMatch(/hs-num--req/);
            expect(input('sp-upper').placeholder).toBe('Required');
            expect(field('sp-lower').className).toMatch(/hs-num--err/);
            expect(input('sp-lower').getAttribute('aria-invalid')).toBe('true');
        });

        it('a valid pair has no marked field', () => {
            mount({ sp: IND_VALID });
            expect(field('sp-lower').className).not.toMatch(/hs-num--(req|err)/);
            expect(field('sp-upper').className).not.toMatch(/hs-num--(req|err)/);
        });

        it('typing a value that Rust rejects turns the field red; fixing it clears it', () => {
            mount({ sp: IND_VALID });
            type('sp-lower', '3');
            expect(field('sp-lower').className).toMatch(/hs-num--err/);
            type('sp-lower', '1');
            expect(field('sp-lower').className).not.toMatch(/hs-num--err/);
        });
    });

    it('the master-data note is shown for Individual', () => {
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('master-note').textContent).toBe('H and L entered here are saved on this model only. Master data is not changed.');
    });
});

describe('Relationship: four points, all start empty', () => {
    it('ladder: ±2RMSE read-only (locked, "from training"), Lower / Upper at 80 and at 0 are inputs showing the unit', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        expect(screen.getByTestId('rung-100').textContent).toMatch(/Within ±2RMSE/);
        expect(screen.getByTestId('rung-100').textContent).toMatch(/from training/);
        expect(screen.getByTestId('ro-l2').textContent).toBe('−0.913');
        expect(screen.getByTestId('ro-u2').textContent).toBe('+0.913');
        const ids = ['sp-residual_at_80_lower', 'sp-residual_at_80_upper', 'sp-residual_at_0_lower', 'sp-residual_at_0_upper'];
        for (const id of ids) {
            expect(input(id).value).toBe('');
            expect(input(id).placeholder).toBe('Required');
            expect(field(id).className).toMatch(/hs-num--req/);
            expect(field(id).textContent).toContain('bar');
        }
        expect(screen.queryByTestId('master-note')).toBeNull();
    });

    it('typing writes the matching field of the draft', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        type('sp-residual_at_80_lower', '-1.5');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: null }), undefined);
        type('sp-residual_at_0_upper', '3');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ residualAt0Upper: 3, residualAt80Lower: -1.5 }), undefined);
    });

    it('Checks: the four empty points are ONE line ("Enter 4 empty points: ..."); entering them one by one shrinks it', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        let lines = screen.getAllByTestId('check-line');
        expect(lines).toHaveLength(1);
        expect(lines[0].textContent).toMatch(/Enter 4 empty points: lower 80, upper 80, lower 0, upper 0/);
        type('sp-residual_at_80_lower', '-1.5');
        type('sp-residual_at_80_upper', '1.5');
        lines = screen.getAllByTestId('check-line');
        expect(lines).toHaveLength(1);
        expect(lines[0].textContent).toMatch(/Enter 2 empty points: lower 0, upper 0/);
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Incomplete');
    });

    it('all four entered: Valid, the green line, no field marked', () => {
        mount({ kind: 'relationship', sp: { ...REL_VALID } });
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Valid');
        expect(screen.getByTestId('check-valid')).toBeTruthy();
        expect(screen.queryAllByTestId('check-line')).toHaveLength(0);
    });
});

describe('Clustering: one outer ring N for every cluster', () => {
    const CL = (n: number | null) => ({ kind: 'clustering', outerSd: n }) as const;

    it('ladder: 100 and 80 are locked text, the 0 rung is the "Outer ring" with a number box, - / + and 4x 5x 6x 7x', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        expect(screen.getByTestId('rung-100').textContent).toMatch(/Inside the 1× SD ring/);
        expect(screen.getByTestId('rung-80').textContent).toMatch(/On the 3× SD ring/);
        expect(screen.getByTestId('rung-0').textContent).toMatch(/Outer ring — N× SD \(more than 3\)/);
        expect(input('sp-outer_sd').value).toBe('');
        expect(input('sp-outer_sd').placeholder).toBe('Required');
        expect(field('sp-outer_sd').textContent).toContain('× SD');
        expect(['ring-quick-4', 'ring-quick-5', 'ring-quick-6', 'ring-quick-7'].map(id => screen.getByTestId(id).textContent)).toEqual(['4×', '5×', '6×', '7×']);
        expect(screen.getByTestId('rung-0').textContent).toMatch(/One number for every cluster/);
    });

    it('a quick button sets N and commits at once; the current one is pressed', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        fireEvent.click(screen.getByTestId('ring-quick-6'));
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clustering', outerSd: 6 }, true);
        expect(input('sp-outer_sd').value).toBe('6');
        expect(screen.getByTestId('ring-quick-6').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('ring-quick-5').getAttribute('aria-pressed')).toBe('false');
    });

    it('the stepper moves by 0.5 with an immediate commit, starts at 4 when empty and never goes to 3 or below', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        fireEvent.click(screen.getByTestId('ring-inc'));
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clustering', outerSd: 4 }, true);
        fireEvent.click(screen.getByTestId('ring-inc'));
        expect(input('sp-outer_sd').value).toBe('4.5');
        fireEvent.click(screen.getByTestId('ring-dec'));
        fireEvent.click(screen.getByTestId('ring-dec'));
        fireEvent.click(screen.getByTestId('ring-dec'));
        fireEvent.click(screen.getByTestId('ring-dec'));
        expect(input('sp-outer_sd').value).toBe('3.5');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clustering', outerSd: 3.5 }, true);
    });

    it('typing N reports it as a draft (no commit until blur / Enter)', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        type('sp-outer_sd', '5.5');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clustering', outerSd: 5.5 }, undefined);
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.blur(input('sp-outer_sd'));
        expect(onCommit).toHaveBeenCalled();
    });

    it('N of 3 or less is marked as an error with Rust\'s message in Checks', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        type('sp-outer_sd', '3');
        expect(field('sp-outer_sd').className).toMatch(/hs-num--err/);
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Not valid');
        expect(screen.getByTestId('check-line').textContent).toMatch(/must be more than 3× SD/);
    });

    it('the set-point chart carries the 1x, 3x and N x ring of EVERY cluster, and follows N', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        const rings = (c: any) => c.option.series.filter((s: any) => s.type === 'custom').length;
        expect(rings(setChart())).toBe(4); // 2 clusters x (1x, 3x)
        fireEvent.click(screen.getByTestId('ring-quick-5'));
        expect(rings(setChart())).toBe(6); // + N x ring of each
    });

    it('no master-data note (that is Individual\'s)', () => {
        mount({ kind: 'clustering', sp: CL(5) });
        expect(screen.queryByTestId('master-note')).toBeNull();
    });
});

describe('Checks card', () => {
    it('renders Rust\'s issues as lines - empty = amber, rejected = red - with the verdict pill', () => {
        mount({ sp: { kind: 'individual', lower: 3, upper: null, masterLower: null, masterUpper: null } });
        const lines = screen.getAllByTestId('check-line');
        expect(lines.map(l => l.getAttribute('data-tone'))).toEqual(['need', 'bad']);
        expect(lines[0].textContent).toMatch(/Enter the upper set point \(H\)/);
        expect(lines[1].textContent).toMatch(/must be below the lower 3σ boundary/);
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Not valid');
    });

    it('"Incomplete" when everything missing is only empty, "Valid" when nothing is left', () => {
        mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Incomplete');
        cleanup();
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Valid');
        expect(screen.getByTestId('check-valid').textContent).toMatch(/passes the checks/);
    });

    it('shows the issues of a refused Mark complete (attemptIssues) instead of the live ones', () => {
        const attempt: HealthIssue[] = [{ code: 'lower_equals_3sd', field: 'lower', severity: 'error', message: 'L equals the lower 3σ boundary (found when saving)' }];
        mount({ sp: IND_VALID, attemptIssues: attempt });
        expect(screen.getAllByTestId('check-line')).toHaveLength(1);
        expect(screen.getByTestId('check-line').textContent).toMatch(/found when saving/);
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Not valid');
        expect(field('sp-lower').className).toMatch(/hs-num--err/);
    });
});

describe('Health score chart', () => {
    it('is locked ("Set the points above") while the set points are not valid - no score chart is drawn', () => {
        mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
        expect(screen.getByTestId('score-locked').textContent).toMatch(/Set the points above/);
        expect(scoreChart()).toBeUndefined();
        expect(screen.queryByTestId('chart-card-score')).toBeNull();
    });

    it('is locked when the preview carries no score even though it says valid', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, series: { ...d.series, score: null } as any } });
        expect(screen.getByTestId('score-locked')).toBeTruthy();
    });

    it('draws the score chart once valid: 0-100 series from series.score, with a gap (null), never 0, for a row without a score', () => {
        const d = previewFor('individual', IND_VALID);
        const series = { ...d.series, score: [100, null, 80, 55, 30] } as any;
        mount({ sp: IND_VALID, data: { ...d, series } });
        expect(screen.queryByTestId('score-locked')).toBeNull();
        expect(screen.getByTestId('chart-card-score')).toBeTruthy();
        const opt = scoreChart().option;
        expect(opt.series[0].data.map((p: any) => p[1])).toEqual([100, null, 80, 55, 30]);
        expect(opt.yAxis.min).toBe(0);
        expect(opt.yAxis.max).toBe(100);
    });

    it('header: the lowest score and when, % of scored rows below 80, and the three time-share numbers', () => {
        mount({ sp: IND_VALID });
        const sum = screen.getByTestId('score-summary');
        expect(screen.getByTestId('score-lowest').textContent).toBe('30');
        expect(sum.textContent).toMatch(/on 2026-01-01 04:00:00/);
        expect(screen.getByTestId('score-below80').textContent).toBe('40.0%');
        expect(screen.getByTestId('share-share_80_100').textContent).toBe('80–10060.0%');
        expect(screen.getByTestId('share-share_40_80').textContent).toBe('40–8020.0%');
        expect(screen.getByTestId('share-share_0_40').textContent).toBe('0–4020.0%');
    });

    it('a lowest score of 80 or more reads green, below 80 red', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, min_score: { score: 92, row: 1, timestamp: 't' } } } });
        expect(screen.getByTestId('score-lowest').className).toMatch(/hs-good/);
        cleanup();
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('score-lowest').className).toMatch(/hs-bad/);
    });

    it('shows an em dash for a share Rust did not provide', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, share_40_80: null, pct_below_80: null } } });
        expect(screen.getByTestId('share-share_40_80').textContent).toBe('40–80—');
        expect(screen.getByTestId('score-summary').textContent).not.toMatch(/below 80 for/);
    });

    it('every chart card has the Expand button (set-point chart and score chart)', () => {
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('chart-expand-set-individual')).toBeTruthy();
        fireEvent.click(screen.getByTestId('chart-expand-score'));
        expect(screen.getByTestId('chart-overlay-score')).toBeTruthy();
        expect(screen.getByTestId('chart-overlay-score').querySelector('[data-testid="score-shares"]')).toBeTruthy();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('chart-overlay-score')).toBeNull();
    });

    it('the Out of date film covers both charts while the model is stale', () => {
        mount({ sp: IND_VALID, stale: true });
        expect(screen.getAllByTestId('chart-outdated').length).toBe(2);
    });
});

describe('set-point chart per kind', () => {
    it('Individual: raw values with the L / H lines the draft holds (and they move as the user types)', () => {
        mount({ sp: IND_VALID });
        const marks = (c: any) => c.option.series[0].markLine.data.map((d: any) => d.label?.formatter);
        expect(marks(setChart())).toEqual(expect.arrayContaining(['L', 'H']));
        type('sp-upper', '');
        expect(marks(setChart())).not.toContain('H');
        expect(marks(setChart())).toContain('L');
        expect(screen.getByTestId('chart-card-set-individual').textContent).toMatch(/type L and H on the right/);
    });

    it('Relationship: the residual only - the 80 / 0 lines appear as they are typed', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        expect(screen.getByTestId('chart-card-set-relationship')).toBeTruthy();
        const marks = (c: any) => c.option.series[0].markLine.data.length;
        expect(marks(setChart())).toBe(3); // +2RMSE, -2RMSE, zero
        type('sp-residual_at_80_upper', '1.5');
        expect(marks(setChart())).toBe(4);
    });

    it('Clustering: the scatter card', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(screen.getByTestId('chart-card-set-clustering')).toBeTruthy();
        expect(setChart().option.series[0].name).toBe('Points');
    });
});

describe('hover sync (the pointer on either chart reads the same row on both)', () => {
    const TS = '2026-01-01 03:00:00';
    const axisEvent = (t: string) => ({ axesInfo: [{ axisDim: 'x', value: new Date(t).getTime() }] });

    it('the two time charts join one ECharts group (shared cursor + tooltip)', () => {
        mount({ sp: IND_VALID });
        const inst1: any = {};
        const inst2: any = {};
        setChart().onChartReady(inst1);
        scoreChart().onChartReady(inst2);
        expect(inst1.group).toBeTruthy();
        expect(inst1.group).toBe(inst2.group);
    });

    it('hovering the score chart prints time, raw value and score; leaving clears it', () => {
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent(TS)); });
        expect(screen.getByTestId('hs-readout').textContent).toBe(`${TS} · value 6.20 bar · score 60`);
        act(() => { scoreChart().onEvents.globalout(); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
    });

    it('hovering the SET-POINT chart drives the same read-out', () => {
        mount({ sp: IND_VALID });
        act(() => { setChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 04:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026-01-01 04:00:00 · value 3.10 bar · score 30');
    });

    it('Relationship reads "residual"', () => {
        mount({ kind: 'relationship', sp: { ...REL_VALID } });
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 02:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toMatch(/residual -0\.200 bar · score 80/);
    });

    it('Clustering: hovering a point of the scatter highlights that row and fills the read-out; hovering the score chart highlights it on the scatter', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(setChart().option.series.some((s: any) => s.name === 'Hover')).toBe(false);
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Points', dataIndex: 3 }); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026-01-01 03:00:00 · score 60');
        expect(setChart().option.series.find((s: any) => s.name === 'Hover').data).toEqual([[21, 41]]);
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Centres', dataIndex: 0 }); }); // a ring / centre is not a row
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026-01-01 03:00:00 · score 60');
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 01:00:00')); });
        expect(setChart().option.series.find((s: any) => s.name === 'Hover').data).toEqual([[11, 21]]);
        act(() => { setChart().onEvents.globalout(); });
        expect(setChart().option.series.some((s: any) => s.name === 'Hover')).toBe(false);
    });

    it('a row without a score reads "not running"', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, series: { ...d.series, score: [100, null, 80, 55, 30] } as any } });
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 01:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026-01-01 01:00:00 · not running');
    });
});

describe('states of the preview', () => {
    it('while loading with nothing to show: a loading frame', () => {
        mount({ data: null });
        expect(screen.getByTestId('health-loading')).toBeTruthy();
    });

    it('NOT_FITTED with nothing to show: "Re-train to recompute" with a Re-train button', () => {
        mount({ data: null, preview: { data: null, loading: false, error: 'no fit', errorCode: 'NOT_FITTED', notFitted: true, needsRetrain: true, idle: null } });
        expect(screen.getByTestId('health-not-fitted').textContent).toMatch(/Re-train to recompute/);
        fireEvent.click(screen.getByTestId('health-not-fitted-retrain'));
        expect(onRetrain).toHaveBeenCalled();
    });

    it('NOT_FITTED while the last charts are still held: a banner above them', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, preview: { data: d, loading: false, error: 'no fit', errorCode: 'NOT_FITTED', notFitted: true, needsRetrain: true, idle: null } });
        expect(screen.getByTestId('health-not-fitted-banner')).toBeTruthy();
        expect(screen.getByTestId('set-points-card')).toBeTruthy();
    });

    it('another error with nothing to show: the message', () => {
        mount({ data: null, preview: { data: null, loading: false, error: 'No rows in the training scope', errorCode: 'NO_DATA', notFitted: false, needsRetrain: false, idle: null } });
        expect(screen.getByTestId('health-error').textContent).toMatch(/No rows in the training scope/);
    });

    it('while a newer answer loads the previous charts stay (the card never blanks out)', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, preview: { data: d, loading: true, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: null } });
        expect(screen.getByTestId('set-points-card')).toBeTruthy();
        expect(screen.getByTestId('chart-card-score')).toBeTruthy();
    });
});

describe('saved files: progress, result and "changed after saving"', () => {
    const save = (s: SaveInfo) => mount({ sp: IND_VALID, save: s });

    it('nothing to say while idle', () => {
        save({ phase: 'idle' });
        expect(screen.queryByTestId('save-running')).toBeNull();
        expect(screen.queryByTestId('save-ok')).toBeNull();
        expect(screen.queryByTestId('save-error')).toBeNull();
    });

    it('running: "Saving results…"; a Relationship adds that it can take about 15 seconds', () => {
        save({ phase: 'running', slow: false });
        expect(screen.getByTestId('save-running').textContent).toBe('Saving results…');
        cleanup();
        save({ phase: 'running', slow: true });
        expect(screen.getByTestId('save-running').textContent).toMatch(/Saving results….*15 seconds/);
    });

    it('ok: "Saved N files to <path>" in plain text, with the file names in an expandable row', () => {
        save({
            phase: 'ok', outputDir: 'C:/data/workspaces/ws1/output', at: 'now',
            files: [{ file_name: 'REL_INFO_a.json', path: 'C:/o/REL_INFO_a.json' }, { file_name: 'REL_DATASET_a.csv', path: 'C:/o/REL_DATASET_a.csv' }],
        });
        const ok = screen.getByTestId('save-ok');
        expect(ok.textContent).toMatch(/Saved 2 files to C:\/data\/workspaces\/ws1\/output/);
        const files = within(screen.getByTestId('save-files'));
        expect(files.getByText('REL_INFO_a.json')).toBeTruthy();
        expect(files.getByText('REL_DATASET_a.csv')).toBeTruthy();
    });

    it('ok for one file is singular', () => {
        save({ phase: 'ok', outputDir: 'C:/o', at: 'now', files: [{ file_name: 'INDV_INFO_a.json', path: 'C:/o/INDV_INFO_a.json' }] });
        expect(screen.getByTestId('save-ok').textContent).toMatch(/Saved 1 file to C:\/o/);
    });

    it('ok from an earlier session (only the record is known): the folder, no file list', () => {
        save({ phase: 'ok', outputDir: 'C:/o', at: 'earlier', files: null });
        expect(screen.getByTestId('save-ok').textContent).toBe('Files saved to C:/o');
        expect(screen.queryByTestId('save-files')).toBeNull();
    });

    it('error: says the model was not saved and why', () => {
        save({ phase: 'error', message: 'Re-train first — the fitted Relation model is no longer in memory.' });
        expect(screen.getByTestId('save-error').textContent).toMatch(/not saved.*Re-train first/);
    });

    it('"Changed after saving — Mark complete again to update the files" only when the files are out of date', () => {
        mount({ sp: IND_VALID, filesOutOfDate: true });
        expect(screen.getByTestId('files-out-of-date').textContent).toMatch(/Changed after saving.*Mark complete again to update the files/);
        cleanup();
        mount({ sp: IND_VALID, filesOutOfDate: false });
        expect(screen.queryByTestId('files-out-of-date')).toBeNull();
    });
});

describe('the page never decides a value is wrong by itself', () => {
    it('a valid-looking pair that Rust rejects is shown as Rust says (no TS re-validation)', () => {
        const d = previewFor('individual', IND_VALID);
        const rejected: HealthPreview = { ...d, valid: false, series: { ...d.series, score: null } as any, score_summary: null, validation: [{ code: 'ordering', field: 'lower', severity: 'error', message: 'Rust says no' }] };
        mount({ sp: IND_VALID, data: rejected });
        expect(screen.getByTestId('check-line').textContent).toBe('Rust says no');
        expect(screen.getByTestId('score-locked')).toBeTruthy();
        expect(field('sp-lower').className).toMatch(/hs-num--err/);
    });

    it('an unscored preview with no issues at all (still being answered) shows a neutral "Checking" line, not a verdict', () => {
        mount({ sp: IND_VALID, data: makeHealthPreview({ kind: 'individual' }) });
        expect(screen.getByTestId('checks-pending')).toBeTruthy();
        expect(screen.queryByTestId('hs-verdict')).toBeNull();
    });
});
