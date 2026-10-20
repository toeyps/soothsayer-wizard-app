import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';

// ECharts is not drawn in jsdom: every chart is a stand-in that records its props, so the tests can read the
// option it was given and fire the events a real chart would (hover).
const charts: any[] = [];
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => { charts.push(props); return <div data-testid="echarts-mock" data-y-name={props.option?.yAxis?.name ?? ''} />; },
}));

import HealthScorePage, { SLOW_SAVE_NOTICE_MS, ScoreKpis, lockReason, sameHealthScoreProps, scoreLockText, shareText } from '../components/windows/workbench/HealthScorePage';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { CHART } from '../components/windows/workbench/chartTheme';
import type { HealthScorePageProps, SaveInfo } from '../components/windows/workbench/workbenchTypes';
import type { HealthSetPoints } from '../types';
import type { HealthIssue, HealthPreview, ScoreSummary } from '../types/health';
import { HOURLY_TS, makeHealthPreview, makeSetPointAwarePreview } from './helpers/healthPreviewFixture';
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
/** The score ruler (the band that replaced the set-point table) and its parts, by tick key. */
const ruler = () => screen.getByTestId('score-ruler');
const rulerPart = (part: 'tick' | 'name' | 'value', key: string) => ruler().querySelector(`[data-testid="ruler-${part}"][data-tick="${key}"]`) as HTMLElement;
const tickKeys = () => [...ruler().querySelectorAll('[data-testid="ruler-tick"]')].map(el => (el as HTMLElement).dataset.tick);
const rulerScores = () => [...ruler().querySelectorAll('.wb3-ruler-scores > span')].map(el => el.textContent);
/** A tick's name (its own text: the Relation ruler also carries a narrow-layout copy of the value in a <small>). */
const rulerNames = () => [...ruler().querySelectorAll('[data-testid="ruler-name"]')].map(el => el.childNodes[0].textContent);
const markers = () => screen.queryAllByTestId('ruler-marker');
/** The KPI strip at the top of the page (`data-state`: ready / locked / error) and its three tiles. */
const kpis = () => screen.getByTestId('score-summary');
const tile = (id: 'kpi-lowest' | 'kpi-below80' | 'score-shares') => screen.getByTestId(id);
const tileSub = (id: 'kpi-lowest' | 'kpi-below80' | 'score-shares') => tile(id).querySelector('.wb3-kpi-s')?.textContent ?? null;
/** The bands drawn in the stacked share bar, with how much each grows. */
/** The ONE chart card of the page (both charts), its header subtitle and its two halves. */
const stackCard = () => screen.getByTestId('chart-card-stack');
const stackSub = () => stackCard().querySelector('.wb2-card-s')!.textContent;
const barBands = () => [...screen.getByTestId('share-bar').querySelectorAll('i')].map(i => [(i as HTMLElement).dataset.band, (i as HTMLElement).style.flexGrow]);
const scoreChart = () => charts.filter(c => c.option?.yAxis?.name === 'Score').pop();
const setChart = () => charts.filter(c => c.option?.yAxis?.name !== 'Score' || c.option?.series?.[0]?.name === 'Points').pop();
/** The names PRINTED in the strip above a time chart's plot (the TRAIN periods — a scoring period is not drawn), in band order. */
const stripOf = (c: any): string[] => (c.option.series.find((x: any) => x.name === '__scopes')?.markArea?.data ?? [])
    .filter((a: any) => a[0].label.show).map((a: any) => a[0].label.formatter);
/** Every band drawn under a time chart's data, by name. */
const bandsOf = (c: any): string[] => (c.option.series.find((x: any) => x.name === '__scopes')?.markArea?.data ?? []).map((a: any) => a[0].name);
/** Local wall-clock ms of hour `h` on 2026/01/01 — where the fixture's hourly point of that hour sits on the axis. */
const hourAt = (h: number) => new Date(2026, 0, 1, h).getTime();
/** The heading of a time chart's hover tooltip for the X value `ms` (the X axis' pointer-label formatter). */
const tipHeading = (c: any, ms: number): string => c.option.xAxis.axisPointer.label.formatter({ value: ms });
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

