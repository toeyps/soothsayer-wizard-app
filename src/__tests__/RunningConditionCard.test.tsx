import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { RunningConditionCard } from '../components/windows/RunningConditionCard';
import type { RowCountPreview } from '../components/windows/useRowCountPreview';
import type { WorkspaceSensorFilter } from '../types';

afterEach(cleanup);

const p = (id: string, start: string, end: string) => ({ id, start, end });
const f = (id: string, sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, value2 = ''): WorkspaceSensorFilter =>
    ({ id, sensor, operation, value1, value2 });
const DESC: Record<string, string> = { POWER: 'GENERATOR ACTIVE POWER', SPEED: 'TURBINE SPEED' };
const UNIT: Record<string, string> = { POWER: 'kW', SPEED: 'RPM' };
const OK: RowCountPreview = { status: 'ok', used: 11_066, total: 52_340 };

function card(over: Partial<React.ComponentProps<typeof RunningConditionCard>> = {}) {
    const onOpen = vi.fn();
    render(
        <RunningConditionCard
            state="set"
            periods={[p('a', '2026-01-01T00:00', '2026-03-31T23:59'), p('b', '2026-04-15T00:00', '')]}
            filters={[f('f1', 'POWER', 'greater_than', '4000')]}
            combine="and"
            noneConfirmed={false}
            headers={['POWER', 'SPEED']}
            getDesc={t => DESC[t] ?? ''}
            getUnit={t => UNIT[t] ?? ''}
            rows={OK}
            onOpen={onOpen}
            {...over}
        />,
    );
    return onOpen;
}

