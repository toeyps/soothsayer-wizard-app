import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PeriodCoverageBar, TrainHighlightWarnings } from '../components/windows/RunningConditionParts';
import type { TimeHighlight } from '../types';

afterEach(cleanup);

const B = { min: '2025-01-01 00:00:00', max: '2026-03-31 23:50:00' };
const p = (id: string, start: string, end: string) => ({ id, start, end });
const P3 = [
    p('a', '2025-01-01T00:00', '2025-02-28T23:59'),
    p('b', '2025-06-01T00:00', '2025-07-31T23:59'),
    p('c', '2025-11-03T06:00', '2025-12-19T18:00'),
];

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

describe('TrainHighlightWarnings (one amber line under the train rows)', () => {
    const train = [p('a', '2026-01-01T00:00', '2026-03-31T23:59')];
    const hl = (over: Partial<TimeHighlight> = {}): TimeHighlight =>
        ({ id: 'h1', label: 'Trip', start: '2026-02-10T00:00', end: '2026-02-12T00:00', color: '#f00', enabled: true, ...over } as TimeHighlight);

    it('names the train period and the highlight, with "Remove the overlap" as an inline link (no box, no button chrome)', () => {
        const onPeriodsChange = vi.fn();
        render(<TrainHighlightWarnings periods={train} highlights={[hl()]} onPeriodsChange={onPeriodsChange} />);
        const line = screen.getByTestId('train-hl-warning');
        expect(line.className).toBe('tpe-hlwarn');
        expect(line.getAttribute('role')).toBe('status');
        expect(line.textContent).toBe('Train P1 overlaps the highlight “Trip” — if something was wrong at that time, leave it out.Remove the overlap');
        const fix = screen.getByTestId('train-hl-split');
        expect(fix.className).toBe('f4-link');
        fireEvent.click(fix);
        // the highlight's time is cut out of the train period: two periods around it
        const next = onPeriodsChange.mock.calls[0][0] as { start: string; end: string }[];
        expect(next).toHaveLength(2);
        expect(next[0].start).toBe('2026-01-01T00:00');
        expect(next[1].end).toBe('2026-03-31T23:59');
    });

    it('nothing when no train period overlaps a highlight, or the highlight is switched off', () => {
        const { container, rerender } = render(<TrainHighlightWarnings periods={train} highlights={[hl({ start: '2026-05-01T00:00', end: '2026-05-02T00:00' })]} onPeriodsChange={vi.fn()} />);
        expect(container.textContent).toBe('');
        rerender(<TrainHighlightWarnings periods={train} highlights={[hl({ enabled: false })]} onPeriodsChange={vi.fn()} />);
        expect(container.textContent).toBe('');
    });
});
