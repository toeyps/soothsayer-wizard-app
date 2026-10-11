import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';

// ECharts is not drawn in jsdom: every chart is a stand-in that records its props, so the tests can read the
// option it was given and fire the events a real chart would (hover).
const charts: any[] = [];
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => { charts.push(props); return <div data-testid="echarts-mock" data-y-name={props.option?.yAxis?.name ?? ''} />; },
}));

import HealthScorePage, { SLOW_SAVE_NOTICE_MS, sameHealthScoreProps, shareText } from '../components/windows/workbench/HealthScorePage';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { CHART } from '../components/windows/workbench/chartTheme';
import type { HealthScorePageProps, SaveInfo } from '../components/windows/workbench/workbenchTypes';
import type { HealthSetPoints } from '../types';
import type { HealthIssue, HealthPreview } from '../types/health';
import { makeHealthPreview, makeSetPointAwarePreview } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';

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
const onGoTrain = vi.fn();
const onReload = vi.fn();

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
            setPoints={points}
            onSetPointsChange={(next, commit) => { setPoints(next); onChange(next, commit); }}
            onSetPointsCommit={onCommit}
            attemptIssues={null}
            save={{ phase: 'idle' }}
            fitGone={{ onReload, onGoTrainSensor: onGoTrain }}
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
/** Text of the legend row under a card's chart, or null when the card has none. */
const legendOf = (id: string) => screen.getByTestId(`chart-card-${id}`).querySelector('.wb2-legend')?.textContent ?? null;
/** The names PRINTED in the strip above a time chart's plot (train / scoring scopes), in band order. */
const stripOf = (c: any): string[] => (c.option.series.find((x: any) => x.name === '__scopes')?.markArea?.data ?? [])
    .filter((a: any) => a[0].label.show).map((a: any) => a[0].label.formatter);
/** The ring levels named on the Clusters chart. */
const ringLabelsOf = (c: any): string[] => (c.option.series.find((x: any) => x.name === 'Ring labels')?.data ?? []).map((x: any) => x.label.formatter);

beforeEach(() => {
    charts.length = 0;
    onChange.mockClear();
    onCommit.mockClear();
    onGoTrain.mockClear();
    onReload.mockClear();
});
afterEach(cleanup);

