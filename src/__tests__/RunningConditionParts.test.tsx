import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PeriodChipsLine, PeriodCoverageBar, RuleFormula } from '../components/windows/RunningConditionParts';
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

describe('RuleFormula', () => {
    it('renders the mockup sentence with OR / AND as chips (periods OR, conditions AND)', () => {
        const { container } = render(<RuleFormula periods={P3} filters={[f('I_MOT_A', 'greater_than', '12'), f('PT_2041', 'greater_than', '2.4')]} combine="and" none={false} />);
        const box = screen.getByTestId('rule-formula');
        expect(box.textContent).toBe('Row is used when ( P1ORP2ORP3 ) AND ( I_MOT_A > 12ANDPT_2041 > 2.4 )'); // chips carry their own margin, no spaces
        const chips = Array.from(container.querySelectorAll('.f4-op')).map(c => c.textContent);
        expect(chips).toEqual(['OR', 'OR', 'AND', 'AND']); // 2 between 3 periods, the outer AND, 1 between 2 conditions
        expect(container.querySelectorAll('.f4-op--or')).toHaveLength(2); // only the period ORs are blue
        expect(Array.from(container.querySelectorAll('b')).map(b => b.textContent)).toEqual(['P1', 'P2', 'P3', 'I_MOT_A > 12', 'PT_2041 > 2.4']);
    });

    it('Match OR: the condition joiner reads OR (not blue)', () => {
        const { container } = render(<RuleFormula periods={[]} filters={[f('A', 'greater_than', '1'), f('B', 'less_than', '2')]} combine="or" none={false} />);
        expect(Array.from(container.querySelectorAll('.f4-op')).map(c => c.textContent)).toEqual(['AND', 'OR']);
        expect(container.querySelectorAll('.f4-op--or')).toHaveLength(0);
    });

    it('no periods reads "any time"; none reads "no condition (every row)"; empty reads "no condition yet"', () => {
        const { rerender } = render(<RuleFormula periods={[]} filters={[]} combine="and" none />);
        expect(screen.getByTestId('rule-formula').textContent).toContain('any time');
        expect(screen.getByTestId('rule-formula').textContent).toContain('no condition (every row)');
        rerender(<RuleFormula periods={[]} filters={[]} combine="and" none={false} />);
        expect(screen.getByTestId('rule-formula').textContent).toContain('no condition yet');
    });

    it('compact variant is the smaller sidebar size', () => {
        render(<RuleFormula compact periods={[]} filters={[]} combine="and" none />);
        expect(screen.getByTestId('rule-formula').className).toContain('f4-formula--compact');
    });
});

describe('PeriodChipsLine (collapsed panel header)', () => {
    it('first two periods as chips and "+N more"', () => {
        render(<PeriodChipsLine periods={P3} />);
        expect(screen.getAllByTestId('period-chip').map(c => c.textContent)).toEqual(['1 Jan – 28 Feb 2025', '1 Jun – 31 Jul 2025']);
        expect(screen.getByTestId('period-chips-more').textContent).toBe('+1 more');
    });

    it('all fit: no "+N more"; open-ended periods get the dashed variant; invalid ones are skipped', () => {
        render(<PeriodChipsLine periods={[p('a', '', '2025-02-28T23:59'), p('b', '2025-06-01T00:00', '2025-05-20T23:59')]} />);
        const chips = screen.getAllByTestId('period-chip');
        expect(chips).toHaveLength(1);
        expect(chips[0].className).toContain('f4-pchip--open');
        expect(screen.queryByTestId('period-chips-more')).toBeNull();
    });

    it('renders nothing when there is no valid period', () => {
        const { container } = render(<PeriodChipsLine periods={[]} />);
        expect(container.firstChild).toBeNull();
    });
});
