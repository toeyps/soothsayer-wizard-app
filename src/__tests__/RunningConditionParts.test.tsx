import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PeriodCoverageBar, RuleSentence } from '../components/windows/RunningConditionParts';
import type { WorkspaceSensorFilter } from '../types';

afterEach(cleanup);

const B = { min: '2025-01-01 00:00:00', max: '2026-03-31 23:50:00' };
const p = (id: string, start: string, end: string) => ({ id, start, end });
const P3 = [
    p('a', '2025-01-01T00:00', '2025-02-28T23:59'),
    p('b', '2025-06-01T00:00', '2025-07-31T23:59'),
    p('c', '2025-11-03T06:00', '2025-12-19T18:00'),
];
const f = (sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string): WorkspaceSensorFilter =>
    ({ id: `f-${sensor}`, sensor, operation, value1, value2: '' });

describe('PeriodCoverageBar', () => {
    it('shows the mockup caption "166 of 455 days used" between Jan 2025 and Mar 2026, one block per period', () => {
        const { container } = render(<PeriodCoverageBar periods={P3} bounds={B} />);
        expect(screen.getByTestId('period-coverage-days').textContent).toBe('166 of 455 days used');
        const axis = container.querySelector('.f4-strip-ax')!;
        expect(axis.firstElementChild!.textContent).toBe('Jan 2025');
        expect(axis.lastElementChild!.textContent).toBe('Mar 2026');
        expect(container.querySelectorAll('.f4-strip i')).toHaveLength(3);
        expect(container.querySelector('.f4-strip')!.getAttribute('role')).toBe('img');
    });

    it('block geometry is a percentage of the dataset; each block carries its label as a tooltip', () => {
        const { container } = render(<PeriodCoverageBar periods={[P3[0]]} bounds={B} />);
        const block = container.querySelector('.f4-strip i') as HTMLElement;
        expect(block.style.left).toBe('0%'); // jsdom normalises 0.00% -> 0%
        expect(parseFloat(block.style.width)).toBeCloseTo(12.97, 1); // 59 / 455
        expect(block.title).toBe('1 Jan – 28 Feb 2025');
    });

    it('empty list: a full-width block and "all N days"', () => {
        const { container } = render(<PeriodCoverageBar periods={[]} bounds={B} />);
        expect(screen.getByTestId('period-coverage-days').textContent).toBe('all 455 days');
        expect((container.querySelector('.f4-strip i') as HTMLElement).style.width).toBe('100%');
    });

    it('renders nothing without dataset bounds', () => {
        const { container } = render(<PeriodCoverageBar periods={P3} bounds={null} />);
        expect(container.firstChild).toBeNull();
    });

    it('overlap and invalid blocks use the warning / danger classes', () => {
        const { container } = render(<PeriodCoverageBar
            periods={[p('a', '2025-01-01T00:00', '2025-02-28T23:59'), p('b', '2025-02-15T00:00', '2025-03-31T23:59'), p('c', '2025-06-01T00:00', '2025-05-20T23:59')]}
            bounds={B}
        />);
        expect(container.querySelectorAll('.f4-strip i.ovl')).toHaveLength(1);
        expect(container.querySelectorAll('.f4-strip i.bad')).toHaveLength(1);
    });
});