describe('Individual: the set-point table (100 / 80 / 0)', () => {
    // workbench-redesign SPEC §4: Score · Band · Lower · Upper. Automatic values are TEXT.
    it('is ONE table — Score · Band · Lower · Upper; what the program computes is plain text, only L and H are inputs', () => {
        mount({ sp: IND_VALID });
        const card = screen.getByTestId('set-points-card');
        const table = within(card).getByRole('table', { name: 'Health set points' });
        expect(within(table).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Score', 'Band', 'Lower', 'Upper']);
        expect(within(table).getAllByRole('row')).toHaveLength(4); // head + 100 / 80 / 0
        expect(within(card).getByTestId('rung-100').textContent).toBe('100within ±1SD · automatic4.0006.000');
        expect(within(card).getByTestId('rung-80').textContent).toBe('80at ±3SD · automatic2.0008.000');
        expect(within(card).getByTestId('rung-0').textContent).toMatch(/^0at L \/ H · you set them/);
        // automatic values: text, never something that looks like an input
        for (const id of ['ro-l1', 'ro-u1', 'ro-l3', 'ro-u3']) {
            const el = screen.getByTestId(id);
            expect(el.tagName).toBe('SPAN');
            expect(el.className).toBe('hsx-ro');
            expect(el.closest('.hs-num')).toBeNull();
        }
        expect([screen.getByTestId('ro-l1'), screen.getByTestId('ro-u1'), screen.getByTestId('ro-l3'), screen.getByTestId('ro-u3')].map(e => e.textContent)).toEqual(['4.000', '6.000', '2.000', '8.000']);
        expect(card.querySelectorAll('input')).toHaveLength(2);
        // no locks, no boxed rungs, no source chips any more
        expect(card.querySelectorAll('svg.lucide-lock')).toHaveLength(0);
        expect(card.querySelector('.hs-rung, .hs-ro, .hs-src, .hs-lock')).toBeNull();
        expect(input('sp-lower').value).toBe('1');
        expect(input('sp-upper').value).toBe('9');
        expect(screen.getByLabelText(/^L — /)).toBe(input('sp-lower'));
        expect(screen.getByLabelText(/^H — /)).toBe(input('sp-upper'));
    });

    it('the Checks live in the SAME card, under the table (no second card, no second header)', () => {
        mount({ sp: IND_VALID });
        const card = screen.getByTestId('set-points-card');
        const checks = within(card).getByTestId('checks-card');
        expect(checks.tagName).toBe('DIV');
        expect(checks.closest('.hsx-checks')).not.toBeNull();
        expect(within(card).getByTestId('check-valid').textContent).toBe('Every set point passes the checks — the score is below.');
        expect(screen.getAllByTestId('checks-card')).toHaveLength(1);
        expect(document.querySelectorAll('.hs-spp > section')).toHaveLength(1);
        expect(card.querySelectorAll('.wb2-card-h')).toHaveLength(1);
        expect(card.textContent).not.toMatch(/Checks/);
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

    describe('master-data footnote (inside the card) + "Use master H …" only for a side that differs', () => {
        const origin = () => screen.getByTestId('master-origin');

        it('both sides equal the master data: one sentence, no link', () => {
            mount({ sp: IND_VALID });
            const note = screen.getByTestId('master-note');
            expect(note.closest('[data-testid="set-points-card"]')).not.toBeNull();
            expect(note.textContent).toBe('L and H come from the master data alarm limits. Saved on this model only; the master data is not changed.');
            expect(origin().dataset.lower).toBe('master');
            expect(origin().dataset.upper).toBe('master');
            expect(note.querySelector('button')).toBeNull();
            expect(screen.queryByTestId('sp-lower-reset')).toBeNull();
            expect(screen.queryByTestId('sp-upper-reset')).toBeNull();
            // the old per-field chips are gone
            expect(screen.queryByTestId('sp-lower-source')).toBeNull();
        });

        it('H differs: the note says which side, the link offers the master value and restores it with an immediate commit', () => {
            mount({ sp: { ...IND_VALID, upper: 12 } });
            expect(origin().textContent).toBe('L comes from the master data · H is set on this model.');
            expect(screen.queryByTestId('sp-lower-reset')).toBeNull();
            const reset = screen.getByTestId('sp-upper-reset');
            expect(reset.textContent).toBe('Use master H 9');
            fireEvent.click(reset);
            expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'individual', upper: 9, masterUpper: 9 }), true);
            expect(input('sp-upper').value).toBe('9');
            expect(origin().textContent).toBe('L and H come from the master data alarm limits.');
            expect(screen.queryByTestId('sp-upper-reset')).toBeNull();
        });

        it('typing a value over a master one changes the note live', () => {
            mount({ sp: IND_VALID });
            type('sp-lower', '0.5');
            expect(origin().textContent).toBe('L is set on this model · H comes from the master data.');
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('Use master L 1');
        });

        it('both sides differ: two links', () => {
            mount({ sp: { kind: 'individual', lower: 0, upper: 12, masterLower: 1, masterUpper: 9 } });
            expect(screen.getByTestId('master-note').textContent).toBe('L is set on this model · H is set on this model. Saved on this model only; the master data is not changed. Use master L 1 · Use master H 9');
        });

        // The user reported a padded "-2.000": a master value is one somebody TYPED — shown exactly.
        it('the master value in the link is printed exactly as typed: never padded, never rounded', () => {
            mount({ sp: { kind: 'individual', lower: -5, upper: 12, masterLower: -2, masterUpper: 4.5 } });
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('Use master L -2');
            expect(screen.getByTestId('sp-upper-reset').textContent).toBe('Use master H 4.5');
            cleanup();
            mount({ sp: { kind: 'individual', lower: 1, upper: 12, masterLower: 0.05, masterUpper: 4.61234 } });
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('Use master L 0.05');
            expect(screen.getByTestId('sp-upper-reset').textContent).toBe('Use master H 4.61234');
            expect(screen.getByTestId('set-points-card').textContent).not.toMatch(/-2\.0|4\.50|4\.612(?!34)|0\.050/);
        });

        it('master has no value (special sensor / no alarm): the note says so and there is nothing to restore', () => {
            mount({ sp: { kind: 'individual', lower: null, upper: 20, masterLower: null, masterUpper: null } });
            expect(origin().textContent).toBe('L is not in the master data · H is set on this model.');
            expect(screen.queryByTestId('sp-lower-reset')).toBeNull();
            expect(screen.queryByTestId('sp-upper-reset')).toBeNull();
            cleanup();
            mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
            expect(origin().textContent).toBe('The master data has no alarm limits for this sensor — type L and H.');
        });

        it('a value that master has but the user cleared is "set on this model" with a link to bring it back', () => {
            mount({ sp: { kind: 'individual', lower: null, upper: 9, masterLower: 5, masterUpper: 9 } });
            expect(origin().dataset.lower).toBe('model');
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('Use master L 5');
        });
    });

    describe('field state comes from Rust\'s issues', () => {
        it('an empty field is "required" (dashed amber box, aria-required; the placeholder names the box: "L" / "H"); a rejected one is "error"; a fine one is neither', () => {
            mount({ sp: { kind: 'individual', lower: 3, upper: null, masterLower: null, masterUpper: null } });
            expect(field('sp-upper').className).toMatch(/hs-num--req/);
            expect(input('sp-upper').placeholder).toBe('H');
            expect(input('sp-lower').placeholder).toBe('L');
            expect(input('sp-upper').getAttribute('aria-required')).toBe('true');
            expect(input('sp-lower').getAttribute('aria-required')).toBeNull();
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

    it('an input keeps the text the user typed ("2.50" is not rewritten to "2.5"; "-2" never becomes "-2.000")', () => {
        mount({ sp: { kind: 'individual', lower: null, upper: 9, masterLower: null, masterUpper: null } });
        type('sp-lower', '-2');
        expect(input('sp-lower').value).toBe('-2');
        type('sp-lower', '-2.50');
        expect(input('sp-lower').value).toBe('-2.50');
        fireEvent.blur(input('sp-lower'));
        expect(input('sp-lower').value).toBe('-2.50');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lower: -2.5 }), undefined);
    });
});

describe('Relationship: four points, all start empty', () => {
    it('table: the 100 row is text ("within ±2RMSE · automatic"); the four residual points are the only inputs, empty, with − / + placeholders and the unit', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        const card = screen.getByTestId('set-points-card');
        expect(within(card).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Score', 'Band', 'Lower', 'Upper']);
        expect(screen.getByTestId('rung-100').textContent).toBe('100within ±2RMSE · automatic−0.913+0.913');
        expect(screen.getByTestId('rung-100').querySelector('input')).toBeNull();
        expect(screen.getByTestId('ro-l2').textContent).toBe('−0.913');
        expect(screen.getByTestId('ro-u2').textContent).toBe('+0.913');
        expect(screen.getByTestId('ro-l2').closest('.hs-num')).toBeNull();
        expect(screen.getByTestId('rung-80').textContent).toMatch(/^80residual at 80 · you set them/);
        expect(screen.getByTestId('rung-0').textContent).toMatch(/^0residual at 0 · you set them/);
        const ids = ['sp-residual_at_80_lower', 'sp-residual_at_80_upper', 'sp-residual_at_0_lower', 'sp-residual_at_0_upper'];
        expect(card.querySelectorAll('input')).toHaveLength(4);
        for (const id of ids) {
            expect(input(id).value).toBe(''); // they start EMPTY — no defaults
            expect(input(id).placeholder).toBe(id.endsWith('_lower') ? '−' : '+');
            expect(field(id).className).toMatch(/hs-num--req/);
            expect(field(id).textContent).toContain('bar');
        }
        expect(screen.getByTestId('sign-note').textContent).toBe('Residual = actual − predicted: lower points are negative, upper points positive. 0 sits further from zero than 80.');
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
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points still empty');
    });

    it('all four entered: Valid, the green line, no field marked', () => {
        mount({ kind: 'relationship', sp: { ...REL_VALID } });
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points valid');
        expect(screen.getByTestId('check-valid')).toBeTruthy();
        expect(screen.queryAllByTestId('check-line')).toHaveLength(0);
    });
});

describe('Clustering: one outer ring N for every cluster', () => {
    const CL = (n: number | null) => ({ kind: 'clustering', outerSd: n }) as const;

    it('table: the 1× and 3× rows are text; N is the one control (number box, − / +, 4× 5× 6× 7×) on its own line', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        const card = screen.getByTestId('set-points-card');
        expect(screen.getByTestId('rung-100').textContent).toBe('100inside the 1× SD ring · automatic1× SD');
        expect(screen.getByTestId('rung-80').textContent).toBe('80on the 3× SD ring · automatic3× SD');
        expect(screen.getByTestId('rung-0').textContent).toBe('0on the N× SD ring · you set N · more than 3N× SD');
        expect(within(card).queryAllByRole('columnheader')).toHaveLength(0); // one value column: no head row
        for (const id of ['rung-100', 'rung-80', 'rung-0']) expect(screen.getByTestId(id).querySelector('input, button')).toBeNull();
        expect(card.querySelectorAll('input')).toHaveLength(1);
        const ctl = screen.getByTestId('ring-control');
        expect(within(ctl).getByTestId('sp-outer_sd')).toBe(input('sp-outer_sd'));
        expect(input('sp-outer_sd').value).toBe('');
        expect(input('sp-outer_sd').placeholder).toBe('N');
        expect(field('sp-outer_sd').className).toMatch(/hs-num--req/);
        expect(field('sp-outer_sd').textContent).toContain('× SD');
        expect(['ring-quick-4', 'ring-quick-5', 'ring-quick-6', 'ring-quick-7'].map(id => within(ctl).getByTestId(id).textContent)).toEqual(['4×', '5×', '6×', '7×']);
        expect(card.textContent).toMatch(/One N for every cluster: each cluster gets its own 1×, 3× and N× rings/);
    });

    it('the 0 row names the N that is set, exactly as typed', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        fireEvent.click(screen.getByTestId('ring-quick-5'));
        expect(screen.getByTestId('ro-nx').textContent).toBe('5× SD');
        type('sp-outer_sd', '4.25');
        expect(screen.getByTestId('ro-nx').textContent).toBe('4.25× SD');
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
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('A set point is not valid');
        expect(screen.getByTestId('check-line').textContent).toMatch(/must be more than 3× SD/);
    });

    it('the set-point chart carries the 1x, 3x and N x ring of EVERY cluster, and follows N', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        const rings = (c: any) => c.option.series.filter((s: any) => s.type === 'custom').length;
        expect(rings(setChart())).toBe(4); // 2 clusters x (1x, 3x)
        fireEvent.click(screen.getByTestId('ring-quick-5'));
        expect(rings(setChart())).toBe(6); // + N x ring of each
    });

    // workbench-redesign SPEC §3: rings labelled once per level; N as typed; no legend row.
    it('the ring levels are named ON the chart, once each, and the N label follows what is typed — as typed', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        expect(ringLabelsOf(setChart())).toEqual(['1× · 100', '3× · 80']);
        fireEvent.click(screen.getByTestId('ring-quick-5'));
        expect(ringLabelsOf(setChart())).toEqual(['1× · 100', '3× · 80', '5× · 0']);
        type('sp-outer_sd', '4.5');
        expect(ringLabelsOf(setChart())).toEqual(['1× · 100', '3× · 80', '4.5× · 0']);
        type('sp-outer_sd', '4.25');
        expect(ringLabelsOf(setChart()).slice(-1)).toEqual(['4.25× · 0']);
        expect(legendOf('set-clustering')).toBeNull();
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
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('A set point is not valid');
    });

    it('"Incomplete" when everything missing is only empty, "Valid" when nothing is left', () => {
        mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points still empty');
        cleanup();
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points valid');
        expect(screen.getByTestId('check-valid').textContent).toMatch(/passes the checks/);
    });

    it('shows the issues of a refused Mark complete (attemptIssues) instead of the live ones', () => {
        const attempt: HealthIssue[] = [{ code: 'lower_equals_3sd', field: 'lower', severity: 'error', message: 'L equals the lower 3σ boundary (found when saving)' }];
        mount({ sp: IND_VALID, attemptIssues: attempt });
        expect(screen.getAllByTestId('check-line')).toHaveLength(1);
        expect(screen.getByTestId('check-line').textContent).toMatch(/found when saving/);
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('A set point is not valid');
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

    it('has NO legend row and no "hover to read" sentence: the share column and the read-out say it', () => {
        mount({ sp: IND_VALID });
        expect(legendOf('score')).toBeNull();
        const card = screen.getByTestId('chart-card-score');
        expect(card.textContent).not.toMatch(/Hover to read|near 0|both charts move together/i);
        expect(screen.getByTestId('score-shares')).toBeTruthy(); // the share column stays
        expect(screen.getByTestId('hs-readout')).toBeTruthy(); // so does the hover read-out
    });

    it('the line at 80 is named at the right edge outside the plot; the tooltip prints whole scores', () => {
        mount({ sp: IND_VALID });
        const opt = scoreChart().option;
        const line = opt.series[0].markLine.data[0];
        expect([line.yAxis, line.label.formatter, line.label.position]).toEqual([80, '80', 'end']);
        expect(opt.tooltip.valueFormatter(85)).toBe('85');
        expect(opt.tooltip.valueFormatter(84.99)).toBe('85');
    });

    it('a share that is not zero never reads "0.0%": below a tenth of a percent it says "< 0.1%"', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, share_80_100: 99.96, share_40_80: 0.04, share_0_40: 0 } } });
        expect(screen.getByTestId('share-share_40_80').textContent).toBe('40–80< 0.1%');
        expect(screen.getByTestId('share-share_0_40').textContent).toBe('0–400.0%'); // a real zero stays zero
        expect(screen.getByTestId('share-share_80_100').textContent).toBe('80–100100.0%');
    });

    // The rule was on the share column only — the same card's subtitle
    // printed `toFixed(1)`: "below 80 for 0.0%" next to a "< 0.1%" share.
    it('the subtitle follows the same rule: "below 80 for < 0.1% of scored rows", never "0.0%" for a share that is not zero', () => {
        const d = previewFor('individual', IND_VALID);
        const withPct = (pct: number | null) => ({ ...d, score_summary: { ...d.score_summary!, share_80_100: 99.96, share_40_80: 0.04, share_0_40: 0, pct_below_80: pct } });
        mount({ sp: IND_VALID, data: withPct(0.04) });
        expect(screen.getByTestId('score-below80').textContent).toBe('< 0.1%');
        expect(screen.getByTestId('score-summary').textContent).toContain('below 80 for < 0.1% of scored rows');
        expect(screen.getByTestId('score-summary').textContent).not.toContain('0.0%');
        // the subtitle and the share column of the same card agree
        expect(screen.getByTestId('share-share_40_80').textContent).toBe('40–80< 0.1%');
        cleanup();
        mount({ sp: IND_VALID, data: withPct(0) });
        expect(screen.getByTestId('score-below80').textContent).toBe('0.0%'); // a real zero stays zero
        cleanup();
        mount({ sp: IND_VALID, data: withPct(0.1) });
        expect(screen.getByTestId('score-below80').textContent).toBe('0.1%');
        cleanup();
        mount({ sp: IND_VALID, data: withPct(41.56) });
        expect(screen.getByTestId('score-below80').textContent).toBe('41.6%');
        expect(shareText(0.0999)).toBe('< 0.1%');
        expect(shareText(100)).toBe('100.0%');
    });

    it('header: the lowest score and when, % of scored rows below 80, and the three time-share numbers', () => {
        mount({ sp: IND_VALID });
        const sum = screen.getByTestId('score-summary');
        expect(screen.getByTestId('score-lowest').textContent).toBe('30');
        // ONE Workbench date format, in mono — never the raw CSV timestamp.
        expect(sum.textContent).toMatch(/Lowest 30 on 1 Jan 2026 04:00 ·/);
        expect(sum.textContent).not.toMatch(/2026-01-01/);
        expect(screen.getByTestId('score-lowest-at').className).toContain('wbx-dt');
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
    const marks = (c: any): (string | undefined)[] => c.option.series[0].markLine.data.map((d: any) => d.label?.formatter);

    it('Individual: raw values with the L / H lines the draft holds (and they move as the user types)', () => {
        mount({ sp: IND_VALID });
        expect(marks(setChart())).toEqual(expect.arrayContaining(['L 1', 'H 9']));
        type('sp-upper', '');
        expect(marks(setChart()).some(m => m?.startsWith('H'))).toBe(false);
        expect(marks(setChart())).toContain('L 1');
    });

    // workbench-redesign SPEC §3: the set points carry their value AS TYPED on the chart.
    it('Individual: what the user types is what the line says — "4.60" is never padded back, "9.61234" is never rounded', () => {
        mount({ sp: IND_VALID });
        type('sp-upper', '9.5');
        expect(marks(setChart())).toContain('H 9.5');
        expect(marks(setChart())).not.toContain('H 9.50');
        type('sp-upper', '9.50'); // the same number: the label does not grow a padded zero
        expect(marks(setChart())).toContain('H 9.5');
        expect(input('sp-upper').value).toBe('9.50'); // while the box keeps the user's own text
        type('sp-upper', '9.61234');
        expect(marks(setChart())).toContain('H 9.61234');
        type('sp-lower', '0.25');
        expect(marks(setChart())).toContain('L 0.25');
        // half-typed text that is not a number yet draws no line (and no "H NaN")
        type('sp-upper', '-');
        expect(marks(setChart()).some(m => m?.startsWith('H'))).toBe(false);
    });

    it('Individual: the subtitle is just the unit (no "type L and H on the right"), and the card has no legend row', () => {
        mount({ sp: IND_VALID });
        const card = screen.getByTestId('chart-card-set-individual');
        expect(card.querySelector('.wb2-card-s')!.textContent).toBe('bar');
        expect(card.textContent).not.toMatch(/type L and H|on the right/);
        expect(legendOf('set-individual')).toBeNull();
        // only the score-100 band is filled
        const bands = setChart().option.series[0].markArea.data;
        expect(bands).toHaveLength(1);
        expect(bands[0][0].itemStyle.color).toBe(CHART.okFill);
    });

    it('Relationship: the residual only - the 80 / 0 lines appear as they are typed', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        expect(screen.getByTestId('chart-card-set-relationship')).toBeTruthy();
        expect(marks(setChart())).toHaveLength(3); // +2RMSE, -2RMSE, zero
        type('sp-residual_at_80_upper', '1.5');
        expect(marks(setChart())).toHaveLength(4);
        expect(marks(setChart()).slice(-1)).toEqual(['80 · +1.5']);
    });

    it('Relationship: each point says its score and its value as typed, signed; the subtitle carries no typing hint; no legend row', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        type('sp-residual_at_80_upper', '5');
        type('sp-residual_at_80_lower', '-2.5');
        type('sp-residual_at_0_upper', '12.250'); // typed with a trailing zero
        type('sp-residual_at_0_lower', '-9.61234');
        expect(marks(setChart()).slice(3)).toEqual(['80 · +5', '80 · −2.5', '0 · +12.25', '0 · −9.61234']);
        const card = screen.getByTestId('chart-card-set-relationship');
        expect(card.querySelector('.wb2-card-s')!.textContent).toBe('actual − predicted (bar)');
        expect(card.textContent).not.toMatch(/type the 80|on the right/);
        expect(legendOf('set-relationship')).toBeNull();
    });

    it('Clustering: the scatter card', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(screen.getByTestId('chart-card-set-clustering')).toBeTruthy();
        expect(setChart().option.series[0].name).toBe('Points');
    });

    it('Clustering: the subtitle names both sensors and says what the point colours mean right now', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(screen.getByTestId('chart-card-set-clustering').querySelector('.wb2-card-s')!.textContent).toBe('TAG1 vs TAG2 · points coloured by score');
        cleanup();
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: null } }); // not scored yet: the points show their cluster
        expect(screen.getByTestId('chart-card-set-clustering').querySelector('.wb2-card-s')!.textContent).toBe('TAG1 vs TAG2 · coloured by score once N is set');
    });

    it('Clustering: axis titles are description + unit (from the Tag names); the tags stay in the subtitle', () => {
        const meta = [
            { tag: 'TAG1', description: 'GENERATOR ACTIVE POWER', unit: 'MW', component: 'Generator' },
            { tag: 'TAG2', description: 'BEARING DE TEMPERATURE', unit: '°C', component: 'Bearing' },
        ];
        render(<SensorMetaProvider metadata={meta}><Harness kind="clustering" sp={{ kind: 'clustering', outerSd: 5 }} /></SensorMetaProvider>);
        expect(setChart().option.xAxis.name).toBe('GENERATOR ACTIVE POWER · MW');
        expect(setChart().option.yAxis.name).toBe('BEARING DE TEMPERATURE · °C');
        expect(screen.getByTestId('chart-card-set-clustering').querySelector('.wb2-card-s')!.textContent)
            .toBe('GENERATOR ACTIVE POWERTAG1 vs BEARING DE TEMPERATURETAG2 · points coloured by score');
        cleanup();
        // without Tag names the axis falls back to the tag
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(setChart().option.xAxis.name).toBe('TAG1');
        expect(setChart().option.yAxis.name).toBe('TAG2');
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

    // Real-app bug: with a chart enlarged, the tooltips of the two charts UNDER the backdrop
    // showed through over the overlay, because the enlarged copy had joined the same group.
    it('the enlarged copy of a chart (inside the overlay dialog) does not join the group', () => {
        mount({ sp: IND_VALID });
        const dialog = document.createElement('div');
        dialog.className = 'pm-chart-modal-backdrop'; // ChartCard's overlay
        const inner = dialog.appendChild(document.createElement('div'));
        const enlarged: any = { getDom: () => inner };
        scoreChart().onChartReady(enlarged);
        expect(enlarged.group).toBeUndefined();
        // a chart on the page itself still joins
        const onPage: any = { getDom: () => document.createElement('div') };
        scoreChart().onChartReady(onPage);
        expect(onPage.group).toBeTruthy();
    });

    it('hovering the score chart prints time, raw value and score; leaving clears it', () => {
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent(TS)); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('1 Jan 2026 03:00 · value 6.2 bar · score 60');
        act(() => { scoreChart().onEvents.globalout(); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
    });

    it('hovering the SET-POINT chart drives the same read-out', () => {
        mount({ sp: IND_VALID });
        act(() => { setChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 04:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('1 Jan 2026 04:00 · value 3.1 bar · score 30');
    });

    it('Relationship reads "residual"', () => {
        mount({ kind: 'relationship', sp: { ...REL_VALID } });
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 02:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toMatch(/residual -0\.2 bar · score 80/);
    });

    it('Clustering: hovering a point of the scatter highlights that row and fills the read-out; hovering the score chart highlights it on the scatter', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(setChart().option.series.some((s: any) => s.name === 'Hover')).toBe(false);
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Points', dataIndex: 3 }); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('1 Jan 2026 03:00 · score 60');
        expect(setChart().option.series.find((s: any) => s.name === 'Hover').data).toEqual([[21, 41]]);
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Centres', dataIndex: 0 }); }); // a ring / centre is not a row
        expect(screen.getByTestId('hs-readout').textContent).toBe('1 Jan 2026 03:00 · score 60');
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 01:00:00')); });
        expect(setChart().option.series.find((s: any) => s.name === 'Hover').data).toEqual([[11, 21]]);
        act(() => { setChart().onEvents.globalout(); });
        expect(setChart().option.series.some((s: any) => s.name === 'Hover')).toBe(false);
    });

    it('a row without a score reads "not running"', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, series: { ...d.series, score: [100, null, 80, 55, 30] } as any } });
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 01:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('1 Jan 2026 01:00 · not running');
    });
});