describe('RunningConditionCard — Not set', () => {
    it('big yellow card: number 1, "Set the running condition", the one-sentence reason, a primary "Set running condition →" button', () => {
        const onOpen = card({ state: 'unset', periods: [], filters: [] });
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-state')).toBe('unset');
        expect(c.className).toContain('rcc-card--req');
        expect(c.querySelector('.rcc-num')!.textContent).toBe('1');
        expect(c.textContent).toContain('Step 1 · Required before training');
        expect(within(c).getByRole('heading', { name: 'Set the running condition' })).toBeTruthy();
        expect(c.textContent).toContain('Tell Wizard when the plant is running');
        const btn = screen.getByTestId('rc-card-open');
        expect(btn.textContent).toBe('Set running condition →');
        expect(btn.className).toContain('rcx-btn--pri');
        fireEvent.click(btn);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('shows neither the chips nor the row count', () => {
        card({ state: 'unset', periods: [], filters: [] });
        expect(screen.queryByTestId('rc-card-time')).toBeNull();
        expect(screen.queryByTestId('rc-card-use')).toBeNull();
    });
});

describe('RunningConditionCard — Invalid period', () => {
    const bad = [p('a', '2026-01-01T00:00', '2026-03-31T23:59'), p('x', '2026-05-30T00:00', '2026-04-10T23:59')];

    it('red card: "Period N needs fixing", the validatePeriods reason, the period chips (broken one flagged) and a "Fix period" button', () => {
        const onOpen = card({ state: 'invalid', periods: bad });
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-state')).toBe('invalid');
        expect(c.className).toContain('rcc-card--bad');
        expect(screen.getByTestId('rc-card-title').textContent).toBe('Period 2 needs fixing');
        expect(screen.getByTestId('rc-card-reason').textContent).toBe("Period 2 ends before it starts. Models can't be trained until it's fixed.");
        const chips = screen.getAllByTestId('rc-card-period-chip');
        expect(chips.map(x => x.textContent)).toEqual(['1 Jan 2026 → 31 Mar 2026', '⚠ 30 May 2026 → 10 Apr 2026']);
        expect(chips[1].className).toContain('rcc-chip--bad');
        expect(chips[0].className).not.toContain('rcc-chip--bad');
        const btn = screen.getByTestId('rc-card-open');
        expect(btn.textContent).toBe('Fix period');
        expect(btn.className).toContain('rcx-btn--danger');
        fireEvent.click(btn);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('names the FIRST broken period', () => {
        card({ state: 'invalid', periods: [p('a', '2026-01-01T00:00', ''), p('b', '2026-05-01T00:00', '2026-06-01T23:59')] });
        expect(screen.getByTestId('rc-card-title').textContent).toBe('Period 1 needs fixing');
        expect(screen.getByTestId('rc-card-reason').textContent).toContain('Period 1 needs an end date.');
    });
});

describe('RunningConditionCard — Set', () => {
    it('compact card: green left bar + tick, "Step 1 · Running condition · Set · applies to every model"', () => {
        card();
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-state')).toBe('set');
        expect(c.className).toContain('rcc-card--ok');
        expect(c.querySelector('.rcc-num--ok svg')).not.toBeNull();
        expect(c.querySelector('.rcc-kicker')!.textContent).toBe('Step 1 · Running condition Setapplies to every model');
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Set');
    });

    it('"Which time" shows readable date-range chips with open ends as Start / End', () => {
        card();
        expect(within(screen.getByTestId('rc-card-time')).getByText('Which time')).toBeTruthy();
        expect(screen.getAllByTestId('rc-card-period-chip').map(x => x.textContent)).toEqual(['1 Jan 2026 → 31 Mar 2026', '15 Apr 2026 → End']);
        cleanup();
        card({ periods: [p('a', '', '2026-03-31T23:59')] });
        expect(screen.getByTestId('rc-card-period-chip').textContent).toBe('Start → 31 Mar 2026');
    });

    it('no periods = a single "Whole dataset" chip', () => {
        card({ periods: [] });
        expect(screen.getByTestId('rc-card-period-chip').textContent).toBe('Whole dataset');
    });

    it('"When running": condition chips with sensor name + operator + value + unit, joined by AND / OR', () => {
        card({
            filters: [f('f1', 'POWER', 'greater_than', '4000'), f('f2', 'SPEED', 'between', '2900', '3100')],
        });
        const chips = screen.getAllByTestId('rc-card-cond-chip');
        expect(chips.map(x => x.textContent)).toEqual(['GENERATOR ACTIVE POWER > 4000 kW', 'TURBINE SPEED between 2900–3100 RPM']);
        expect(chips[0].querySelector('b')!.textContent).toBe('GENERATOR ACTIVE POWER'); // the name is the bold part
        expect(within(screen.getByTestId('rc-card-cond')).getByText('AND')).toBeTruthy();
        cleanup();
        card({ filters: [f('f1', 'POWER', 'greater_than', '4000'), f('f2', 'SPEED', 'less_than', '3')], combine: 'or' });
        expect(within(screen.getByTestId('rc-card-cond')).getByText('OR')).toBeTruthy();
    });

    it('a sensor without a description shows its tag; one without a unit shows no unit', () => {
        card({ filters: [f('f1', 'MYSTERY', 'greater_than', '7')], headers: ['MYSTERY'] });
        expect(screen.getByTestId('rc-card-cond-chip').textContent).toBe('MYSTERY > 7');
    });

    it('"Use all rows" reads "All rows — no condition"', () => {
        card({ noneConfirmed: true, filters: [f('f1', 'POWER', 'greater_than', '4000')] });
        expect(within(screen.getByTestId('rc-card-cond')).getByText('All rows — no condition')).toBeTruthy();
        expect(screen.queryByTestId('rc-card-cond-chip')).toBeNull();
    });

    it('conditions the build would not apply (incomplete, or sensor not in the dataset) are not shown as chips', () => {
        card({ filters: [f('f1', 'POWER', 'greater_than', '4000'), f('f2', 'SPEED', 'greater_than', ''), f('f3', 'GONE', 'greater_than', '1')] });
        expect(screen.getAllByTestId('rc-card-cond-chip')).toHaveLength(1);
    });

    it('right side: rows used, "rows · %" and a bar; the Edit button opens the settings', () => {
        const onOpen = card();
        expect(screen.getByTestId('rc-card-rows').textContent).toBe('11,066');
        expect(screen.getByTestId('rc-card-pct').textContent).toBe('rows · 21%');
        const bar = screen.getByTestId('rc-card-use').querySelector('.rcc-meter span') as HTMLElement;
        expect(parseFloat(bar.style.width)).toBeCloseTo(21.14, 1);
        const edit = screen.getByTestId('rc-card-open');
        expect(edit.textContent).toBe('Edit');
        fireEvent.click(edit);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    describe('period strip (restored 2026-10-03)', () => {
        // 2025-01-01 -> 2026-07-31 23:50 = 577 days
        const B = { min: '2025-01-01 00:00:00', max: '2026-07-31 23:50:00' };
        const cov = () => within(screen.getByTestId('rc-card')).getByTestId('period-coverage');

        it('draws one block per PERSISTED period under the rows-used bar, with start/end year-month and a short day count', () => {
            card({ bounds: B });
            expect(cov().querySelectorAll('.f4-strip i')).toHaveLength(2);
            expect(cov().className).toContain('f4-cov--mini');
            expect(cov().textContent).toContain('Jan 2025');
            expect(cov().textContent).toContain('Jul 2026');
            expect(within(cov()).getByTestId('period-coverage-days').textContent).toBe('198 / 577 d'); // Jan1-Mar31 2026 (90 d) + Apr15 2026-end of data (108 d)
            expect(screen.getByTestId('rc-card-use').contains(cov())).toBe(true);
            // the rows-used count, % and bar are all still there
            expect(screen.getByTestId('rc-card-rows').textContent).toBe('11,066');
            expect(screen.getByTestId('rc-card-use').querySelector('.rcc-meter')).not.toBeNull();
        });

        it('reads the periods prop only: re-rendering with the same persisted periods does not change it', () => {
            const { rerender } = render(
                <RunningConditionCard state="set" periods={[p('a', '2025-01-01T00:00', '2025-01-31T23:59')]} filters={[]} combine="and" noneConfirmed headers={[]}
                    getDesc={() => ''} getUnit={() => ''} rows={OK} bounds={B} onOpen={vi.fn()} />,
            );
            const first = within(cov()).getByTestId('period-coverage-days').textContent;
            expect(first).toBe('31 / 577 d');
            rerender(
                <RunningConditionCard state="set" periods={[p('a', '2025-01-01T00:00', '2025-01-31T23:59')]} filters={[]} combine="and" noneConfirmed headers={[]}
                    getDesc={() => ''} getUnit={() => ''} rows={{ status: 'ok', used: 1, total: 2 }} bounds={B} onOpen={vi.fn()} />,
            );
            expect(within(cov()).getByTestId('period-coverage-days').textContent).toBe(first);
        });

        it('no periods = a full strip ("all N days")', () => {
            card({ periods: [], bounds: B });
            expect(within(cov()).getByTestId('period-coverage-days').textContent).toBe('all 577 days');
        });

        it('open ends reach the edge of the strip', () => {
            card({ periods: [p('a', '2026-07-01T00:00', '')], bounds: B });
            const b = cov().querySelector('.f4-strip i') as HTMLElement;
            expect(Math.round(parseFloat(b.style.left) + parseFloat(b.style.width))).toBe(100);
        });

        it('hidden (no strip, nothing else changes) while the dataset bounds are unknown', () => {
            card({ bounds: null });
            expect(screen.queryByTestId('period-coverage')).toBeNull();
            expect(screen.getByTestId('rc-card-rows').textContent).toBe('11,066');
            cleanup();
            card({ bounds: { min: null, max: null } });
            expect(screen.queryByTestId('period-coverage')).toBeNull();
        });

        it('is not drawn on the unset / invalid cards', () => {
            card({ state: 'unset', bounds: B });
            expect(screen.queryByTestId('period-coverage')).toBeNull();
        });
    });

    it('while counting: "Counting rows…" first, then the previous numbers stay; on failure: "— rows" with a title; idle: nothing', () => {
        card({ rows: { status: 'loading', used: null, total: null } });
        expect(screen.getByTestId('rc-card-rows-loading').textContent).toBe('Counting rows…');
        cleanup();
        card({ rows: { status: 'loading', used: 5, total: 10 } });
        expect(screen.getByTestId('rc-card-rows').textContent).toBe('5');
        expect(screen.getByTestId('rc-card-pct').textContent).toBe('rows · 50%');
        cleanup();
        card({ rows: { status: 'error', used: null, total: null } });
        expect(screen.getByTestId('rc-card-rows-error').textContent).toBe('— rows');
        expect(screen.getByTestId('rc-card-rows-error').getAttribute('title')).toBe("Couldn't count the rows");
        cleanup();
        card({ rows: { status: 'idle', used: null, total: null } });
        expect(screen.getByTestId('rc-card-use').textContent).toBe('');
    });

    it('<1% rows and a zero count are formatted, not rounded away', () => {
        card({ rows: { status: 'ok', used: 3, total: 10_000 } });
        expect(screen.getByTestId('rc-card-pct').textContent).toBe('rows · <1%');
        cleanup();
        card({ rows: { status: 'ok', used: 0, total: 10_000 } });
        expect(screen.getByTestId('rc-card-rows').textContent).toBe('0');
        expect(screen.getByTestId('rc-card-pct').textContent).toBe('rows · 0%');
    });
});