describe('Individual: the score ruler (0 · 80 · 100 · 100 · 80 · 0)', () => {
    // Workbench detail pages v2 §6: ONE band maps value → score. The program's ticks are TEXT.
    it('is ONE ruler — 0 · 80 · 100 · 100 · 80 · 0 on L · −3SD · −1SD · +1SD · +3SD · H; what the program computes is plain text, only L and H are inputs', () => {
        mount({ sp: IND_VALID });
        const card = screen.getByTestId('set-points-card');
        expect(within(card).getByTestId('score-ruler')).toBe(ruler());
        expect(ruler().dataset.kind).toBe('individual');
        expect(tickKeys()).toEqual(['lower', 'm3sd', 'm1sd', 'p1sd', 'p3sd', 'upper']);
        expect(rulerScores()).toEqual(['0', '80', '100', '100', '80', '0']);
        expect(rulerNames()).toEqual(['L', '−3SD', '−1SD', '+1SD', '+3SD', 'H']);
        // the program's values: text, never something that looks like an input
        for (const key of ['m3sd', 'm1sd', 'p1sd', 'p3sd']) {
            const el = rulerPart('value', key);
            expect(el.tagName).toBe('SPAN');
            expect(el.querySelector('input, .hs-num')).toBeNull();
        }
        expect(['m3sd', 'm1sd', 'p1sd', 'p3sd'].map(k => rulerPart('value', k).textContent)).toEqual(['2', '4', '6', '8']);
        // the user's points are the ONLY inputs, each under its own tick, in the large variant
        expect(card.querySelectorAll('input')).toHaveLength(2);
        expect(rulerPart('value', 'lower').contains(input('sp-lower'))).toBe(true);
        expect(rulerPart('value', 'upper').contains(input('sp-upper'))).toBe(true);
        expect(field('sp-lower').className).toMatch(/\bhs-num--big\b/);
        expect(field('sp-upper').className).toMatch(/\bhs-num--big\b/);
        expect(input('sp-lower').value).toBe('1');
        expect(input('sp-upper').value).toBe('9');
        expect(screen.getByLabelText(/^L — /)).toBe(input('sp-lower'));
        expect(screen.getByLabelText(/^H — /)).toBe(input('sp-upper'));
        // what the band means is said once, in the card's subtitle
        expect(screen.getByTestId('ruler-kind-note').textContent).toBe('Score 100 within ±1SD of the learned normal · 80 at ±3SD · 0 at L and H — you set L and H');
        // valid: nothing is marked
        expect(markers()).toHaveLength(0);
        expect(screen.queryByTestId('ruler-markers')).toBeNull();
        expect(ruler().querySelector('[data-state]')).toBeNull();
        // the set-point TABLE is gone: no table, no 100 / 80 / 0 rows, no read-only cells, no locks or chips
        expect(within(card).queryByRole('table')).toBeNull();
        expect(within(card).queryAllByRole('columnheader')).toHaveLength(0);
        for (const id of ['rung-100', 'rung-80', 'rung-0', 'ro-l1', 'ro-u1', 'ro-l3', 'ro-u3', 'hs-ladder']) expect(screen.queryByTestId(id)).toBeNull();
        expect(card.querySelector('.hsx-table, .hsx-row, .hsx-ro, .hs-rung, .hs-ro, .hs-src, .hs-lock')).toBeNull();
        expect(card.querySelectorAll('svg.lucide-lock')).toHaveLength(0);
    });

    it('the Checks live in the SAME card, under the ruler (no second card, no second header)', () => {
        mount({ sp: IND_VALID });
        const card = screen.getByTestId('set-points-card');
        const checks = within(card).getByTestId('checks-card');
        expect(checks.tagName).toBe('DIV');
        expect(checks.closest('.wb3-ruler-checks')).not.toBeNull();
        expect(ruler().compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // under the ruler
        expect(within(card).getByTestId('check-valid').textContent).toBe('Every set point passes the checks — the score is below.');
        expect(screen.getAllByTestId('checks-card')).toHaveLength(1);
        expect(screen.getAllByTestId('set-points-card')).toHaveLength(1);
        expect(card.querySelectorAll('.wb2-card-h')).toHaveLength(1);
        expect(card.textContent).not.toMatch(/Checks/);
    });

    it('every ruler input points at the Checks (aria-describedby) — they say in words what its colour means', () => {
        mount({ sp: { kind: 'individual', lower: 3, upper: null, masterLower: null, masterUpper: null } });
        for (const id of ['sp-lower', 'sp-upper']) {
            const target = document.getElementById(input(id).getAttribute('aria-describedby')!)!;
            expect(target.contains(screen.getByTestId('checks-card'))).toBe(true);
        }
        cleanup();
        mount({ sp: IND_VALID }); // a valid point too
        expect(document.getElementById(input('sp-lower').getAttribute('aria-describedby')!)!.contains(screen.getByTestId('check-valid'))).toBe(true);
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

    // The user's concept rule: a wrong value must WARN — on the band itself, not only in a sentence.
    describe('wrong values warn on the ruler', () => {
        it('a rejected value: red tick, red name, red input AND a red marker where the typed value really sits, labelled as typed', () => {
            mount({ sp: IND_VALID });
            type('sp-lower', '3'); // between −3SD (2) and −1SD (4): the fixture's Rust rejects it
            expect(rulerPart('tick', 'lower').dataset.state).toBe('error');
            expect(rulerPart('tick', 'lower').className).toMatch(/wb3-ruler-tick--bad/);
            expect(rulerPart('name', 'lower').className).toMatch(/wb3-ruler-nm--bad/);
            expect(field('sp-lower').className).toMatch(/hs-num--err/);
            const [m] = markers();
            expect(markers()).toHaveLength(1);
            expect(m.textContent).toBe('L = 3');
            expect(m.dataset.point).toBe('lower');
            expect(m.style.left).toBe('30%'); // half-way between tick 1 and tick 2 of 5
            expect(m.dataset.beyond).toBeUndefined();
            // the Checks sentence carries the value as typed, in the same card
            expect(within(screen.getByTestId('set-points-card')).getByTestId('check-line').textContent).toBe('The lower set point (L = 3) must be below the lower 3σ boundary (2).');
            // the other, valid point is untouched
            expect(rulerPart('tick', 'upper').dataset.state).toBeUndefined();
            // fixing it removes every mark
            type('sp-lower', '1');
            expect(markers()).toHaveLength(0);
            expect(rulerPart('tick', 'lower').dataset.state).toBeUndefined();
        });

        it('the marker keeps what was typed: every decimal, a real minus sign', () => {
            mount({ sp: IND_VALID });
            type('sp-lower', '2.61234');
            expect(markers()[0].textContent).toBe('L = 2.61234');
            type('sp-upper', '-0.5');
            expect(markers().map(m => m.textContent)).toEqual(['L = 2.61234', 'H = −0.5']);
        });

        it('an EMPTY point is dashed amber (tick, name, input) and has no marker; a rejected one is red', () => {
            mount({ sp: { kind: 'individual', lower: 3, upper: null, masterLower: null, masterUpper: null } });
            expect(rulerPart('tick', 'upper').dataset.state).toBe('required');
            expect(rulerPart('tick', 'upper').className).toMatch(/wb3-ruler-tick--req/);
            expect(rulerPart('tick', 'upper').className).not.toMatch(/wb3-ruler-tick--bad/);
            expect(rulerPart('name', 'upper').className).toMatch(/wb3-ruler-nm--req/);
            expect(field('sp-upper').className).toMatch(/hs-num--req/);
            expect(rulerPart('tick', 'lower').className).toMatch(/wb3-ruler-tick--bad/);
            expect(markers().map(m => m.dataset.point)).toEqual(['lower']); // nothing to mark for an empty box
        });

        it('a value beyond the user\'s other point sits AT that end with an arrow ("L = 90 →")', () => {
            mount({ sp: IND_VALID }); // H = 9 is valid
            type('sp-lower', '90');
            const [m] = markers();
            expect(m.textContent).toBe('L = 90 →');
            expect(m.dataset.beyond).toBe('right');
            expect(m.style.left).toBe('100%');
            expect(m.className).toMatch(/wb3-ruler-mark--right/);
        });

        it('two rejected values whose labels would collide are stacked on rows', () => {
            mount({ sp: { kind: 'individual', lower: 4.5, upper: 5.5, masterLower: null, masterUpper: null } });
            const ms = markers();
            expect(ms.map(m => m.textContent)).toEqual(['L = 4.5', 'H = 5.5']);
            expect(ms.map(m => m.dataset.row)).toEqual(['0', '1']);
            expect(ms.map(m => m.style.top)).toEqual(['0px', '22px']);
            expect(screen.getByTestId('ruler-markers').dataset.rows).toBe('2');
            expect(screen.getByTestId('ruler-markers').style.height).toBe('44px');
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
    it('ruler: 0 low · 80 low · −2RMSE · no residual · +2RMSE · 80 high · 0 high; the band edges are text; the four residual points are the only inputs, empty, with − / + placeholders and the unit', () => {
        mount({ kind: 'relationship', sp: { ...REL_EMPTY } });
        const card = screen.getByTestId('set-points-card');
        expect(ruler().dataset.kind).toBe('relationship');
        expect(tickKeys()).toEqual(['residual_at_0_lower', 'residual_at_80_lower', 'm2rmse', 'zero', 'p2rmse', 'residual_at_80_upper', 'residual_at_0_upper']);
        expect(rulerScores()).toEqual(['0', '80', '100', '100', '100', '80', '0']);
        expect(rulerNames()).toEqual(['0 low', '80 low', '−2RMSE', 'no residual', '+2RMSE', '80 high', '0 high']);
        expect(['m2rmse', 'zero', 'p2rmse'].map(k => rulerPart('value', k).textContent)).toEqual(['−0.913', '0', '+0.913']);
        for (const k of ['m2rmse', 'zero', 'p2rmse']) expect(rulerPart('value', k).querySelector('input, .hs-num')).toBeNull();
        // the inputs, in RULER order (low side first)
        const ids = ['sp-residual_at_0_lower', 'sp-residual_at_80_lower', 'sp-residual_at_80_upper', 'sp-residual_at_0_upper'];
        expect([...card.querySelectorAll('input')].map(i => i.id)).toEqual(ids);
        for (const id of ids) {
            expect(input(id).value).toBe(''); // they start EMPTY — no defaults
            expect(input(id).placeholder).toBe(id.endsWith('_lower') ? '−' : '+');
            expect(field(id).className).toMatch(/hs-num--req/);
            expect(field(id).className).toMatch(/hs-num--big/);
            expect(field(id).textContent).toContain('bar');
            expect(rulerPart('tick', id.slice(3)).dataset.state).toBe('required');
        }
        expect(screen.getByTestId('ruler-kind-note').textContent).toBe('Residual = actual − predicted · 100 within ±2RMSE · you set where 80 and 0 sit on each side');
        expect(screen.getByTestId('sign-note').textContent).toBe('The low points are negative, the high points positive. Each 0 point sits further from zero than its 80 point.');
        expect(screen.queryByTestId('master-note')).toBeNull();
        expect(within(card).queryByRole('table')).toBeNull();
    });

    // On a narrow pane the four inputs sit on their own labelled row under the band (CSS, by
    // container width): each input carries its point's name, each program tick its value.
    it('each input carries its point\'s name and each program tick its value, for the narrow layout\'s own row', () => {
        mount({ kind: 'relationship', sp: { ...REL_VALID } });
        const label = (key: string) => rulerPart('value', key).querySelector('.wb3-ruler-vl')!;
        expect(['residual_at_0_lower', 'residual_at_80_lower', 'residual_at_80_upper', 'residual_at_0_upper'].map(k => label(k).textContent)).toEqual(['0 low', '80 low', '80 high', '0 high']);
        expect(label('residual_at_0_lower').getAttribute('aria-hidden')).toBe('true'); // the input has its own accessible name
        expect(['m2rmse', 'zero', 'p2rmse'].map(k => rulerPart('name', k).querySelector('.wb3-ruler-nm-pv')!.textContent)).toEqual(['−0.913', '0', '+0.913']);
        // ...and only the Relation ruler does (Individual / Clustering inputs stay under their ticks at every width)
        cleanup();
        mount({ sp: IND_VALID });
        expect(ruler().querySelector('.wb3-ruler-vl, .wb3-ruler-nm-pv')).toBeNull();
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
        expect(lines[0].textContent).toMatch(/Enter 4 empty points: 0 low, 80 low, 80 high, 0 high/);
        expect(lines[0].textContent).toMatch(/Read them off the residual chart below, or type the values\./);
        type('sp-residual_at_80_lower', '-1.5');
        type('sp-residual_at_80_upper', '1.5');
        lines = screen.getAllByTestId('check-line');
        expect(lines).toHaveLength(1);
        expect(lines[0].textContent).toMatch(/Enter 2 empty points: 0 low, 0 high/);
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

    it('ruler: one-sided — centre · 1× · 3× · N×; the 1× and 3× ticks are text; N is the one control (number box, − / +) under its tick, with the 4× 5× 6× 7× presets', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        const card = screen.getByTestId('set-points-card');
        expect(ruler().dataset.kind).toBe('clustering');
        expect(tickKeys()).toEqual(['centre', 'ring1', 'ring3', 'outer_sd']);
        expect(rulerScores()).toEqual(['100', '100', '80', '0']);
        expect(rulerNames()).toEqual(['centre', '1× SD', '3× SD', 'N× SD']);
        expect(['centre', 'ring1', 'ring3'].map(k => rulerPart('value', k).textContent)).toEqual(['0× SD', '1×', '3×']);
        for (const k of ['centre', 'ring1', 'ring3']) expect(rulerPart('value', k).querySelector('input, button')).toBeNull();
        expect(card.querySelectorAll('input')).toHaveLength(1);
        const ctl = screen.getByTestId('ring-control');
        expect(rulerPart('value', 'outer_sd').contains(ctl)).toBe(true);
        expect(within(ctl).getByTestId('sp-outer_sd')).toBe(input('sp-outer_sd'));
        expect(within(ctl).getByTestId('ring-dec')).toBeTruthy();
        expect(within(ctl).getByTestId('ring-inc')).toBeTruthy();
        expect(input('sp-outer_sd').value).toBe('');
        expect(input('sp-outer_sd').placeholder).toBe('N');
        expect(field('sp-outer_sd').className).toMatch(/hs-num--req/);
        expect(field('sp-outer_sd').className).toMatch(/hs-num--big/);
        expect(field('sp-outer_sd').textContent).toContain('× SD');
        expect(rulerPart('tick', 'outer_sd').dataset.state).toBe('required');
        expect(['ring-quick-4', 'ring-quick-5', 'ring-quick-6', 'ring-quick-7'].map(id => within(card).getByTestId(id).textContent)).toEqual(['4×', '5×', '6×', '7×']);
        expect(screen.getByTestId('ruler-kind-note').textContent).toBe('Distance from each cluster\'s centre in SD units · 100 inside 1× SD · 80 at 3× SD · 0 at N× SD — you set N');
        expect(card.textContent).toMatch(/One N for every cluster: each cluster gets its own 1×, 3× and N× rings/);
        expect(within(card).queryByRole('table')).toBeNull();
        expect(screen.queryByTestId('ro-nx')).toBeNull();
    });

    it('the box shows the N that is set, exactly as typed; a rejected N is marked on the band where it sits, as typed', () => {
        mount({ kind: 'clustering', sp: CL(null) });
        fireEvent.click(screen.getByTestId('ring-quick-5'));
        expect(input('sp-outer_sd').value).toBe('5');
        expect(markers()).toHaveLength(0);
        type('sp-outer_sd', '4.25');
        expect(input('sp-outer_sd').value).toBe('4.25');
        expect(markers()).toHaveLength(0);
        type('sp-outer_sd', '2.5'); // not above 3: rejected
        expect(rulerPart('tick', 'outer_sd').className).toMatch(/wb3-ruler-tick--bad/);
        const [m] = markers();
        expect(m.textContent).toBe('N = 2.5×');
        expect(parseFloat(m.style.left)).toBeCloseTo((1.75 / 3) * 100, 3); // three quarters of the way from the 1× tick to the 3× tick
        type('sp-outer_sd', '3'); // exactly ON the 3× tick
        expect(markers()[0].textContent).toBe('N = 3×');
        expect(parseFloat(markers()[0].style.left)).toBeCloseTo((2 / 3) * 100, 3);
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
        expect(stackCard().querySelector('.wb2-legend')).toBeNull();
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
    it('is locked while the set points are not valid - no score chart is drawn; the text sends the user to the ruler', () => {
        mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
        const lock = screen.getByTestId('score-locked');
        expect(lock.textContent).toBe('Set every point on the ruler above — the score appears here');
        expect(stackCard().contains(lock)).toBe(true); // in the lower half of the one chart card
        expect(lock.dataset.lock).toBe('empty');
        expect(scoreChart()).toBeUndefined();
        expect(screen.queryByTestId('chart-card-score')).toBeNull();
    });

    // Workbench detail pages v2 §6 "Lock text": a rejected point reads differently from an empty one.
    it('lock text: a rejected set point -> "Fix the set point on the ruler above…"; only empty ones -> "Set every point on the ruler above…"', () => {
        mount({ sp: IND_VALID });
        type('sp-lower', '3'); // rejected
        expect(screen.getByTestId('score-locked').textContent).toBe('Fix the set point on the ruler above — the score appears here');
        expect(screen.getByTestId('score-locked').dataset.lock).toBe('bad');
        type('sp-lower', ''); // empty again: nothing is rejected
        expect(screen.getByTestId('score-locked').textContent).toBe('Set every point on the ruler above — the score appears here');
        expect(screen.getByTestId('score-locked').dataset.lock).toBe('empty');
        // a rejected point AND an empty one: the rejected one decides
        cleanup();
        mount({ sp: { kind: 'individual', lower: 3, upper: null, masterLower: null, masterUpper: null } });
        expect(screen.getByTestId('score-locked').dataset.lock).toBe('bad');
        // the old words are gone
        expect(screen.getByTestId('health-page').textContent).not.toMatch(/Set the points above|once every set point is valid/);
        // the pure rule behind it
        expect(scoreLockText('bad')).toBe('Fix the set point on the ruler above — the score appears here');
        expect(scoreLockText('needs')).toBe('Set every point on the ruler above — the score appears here');
        expect(scoreLockText(null)).toBe('Set every point on the ruler above — the score appears here');
        expect([lockReason(true, 'bad'), lockReason(false, 'bad'), lockReason(false, 'needs'), lockReason(false, null)]).toEqual(['error', 'bad', 'empty', 'empty']);
    });

    it('is locked when the preview carries no HOURLY score even though it says valid', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, hourly: { ...d.hourly, score: null } as any } });
        expect(screen.getByTestId('score-locked')).toBeTruthy();
    });

    it('draws the score chart once valid: 0-100 series from hourly.score, with a gap (null), never 0, for an hour without a score', () => {
        const d = previewFor('individual', IND_VALID);
        const hourly = { ...d.hourly, score: [100, null, 80, 55, 30] } as any;
        mount({ sp: IND_VALID, data: { ...d, hourly } });
        expect(screen.queryByTestId('score-locked')).toBeNull();
        expect(screen.getByTestId('chart-card-score')).toBeTruthy();
        const opt = scoreChart().option;
        expect(opt.series[0].data.map((p: any) => p[1])).toEqual([100, null, 80, 55, 30]);
        expect(opt.yAxis.min).toBe(0);
        expect(opt.yAxis.max).toBe(100);
    });

    // The health score is computed on 1-hour averages (2026-10-11): the raw `series` belongs to the
    // Model fit page and is never scored. The fixture's hourly values differ from the raw ones.
    describe('the page draws `hourly` (1-hour averages), never the raw `series`', () => {
        const ms = (list: string[]) => list.map(t => new Date(t).getTime());
        const xs = (c: any): number[] => c.option.series[0].data.map((p: any) => p[0]);
        const ys = (c: any): (number | null)[] => c.option.series[0].data.map((p: any) => p[1]);

        it('Individual: the set-point chart plots the hour means at the hour starts; the score chart shares that index set', () => {
            const d = previewFor('individual', IND_VALID);
            mount({ sp: IND_VALID, data: d });
            expect(ys(setChart())).toEqual([5.1, 5.4, 4.6, 6.1, 3.2]);
            expect(ys(setChart())).not.toEqual((d.series as any).value);
            expect(xs(setChart())).toEqual(ms(HOURLY_TS));
            expect(xs(scoreChart())).toEqual(xs(setChart()));
            expect(ys(scoreChart())).toEqual([100, 90, 80, 60, 30]);
        });

        it('a score on the RAW series alone (an answer from before the change) unlocks nothing: only hourly.score counts', () => {
            const d = previewFor('individual', IND_VALID);
            mount({ sp: IND_VALID, data: { ...d, series: { ...d.series, score: [1, 2, 3, 4, 5] } as any, hourly: { ...d.hourly, score: null } as any } });
            expect(screen.getByTestId('score-locked')).toBeTruthy();
            expect(scoreChart()).toBeUndefined();
        });

        it('the raw series can be any length: the charts follow hourly only (12 five-minute rows = 1 hourly point)', () => {
            const d = previewFor('individual', IND_VALID);
            const raw = {
                ...d.series,
                rows: Array.from({ length: 12 }, (_, i) => i),
                timestamps: Array.from({ length: 12 }, (_, i) => `2026-01-01 00:${String(i * 5).padStart(2, '0')}:00`),
                value: Array.from({ length: 12 }, (_, i) => 4 + i * 0.1),
                in_scope: Array.from({ length: 12 }, () => true),
                total_points: 12,
            } as any;
            const hourly = { ...d.hourly, rows: [0], timestamps: ['2026-01-01T00:00:00'], value: [4.55], in_scope: [true], score: [100], total_points: 1 } as any;
            mount({ sp: IND_VALID, data: { ...d, series: raw, hourly } });
            expect(ys(setChart())).toEqual([4.55]);
            expect(ys(scoreChart())).toEqual([100]);
            act(() => { scoreChart().onEvents.updateAxisPointer({ axesInfo: [{ axisDim: 'x', value: new Date('2026-01-01T00:35:00').getTime() }] }); });
            expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 00:00:00 · 1 h avg 4.55 bar · score 100');
        });

        it('Relationship: the residual line is the hourly residual', () => {
            const d = previewFor('relationship', REL_VALID);
            mount({ kind: 'relationship', sp: REL_VALID, data: d });
            expect(ys(setChart())).toEqual([0.1, 0.3, 0, 0.2, 0.4]);
            expect(ys(setChart())).not.toEqual((d.series as any).residual);
            expect(xs(setChart())).toEqual(ms(HOURLY_TS));
        });

        it('Clustering: the points are the hour means (x, y), coloured by the hourly score', () => {
            const sp = { kind: 'clustering', outerSd: 5 } as const;
            mount({ kind: 'clustering', sp });
            expect(setChart().option.series[0].data).toEqual([
                [10.5, 20.5, 100, 1], [11.5, 21.5, 90, 1], [20.5, 40.5, 80, 2], [21.5, 41.5, 60, 2], [12.5, 22.5, 30, null],
            ]);
        });
    });

    it('has NO legend row and no "hover to read" sentence: the shares tile and the read-out say it', () => {
        mount({ sp: IND_VALID });
        expect(stackCard().querySelector('.wb2-legend')).toBeNull();
        const card = stackCard();
        expect(card.textContent).not.toMatch(/Hover to read|near 0|both charts move together/i);
        expect(screen.getByTestId('score-shares')).toBeTruthy(); // the shares stay — as a tile at the top
        expect(card.contains(screen.getByTestId('score-shares'))).toBe(false);
        expect(screen.getByTestId('hs-readout')).toBeTruthy(); // so does the hover read-out
    });

    // Workbench detail pages v2: the numbers left the card's subtitle for the KPI tiles; the card
    // only says what a point of its charts is.
    it('the chart card\'s subtitle says ONCE that every point is a "1-hour average of the running rows" — with no numbers in it', () => {
        mount({ sp: IND_VALID });
        expect(stackSub()).toBe('bar · 1-hour averages of the running rows · one time axis, one cursor for both');
        expect(screen.getAllByTestId('score-basis')).toHaveLength(1);
        expect(screen.getByTestId('score-basis').textContent).toBe('1-hour averages of the running rows');
        expect(screen.getByTestId('score-basis').closest('.wb2-card-s')).not.toBeNull();
        expect(stackCard().querySelector('.wb2-card-h')!.textContent).not.toMatch(/Lowest|below 80|scored hours/);
        expect(stackCard().querySelector('[data-testid="score-lowest"], [data-testid="score-below80"]')).toBeNull();
    });

    it('the line at 80 is named at the right edge outside the plot; the tooltip prints whole scores', () => {
        mount({ sp: IND_VALID });
        const opt = scoreChart().option;
        const line = opt.series[0].markLine.data[0];
        expect([line.yAxis, line.label.formatter, line.label.position]).toEqual([80, '80', 'end']);
        expect(opt.tooltip.valueFormatter(85)).toBe('85');
        expect(opt.tooltip.valueFormatter(84.99)).toBe('85');
    });

    // User report 2026-10-12: the tooltip was headed by the date alone ("2026-01-01").
    it('the hover tooltip of both time charts is headed by the hovered HOUR — date and time, the hour start, in the one date format', () => {
        mount({ sp: IND_VALID });
        for (const chart of [scoreChart(), setChart()]) {
            expect(chart.option.xAxis.type).toBe('time');
            expect(tipHeading(chart, hourAt(2))).toBe('2026/01/01 02:00:00');
            expect(tipHeading(chart, hourAt(0))).toBe('2026/01/01 00:00:00'); // midnight still shows its time
            // the same text as the read-out under the score chart, and nothing else about the tooltip changed
            expect(chart.option.tooltip).toMatchObject({ trigger: 'axis', confine: true, transitionDuration: 0, hideDelay: 0, enterable: false });
            expect(chart.option.tooltip.formatter).toBeUndefined(); // the value rows are ECharts' own
            expect(chart.option.axisPointer).toEqual({ zlevel: 1, triggerEmphasis: false, link: [{ xAxisIndex: 'all' }] });
        }
    });

    it('a share that is not zero never reads "0.0%": below a tenth of a percent it says "< 0.1%"', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, share_80_100: 99.96, share_40_80: 0.04, share_0_40: 0 } } });
        expect(screen.getByTestId('share-share_40_80').textContent).toBe('40–80< 0.1%');
        expect(screen.getByTestId('share-share_0_40').textContent).toBe('0–400.0%'); // a real zero stays zero
        expect(screen.getByTestId('share-share_80_100').textContent).toBe('80–100100.0%');
    });

    // The rule was once on the share column only, while "below 80" printed `toFixed(1)`:
    // "below 80 for 0.0%" next to a "< 0.1%" share.
    it('the "Below 80" tile follows the same rule: "< 0.1%", never "0.0%" for a share that is not zero', () => {
        const d = previewFor('individual', IND_VALID);
        const withPct = (pct: number | null) => ({ ...d, score_summary: { ...d.score_summary!, share_80_100: 99.96, share_40_80: 0.04, share_0_40: 0, pct_below_80: pct } });
        mount({ sp: IND_VALID, data: withPct(0.04) });
        expect(screen.getByTestId('score-below80').textContent).toBe('< 0.1%');
        expect(tile('kpi-below80').textContent).toBe('Below 80< 0.1%of 5 scored hours');
        expect(tile('kpi-below80').textContent).not.toContain('0.0%');
        // the tile and the shares tile beside it agree
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

    it('shows an em dash for a share Rust did not provide — and no "Below 80" number', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, share_40_80: null, pct_below_80: null } } });
        expect(screen.getByTestId('share-share_40_80').textContent).toBe('40–80—');
        expect(barBands().map(b => b[0])).toEqual(['share_80_100', 'share_0_40']); // no segment for a share that is not known
        expect(screen.queryByTestId('score-below80')).toBeNull();
        expect(tile('kpi-below80').textContent).toBe('Below 80—of 5 scored hours');
    });

    it('no hour got a score: the Lowest tile reads "no scored hours" (never "rows"), every number is a dash, the chart caption stays', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, hourly: { ...d.hourly, score: [null, null, null, null, null] } as any, score_summary: { ...d.score_summary!, scored: 0, unscored: 5, min_score: null, pct_below_80: null, share_80_100: null, share_40_80: null, share_0_40: null } } });
        expect(kpis().dataset.state).toBe('ready'); // the set points ARE valid: this is an answer, not a lock
        expect(tile('kpi-lowest').textContent).toBe('Lowest score—no scored hours');
        expect(tile('kpi-lowest').className).toBe('wb3-kpi'); // no score, no colour
        expect(tile('kpi-below80').textContent).toBe('Below 80—of 0 scored hours');
        expect(barBands()).toEqual([]);
        expect(kpis().textContent).not.toMatch(/rows/);
        expect(screen.getByTestId('score-basis').textContent).toBe('1-hour averages of the running rows');
    });

    it('the card has ONE Expand button: the enlarged copy holds BOTH charts (and nothing else of the page)', () => {
        mount({ sp: IND_VALID });
        expect(screen.queryByTestId('chart-expand-set-individual')).toBeNull();
        expect(screen.queryByTestId('chart-expand-score')).toBeNull();
        expect(stackCard().querySelectorAll('button[title="Expand"]')).toHaveLength(1);
        fireEvent.click(screen.getByTestId('chart-expand-stack'));
        const overlay = screen.getByTestId('chart-overlay-stack');
        expect(overlay.querySelectorAll('[data-testid="echarts-mock"]')).toHaveLength(2);
        expect(overlay.querySelectorAll('.wb3-stack-in > *')).toHaveLength(2);
        expect([...overlay.querySelectorAll('[data-testid="echarts-mock"]')].map(c => c.getAttribute('data-y-name'))).toEqual(['bar', 'Score']); // value above, score below
        // the enlarged copy is the charts alone: the tiles stay on the page
        expect(overlay.querySelector('[data-testid="score-shares"]')).toBeNull();
        // ...and it repeats none of the page's test ids
        for (const id of ['chart-stack', 'chart-card-set-individual', 'chart-card-score']) expect(screen.getAllByTestId(id)).toHaveLength(1);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('chart-overlay-stack')).toBeNull();
    });

    // The enlarged copy is a pair of its own: it used to be ONE chart kept out of everything; now
    // that it is both charts, they must be linked to each other — and still not to the page's.
    it('the enlarged copy: its two charts share THEIR OWN cursor group and zoom window — never the page\'s', () => {
        mount({ sp: IND_VALID });
        const pageJoin = scoreChart().onChartReady;
        const pageZoom = scoreChart().onEvents.datazoom;
        fireEvent.click(screen.getByTestId('chart-expand-stack'));
        const [upper, lower] = charts.slice(-2); // the two charts drawn for the overlay
        expect(upper.onChartReady).toBe(lower.onChartReady);
        expect(upper.onEvents.datazoom).toBe(lower.onEvents.datazoom);
        expect(upper.onChartReady).not.toBe(pageJoin);
        expect(upper.onEvents.datazoom).not.toBe(pageZoom);
        // a chart inside the overlay joins the EXPANDED group through the overlay's handler...
        const dialog = document.createElement('div');
        dialog.className = 'pm-chart-modal-backdrop';
        const inOverlay: any = { getDom: () => dialog.appendChild(document.createElement('div')) };
        upper.onChartReady(inOverlay);
        expect(inOverlay.group).toBe('health-score-sync-expanded');
        // ...but not through the page's (the charts under the backdrop must stay still)
        const stray: any = { getDom: () => dialog.appendChild(document.createElement('div')) };
        pageJoin(stray);
        expect(stray.group).toBeUndefined();
        // and a chart on the page never joins the overlay's pair
        const onPage: any = { getDom: () => document.createElement('div') };
        upper.onChartReady(onPage);
        expect(onPage.group).toBeUndefined();
        pageJoin(onPage);
        expect(onPage.group).toBe('health-score-sync');
        // hovering in the overlay still drives the page's read-out state (one hovered hour for the page)
        act(() => { lower.onEvents.updateAxisPointer({ axesInfo: [{ axisDim: 'x', value: new Date('2026-01-01 03:00:00').getTime() }] }); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 03:00:00 · 1 h avg 6.1 bar · score 60');
    });

    // Real-app request 2026-10-12: "if the two charts were the same size it would be much easier
    // to read — no need to line the point up by eye". Workbench detail pages v2: ONE full-width card
    // holds both charts, on one time axis.
    it('one column: the KPI tiles, the ruler card, then ONE chart card with the set-point chart above the score chart', () => {
        mount({ sp: IND_VALID });
        const page = screen.getByTestId('health-page');
        const rulerCard = screen.getByTestId('set-points-card');
        // every block is a direct child of the ONE-column board, in this order — the tiles first
        expect(page.className).toBe('wb2-board hs-board');
        expect([...page.children]).toEqual([kpis(), rulerCard, stackCard()]);
        // no side column, no wrappers of the old two-column layout, no "Share of scored hours" card
        expect(page.querySelector('.hs-spp, .hs-setwrap, .hs-sharecard, .hs-shares')).toBeNull();
        expect(rulerCard.className).toBe('hs-card wb3-rulercard');
        expect(kpis().contains(screen.getByTestId('score-shares'))).toBe(true);
        // ONE card (not two), full width, 560 px tall (the "stack" size)
        expect(page.querySelectorAll('.wb2-card')).toHaveLength(1);
        expect(stackCard().className).toBe('wb2-card wb2-card--stack wb2-full');
        expect(stackCard().querySelector('.wb2-card-h b')!.textContent).toBe('Sensor value and health score');
        // both charts inside it, in order: the set-point chart, then the score chart
        const stack = screen.getByTestId('chart-stack');
        expect(stack.className).toBe('wb3-stack-in');
        expect([...stack.children]).toEqual([screen.getByTestId('chart-card-set-individual'), screen.getByTestId('chart-card-score')]);
        expect(screen.getByTestId('chart-card-set-individual').className).toBe('wb3-stack-top');
        expect(screen.getByTestId('chart-card-score').className).toBe('wb3-stack-bot');
        expect(stack.querySelectorAll('[data-testid="echarts-mock"]')).toHaveLength(2);
        expect(screen.getByTestId('chart-card-set-individual').querySelector('[data-testid="echarts-mock"]')!.getAttribute('data-y-name')).toBe('bar');
        expect(screen.getByTestId('chart-card-score').querySelector('[data-testid="echarts-mock"]')!.getAttribute('data-y-name')).toBe('Score');
    });

    it('ONE time axis: the same plot margins left and right, the X labels printed once (under the lower chart), the periods named once (above the upper one)', () => {
        mount({ sp: IND_VALID, data: { ...previewFor('individual', IND_VALID), test_validation: makeValidation({ tests: [makeTestResult()] }) } });
        const g = (c: any) => [c.option.grid.left, c.option.grid.right];
        expect(g(scoreChart())).toEqual(g(setChart()));
        // the same X values in both (the hour starts), so a moment in time is at the same X
        const xs = (c: any): number[] => c.option.series[0].data.map((p: any) => p[0]);
        expect(xs(scoreChart())).toEqual(xs(setChart()));
        expect(setChart().option.xAxis.type).toBe('time');
        expect(scoreChart().option.xAxis.type).toBe('time');
        // upper: no X labels / ticks of its own, its plot runs down to the divider
        expect(setChart().option.xAxis.axisLabel.show).toBe(false);
        expect(setChart().option.xAxis.axisTick).toEqual({ show: false });
        expect(setChart().option.grid.bottom).toBe(8);
        // lower: it prints the time labels; its plot starts right under the divider
        expect(scoreChart().option.xAxis.axisLabel.show).not.toBe(false);
        expect(scoreChart().option.grid.top).toBe(8);
        expect(scoreChart().option.grid.bottom).toBe(28);
        // the TRAIN band is on both, its NAME only above the upper plot
        expect(bandsOf(setChart())).toEqual(['TRAIN']);
        expect(bandsOf(scoreChart())).toEqual(['TRAIN']);
        expect(stripOf(setChart())).toEqual(['TRAIN']);
        expect(stripOf(scoreChart())).toEqual([]);
    });

    // Code review 2026-10-12: a new `onEvents` object on every render makes echarts-for-react bind
    // the handlers again without removing the old ones — every hovered hour re-renders this
    // card, so each mouse move cost more than the one before it.
    it('the charts keep the SAME event handlers across a hover re-render (nothing is bound again on every mouse move)', () => {
        mount({ sp: IND_VALID });
        const before = { upper: setChart().onEvents, lower: scoreChart().onEvents };
        for (const hour of ['2026-01-01 01:00:00', '2026-01-01 03:00:00']) {
            act(() => { scoreChart().onEvents.updateAxisPointer({ axesInfo: [{ axisDim: 'x', value: new Date(hour).getTime() }] }); });
        }
        expect(screen.getByTestId('hs-readout').textContent).toMatch(/^2026\/01\/01 03:00:00/); // the hover really re-rendered the card
        expect(setChart().onEvents).toBe(before.upper);
        expect(scoreChart().onEvents).toBe(before.lower);
        // ... and they still report the pointer: leaving the chart clears the read-out
        act(() => { scoreChart().onEvents.globalout(); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
    });

    it('Clustering: the scatter keeps its handlers across a hover too', () => {
        const sp = { kind: 'clustering', outerSd: 5 } as const;
        mount({ kind: 'clustering', sp });
        const before = setChart().onEvents;
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Points', dataIndex: 2 }); });
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Points', dataIndex: 3 }); });
        expect(setChart().onEvents).toBe(before);
    });

    it('one zoom window and one cursor for both: the two charts join through the same handler and report their zoom to the same one', () => {
        mount({ sp: IND_VALID });
        expect(typeof scoreChart().onEvents.datazoom).toBe('function');
        expect(scoreChart().onEvents.datazoom).toBe(setChart().onEvents.datazoom);
        expect(scoreChart().onChartReady).toBe(setChart().onChartReady);
        // both link their X cursor (the group carries it across)
        for (const c of [scoreChart(), setChart()]) expect(c.option.axisPointer.link).toEqual([{ xAxisIndex: 'all' }]);
        // a zoom on one is pushed to the other; a set-point edit (a redrawn chart) puts the window back
        const inst = (start: number, end: number) => {
            const z = { start, end };
            const chart: any = {
                getDom: () => document.createElement('div'),
                isDisposed: () => false,
                getOption: () => ({ dataZoom: [z] }),
                dispatchAction: vi.fn((a: any) => { z.start = a.start; z.end = a.end; }),
            };
            return chart;
        };
        const upper = inst(0, 100);
        const lower = inst(0, 100);
        setChart().onChartReady(upper);
        scoreChart().onChartReady(lower);
        upper.getOption().dataZoom[0].start = 20;
        upper.getOption().dataZoom[0].end = 60;
        act(() => { setChart().onEvents.datazoom({}, upper); });
        expect(lower.dispatchAction).toHaveBeenLastCalledWith({ type: 'dataZoom', dataZoomIndex: 0, start: 20, end: 60, escapeConnect: true });
        expect(upper.dispatchAction).not.toHaveBeenCalled();
        // the user edits a set point while zoomed: the upper chart is redrawn from a new option (unzoomed)...
        upper.getOption().dataZoom[0].start = 0;
        upper.getOption().dataZoom[0].end = 100;
        type('sp-upper', '9.5');
        // ...and gets the window back; the lower one, which kept it, is left alone
        expect(upper.dispatchAction).toHaveBeenLastCalledWith({ type: 'dataZoom', dataZoomIndex: 0, start: 20, end: 60, escapeConnect: true });
        expect(lower.dispatchAction).toHaveBeenCalledTimes(1);
    });

    it('LOCKED: the upper chart is alone in the card and keeps its own time labels; the lock sentence takes the score chart\'s place', () => {
        mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
        const stack = screen.getByTestId('chart-stack');
        expect([...stack.children]).toEqual([screen.getByTestId('chart-card-set-individual'), screen.getByTestId('score-locked')]);
        expect(screen.getByTestId('score-locked').className).toBe('wb3-stack-bot wb3-stack-bot--lock');
        expect(screen.queryByTestId('chart-card-score')).toBeNull();
        expect(stack.querySelectorAll('[data-testid="echarts-mock"]')).toHaveLength(1);
        // not the upper half of a pair: its X labels and its own bottom margin are back
        expect(setChart().option.xAxis.axisLabel.show).not.toBe(false);
        expect(setChart().option.grid.bottom).toBe(28);
        // the card is the same card (title, size, read-out) — only its lower half differs
        expect(stackCard().className).toBe('wb2-card wb2-card--stack wb2-full');
        expect(stackCard().querySelector('.wb2-card-h b')!.textContent).toBe('Sensor value and health score');
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
    });

    it('Clustering: the 700 px variant — the scatter above (taller share of the card), the score chart below; they share no axis', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(stackCard().className).toBe('wb2-card wb2-card--stackxy wb2-full');
        expect(stackCard().querySelector('.wb2-card-h b')!.textContent).toBe('Clusters and health score');
        const stack = screen.getByTestId('chart-stack');
        expect(stack.className).toBe('wb3-stack-in wb3-stack-in--xy');
        expect([...stack.children]).toEqual([screen.getByTestId('chart-card-set-clustering'), screen.getByTestId('chart-card-score')]);
        // the scatter is not a time chart: it joins no cursor group and no zoom window, and keeps its own axes
        expect(setChart().onChartReady).toBeUndefined();
        expect(setChart().onEvents.datazoom).toBeUndefined();
        expect(setChart().option.xAxis.type).toBe('value');
        expect(setChart().option.xAxis.axisLabel?.show).not.toBe(false);
        // the score chart under it is a whole chart of its own: its time labels, its own top margin
        expect(typeof scoreChart().onEvents.datazoom).toBe('function');
        expect(scoreChart().option.grid.top).toBe(14);
        // a time kind is the 560 px one
        cleanup();
        mount({ kind: 'relationship', sp: REL_VALID });
        expect(stackCard().className).toBe('wb2-card wb2-card--stack wb2-full');
        expect(stackCard().querySelector('.wb2-card-h b')!.textContent).toBe('Residual and health score');
        expect(screen.getByTestId('chart-stack').className).toBe('wb3-stack-in');
    });

    it('the hover read-out is in the card header — there whether or not the score is drawn', () => {
        mount({ sp: IND_VALID });
        const head = stackCard().querySelector('.wb2-card-h')!;
        expect(head.contains(screen.getByTestId('hs-readout'))).toBe(true);
        expect(screen.getAllByTestId('hs-readout')).toHaveLength(1);
        act(() => { setChart().onEvents.updateAxisPointer({ axesInfo: [{ axisDim: 'x', value: new Date('2026-01-01 04:00:00').getTime() }] }); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 04:00:00 · 1 h avg 3.2 bar · score 30');
        cleanup();
        mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
        expect(stackCard().querySelector('.wb2-card-h')!.contains(screen.getByTestId('hs-readout'))).toBe(true);
        act(() => { setChart().onEvents.updateAxisPointer({ axesInfo: [{ axisDim: 'x', value: new Date('2026-01-01 04:00:00').getTime() }] }); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 04:00:00 · no score');
    });

    it('the Out of date film: ONE, over the whole card (both charts), while the model is stale', () => {
        mount({ sp: IND_VALID, stale: true });
        const films = screen.getAllByTestId('chart-outdated');
        expect(films).toHaveLength(1);
        const body = stackCard().querySelector('.wb2-cv')!;
        expect(films[0].parentElement).toBe(body);
        expect(body.contains(screen.getByTestId('chart-card-set-individual'))).toBe(true);
        expect(body.contains(screen.getByTestId('chart-card-score'))).toBe(true);
        cleanup();
        mount({ sp: IND_VALID });
        expect(screen.queryByTestId('chart-outdated')).toBeNull();
    });
});

// Workbench detail pages v2 §6 "KPI strip" (as cut down 2026-10-12): Lowest score · Below 80 ·
// Share of scored hours. It replaces the score chart's long subtitle and the "Share of scored
// hours" card. Never a tile per scoring period.
describe('KPI tiles at the top of the page', () => {
    it('three tiles, in one row above the ruler: Lowest score (with the hour), Below 80 (of the scored hours), Share of scored hours (a stacked bar + its key)', () => {
        mount({ sp: IND_VALID });
        const strip = kpis();
        expect(strip.className).toBe('wb3-kpis wb3-kpis--scroll'); // one row; it scrolls sideways when the pane is too narrow
        expect(strip.dataset.state).toBe('ready');
        expect(screen.getByTestId('health-page').firstElementChild).toBe(strip);
        expect(strip.compareDocumentPosition(screen.getByTestId('set-points-card')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect([...strip.children]).toEqual([tile('kpi-lowest'), tile('kpi-below80'), tile('score-shares')]);
        expect([...strip.querySelectorAll('.wb3-kpi-l')].map(l => l.textContent)).toEqual(['Lowest score', 'Below 80', 'Share of scored hours']);
        // Lowest score: the whole number, then the START of that hour in the app's one date format (mono)
        expect(screen.getByTestId('score-lowest').textContent).toBe('30');
        expect(screen.getByTestId('score-lowest').closest('.wb3-kpi-v')).not.toBeNull();
        expect(tileSub('kpi-lowest')).toBe('on 2026/01/01 04:00:00 · 1 h average');
        expect(screen.getByTestId('score-lowest-at').textContent).toBe('2026/01/01 04:00:00');
        expect(screen.getByTestId('score-lowest-at').className).toContain('wbx-dt');
        expect(tile('kpi-lowest').textContent).not.toMatch(/2026-01-01|T04/); // never the raw text
        // Below 80: % of the scored HOURS (never "rows"), and how many hours that is of
        expect(screen.getByTestId('score-below80').textContent).toBe('40.0%');
        expect(tileSub('kpi-below80')).toBe('of 5 scored hours');
        // Share of scored hours: one stacked bar, each band growing by its share, and the key with the numbers
        expect(screen.getByRole('img', { name: 'Share of scored hours by score band' })).toBe(screen.getByTestId('share-bar'));
        expect(barBands()).toEqual([['share_80_100', '60'], ['share_40_80', '20'], ['share_0_40', '20']]);
        expect(screen.getByTestId('share-share_80_100').textContent).toBe('80–10060.0%');
        expect(screen.getByTestId('share-share_40_80').textContent).toBe('40–8020.0%');
        expect(screen.getByTestId('share-share_0_40').textContent).toBe('0–4020.0%');
        expect(tileSub('score-shares')).toBeNull();
        expect(strip.textContent).not.toMatch(/scored rows|training hours/);
    });

    it('colour is ONLY on the score number itself: the lowest score takes the colour of its band (80–100 green, 40–80 amber, below 40 red) — the other tiles never judge', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID }); // lowest 30
        expect(tile('kpi-lowest').className).toBe('wb3-kpi wb3-kpi--bad');
        expect(tile('kpi-below80').className).toBe('wb3-kpi');
        expect(tile('score-shares').className).toBe('wb3-kpi');
        cleanup();
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, min_score: { score: 92, row: 1, timestamp: 't' } } } });
        expect(tile('kpi-lowest').className).toBe('wb3-kpi wb3-kpi--ok');
        cleanup();
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, min_score: { score: 80, row: 1, timestamp: 't' } } } });
        expect(tile('kpi-lowest').className).toBe('wb3-kpi wb3-kpi--ok'); // 80 itself is good
        cleanup();
        for (const [score, tone] of [[79.9, 'warn'], [40, 'warn'], [39.9, 'bad'], [0, 'bad']] as const) {
            mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, min_score: { score, row: 1, timestamp: 't' } } } });
            expect(tile('kpi-lowest').className, String(score)).toBe(`wb3-kpi wb3-kpi--${tone}`);
            cleanup();
        }
        // a terrible "Below 80" is still plain: tiles do not judge
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, pct_below_80: 97.3 } } });
        expect(tile('kpi-below80').className).toBe('wb3-kpi');
        expect(kpis().querySelector('.hs-good, .hs-bad')).toBeNull();
        expect(kpis().querySelectorAll('.wb3-kpi--ok, .wb3-kpi--warn, .wb3-kpi--bad')).toHaveLength(1); // the Lowest tile alone
    });

    it('a lowest score is shown as a whole number; one without a timestamp still says it is a 1 h average', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, min_score: { score: 79.6, row: 1, timestamp: null as any } } } });
        expect(screen.getByTestId('score-lowest').textContent).toBe('80');
        expect(tile('kpi-lowest').className).toBe('wb3-kpi wb3-kpi--warn'); // the colour follows the real score (79.6), not the rounded text
        expect(tileSub('kpi-lowest')).toBe('1 h average');
        expect(screen.queryByTestId('score-lowest-at')).toBeNull();
    });

    it('a band with no hours has no segment in the bar; a tiny one still has one (and reads "< 0.1%")', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, score_summary: { ...d.score_summary!, share_80_100: 99.96, share_40_80: 0.04, share_0_40: 0 } } });
        expect(barBands()).toEqual([['share_80_100', '99.96'], ['share_40_80', '0.04']]);
        expect(screen.getByTestId('share-share_0_40').textContent).toBe('0–400.0%');
    });

    it('LOCKED (the set points are empty or rejected): the same three tiles, every number a dash, no colour, and a caption that says what is missing', () => {
        mount({ sp: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } });
        expect(kpis().dataset.state).toBe('locked');
        expect(kpis().children).toHaveLength(3);
        expect(tile('kpi-lowest').textContent).toBe('Lowest score—once the set points are valid');
        expect(tile('kpi-below80').textContent).toBe('Below 80—of the scored hours');
        expect(tile('score-shares').textContent).toBe('Share of scored hours80–100—40–80—0–40—');
        expect(barBands()).toEqual([]);
        for (const id of ['kpi-lowest', 'kpi-below80', 'score-shares'] as const) expect(tile(id).className).toBe('wb3-kpi');
        expect(screen.queryByTestId('score-lowest')).toBeNull();
        expect(screen.queryByTestId('score-lowest-at')).toBeNull();
        expect(screen.queryByTestId('score-below80')).toBeNull();
        // a rejected point: the same
        cleanup();
        mount({ sp: IND_VALID });
        type('sp-lower', '3');
        expect(kpis().dataset.state).toBe('locked');
        expect(tileSub('kpi-lowest')).toBe('once the set points are valid');
        // fixed: the numbers are back
        type('sp-lower', '1');
        expect(kpis().dataset.state).toBe('ready');
        expect(screen.getByTestId('score-lowest').textContent).toBe('30');
    });

    it('valid by Rust but no hourly score in the answer: locked as well (the tiles never show numbers the chart cannot)', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, hourly: { ...d.hourly, score: null } as any } });
        expect(kpis().dataset.state).toBe('locked');
        expect(screen.queryByTestId('score-lowest')).toBeNull();
    });

    // SPEC "Preview failed": every tile says "not available until the score loads".
    it('PREVIEW FAILED: every tile says "not available until the score loads" — the old answer\'s numbers are not shown', () => {
        const last = previewFor('individual', IND_VALID); // an answer that HAD a lowest score of 30
        mount({ sp: IND_VALID, preview: { data: null, lastData: last, loading: false, error: 'boom', errorCode: null, notFitted: false, needsRetrain: false, idle: null } as any });
        expect(kpis().dataset.state).toBe('error');
        expect(kpis().children).toHaveLength(3);
        for (const id of ['kpi-lowest', 'kpi-below80', 'score-shares'] as const) {
            expect(tileSub(id)).toBe('not available until the score loads');
            expect(tile(id).className).toBe('wb3-kpi');
        }
        expect(tile('kpi-lowest').textContent).toBe('Lowest score—not available until the score loads');
        expect(tile('kpi-below80').textContent).toBe('Below 80—not available until the score loads');
        expect(tile('score-shares').textContent).toBe('Share of scored hours80–100—40–80—0–40—not available until the score loads');
        expect(barBands()).toEqual([]);
        expect(kpis().textContent).not.toMatch(/30|40\.0%|60\.0%/);
        // the next request (error cleared, data still null): still "not available", never the old numbers
        cleanup();
        mount({ sp: IND_VALID, preview: { data: null, lastData: last, loading: true, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: null } as any });
        expect(kpis().dataset.state).toBe('error');
        expect(tileSub('kpi-lowest')).toBe('not available until the score loads');
    });

    it('the chart-less states (loading, fit gone, load failed) have NO tiles: there is no preview to summarise', () => {
        mount({ data: null });
        expect(screen.getByTestId('health-loading')).toBeTruthy();
        expect(screen.queryByTestId('score-summary')).toBeNull();
        cleanup();
        mount({ data: null, preview: { data: null, loading: false, error: 'No rows in the training scope.', errorCode: 'NO_DATA', notFitted: false, needsRetrain: false, idle: null } });
        expect(screen.queryByTestId('score-summary')).toBeNull();
    });

    it('never a tile per scoring period: with scoring periods the strip is still exactly three tiles, for all scored hours', () => {
        const withPeriods: HealthPreview = {
            ...previewFor('individual', IND_VALID),
            test_validation: makeValidation({ tests: [makeTestResult({ pct_below_80: 7, lowest: 62, lowest_at: '2026-01-01T02:00:00' }), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00', pct_below_80: 41.5, lowest: 12, lowest_at: '2026-01-01T03:00:00' })] }),
        };
        mount({ sp: IND_VALID, data: withPeriods, testNumbers: [1, 2] });
        expect([...kpis().children].map(t => t.getAttribute('data-testid'))).toEqual(['kpi-lowest', 'kpi-below80', 'score-shares']);
        expect(kpis().textContent).not.toMatch(/S1|S2|62|41\.5|12\b|scoring period/i); // no period's own numbers
        // and with an EMPTY list of scoring periods there is no "no scoring period" tile either
        cleanup();
        mount({ sp: IND_VALID, data: { ...previewFor('individual', IND_VALID), test_validation: makeValidation({ tests: [] }) } });
        expect(kpis().children).toHaveLength(3);
        expect(screen.getByTestId('health-page').textContent).not.toMatch(/no scoring period/i);
    });

    it('ScoreKpis alone: one scored hour is "of 1 scored hour"; large counts are grouped; "ready" without a summary is treated as nothing to show', () => {
        const summary = (over: Partial<ScoreSummary>): ScoreSummary => ({ ...previewFor('individual', IND_VALID).score_summary!, ...over });
        const { rerender } = render(<ScoreKpis state="ready" summary={summary({ scored: 1 })} />);
        expect(tileSub('kpi-below80')).toBe('of 1 scored hour');
        rerender(<ScoreKpis state="ready" summary={summary({ scored: 12345 })} />);
        expect(tileSub('kpi-below80')).toBe('of 12,345 scored hours');
        rerender(<ScoreKpis state="ready" summary={null} />);
        expect(screen.queryByTestId('score-lowest')).toBeNull();
        expect(tile('kpi-lowest').textContent).toBe('Lowest score—once the set points are valid');
        rerender(<ScoreKpis state="error" summary={summary({})} />); // an error never shows a summary, even if one is passed
        expect(screen.queryByTestId('score-lowest')).toBeNull();
        expect(tileSub('score-shares')).toBe('not available until the score loads');
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

    it('Individual: the subtitle is the unit and "1-hour averages of the running rows" (no "type L and H on the right"), and the card has no legend row', () => {
        mount({ sp: IND_VALID, unit: '' });
        expect(stackSub()).toBe('1-hour averages of the running rows · one time axis, one cursor for both'); // no unit: no stray "·"
        cleanup();
        mount({ sp: IND_VALID });
        const card = stackCard();
        expect(stackSub()).toBe('bar · 1-hour averages of the running rows · one time axis, one cursor for both');
        expect(card.textContent).not.toMatch(/type L and H|on the right/);
        expect(card.querySelector('.wb2-legend')).toBeNull();
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
        const card = stackCard();
        expect(stackSub()).toBe('actual − predicted (bar) · 1-hour averages of the running rows · one time axis, one cursor for both');
        expect(card.textContent).not.toMatch(/type the 80|on the right/);
        expect(card.querySelector('.wb2-legend')).toBeNull();
    });

    it('Clustering: the scatter card', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(screen.getByTestId('chart-card-set-clustering')).toBeTruthy();
        expect(setChart().option.series[0].name).toBe('Points');
    });

    it('Clustering: the subtitle names both sensors and says what the point colours mean right now', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(stackSub()).toBe('TAG1 vs TAG2 · 1-hour averages of the running rows · coloured by score');
        expect(stackSub()).not.toMatch(/one time axis/); // the scatter shares no axis with the score chart
        cleanup();
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: null } }); // not scored yet: the points (still hour means) show their cluster
        expect(stackSub()).toBe('TAG1 vs TAG2 · 1-hour averages of the running rows · coloured by score once N is set');
    });

    it('Clustering: axis titles are description + unit (from the Tag names); the tags stay in the subtitle', () => {
        const meta = [
            { tag: 'TAG1', description: 'GENERATOR ACTIVE POWER', unit: 'MW', component: 'Generator' },
            { tag: 'TAG2', description: 'BEARING DE TEMPERATURE', unit: '°C', component: 'Bearing' },
        ];
        render(<SensorMetaProvider metadata={meta}><Harness kind="clustering" sp={{ kind: 'clustering', outerSd: 5 }} /></SensorMetaProvider>);
        expect(setChart().option.xAxis.name).toBe('GENERATOR ACTIVE POWER · MW');
        expect(setChart().option.yAxis.name).toBe('BEARING DE TEMPERATURE · °C');
        expect(stackSub()).toBe('GENERATOR ACTIVE POWERTAG1 vs BEARING DE TEMPERATURETAG2 · 1-hour averages of the running rows · coloured by score');
        cleanup();
        // without Tag names the axis falls back to the tag
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(setChart().option.xAxis.name).toBe('TAG1');
        expect(setChart().option.yAxis.name).toBe('TAG2');
    });
});