describe('states of the preview', () => {
    it('while loading with nothing to show: a loading frame', () => {
        mount({ data: null });
        expect(screen.getByTestId('health-loading')).toBeTruthy();
    });

    // No in-pane Re-train button. Nothing about the model changed, so the board's way
    // back is the text link "Load it again" ("Train sensor ↑" alone would be a dead
    // end for a Complete model — Train sensor never trains one).
    /** What the real hook returns after NOT_FITTED: no data, and (when there was one) the last answer. */
    const notFitted = (last: HealthPreview | null = null) => ({
        data: null, lastData: last, loading: false, error: 'no fit', errorCode: 'NOT_FITTED' as const, notFitted: true, needsRetrain: true, idle: null as null,
    });

    it('NOT_FITTED, a model that is NOT Complete: ONE board, no button of its own — "Load it again" and "Train sensor ↑" as text links', () => {
        mount({ kind: 'relationship', sp: REL_VALID, data: null, preview: notFitted() });
        const board = screen.getByTestId('health-not-fitted');
        expect(board.className).toMatch(/\bwbx-msg\b/);
        expect(board.className).not.toMatch(/wbx-msg--bad/);
        expect(board.querySelector('.wbx-msg-t')!.textContent).toBe('Fit no longer in memory');
        expect(board.querySelector('.wbx-msg-s')!.textContent).toBe('The fitted Relation model is no longer in memory (the data was reloaded, a special sensor changed, or many Relation models were opened). Nothing about the model changed — Load it again, or re-train it with Train sensor ↑. Your set points are kept and scored again when it is loaded.');
        expect(board.querySelector('.wbx-msg-d')).toBeNull();
        expect(screen.queryByTestId('health-not-fitted-retrain')).toBeNull();
        expect(screen.queryByRole('button', { name: /^↻|Re-train$/ })).toBeNull();
        expect(board.querySelector('.rcx-btn, .bmw-btn-ok, .f4-btn-save')).toBeNull();
        const load = within(board).getByTestId('health-load-fit') as HTMLButtonElement;
        expect(load.className).toBe('tq-inline-link');
        expect(load.textContent).toBe('Load it again');
        expect(load.disabled).toBe(false);
        const link = within(board).getByTestId('health-go-train-sensor');
        expect(link.className).toBe('tq-inline-link');
        expect(link.textContent).toBe('Train sensor ↑');
        expect(within(board).getAllByRole('button')).toHaveLength(2);
        fireEvent.click(load);
        expect(onReload).toHaveBeenCalledTimes(1);
        expect(onGoTrain).not.toHaveBeenCalled();
        fireEvent.click(link);
        expect(onGoTrain).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('health-error')).toBeNull(); // not the red "couldn't load" card
    });

    it('NOT_FITTED, a COMPLETE model (no onGoTrainSensor): only "Load it again" — never a link that cannot work', () => {
        mount({ kind: 'relationship', sp: REL_VALID, data: null, preview: notFitted(), fitGone: { onReload } });
        const board = screen.getByTestId('health-not-fitted');
        expect(within(board).queryByTestId('health-go-train-sensor')).toBeNull();
        expect(board.textContent).not.toMatch(/Train sensor/);
        expect(board.querySelector('.wbx-msg-s')!.textContent).toMatch(/Nothing about the model changed — Load it again\. Your set points are kept/);
        expect(within(board).getAllByRole('button')).toHaveLength(1);
        fireEvent.click(within(board).getByTestId('health-load-fit'));
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('NOT_FITTED while the fit is being loaded again: "Loading the Relation model…", no fit-gone board', () => {
        mount({ kind: 'relationship', sp: REL_VALID, data: null, preview: notFitted(), fitLoading: true });
        expect(screen.queryByTestId('health-not-fitted')).toBeNull();
        expect(screen.getByTestId('health-loading').querySelector('.wbx-msg-t')!.textContent).toBe('Loading the Relation model…');
        expect(screen.queryByTestId('health-load-fit')).toBeNull();
    });

    it('NOT_FITTED after a load that failed: back on the board, red, with the reason — and "Load it again" still there', () => {
        mount({ kind: 'relationship', sp: REL_VALID, data: null, preview: notFitted(), fitGone: { onReload, error: 'The Relation model engine stopped.' } });
        const board = screen.getByTestId('health-not-fitted');
        expect(board.className).toMatch(/wbx-msg--bad/);
        expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('The last attempt did not work: The Relation model engine stopped.');
        fireEvent.click(within(board).getByTestId('health-load-fit'));
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    // The model's own load failed (NOT a lost fit), so no preview is asked for at
    // all — the page must not read "Loading…" for ever, and never offers a link that cannot work.
    const idlePreview = { data: null, lastData: null, loading: false, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: 'disabled' as const };

    // After a fit-gone model's reload failed and the tab was left and
    // opened again, no request is asked any more — `preview.notFitted` is no longer set — but
    // the fit is still gone. The window says so (`fitGone.gone`), and the page must keep the
    // "Fit no longer in memory" board the footer and the Model fit page show.
    it.each([
        ['a Complete model', undefined],
        ['a model that is not Complete', onGoTrain],
    ] as const)('%s whose fit is gone by the WINDOW\'s knowledge (no live NOT_FITTED): still the "Fit no longer in memory" board with the failed load as its reason', (_n, go) => {
        mount({ kind: 'relationship', sp: REL_VALID, data: null, preview: idlePreview, fitGone: { onReload, onGoTrainSensor: go, error: 'The Relation model engine stopped.', gone: true } });
        const board = screen.getByTestId('health-not-fitted');
        expect(board.querySelector('.wbx-msg-t')!.textContent).toBe('Fit no longer in memory');
        expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('The last attempt did not work: The Relation model engine stopped.');
        expect(screen.queryByTestId('health-load-failed')).toBeNull();
        expect(screen.queryByTestId('health-train-failed')).toBeNull();
        expect(screen.queryByTestId('health-error')).toBeNull();
        expect(screen.queryByTestId('health-loading')).toBeNull();
        fireEvent.click(within(board).getByTestId('health-load-fit'));
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('...and while that fit is being loaded again the page reads "Loading the Relation model…"', () => {
        mount({ kind: 'relationship', sp: REL_VALID, data: null, preview: idlePreview, fitLoading: true, fitGone: { onReload, gone: true } });
        expect(screen.getByTestId('health-loading').querySelector('.wbx-msg-t')!.textContent).toBe('Loading the Relation model…');
        expect(screen.queryByTestId('health-not-fitted')).toBeNull();
    });
    it.each([
        ['individual', 'Individual model'],
        ['relationship', 'Relation model'],
        ['clustering', 'Clustering model'],
    ] as const)('%s — a COMPLETE model whose load failed: "Couldn\'t load the …" with "Load it again" (same words as the fit-gone board), no Train sensor link', (kind, name) => {
        mount({ kind, data: null, preview: idlePreview, fitGone: { onReload, error: 'The engine stopped.' } });
        expect(screen.queryByTestId('health-loading')).toBeNull();
        const board = screen.getByTestId('health-load-failed');
        expect(board.className).toMatch(/wbx-msg--bad/);
        expect(board.querySelector('.wbx-msg-t')!.textContent).toBe(`Couldn't load the ${name}`);
        expect(board.querySelector('.wbx-msg-s')!.textContent).toBe('Nothing about the model changed and it stays Complete — Load it again. Your set points are kept and scored again when it is loaded.');
        expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('The engine stopped.');
        expect(board.textContent).not.toMatch(/Train sensor/);
        expect(within(board).getAllByRole('button')).toHaveLength(1);
        const link = within(board).getByTestId('health-load-again');
        expect(link.textContent).toBe('Load it again');
        expect(link.className).toBe('tq-inline-link');
        fireEvent.click(link);
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('a model that is NOT Complete whose train failed: "Training failed" with the "Train sensor ↑" link (Train sensor trains it again)', () => {
        mount({ kind: 'individual', data: null, preview: idlePreview, fitGone: { onReload, onGoTrainSensor: onGoTrain, error: 'stats exploded' } });
        expect(screen.queryByTestId('health-loading')).toBeNull();
        expect(screen.queryByTestId('health-load-failed')).toBeNull();
        const board = screen.getByTestId('health-train-failed');
        expect(board.querySelector('.wbx-msg-t')!.textContent).toBe('Training failed');
        expect(board.querySelector('.wbx-msg-s')!.textContent).toBe('Fix the problem, then train again with Train sensor ↑. Your set points are kept.');
        expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('stats exploded');
        fireEvent.click(within(board).getByTestId('health-go-train-sensor'));
        expect(onGoTrain).toHaveBeenCalledTimes(1);
    });

    it('while that load runs again the page reads "Loading the … model…"; with no error at all it is the plain loading board', () => {
        const { unmount } = mount({ kind: 'clustering', data: null, preview: idlePreview, fitLoading: true, fitGone: { onReload, error: 'old error' } });
        expect(screen.queryByTestId('health-load-failed')).toBeNull();
        expect(screen.getByTestId('health-loading').querySelector('.wbx-msg-t')!.textContent).toBe('Loading the Clustering model…');
        unmount();
        mount({ kind: 'individual', data: null, preview: idlePreview, fitGone: { onReload } });
        expect(screen.getByTestId('health-loading')).toBeTruthy();
        expect(screen.queryByTestId('health-load-failed')).toBeNull();
        expect(screen.queryByTestId('health-train-failed')).toBeNull();
    });

    it('"Load it again" is disabled, with the reason as its tooltip, while it cannot run (a training run is active)', () => {
        mount({ kind: 'relationship', sp: REL_VALID, data: null, preview: notFitted(), fitGone: { onReload, reloadDisabledReason: 'Wait for the training run to finish' } });
        const load = screen.getByTestId('health-load-fit') as HTMLButtonElement;
        expect(load.disabled).toBe(true);
        expect(load.title).toBe('Wait for the training run to finish');
        fireEvent.click(load);
        expect(onReload).not.toHaveBeenCalled();
    });

    // The hook never returns `data` together with `notFitted` (a failed request sets `data`
    // to null): with the last answer still held, NOT_FITTED is the board — there is no
    // "line above the last charts" state (the unreachable `health-not-fitted-banner` is gone).
    it('NOT_FITTED with an earlier answer held (what the hook really returns): the board, not the old charts', () => {
        mount({ kind: 'relationship', sp: REL_VALID, preview: notFitted(previewFor('relationship', REL_VALID)) });
        expect(screen.getByTestId('health-not-fitted')).toBeTruthy();
        expect(screen.queryByTestId('health-not-fitted-banner')).toBeNull();
        expect(screen.queryByTestId('set-points-card')).toBeNull();
        expect(screen.queryByTestId('chart-card-score')).toBeNull();
    });

    it('another error with nothing to show: the red card with the reason', () => {
        mount({ data: null, preview: { data: null, loading: false, error: 'No rows in the training scope.', errorCode: 'NO_DATA', notFitted: false, needsRetrain: false, idle: null } });
        const card = screen.getByTestId('health-error');
        expect(card.className).toMatch(/hs-save--bad/);
        expect(card.getAttribute('role')).toBe('alert');
        // "<reason> · the score and Checks …": the reason's own full stop is dropped
        expect(card.textContent).toBe("Couldn't load the health score. No rows in the training scope · the score and Checks are not available until it loads");
        expect(screen.queryByTestId('health-loading')).toBeNull();
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

    // Saving is the FOOTER only — no card on the page, unless the save is slow.
    it('running: no "Saving…" card on the page; one appears only once the save has been running for a while', () => {
        vi.useFakeTimers();
        try {
            save({ phase: 'running' });
            expect(screen.queryByTestId('save-running')).toBeNull();
            expect(screen.getByTestId('health-page').querySelector('.hs-save')).toBeNull();
            expect(screen.getByTestId('health-page').textContent).not.toMatch(/Saving/);
            act(() => { vi.advanceTimersByTime(SLOW_SAVE_NOTICE_MS - 1); });
            expect(screen.queryByTestId('save-running')).toBeNull();
            act(() => { vi.advanceTimersByTime(1); });
            expect(screen.getByTestId('save-running').textContent).toBe('Still saving… Writing the model files is taking longer than usual.');
            cleanup();
            // a Relation model: not at once either (it used to show the card from the first moment)
            mount({ kind: 'relationship', sp: REL_VALID, save: { phase: 'running' } });
            expect(screen.queryByTestId('save-running')).toBeNull();
            act(() => { vi.advanceTimersByTime(SLOW_SAVE_NOTICE_MS); });
            expect(screen.getByTestId('save-running').textContent).toMatch(/Still saving….*longer than 15 seconds, especially the first time/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('the slow-save line goes as soon as the save ends', () => {
        vi.useFakeTimers();
        try {
            const { rerender } = render(<Harness sp={IND_VALID} save={{ phase: 'running' }} />);
            act(() => { vi.advanceTimersByTime(SLOW_SAVE_NOTICE_MS); });
            expect(screen.getByTestId('save-running')).toBeTruthy();
            rerender(<Harness sp={IND_VALID} save={{ phase: 'idle' }} />);
            expect(screen.queryByTestId('save-running')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    // Workbench redesign §1: a SUCCESSFUL save has no banner on the page — it is the
    // footer sentence ("Files saved <date> · <folder>", BuildModelWindow.test.tsx).
    it('ok: NO "Saved N files to …" / "Files saved to …" banner on the page (this session or an earlier one)', () => {
        save({ phase: 'ok', outputDir: 'C:/data/workspaces/ws1/output', at: '2026-10-08T20:31:00' });
        const page = screen.getByTestId('health-page');
        expect(screen.queryByTestId('save-ok')).toBeNull();
        expect(screen.queryByTestId('save-files')).toBeNull();
        expect(page.querySelector('.hs-save')).toBeNull();
        expect(page.textContent).not.toMatch(/Files saved|Saved 2 files|workspaces\/ws1/);
        cleanup();
        save({ phase: 'ok', outputDir: 'C:/o', at: 'earlier' });
        expect(screen.getByTestId('health-page').querySelector('.hs-save')).toBeNull();
        expect(screen.getByTestId('health-page').textContent).not.toMatch(/Files saved/);
    });

    it('error: a red card that says the model was not saved and why — with the file it could not write', () => {
        const why = "Couldn't write C:\\Users\\me\\AppData\\Roaming\\app\\workspaces\\ws1\\output\\TAG1\\INDV_INFO_TAG1.json — the file is open in another program.";
        save({ phase: 'error', message: why });
        const card = screen.getByTestId('save-error');
        expect(card.className).toMatch(/hs-save--bad/);
        expect(card.getAttribute('role')).toBe('alert');
        expect(card.textContent).toBe(`The model was not saved. ${why}`);
        expect(screen.getByTestId('save-error-reason').textContent).toContain('output\\TAG1\\INDV_INFO_TAG1.json');
    });

    it('the page has no "Changed after saving" banner of its own (it is the footer sentence, next to Mark complete again)', () => {
        mount({ sp: IND_VALID });
        expect(screen.queryByTestId('files-out-of-date')).toBeNull();
        expect(screen.getByTestId('health-page').textContent).not.toMatch(/Changed after saving/);
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

describe('a failed request keeps the page (QA 2026-10-04)', () => {
    const onRetry = vi.fn();
    beforeEach(() => onRetry.mockClear());
    const failed = (code: string | null, last: HealthPreview | null) => ({
        data: null, lastData: last, loading: false, error: 'Failed to read column: transient I/O error', errorCode: code as any, notFitted: false, needsRetrain: false, idle: null as null, retry: onRetry,
    });

    it('with an earlier answer: the inputs and charts stay under an error banner with a Retry button', () => {
        mount({ sp: IND_VALID, preview: failed(null, previewFor('individual', IND_VALID)), onRetryPreview: onRetry });
        const banner = screen.getByTestId('health-error');
        expect(banner.className).toMatch(/hs-save--bad/);
        expect(banner.textContent).toBe("Couldn't load the health score. Failed to read column: transient I/O error · the score and Checks are not available until it loadsRetry");
        expect(screen.getByTestId('health-error-reason').textContent).toBe('Failed to read column: transient I/O error');
        expect(screen.getByTestId('set-points-card')).toBeTruthy();
        expect(input('sp-lower').value).toBe('1'); // still editable
        fireEvent.click(screen.getByTestId('health-retry'));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('while the error shows nothing is judged: no verdict, Checks say so, the score stays locked (the old answer does not describe what is typed)', () => {
        mount({ sp: IND_VALID, preview: failed(null, previewFor('individual', IND_VALID)), onRetryPreview: onRetry });
        expect(screen.queryByTestId('hs-verdict')).toBeNull();
        expect(screen.queryByTestId('check-valid')).toBeNull();
        expect(screen.getByTestId('checks-unavailable').textContent).toBe('Not available until the health score loads.');
        expect(screen.getByTestId('score-locked').textContent).toBe('Health scoreScore not availableNot available until the health score loads.');
        expect(field('sp-lower').className).not.toMatch(/hs-num--err|hs-num--req/);
    });

    it('typing still works under the banner', () => {
        mount({ sp: IND_VALID, preview: failed(null, previewFor('individual', IND_VALID)), onRetryPreview: onRetry });
        type('sp-upper', '9.5');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ upper: 9.5 }), undefined);
    });

    // A new request clears `error` while `data` is still null (the hook), and the
    // whole page used to be replaced by the "Loading…" board — the first key typed under the red
    // card unmounted the input it was typed in.
    it('the NEXT request after a failure (typing under the red card, Retry): the page stays — same input, still focused; a quiet "Loading again" line takes the red card\'s place', () => {
        const last = previewFor('individual', IND_VALID);
        const { rerender } = render(<Harness sp={IND_VALID} preview={failed(null, last)} onRetryPreview={onRetry} />);
        const before = input('sp-upper');
        before.focus();
        type('sp-upper', '9.5');
        // what the hook returns for the request that keystroke starts: error cleared, data still null
        rerender(<Harness sp={IND_VALID} preview={{ ...failed(null, last), loading: true, error: null, errorCode: null }} onRetryPreview={onRetry} />);
        expect(screen.queryByTestId('health-loading')).toBeNull();
        expect(input('sp-upper')).toBe(before); // the SAME element: never unmounted
        expect(document.activeElement).toBe(before);
        expect(before.value).toBe('9.5');
        expect(screen.queryByTestId('health-error')).toBeNull();
        const line = screen.getByTestId('health-asking');
        expect(line.getAttribute('role')).toBe('status');
        expect(line.textContent).toBe('Loading the health score again… the score and Checks are not available until it loads');
        // nothing is judged from the old answer meanwhile
        expect(screen.queryByTestId('hs-verdict')).toBeNull();
        expect(screen.getByTestId('checks-unavailable')).toBeTruthy();
        expect(screen.getByTestId('score-locked')).toBeTruthy();
        // it fails again: the red card is back, the input is still the same one
        rerender(<Harness sp={IND_VALID} preview={failed(null, last)} onRetryPreview={onRetry} />);
        expect(screen.getByTestId('health-error')).toBeTruthy();
        expect(input('sp-upper')).toBe(before);
        // ...or it loads: the page judges again
        rerender(<Harness sp={IND_VALID} preview={{ data: last, lastData: last, loading: false, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: null }} onRetryPreview={onRetry} />);
        expect(screen.queryByTestId('health-asking')).toBeNull();
        expect(screen.queryByTestId('health-error')).toBeNull();
        expect(input('sp-upper')).toBe(before);
        expect(screen.getByTestId('chart-card-score')).toBeTruthy();
    });

    it('a first load (no earlier answer) is still the "Loading…" board, not the quiet line', () => {
        mount({ data: null, preview: { data: null, lastData: null, loading: true, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: null } });
        expect(screen.getByTestId('health-loading')).toBeTruthy();
        expect(screen.queryByTestId('health-asking')).toBeNull();
    });

    it('STALE_SESSION: the same banner but NO Retry (asking again cannot help; the dataset changed)', () => {
        mount({ sp: IND_VALID, preview: failed('STALE_SESSION', previewFor('individual', IND_VALID)), onRetryPreview: onRetry });
        expect(screen.getByTestId('health-error')).toBeTruthy();
        expect(screen.queryByTestId('health-retry')).toBeNull();
    });

    it('with NO earlier answer: the SAME red card with its Retry (one shape for "the preview failed")', () => {
        mount({ data: null, preview: failed(null, null), onRetryPreview: onRetry });
        expect(screen.getByTestId('health-error').className).toMatch(/hs-save--bad/);
        expect(screen.getByTestId('health-error').textContent).toMatch(/^Couldn't load the health score\. Failed to read column: transient I\/O error · the score and Checks are not available until it loads/);
        expect(screen.queryByTestId('set-points-card')).toBeNull();
        fireEvent.click(screen.getByTestId('health-retry'));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('no onRetryPreview given: no Retry button is drawn (nothing to call)', () => {
        mount({ data: null, preview: failed(null, null) });
        expect(screen.queryByTestId('health-retry')).toBeNull();
    });

    it('NOT_FITTED keeps its own board ("Fit no longer in memory"), even with an earlier answer', () => {
        mount({ sp: IND_VALID, preview: { ...failed('NOT_FITTED', previewFor('individual', IND_VALID)), notFitted: true, needsRetrain: true, error: 'no fit' }, onRetryPreview: onRetry });
        expect(screen.getByTestId('health-not-fitted')).toBeTruthy();
        expect(screen.queryByTestId('set-points-card')).toBeNull();
        expect(screen.queryByTestId('health-retry')).toBeNull();
    });

    it('the save banner (a refused / failed Mark complete) is shown on the error frame too', () => {
        mount({ data: null, preview: failed(null, null), save: { phase: 'error', message: 'files were written, but the model was not marked complete: x' } });
        expect(screen.getByTestId('save-error')).toBeTruthy();
    });
});

describe('accessible names and full-precision values (QA 2026-10-04)', () => {
    it('the four Relationship inputs have four DISTINCT accessible names; the visible column heads stay Lower / Upper', () => {
        mount({ kind: 'relationship', sp: REL_VALID });
        const ids = ['sp-residual_at_80_lower', 'sp-residual_at_80_upper', 'sp-residual_at_0_lower', 'sp-residual_at_0_upper'];
        const names = ids.map(id => input(id).getAttribute('aria-label'));
        expect(new Set(names).size).toBe(4);
        expect(names).toEqual(['Lower residual at score 80', 'Upper residual at score 80', 'Lower residual at score 0', 'Upper residual at score 0']);
        for (const [i, id] of ids.entries()) expect(screen.getByLabelText(names[i]!)).toBe(input(id));
        expect(screen.getAllByRole('columnheader').slice(2).map(h => h.textContent)).toEqual(['Lower', 'Upper']);
    });

    it('the state of the card is a dot with words for a screen reader, and a required / rejected input says so', () => {
        mount({ sp: { kind: 'individual', lower: 3, upper: null, masterLower: null, masterUpper: null } });
        expect(screen.getByRole('img', { name: 'A set point is not valid' })).toBe(screen.getByTestId('hs-verdict'));
        expect(input('sp-upper').getAttribute('aria-required')).toBe('true');
        expect(input('sp-lower').getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByRole('group', { name: 'Checks' })).toBe(screen.getByTestId('checks-card'));
    });

    it('a stored 4e-7 is shown as itself (not "0"), and 0.00012345 is not cut to 6 decimals', () => {
        mount({ sp: { kind: 'individual', lower: 4e-7, upper: 0.00012345, masterLower: null, masterUpper: null } });
        expect(Number(input('sp-lower').value)).toBe(4e-7);
        expect(input('sp-lower').value).not.toBe('0');
        expect(input('sp-upper').value).toBe('0.00012345');
    });

    it('typing a tiny value reports exactly that number', () => {
        mount({ sp: IND_VALID });
        type('sp-lower', '0.0000004');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lower: 4e-7 }), undefined);
    });
});

describe('warning issues are shown as non-blocking notes (coordinator 2026-10-04)', () => {
    const warn = { code: 'unsafe_file_name', severity: 'warning' as const, message: 'The model name has characters that are not allowed in a file name.', field: 'name' };

    it('valid + a warning: the green "passes" line stays AND the note shows, flagged as not blocking; the score is unlocked', () => {
        const data = { ...previewFor('individual', IND_VALID), validation: [warn] };
        expect(data.valid).toBe(true);
        mount({ sp: IND_VALID, data });
        expect(screen.getByTestId('check-valid')).toBeTruthy();
        const line = screen.getByTestId('check-line');
        expect(line.getAttribute('data-warning')).toBe('true');
        expect(line.textContent).toMatch(/not allowed in a file name/);
        expect(line.textContent).toMatch(/does not stop you from marking the model complete/);
        expect(screen.queryByTestId('score-locked')).toBeNull();
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points valid');
    });

    it('empty set points + a warning: the verdict is "Incomplete" (amber), not "Not valid"', () => {
        const data = { ...previewFor('individual', { kind: 'individual', lower: null, upper: null }), validation: [{ code: 'required', severity: 'error' as const, message: 'L required', field: 'lower' }, warn] };
        mount({ sp: { kind: 'individual', lower: null, upper: null }, data });
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points still empty');
    });
});

describe('Scoring periods on the Health score page ("just score it", 2026-10-10)', () => {
    const withTests = (kind: 'individual' | 'relationship', sp: HealthSetPoints): HealthPreview => ({
        ...previewFor(kind, sp),
        test_validation: makeValidation({ tests: [makeTestResult({ pct_below_80: 7, lowest: 62, lowest_at: '2026-01-01 02:30:00' }), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00', pct_below_80: 41.5, lowest: 12, lowest_at: '2026-01-01 02:40:00' })] }),
    });

    it('the set-point chart and the score chart both draw the train / scoring scopes — bands only, no EVENT line, no hatch', () => {
        mount({ sp: IND_VALID, data: withTests('individual', IND_VALID) });
        const names = (c: any) => c.option.series.map((x: any) => x.name);
        expect(names(scoreChart())).toContain('__scopes');
        expect(names(setChart())).toContain('__scopes');
        for (const chart of [scoreChart(), setChart()]) {
            const carrier = chart.option.series.find((x: any) => x.name === '__scopes');
            expect(carrier.markLine).toBeUndefined();
            expect(carrier.markPoint).toBeUndefined();
            expect(stripOf(chart)).toEqual(['TRAIN', 'S1', 'S2']);
            expect(JSON.stringify(carrier)).not.toMatch(/EVENT|KNOWN|NORMAL|PROBLEM|data:image/);
            // the names are in the strip ABOVE the plot — no pill inside it
            for (const a of carrier.markArea.data) {
                expect(a[0].label.position).toBe('top');
                expect(a[0].label.backgroundColor).toBeUndefined();
            }
        }
    });

    it('Clustering has no time chart of its own: the strip is on the SCORE chart, not on the scatter', () => {
        const sp = { kind: 'clustering', outerSd: 5 } as const;
        const data: HealthPreview = { ...previewFor('clustering', sp), test_validation: makeValidation({ tests: [makeTestResult(), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00' })] }) };
        mount({ kind: 'clustering', sp, data });
        expect(stripOf(scoreChart())).toEqual(['TRAIN', 'S1', 'S2']);
        expect(stripOf(setChart())).toEqual([]);
        expect(setChart().option.series.map((x: any) => x.name)).not.toContain('__scopes');
    });

    it('no scopes without scoring periods', () => {
        mount({ sp: IND_VALID });
        expect(scoreChart().option.series.map((x: any) => x.name)).not.toContain('__scopes');
    });

    // Many periods printed "TRAIN P1" … "TRAIN P20" on each other.
    it('several train periods: "TRAIN" once then numbers; two periods at the same time print ONE name; the chart beside the set-points card spaces its names for the narrower plot', () => {
        const hhmm = (m: number) => `2026-01-01T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        // 16 short train periods over the 4 hours of data
        const train_ranges = Array.from({ length: 16 }, (_, i) => ({ start: hhmm(i * 15), end: hhmm(i * 15 + 12) }));
        const data: HealthPreview = { ...previewFor('individual', IND_VALID), test_validation: makeValidation({ train_ranges, tests: [makeTestResult(), makeTestResult({ index: 2 })] }) };
        mount({ sp: IND_VALID, data });
        const score = stripOf(scoreChart());
        const set = stripOf(setChart());
        for (const names of [score, set]) {
            expect(names[0]).toBe('TRAIN P1');
            expect(names.filter(n => /TRAIN/.test(n))).toHaveLength(1);
            // S1 and S2 cover the same time: one name there, not two on top of each other
            expect(names.filter(n => /^S\d/.test(n))).toEqual(['S1']);
        }
        // every band is drawn on both charts; only names are left out
        for (const chart of [scoreChart(), setChart()]) {
            expect(chart.option.series.find((x: any) => x.name === '__scopes').markArea.data).toHaveLength(18);
        }
        const trainNames = (names: string[]) => names.filter(n => /P\d/.test(n)).length;
        expect(trainNames(score)).toBeLessThan(16); // 16 names do not fit across the board either
        expect(trainNames(set)).toBeLessThan(trainNames(score)); // fewer on the narrower chart
        expect(trainNames(set)).toBeGreaterThanOrEqual(3);
    });

    it('"Scoring results" under the score: neutral tiles with the two facts — never a verdict, never a tone', () => {
        mount({ sp: IND_VALID, data: withTests('individual', IND_VALID) });
        const card = screen.getByTestId('test-results');
        expect(card.querySelector('.wb2-card-h b')!.textContent).toBe('Scoring results');
        expect(card.textContent).toContain('for reading only — never blocks Mark complete');
        expect(within(card).getByTestId('test-result-1-big').textContent).toBe('7.0% of running time below 80');
        expect(within(card).getByTestId('test-result-1-lowest').textContent).toBe('Lowest 62 (held 1 h) on 1 Jan 2026 02:30.');
        expect(within(card).getByTestId('test-result-2-big').textContent).toBe('41.5% of running time below 80');
        expect(within(card).getByTestId('test-result-2-lowest').textContent).toBe('Lowest 12 (held 1 h) on 1 Jan 2026 02:40.');
        for (const n of [1, 2]) {
            const tile = within(card).getByTestId(`test-result-${n}`);
            expect(tile.className).toBe('vt-tile');
            expect(tile.hasAttribute('data-tone')).toBe(false);
        }
        expect(card.innerHTML).not.toMatch(/danger|--bad|--warn|--ok/);
        expect(card.textContent).not.toMatch(/Known problem|Normal|Not detected|Detected|false alarm|event|lead/i);
    });

    it('until the set points are valid the card is one quiet line: "Scored once the set points are valid" (no tiles)', () => {
        const data = { ...withTests('relationship', REL_EMPTY) };
        mount({ kind: 'relationship', sp: REL_EMPTY, data });
        const card = screen.getByTestId('test-results');
        expect(within(card).getByTestId('test-results-pending').textContent).toBe('Scored once the set points are valid');
        expect(card.querySelector('.vt-tile')).toBeNull();
        expect(card.textContent).not.toContain('Not scored yet');
    });

    it('while the health score failed to load (last answer on screen) the quiet line says so, not "set points"', () => {
        const failed = { data: null, lastData: withTests('individual', IND_VALID), loading: false, error: 'boom', errorCode: null, notFitted: false, needsRetrain: false, idle: null as null, retry: vi.fn() };
        mount({ sp: IND_VALID, preview: failed });
        expect(screen.getByTestId('test-results-pending').textContent).toBe('Not available until the health score loads');
        expect(screen.queryByTestId('test-result-1')).toBeNull();
    });

    it('testNumbers name the tiles and the names in the chart strip by the ORIGINAL list position', () => {
        const data: HealthPreview = { ...previewFor('individual', IND_VALID), test_validation: makeValidation({ tests: [makeTestResult({ index: 1 })] }) };
        mount({ sp: IND_VALID, data, testNumbers: [2] });
        expect(screen.getByTestId('test-result-2').querySelector('.vt-th b')!.textContent).toBe('S2');
        expect(screen.queryByTestId('test-result-1')).toBeNull();
        expect(stripOf(scoreChart())).toEqual(['TRAIN', 'S2']);
        expect(stripOf(setChart())).toEqual(['TRAIN', 'S2']);
    });

    it('test_scoring_failed -> amber notice with "Try again" (the preview Retry) instead of tiles; the score chart still draws', () => {
        const onRetryPreview = vi.fn();
        const data: HealthPreview = {
            ...previewFor('relationship', REL_VALID),
            validation: [{ code: 'test_scoring_failed', severity: 'warning', field: 'test_periods', message: 'The Relation model engine did not answer.' }],
            test_validation: makeValidation({ tests: [makeTestResult({ scored: 0, pct_below_80: null, lowest: null })] }),
        };
        mount({ kind: 'relationship', sp: REL_VALID, data, onRetryPreview });
        expect(screen.getByTestId('test-scoring-failed').textContent).toContain('The scoring periods could not be scored — try again');
        expect(screen.queryByTestId('test-result-1')).toBeNull();
        expect(scoreChart()).toBeTruthy();
        fireEvent.click(screen.getByTestId('test-scoring-retry'));
        expect(onRetryPreview).toHaveBeenCalledTimes(1);
    });

    it('"Try again" on test_scoring_failed calls onRetryTestScoring (which tells Rust to retry the remembered failed prediction) when given, not the plain preview retry', () => {
        const onRetryPreview = vi.fn();
        const onRetryTestScoring = vi.fn();
        const data: HealthPreview = {
            ...previewFor('relationship', REL_VALID),
            validation: [{ code: 'test_scoring_failed', severity: 'warning', field: 'test_periods', message: 'The Relation model engine did not answer.' }],
            test_validation: makeValidation({ tests: [makeTestResult({ scored: 0, pct_below_80: null, lowest: null })] }),
        };
        mount({ kind: 'relationship', sp: REL_VALID, data, onRetryPreview, onRetryTestScoring });
        fireEvent.click(screen.getByTestId('test-scoring-retry'));
        expect(onRetryTestScoring).toHaveBeenCalledTimes(1);
        expect(onRetryPreview).not.toHaveBeenCalled();
    });

    it('the "Scoring these periods … ~15 s" hint shows when the container says so', () => {
        mount({ sp: IND_VALID, slowScoring: true });
        expect(screen.getByTestId('slow-test-scoring').textContent).toBe('Scoring these periods with the Relation model — this can take up to ~15 s.');
        cleanup();
        mount({ sp: IND_VALID });
        expect(screen.queryByTestId('slow-test-scoring')).toBeNull();
    });

    it('banner when only the scoring periods changed since Mark complete ("changed" / "removed")', () => {
        mount({ sp: IND_VALID, testsChanged: 'changed' });
        expect(screen.getByTestId('tests-changed-banner').textContent).toContain('Scoring periods changed');
        expect(screen.getByTestId('tests-changed-banner').textContent).toContain('Mark complete again');
        cleanup();
        mount({ sp: IND_VALID, testsChanged: 'removed' });
        expect(screen.getByTestId('tests-changed-banner').textContent).toContain('Scoring periods removed');
        cleanup();
        mount({ sp: IND_VALID });
        expect(screen.queryByTestId('tests-changed-banner')).toBeNull();
    });
});

describe('memo (customer items 8 + 9: a training run must not redraw these charts)', () => {
    const props = (over: Partial<HealthScorePageProps> = {}): HealthScorePageProps => {
        const sp: HealthSetPoints = { ...IND_VALID };
        return {
            model: { id: 'm1', kind: 'individual', targetSensor: 'TAG1' } as any,
            stale: false,
            preview: { data: previewFor('individual', sp), loading: false, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: null } as any,
            unit: 'bar',
            setPoints: sp, onSetPointsChange: onChange, onSetPointsCommit: onCommit, attemptIssues: null,
            save: { phase: 'idle' }, fitGone: { onReload, onGoTrainSensor: onGoTrain },
            ...over,
        };
    };

    it('a window re-render with equal props (fresh-but-equal model / set points / save / preview objects) draws no chart again; a real change does', () => {
        const a = props();
        const { rerender } = render(<HealthScorePage {...a} />);
        const drawn = charts.length;
        expect(drawn).toBeGreaterThan(0);
        rerender(<HealthScorePage {...a} model={{ ...(a.model as any) }} setPoints={{ ...a.setPoints } as HealthSetPoints} save={{ phase: 'idle' }} preview={{ ...a.preview }} />);
        expect(charts.length).toBe(drawn);
        rerender(<HealthScorePage {...a} stale />);
        expect(charts.length).toBeGreaterThan(drawn);
    });

    it('the comparator covers every prop: a new callback, a new reason or a changed preview field is a change', () => {
        const a = props();
        expect(sameHealthScoreProps(a, { ...a })).toBe(true);
        // `fitGone` is rebuilt by the window on every render: equal fields = no change...
        expect(sameHealthScoreProps(a, { ...a, fitGone: { ...a.fitGone } })).toBe(true);
        expect(sameHealthScoreProps(a, { ...a, fitGone: { ...a.fitGone, error: null, reloadDisabledReason: undefined } })).toBe(true);
        // ...and each of its fields counts (a callback, the link that appears / goes, the reasons)
        expect(sameHealthScoreProps(a, { ...a, fitGone: { ...a.fitGone, onReload: () => {} } })).toBe(false);
        expect(sameHealthScoreProps(a, { ...a, fitGone: { onReload } })).toBe(false);
        expect(sameHealthScoreProps(a, { ...a, fitGone: { ...a.fitGone, error: 'boom' } })).toBe(false);
        expect(sameHealthScoreProps(a, { ...a, fitGone: { ...a.fitGone, reloadDisabledReason: 'Wait for the training run to finish' } })).toBe(false);
        expect(sameHealthScoreProps(a, { ...a, fitLoading: true })).toBe(false);
        expect(sameHealthScoreProps(a, { ...a, onSetPointsCommit: () => {} })).toBe(false);
        expect(sameHealthScoreProps(a, { ...a, preview: { ...a.preview, loading: true } })).toBe(false);
        expect(sameHealthScoreProps(a, { ...a, setPoints: { ...IND_VALID, lower: 2 } as HealthSetPoints })).toBe(false);
    });
});