describe('RuleSentence (settings modal summary)', () => {
    const desc = (t: string) => ({ I_MOT_A: 'Motor current', PT_2041: 'Pump pressure' } as Record<string, string>)[t] ?? '';
    const unit = (t: string) => ({ I_MOT_A: 'A', PT_2041: 'bar' } as Record<string, string>)[t] ?? '';
    const two = [
        p('a', '2026-01-01T00:00', '2026-03-31T23:59'),
        p('b', '2026-04-15T00:00', ''),
    ];

    it('"Train on rows inside <dates> OR <dates> AND <conditions>" with readable dates, names and units', () => {
        const { container } = render(
            <RuleSentence periods={two} filters={[f('I_MOT_A', 'greater_than', '12'), f('PT_2041', 'less_than', '2.4')]} combine="and" none={false} getLabel={desc} getUnit={unit} />,
        );
        const box = screen.getByTestId('rule-sentence');
        expect(box.className).toContain('rcm-sentence');
        expect(box.textContent).toBe('Train on rows inside 1 Jan 2026 → 31 Mar 2026OR15 Apr 2026 → EndANDMotor current > 12 AANDPump pressure < 2.4 bar');
        expect(Array.from(container.querySelectorAll('.f4-op')).map(c => c.textContent)).toEqual(['OR', 'AND', 'AND']);
        expect(container.querySelectorAll('.f4-op--or')).toHaveLength(1); // only the period OR is blue
    });

    it('Match OR joins the conditions with OR', () => {
        const { container } = render(
            <RuleSentence periods={[two[0]]} filters={[f('I_MOT_A', 'greater_than', '12'), f('PT_2041', 'greater_than', '2')]} combine="or" none={false} getLabel={desc} getUnit={unit} />,
        );
        expect(Array.from(container.querySelectorAll('.f4-op')).map(c => c.textContent)).toEqual(['AND', 'OR']);
    });

    it('no train period = "No train period — add one" in amber (Train/Test validation: never "any time" / the whole dataset)', () => {
        render(<RuleSentence periods={[]} filters={[f('I_MOT_A', 'greater_than', '12')]} combine="and" none={false} getLabel={desc} getUnit={unit} />);
        const box = screen.getByTestId('rule-sentence');
        expect(box.textContent).toBe('No train period — add one; models learn only from the train periods.');
        expect(screen.getByTestId('rule-no-train').className).toContain('rcm-sentence-miss');
        expect(box.textContent).not.toContain('any time');
    });

    it('use-all-rows = "every row (no condition)"; nothing set = "not set yet" (amber)', () => {
        const { rerender, container } = render(<RuleSentence periods={[two[0]]} filters={[]} combine="and" none getLabel={desc} getUnit={unit} />);
        expect(screen.getByTestId('rule-sentence').textContent).toContain('every row (no condition)');
        rerender(<RuleSentence periods={[two[0]]} filters={[]} combine="and" none={false} getLabel={desc} getUnit={unit} />);
        expect(screen.getByTestId('rule-sentence').textContent).toContain('not set yet');
        expect(container.querySelector('.rcm-sentence-miss')).not.toBeNull();
    });

    it('invalid periods and conditions the build would not apply (incomplete / sensor missing from the dataset) are left out', () => {
        render(
            <RuleSentence
                periods={[two[0], p('x', '2026-06-01T00:00', '2026-05-20T23:59')]}
                filters={[f('I_MOT_A', 'greater_than', '12'), f('PT_2041', 'greater_than', ''), f('GONE', 'greater_than', '3')]}
                combine="and" none={false} headers={['I_MOT_A', 'PT_2041']} getLabel={desc} getUnit={unit}
            />,
        );
        const t = screen.getByTestId('rule-sentence').textContent!;
        expect(t).toContain('1 Jan 2026 → 31 Mar 2026');
        expect(t).not.toContain('2026-06-01');
        expect(t).toContain('Motor current > 12 A');
        expect(t).not.toContain('Pump pressure');
        expect(t).not.toContain('GONE');
    });

    it('a sensor without a description falls back to its tag; between shows both bounds', () => {
        render(<RuleSentence periods={[two[0]]} filters={[{ ...f('X_TAG', 'between', '1'), value2: '5' }]} combine="and" none={false} getLabel={desc} getUnit={unit} />);
        expect(screen.getByTestId('rule-sentence').textContent).toContain('X_TAG between 1–5');
    });
});

describe('PeriodCoverageBar with scoring periods (two lanes)', () => {
    const B2 = { min: '2026-01-01 00:00:00', max: '2026-12-31 23:50:00' };
    const train = [p('a', '2026-01-01T00:00', '2026-03-31T23:59')];

    it('train on the top lane, scoring periods on the bottom lane, caption "N d train · M d scoring"', () => {
        const { container } = render(<PeriodCoverageBar periods={train} bounds={B2} tests={[
            { id: 't1', start: '2026-01-01T00:00', end: '2026-12-31T23:50' },
            { id: 't2', start: '2026-06-01T00:00', end: '2026-06-10T00:00' },
        ]} />);
        const strip = container.querySelector('.f4-strip')!;
        expect(strip.className).toContain('f4-strip--tt');
        expect(strip.getAttribute('aria-label')).toBe('Train periods (top lane) and scoring periods (bottom lane) on the dataset timeline');
        expect(strip.querySelectorAll('i:not(.te)')).toHaveLength(1);
        const te = screen.getAllByTestId('period-coverage-test');
        expect(te.map(x => x.className)).toEqual(['te', 'te']);
        expect(te.map(x => x.getAttribute('title'))).toEqual(['S1 · 1 Jan 2026 00:00 – 31 Dec 2026 23:50', 'S2 · 1 Jun 2026 00:00 – 10 Jun 2026 00:00']);
        // the scoring periods overlap each other: their days are counted once
        expect(screen.getByTestId('period-coverage-days').textContent).toBe('90 d train · 365 d scoring');
    });

    it('a period saved before 2026-10-10 (label / event time) is drawn like any other: plain block, "S#" tooltip, no hatch', () => {
        render(<PeriodCoverageBar periods={train} bounds={B2} tests={[
            { id: 't1', start: '2026-05-01T00:00', end: '2026-05-10T00:00', label: 'normal' },
            { id: 't2', start: '2026-06-01T00:00', end: '2026-06-10T00:00', label: 'problem', eventTime: '2026-06-05T00:00', fromHighlight: 'Bearing trip' },
        ]} />);
        const te = screen.getAllByTestId('period-coverage-test');
        expect(te.map(x => x.className)).toEqual(['te', 'te']);
        for (const x of te) expect(x.getAttribute('title')).not.toMatch(/Known problem|Normal|event|Bearing/i);
        expect(te[1].getAttribute('title')).toMatch(/^S2 · /);
    });

    it('no train period: an EMPTY top lane and "0 d train" — never the whole dataset', () => {
        const { container } = render(<PeriodCoverageBar periods={[]} bounds={B2} tests={[]} />);
        expect(container.querySelectorAll('.f4-strip i')).toHaveLength(0);
        expect(screen.getByTestId('period-coverage-days').textContent).toBe('0 d train · 0 d scoring');
    });

    it('without the tests prop it is the old single-lane bar', () => {
        const { container } = render(<PeriodCoverageBar periods={train} bounds={B2} />);
        expect(container.querySelector('.f4-strip--tt')).toBeNull();
        expect(screen.getByTestId('period-coverage-days').textContent).toBe('90 of 365 days used');
    });
});