describe('hover sync (the pointer on either chart reads the same HOUR on both)', () => {
    // The pointer's time on the axis; the points it lands on are the hourly ones (`HOURLY_TS`).
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

    it('hovering the score chart prints the hour start, the 1 h average and the score; leaving clears it', () => {
        mount({ sp: IND_VALID });
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent(TS)); });
        // 6.1 = the hour mean (the raw row of the same index is 6.2): the read-out reads `hourly`.
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 03:00:00 · 1 h avg 6.1 bar · score 60');
        act(() => { scoreChart().onEvents.globalout(); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('');
    });

    it('the read-out names the START of the hour the pointer is nearest to, wherever inside the hour the pointer is', () => {
        mount({ sp: IND_VALID });
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 03:20:10')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 03:00:00 · 1 h avg 6.1 bar · score 60');
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 03:40:00')); }); // nearer to 04:00
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 04:00:00 · 1 h avg 3.2 bar · score 30');
    });

    it('hovering the SET-POINT chart drives the same read-out', () => {
        mount({ sp: IND_VALID });
        act(() => { setChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 04:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 04:00:00 · 1 h avg 3.2 bar · score 30');
    });

    it('Relationship reads "residual" (the hourly residual), not "1 h avg"', () => {
        mount({ kind: 'relationship', sp: { ...REL_VALID } });
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 01:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 01:00:00 · residual 0.3 bar · score 90');
    });

    it('Clustering: hovering a point of the scatter highlights that hour and fills the read-out; hovering the score chart highlights it on the scatter', () => {
        mount({ kind: 'clustering', sp: { kind: 'clustering', outerSd: 5 } });
        expect(setChart().option.series.some((s: any) => s.name === 'Hover')).toBe(false);
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Points', dataIndex: 3 }); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 03:00:00 · score 60');
        // the hour's mean point (21.5, 41.5) — the raw row of that index is (21, 41)
        expect(setChart().option.series.find((s: any) => s.name === 'Hover').data).toEqual([[21.5, 41.5]]);
        act(() => { setChart().onEvents.mouseover({ seriesName: 'Centres', dataIndex: 0 }); }); // a ring / centre is not a point
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 03:00:00 · score 60');
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 01:00:00')); });
        expect(setChart().option.series.find((s: any) => s.name === 'Hover').data).toEqual([[11.5, 21.5]]);
        act(() => { setChart().onEvents.globalout(); });
        expect(setChart().option.series.some((s: any) => s.name === 'Hover')).toBe(false);
    });

    it('an hour without a score reads "no score" (it did run — it is a point)', () => {
        const d = previewFor('individual', IND_VALID);
        mount({ sp: IND_VALID, data: { ...d, hourly: { ...d.hourly, score: [100, null, 80, 55, 30] } as any } });
        act(() => { scoreChart().onEvents.updateAxisPointer(axisEvent('2026-01-01 01:00:00')); });
        expect(screen.getByTestId('hs-readout').textContent).toBe('2026/01/01 01:00:00 · no score');
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

describe('Mark complete: checking, result and failure (it writes no files)', () => {
    const save = (s: SaveInfo) => mount({ sp: IND_VALID, save: s });

    it('nothing to say while idle', () => {
        save({ phase: 'idle' });
        expect(screen.queryByTestId('save-running')).toBeNull();
        expect(screen.queryByTestId('save-ok')).toBeNull();
        expect(screen.queryByTestId('save-error')).toBeNull();
    });

    // Checking is the FOOTER only — no card on the page, unless the check is slow.
    it('running: no "Still checking…" card on the page; one appears only once the check has been running for a while', () => {
        vi.useFakeTimers();
        try {
            save({ phase: 'running' });
            expect(screen.queryByTestId('save-running')).toBeNull();
            expect(screen.getByTestId('health-page').querySelector('.hs-save')).toBeNull();
            expect(screen.getByTestId('health-page').textContent).not.toMatch(/Saving|Still checking/);
            act(() => { vi.advanceTimersByTime(SLOW_SAVE_NOTICE_MS - 1); });
            expect(screen.queryByTestId('save-running')).toBeNull();
            act(() => { vi.advanceTimersByTime(1); });
            expect(screen.getByTestId('save-running').textContent).toBe('Still checking… Checking the model is taking longer than usual.');
            cleanup();
            // a Relation model: the same words (nothing is fitted again for files any more)
            mount({ kind: 'relationship', sp: REL_VALID, save: { phase: 'running' } });
            expect(screen.queryByTestId('save-running')).toBeNull();
            act(() => { vi.advanceTimersByTime(SLOW_SAVE_NOTICE_MS); });
            expect(screen.getByTestId('save-running').textContent).toBe('Still checking… Checking the model is taking longer than usual.');
            expect(screen.getByTestId('save-running').textContent).not.toMatch(/15 seconds|files/);
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
        const rejected: HealthPreview = { ...d, valid: false, hourly: { ...d.hourly, score: null } as any, score_summary: null, validation: [{ code: 'ordering', field: 'lower', severity: 'error', message: 'Rust says no' }] };
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
        expect(screen.getByTestId('score-locked').textContent).toBe('Score not availableNot available until the health score loads.');
        expect(screen.getByTestId('score-locked').dataset.lock).toBe('error');
        expect(field('sp-lower').className).not.toMatch(/hs-num--err|hs-num--req/);
    });

    // Workbench detail pages v2 §6 "Preview failed": the ruler never draws an unchecked point as valid.
    it('the ruler draws the user\'s ticks as "not checked": grey and dashed, no score colour, no marker — even for a value the old answer accepted', () => {
        mount({ sp: IND_VALID, preview: failed(null, previewFor('individual', IND_VALID)), onRetryPreview: onRetry });
        for (const key of ['lower', 'upper']) {
            expect(rulerPart('tick', key).dataset.state).toBe('unchecked');
            expect(rulerPart('tick', key).className).toMatch(/wb3-ruler-tick--unk/);
            expect(rulerPart('tick', key).className).not.toMatch(/wb3-ruler-tick--(bad|req)/);
            expect(rulerPart('name', key).className).not.toMatch(/wb3-ruler-nm--(bad|req)/);
        }
        // the program's own ticks are still what the last answer said
        expect(rulerPart('tick', 'm3sd').dataset.state).toBeUndefined();
        expect(rulerScores()).toEqual(['0', '80', '100', '100', '80', '0']);
        const scores = [...ruler().querySelectorAll('.wb3-ruler-scores > span')];
        expect(scores[0].className).toMatch(/wb3-ruler-sc--off/);
        expect(scores[5].className).toMatch(/wb3-ruler-sc--off/);
        expect(scores[1].className).not.toMatch(/wb3-ruler-sc--off/);
        // the band's two ends carry no score colour
        const band = screen.getByTestId('ruler-band').style.background;
        expect(band.startsWith('linear-gradient(90deg, color-mix(in srgb, var(--text-secondary) 35%, transparent) 0%')).toBe(true);
        expect(band).not.toMatch(/var\(--danger\)/);
        expect(markers()).toHaveLength(0);
        // the inputs still point at the Checks, which say why
        expect(document.getElementById(input('sp-lower').getAttribute('aria-describedby')!)!.contains(screen.getByTestId('checks-unavailable'))).toBe(true);
        // a value typed under the red card is not judged either
        type('sp-lower', '3');
        expect(markers()).toHaveLength(0);
        expect(rulerPart('tick', 'lower').dataset.state).toBe('unchecked');
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
    it('the four Relationship inputs have four DISTINCT accessible names, each starting with the ONE name of its point ("0 low" … "0 high")', () => {
        mount({ kind: 'relationship', sp: REL_VALID });
        const ids = ['sp-residual_at_0_lower', 'sp-residual_at_80_lower', 'sp-residual_at_80_upper', 'sp-residual_at_0_upper'];
        const names = ids.map(id => input(id).getAttribute('aria-label'));
        expect(new Set(names).size).toBe(4);
        expect(names).toEqual([
            '0 low — the residual where the score reaches 0 on the low side',
            '80 low — the residual where the score is 80 on the low side',
            '80 high — the residual where the score is 80 on the high side',
            '0 high — the residual where the score reaches 0 on the high side',
        ]);
        for (const [i, id] of ids.entries()) expect(screen.getByLabelText(names[i]!)).toBe(input(id));
        // the same names under the band — and the old "Lower / Upper" column heads are gone
        expect(rulerNames().filter((_, i) => [0, 1, 5, 6].includes(i))).toEqual(['0 low', '80 low', '80 high', '0 high']);
        expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
        expect(screen.getByRole('group', { name: 'Health set points on the score ruler' })).toBe(ruler());
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
        // `lowest_at` = the START of the hour with the lowest hourly score, as Rust labels an hour.
        test_validation: makeValidation({ tests: [makeTestResult({ pct_below_80: 7, lowest: 62, lowest_at: '2026-01-01T02:00:00' }), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00', pct_below_80: 41.5, lowest: 12, lowest_at: '2026-01-01T03:00:00' })] }),
    });

    // User decision 2026-10-12: only the TRAIN period is highlighted — a scoring period has no band, no frame, no name.
    it('the set-point chart and the score chart both highlight the TRAIN period only — one band, no "S1" / "S2", no EVENT line, no hatch; it is NAMED once, above the upper chart', () => {
        mount({ sp: IND_VALID, data: withTests('individual', IND_VALID) });
        const names = (c: any) => c.option.series.map((x: any) => x.name);
        expect(names(scoreChart())).toContain('__scopes');
        expect(names(setChart())).toContain('__scopes');
        for (const chart of [scoreChart(), setChart()]) {
            const carrier = chart.option.series.find((x: any) => x.name === '__scopes');
            expect(carrier.markLine).toBeUndefined();
            expect(carrier.markPoint).toBeUndefined();
            // the name is printed above the UPPER chart only: the lower one is the same time axis
            expect(stripOf(chart)).toEqual(chart === setChart() ? ['TRAIN'] : []);
            expect(bandsOf(chart)).toEqual(['TRAIN']);
            expect(carrier.markArea.data[0][0].itemStyle.borderType).toBeUndefined(); // no dashed frame
            expect(JSON.stringify(carrier)).not.toMatch(/EVENT|KNOWN|NORMAL|PROBLEM|data:image|S1|S2/);
            // the names are in the strip ABOVE the plot — no pill inside it
            for (const a of carrier.markArea.data) {
                expect(a[0].label.position).toBe('top');
                expect(a[0].label.backgroundColor).toBeUndefined();
            }
        }
    });

    // The fixture: hourly points 00:00 … 04:00; TRAIN 00:00–01:30, S1 02:00–03:00, S2 03:00–04:00.
    it('the hours of the scoring periods are still drawn on both charts, exactly as before: one cut (TRAIN → S1), none inside or between the scoring periods', () => {
        mount({ sp: IND_VALID, data: withTests('individual', IND_VALID) });
        for (const chart of [scoreChart(), setChart()]) {
            const data = chart.option.series[0].data as [number, number | null][];
            // every hourly point is on the line — 02:00, 03:00 and 04:00 are the scoring periods' own
            expect(data.filter(p => p[1] !== null).map(p => p[0])).toEqual([0, 1, 2, 3, 4].map(hourAt));
            // cut once, between 01:00 and 02:00 (no period covers 01:30–02:00). Cut from the train period alone it
            // would be three cuts, and 02:00 / 03:00 / 04:00 would each stand apart, not drawn by a symbol-less line.
            expect(data.filter(p => p[1] === null).map(p => p[0])).toEqual([(hourAt(1) + hourAt(2)) / 2]);
            const i = data.findIndex(p => p[0] === hourAt(2));
            expect(data.slice(i).map(p => p[0])).toEqual([2, 3, 4].map(hourAt)); // joined to the end
        }
        expect((scoreChart().option.series[0].data as [number, number | null][]).filter(p => p[1] !== null).map(p => p[1])).toEqual([100, 90, 80, 60, 30]);
        // ... and there are no per-period tiles any more (the "Scoring results" card was removed)
        expect(screen.queryByTestId('test-results')).toBeNull();
    });

    it('Clustering has no time chart of its own: the strip is on the SCORE chart, not on the scatter', () => {
        const sp = { kind: 'clustering', outerSd: 5 } as const;
        const data: HealthPreview = { ...previewFor('clustering', sp), test_validation: makeValidation({ tests: [makeTestResult(), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00' })] }) };
        mount({ kind: 'clustering', sp, data });
        expect(stripOf(scoreChart())).toEqual(['TRAIN']);
        expect(bandsOf(scoreChart())).toEqual(['TRAIN']);
        expect(stripOf(setChart())).toEqual([]);
        expect(setChart().option.series.map((x: any) => x.name)).not.toContain('__scopes');
    });

    it('no scopes without scoring periods', () => {
        mount({ sp: IND_VALID });
        expect(scoreChart().option.series.map((x: any) => x.name)).not.toContain('__scopes');
    });

    // Many periods printed "TRAIN P1" … "TRAIN P20" on each other.
    it('several train periods: "TRAIN" once then numbers, above the upper chart; no scoring name among them; every band is on both charts', () => {
        const hhmm = (m: number) => `2026-01-01T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        // 16 short train periods over the 4 hours of data
        const train_ranges = Array.from({ length: 16 }, (_, i) => ({ start: hhmm(i * 15), end: hhmm(i * 15 + 12) }));
        const data: HealthPreview = { ...previewFor('individual', IND_VALID), test_validation: makeValidation({ train_ranges, tests: [makeTestResult(), makeTestResult({ index: 2 })] }) };
        mount({ sp: IND_VALID, data });
        const set = stripOf(setChart());
        expect(set[0]).toBe('TRAIN P1');
        expect(set.filter(n => /TRAIN/.test(n))).toHaveLength(1);
        // the two scoring periods are not named
        expect(set.some(n => /^S\d/.test(n))).toBe(false);
        // the lower chart names nothing: the strip above the upper plot serves both
        expect(stripOf(scoreChart())).toEqual([]);
        // every TRAIN band is drawn on both charts (only names are left out) — and no band for S1 / S2
        for (const chart of [scoreChart(), setChart()]) {
            expect(bandsOf(chart)).toEqual(Array.from({ length: 16 }, (_, i) => `TRAIN P${i + 1}`));
        }
        const trainNames = (names: string[]) => names.filter(n => /P\d/.test(n)).length;
        expect(trainNames(set)).toBeLessThan(16); // 16 names do not fit
        expect(trainNames(set)).toBeGreaterThanOrEqual(3);
    });

    // User decision 2026-10-12 (real app): "the scoring result is not needed — not used".
    it('there is NO "Scoring results" card: no per-period tiles, no quiet line, whatever the state of the set points', () => {
        mount({ sp: IND_VALID, data: withTests('individual', IND_VALID) });
        const page = screen.getByTestId('health-page');
        expect(screen.queryByTestId('test-results')).toBeNull();
        expect(page.querySelector('.vt-tile, .vt-note, .vt-quiet, .vt-none')).toBeNull();
        expect(page.textContent).not.toMatch(/Scoring results|for reading only|of running hours below 80/);
        // what the page still says about the score: the three KPI tiles, for ALL scored hours — and
        // never a tile per scoring period (S1, S2 …), nor a "no scoring period" one
        expect([...kpis().children].map(t => t.querySelector('.wb3-kpi-l')!.textContent)).toEqual(['Lowest score', 'Below 80', 'Share of scored hours']);
        expect(kpis().textContent).toMatch(/^Lowest score\d+on .* · 1 h averageBelow 80.*%of \d+ scored hours/);
        expect(page.textContent).not.toMatch(/\bS1\b|\bS2\b|includes \d+ d of train time|no scoring period/i);
        cleanup();
        mount({ kind: 'relationship', sp: REL_EMPTY, data: { ...withTests('relationship', REL_EMPTY) } });
        expect(screen.queryByTestId('test-results')).toBeNull();
        expect(screen.queryByTestId('test-results-pending')).toBeNull();
        expect(screen.getByTestId('score-locked')).toBeTruthy(); // "Set every point on the ruler above" says it
        expect(kpis().children).toHaveLength(3); // locked too: the same three tiles, nothing per period
    });

    it('the chart strip names the train period only, whatever the scoring periods\' numbers', () => {
        const data: HealthPreview = { ...previewFor('individual', IND_VALID), test_validation: makeValidation({ tests: [makeTestResult({ index: 1 })] }) };
        mount({ sp: IND_VALID, data, testNumbers: [2] });
        expect(screen.queryByTestId('test-result-2')).toBeNull();
        expect(stripOf(setChart())).toEqual(['TRAIN']);
        expect(bandsOf(scoreChart())).toEqual(['TRAIN']);
        expect(stripOf(scoreChart())).toEqual([]);
    });

    it('test_scoring_failed while some hours WERE scored -> the amber notice (with "Try again" = the preview Retry) in its own card, said once, and the score chart still follows it', () => {
        const onRetryPreview = vi.fn();
        const data: HealthPreview = {
            ...previewFor('relationship', REL_VALID),
            validation: [{ code: 'test_scoring_failed', severity: 'warning', field: 'test_periods', message: 'The Relation model engine did not answer.' }],
            test_validation: makeValidation({ tests: [makeTestResult({ scored: 0, pct_below_80: null, lowest: null })] }),
        };
        mount({ kind: 'relationship', sp: REL_VALID, data, onRetryPreview });
        expect(screen.getByTestId('test-scoring-failed').textContent).toContain('The health score could not be calculated — try again');
        expect(screen.getAllByTestId('test-scoring-failed')).toHaveLength(1); // said once
        expect(screen.getByTestId('test-scoring-failed').closest('[data-testid="score-failed"]')).not.toBeNull();
        expect(screen.queryByTestId('test-results')).toBeNull();
        expect(scoreChart()).toBeTruthy(); // the hours that were scored are still drawn
        expect(screen.getByTestId('score-failed').compareDocumentPosition(screen.getByTestId('chart-card-score')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        fireEvent.click(screen.getByTestId('test-scoring-retry'));
        expect(onRetryPreview).toHaveBeenCalledTimes(1);
    });

    // The Relation model's TRAINING hours need the engine too, so the warning can come with no
    // scored hour at all — the notice then stands in the score card's place.
    describe('"The health score could not be calculated" with NO scoring period: the notice takes the score card\'s place', () => {
        const failedIssue = { code: 'test_scoring_failed', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine did not answer.' };
        /** What Rust sends then: set points valid, every hourly score null, nothing scored. */
        const noScore = (over: Partial<HealthPreview> = {}): HealthPreview => {
            const d = previewFor('relationship', REL_VALID);
            return {
                ...d,
                hourly: { ...d.hourly, score: [null, null, null, null, null] } as any,
                score_summary: { ...d.score_summary!, scored: 0, unscored: 5, min_score: null, pct_below_80: null, share_80_100: null, share_40_80: null, share_0_40: null },
                validation: [failedIssue],
                ...over,
            };
        };

        it('no test_validation: the notice (with its Try again) is in the LOWER HALF of the chart card, where the score chart would be — no empty score chart, no lock sentence, no Scoring results card', () => {
            const onRetryPreview = vi.fn();
            mount({ kind: 'relationship', sp: REL_VALID, data: noScore(), onRetryPreview });
            const card = screen.getByTestId('score-failed');
            expect(card.className).toBe('wb3-stack-bot wb3-stack-bot--lock'); // the score chart's own place: not a new banner
            expect([...screen.getByTestId('chart-stack').children]).toEqual([screen.getByTestId('chart-card-set-relationship'), card]);
            expect(screen.getAllByTestId('score-failed')).toHaveLength(1);
            // the residual chart above it is alone, so it keeps its own time labels
            expect(setChart().option.xAxis.axisLabel.show).not.toBe(false);
            const notice = within(card).getByTestId('test-scoring-failed');
            expect(notice.querySelector('b')!.textContent).toBe('The health score could not be calculated — try again');
            expect(notice.textContent).toContain('The Relation model engine did not answer.');
            expect(screen.queryByTestId('test-results')).toBeNull();
            expect(screen.queryByTestId('score-locked')).toBeNull();
            expect(screen.queryByTestId('chart-card-score')).toBeNull();
            expect(scoreChart()).toBeUndefined();
            // the set points are valid: Checks says so and never lists this warning
            expect(screen.getByTestId('check-valid')).toBeTruthy();
            expect(screen.queryByTestId('check-line')).toBeNull();
            fireEvent.click(within(card).getByTestId('test-scoring-retry'));
            expect(onRetryPreview).toHaveBeenCalledTimes(1);
        });

        it('the retry is onRetryTestScoring when the window gives one', () => {
            const onRetryPreview = vi.fn();
            const onRetryTestScoring = vi.fn();
            mount({ kind: 'relationship', sp: REL_VALID, data: noScore(), onRetryPreview, onRetryTestScoring });
            fireEvent.click(screen.getByTestId('test-scoring-retry'));
            expect(onRetryTestScoring).toHaveBeenCalledTimes(1);
            expect(onRetryPreview).not.toHaveBeenCalled();
        });

        it('with an empty list of scoring periods: the same — the notice once, in the score card\'s place, and no "No scoring period." card', () => {
            mount({ kind: 'relationship', sp: REL_VALID, data: noScore({ test_validation: makeValidation({ tests: [] }) }) });
            expect(screen.queryByTestId('test-results-empty')).toBeNull();
            expect(screen.queryByTestId('chart-card-score')).toBeNull();
            expect(screen.getAllByTestId('test-scoring-failed')).toHaveLength(1);
            expect(screen.getByTestId('test-scoring-failed').closest('[data-testid="score-failed"]')).not.toBeNull();
        });

        it('test_scoring_outdated with no scoring period: the same place, the headline without "try again" and no button', () => {
            const outdated = { code: 'test_scoring_outdated', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine in this build is out of date - reinstall or update the app.' };
            mount({ kind: 'relationship', sp: REL_VALID, data: noScore({ validation: [outdated] }), onRetryPreview: vi.fn() });
            const notice = within(screen.getByTestId('score-failed')).getByTestId('test-scoring-failed');
            expect(notice.querySelector('b')!.textContent).toBe('The health score could not be calculated');
            expect(notice.textContent).toContain('out of date');
            expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
        });

        it('it shows even while the set points are still empty (the notice does not wait for them)', () => {
            const d = previewFor('relationship', REL_EMPTY);
            mount({ kind: 'relationship', sp: REL_EMPTY, data: { ...d, validation: [...d.validation, failedIssue] } });
            expect(within(screen.getByTestId('score-failed')).getByTestId('test-scoring-failed')).toBeTruthy();
            expect(screen.queryByTestId('score-locked')).toBeNull();
        });

        it('without the warning nothing changes: the score chart, or the locked card', () => {
            mount({ kind: 'relationship', sp: REL_VALID });
            expect(screen.queryByTestId('score-failed')).toBeNull();
            expect(screen.queryByTestId('test-scoring-failed')).toBeNull();
            expect(screen.getByTestId('chart-card-score')).toBeTruthy();
            cleanup();
            mount({ kind: 'relationship', sp: REL_EMPTY });
            expect(screen.queryByTestId('score-failed')).toBeNull();
            expect(screen.getByTestId('score-locked')).toBeTruthy();
        });

        it('while the request failed and an OLD answer is on screen, that answer\'s warning is not repeated: the card says "Score not available"', () => {
            const failed = { data: null, lastData: noScore(), loading: false, error: 'boom', errorCode: null, notFitted: false, needsRetrain: false, idle: null as null, retry: vi.fn() };
            mount({ kind: 'relationship', sp: REL_VALID, preview: failed });
            expect(screen.queryByTestId('score-failed')).toBeNull();
            expect(screen.getByTestId('score-locked').textContent).toMatch(/Score not available/);
        });
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

    it('the "Calculating the health score … ~15 s" hint shows when the container says so', () => {
        mount({ sp: IND_VALID, slowScoring: true });
        expect(screen.getByTestId('slow-test-scoring').textContent).toBe('Calculating the health score with the Relation model — this can take up to ~15 s.');
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
