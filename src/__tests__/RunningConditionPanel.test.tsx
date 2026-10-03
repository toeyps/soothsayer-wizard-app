import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// The real picker lives in the heavy PredictiveModelBuild module; this panel
// only needs "a sensor field with a label" (its own behaviour is tested there).
// The stand-in records the props it is given so the test can assert the panel
// still uses the REAL single-select picker (not a native <select>) and what it
// does on selection.
const pickerProps: any[] = [];
vi.mock('../components/windows/PredictiveModelBuild', () => ({
    SensorPickerModal: (props: any) => {
        pickerProps.push(props);
        return (
            <button data-testid="picker" data-single={String(!!props.single)} data-muted={String(!!props.mutedTag)} onClick={() => props.onSelect('PICKED')}>
                {props.value}
            </button>
        );
    },
}));

import RunningConditionPanel, { RunningConditionPills } from '../components/windows/RunningConditionPanel';
import type { RowCountPreview } from '../components/windows/useRowCountPreview';
import type { WorkspaceSensorFilter } from '../types';

afterEach(() => { cleanup(); pickerProps.length = 0; });

const bounds = { min: '2025-01-01 00:00:00', max: '2026-03-31 23:50:00' };
const p = (id: string, start: string, end: string) => ({ id, start, end });
const P2 = [
    p('a', '2026-01-01T00:00', '2026-03-31T23:59'),
    p('b', '2026-04-15T00:00', ''),
];
const f = (id: string, sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, value2 = ''): WorkspaceSensorFilter =>
    ({ id, sensor, operation, value1, value2 });
const COND = [f('f1', 'I_MOT_A', 'greater_than', '12'), f('f2', 'PT_2041', 'greater_than', '2.4')];
const DESC: Record<string, string> = { I_MOT_A: 'Motor current', PT_2041: 'Pump pressure' };
const UNIT: Record<string, string> = { I_MOT_A: 'A', PT_2041: 'bar' };
const OK: RowCountPreview = { status: 'ok', used: 11_066, total: 52_340 };

function setup(over: Partial<React.ComponentProps<typeof RunningConditionPanel>> = {}) {
    const handlers = {
        onPeriodsChange: vi.fn(), onNoneChange: vi.fn(), onCombineChange: vi.fn(),
        onAddFilter: vi.fn(), onUpdateFilter: vi.fn(), onRemoveFilter: vi.fn(),
    };
    render(
        <RunningConditionPanel
            configured
            periods={P2}
            bounds={bounds}
            filters={COND}
            combine="and"
            noneConfirmed={false}
            sensors={['I_MOT_A', 'PT_2041']}
            getDesc={t => DESC[t] ?? ''}
            getComponent={() => 'Pump'}
            getUnit={t => UNIT[t] ?? ''}
            preview={OK}
            {...handlers}
            {...over}
        />,
    );
    return handlers;
}

describe('RunningConditionPanel — two-column layout (mockup 1pp59aydphzaDu2R1SvKGh)', () => {
    it('left column has the two numbered steps, right column is "Data used for training"', () => {
        setup();
        const panel = screen.getByTestId('rc-panel');
        expect(panel.className).toContain('rcm-body');
        const steps = panel.querySelectorAll('.rcm-form > .rcm-step');
        expect(steps).toHaveLength(2);
        expect(steps[0].textContent).toContain('Which time');
        expect(steps[0].querySelector('.rcm-num')!.textContent).toBe('1');
        expect(steps[1].textContent).toContain('When the plant is running');
        expect(steps[1].querySelector('.rcm-num')!.textContent).toBe('2');
        expect(within(screen.getByTestId('rc-preview')).getByText('Data used for training')).toBeTruthy();
        expect(screen.getByTestId('rc-preview').className).toContain('rcm-preview');
    });

    it('step 1 uses the period cards (P1, P2) and not the old collapsible header', () => {
        setup();
        const rows = within(screen.getByTestId('rc-periods')).getAllByTestId(/^period-row-/);
        expect(rows).toHaveLength(2);
        expect(rows[0].className).toContain('rcm-per');
        expect(rows[0].querySelector('.rcm-pn')!.textContent).toBe('P1');
        expect(screen.queryByRole('button', { name: /Running Condition Filter/ })).toBeNull();
        expect(screen.queryByTestId('rc-summary')).toBeNull();
    });
});

describe('RunningConditionPanel — period coverage strip (restored 2026-10-03; removed by mistake in 011675b)', () => {
    // bounds: 2025-01-01 00:00 -> 2026-03-31 23:50  => 455 days
    const JAN = [p('a', '2025-01-01T00:00', '2025-01-31T23:59')];
    const blockStyle = () => {
        const i = within(screen.getByTestId('rc-periods')).getByTestId('period-coverage').querySelectorAll('.f4-strip i');
        return Array.from(i).map(el => ({ left: parseFloat((el as HTMLElement).style.left), width: parseFloat((el as HTMLElement).style.width), cls: el.className }));
    };

    it('sits inside "1 Which time", ABOVE the period cards, with the hatched strip, axis ends and "N of M days used"', () => {
        setup({ periods: JAN });
        const section = screen.getByTestId('rc-periods');
        const cov = within(section).getByTestId('period-coverage');
        expect(cov.className).toContain('rcm-cov');
        expect(cov.querySelector('.f4-strip')).not.toBeNull();
        expect(cov.textContent).toContain('Jan 2025');
        expect(cov.textContent).toContain('Mar 2026');
        expect(within(cov).getByTestId('period-coverage-days').textContent).toBe('31 of 455 days used');
        const firstRow = within(section).getByTestId('period-row-1');
        // coverage comes before the first card in document order
        expect(cov.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('draws one block per period', () => {
        setup({ periods: [p('a', '2025-01-01T00:00', '2025-01-31T23:59'), p('b', '2025-06-01T00:00', '2025-06-30T23:59')] });
        expect(blockStyle()).toHaveLength(2);
        expect(within(screen.getByTestId('rc-periods')).getByTestId('period-coverage-days').textContent).toBe('61 of 455 days used');
    });

    it('updates live while a date is being edited (the draft, not the committed list)', () => {
        setup({ periods: JAN });
        const before = blockStyle()[0].width;
        fireEvent.change(screen.getByLabelText('Period 1 end'), { target: { value: '2025-03-31T23:59' } });
        expect(blockStyle()[0].width).toBeGreaterThan(before);
        expect(within(screen.getByTestId('rc-periods')).getByTestId('period-coverage-days').textContent).toBe('90 of 455 days used');
    });

    it('open ends extend to the dataset edge (blank start -> 0%, blank end -> 100%)', () => {
        setup({ periods: [p('a', '', '2025-01-31T23:59')] });
        expect(blockStyle()[0].left).toBe(0);
        cleanup();
        setup({ periods: [p('a', '2026-03-01T00:00', '')] });
        const b = blockStyle()[0];
        expect(Math.round(b.left + b.width)).toBe(100);
    });

    it('a reversed period is drawn red (bad) and not counted as used days', () => {
        setup({ periods: [p('a', '2025-03-01T00:00', '2025-02-01T00:00')] });
        expect(blockStyle()[0].cls).toContain('bad');
        expect(within(screen.getByTestId('rc-periods')).getByTestId('period-coverage-days').textContent).toBe('0 of 455 days used');
    });

    it('an overlapping period is drawn hatched (ovl)', () => {
        setup({ periods: [p('a', '2025-01-01T00:00', '2025-02-28T23:59'), p('b', '2025-02-15T00:00', '2025-03-31T23:59')] });
        const blocks = blockStyle();
        expect(blocks[0].cls).toBe('');
        expect(blocks[1].cls).toContain('ovl');
    });

    it('no strip, and no error, while the dataset bounds are not available yet', () => {
        setup({ periods: JAN, bounds: null });
        expect(screen.queryByTestId('period-coverage')).toBeNull();
        expect(screen.getAllByTestId(/^period-row-/)).toHaveLength(1);
    });

    it('no strip when there is no period (the "No period" note covers the whole dataset)', () => {
        setup({ periods: [] });
        expect(screen.queryByTestId('period-coverage')).toBeNull();
        expect(screen.getByTestId('periods-empty')).toBeTruthy();
    });
});

describe('RunningConditionPills (modal header)', () => {
    const pills = (over: Partial<React.ComponentProps<typeof RunningConditionPills>> = {}) =>
        render(<RunningConditionPills configured noneConfirmed={false} conditionCount={2} periodInvalid={false} {...over} />);

    it('"N conditions" when configured, singular for one', () => {
        pills();
        expect(screen.getByTestId('rc-count-pill').textContent).toBe('2 conditions');
        cleanup();
        pills({ conditionCount: 1 });
        expect(screen.getByTestId('rc-count-pill').textContent).toBe('1 condition');
    });
    it('"Required" when not configured; "No condition" (grey) when use-all-rows is confirmed', () => {
        pills({ configured: false });
        expect(screen.getByTestId('rc-required-pill').textContent).toBe('Required');
        expect(screen.getByTestId('rc-required-pill').className).toContain('f4-pill--warn');
        cleanup();
        pills({ noneConfirmed: true });
        expect(screen.getByTestId('rc-none-pill').textContent).toBe('No condition');
        expect(screen.getByTestId('rc-none-pill').className).toContain('f4-pill--grey');
    });
    it('an invalid period adds a red "Fix period" pill', () => {
        pills({ periodInvalid: true });
        expect(screen.getByTestId('rc-fix-period-pill').textContent).toBe('Fix period');
        expect(screen.getByTestId('rc-fix-period-pill').className).toContain('f4-pill--bad');
    });
});

describe('RunningConditionPanel — step 2 choice cards', () => {
    it('two cards replace the segmented control; the active one reflects noneConfirmed', () => {
        setup();
        const only = screen.getByTestId('rc-mode-condition');
        const all = screen.getByTestId('rc-mode-none');
        expect(only.className).toContain('rcm-mcard');
        expect(only.textContent).toContain('Only when running');
        expect(only.textContent).toContain('Keep rows that meet a condition');
        expect(all.textContent).toContain('Use all rows');
        expect(all.textContent).toContain('idle and shutdown time included');
        expect(only.getAttribute('aria-pressed')).toBe('true');
        expect(all.getAttribute('aria-pressed')).toBe('false');
        expect(only.className).toContain('rcm-mcard--on');
        expect(screen.queryByRole('button', { name: 'Filter by condition' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'No condition — use all rows' })).toBeNull();
    });

    it('"Use all rows" is active when noneConfirmed', () => {
        setup({ noneConfirmed: true });
        expect(screen.getByTestId('rc-mode-none').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('rc-mode-condition').getAttribute('aria-pressed')).toBe('false');
    });

    it('clicking a card reports the choice once (clicking the active side is a no-op)', () => {
        const h = setup();
        fireEvent.click(screen.getByTestId('rc-mode-condition'));
        expect(h.onNoneChange).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('rc-mode-none'));
        expect(h.onNoneChange).toHaveBeenCalledTimes(1);
        expect(h.onNoneChange).toHaveBeenCalledWith(true);
        cleanup();
        const h2 = setup({ noneConfirmed: true });
        fireEvent.click(screen.getByTestId('rc-mode-none'));
        expect(h2.onNoneChange).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('rc-mode-condition'));
        expect(h2.onNoneChange).toHaveBeenCalledWith(false);
    });

    it('"Use all rows": explanatory dashed box (periods still limit the time), no condition rows, no Add condition', () => {
        setup({ noneConfirmed: true });
        const note = screen.getByTestId('rc-none-note');
        expect(note.className).toContain('rcm-none');
        expect(note.textContent).toContain('Every row inside the training periods is used, idle time included.');
        expect(note.textContent).toContain('The 2 periods above still limit the time.');
        expect(note.textContent).toContain('Your saved conditions are kept but not applied.');
        expect(screen.queryByTestId('rc-add-condition')).toBeNull();
        expect(screen.queryByTestId('rc-cond-1')).toBeNull();
        expect(screen.getByTestId('rule-sentence').textContent).toContain('every row (no condition)');
    });

    it('"Use all rows" with no periods says it means the full dataset', () => {
        setup({ noneConfirmed: true, periods: [], filters: [] });
        expect(screen.getByTestId('rc-none-note').textContent).toContain('No periods are set, so that means the full dataset.');
    });
});

describe('RunningConditionPanel — condition rows', () => {
    it('each row: the REAL single sensor picker (muted tag), operator buttons, value + unit, remove', () => {
        const h = setup();
        const rows = [screen.getByTestId('rc-cond-1'), screen.getByTestId('rc-cond-2')];
        expect(rows[0].className).toContain('rcm-cond');
        const pickers = screen.getAllByTestId('picker');
        expect(pickers).toHaveLength(2);
        expect(pickers[0].getAttribute('data-single')).toBe('true');
        expect(pickers[0].getAttribute('data-muted')).toBe('true');
        expect(pickerProps[0]).toMatchObject({ single: true, value: 'I_MOT_A', noun: 'sensor' });
        fireEvent.click(pickers[1]);
        expect(h.onUpdateFilter).toHaveBeenCalledWith('f2', { sensor: 'PICKED' });
        // value + unit
        expect(within(rows[0]).getByPlaceholderText('value')).toBeTruthy();
        expect(within(rows[0]).getByText('A')).toBeTruthy();
        expect(within(rows[1]).getByText('bar')).toBeTruthy();
        // no native operator <select> any more
        expect(document.querySelectorAll('select')).toHaveLength(0);
    });

    it('operator buttons > < ↔ = : the active one is pressed; clicking another reports it; clicking the active one does nothing', () => {
        const h = setup();
        const ops = within(within(screen.getByTestId('rc-cond-1')).getByRole('group', { name: 'Condition operator' }));
        expect(ops.getAllByRole('button').map(b => b.textContent)).toEqual(['>', '<', '↔', '=']);
        expect(ops.getByRole('button', { name: 'Greater than' }).getAttribute('aria-pressed')).toBe('true');
        expect(ops.getByRole('button', { name: 'Less than' }).getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(ops.getByRole('button', { name: 'Greater than' }));
        expect(h.onUpdateFilter).not.toHaveBeenCalled();
        fireEvent.click(ops.getByRole('button', { name: 'Less than' }));
        fireEvent.click(ops.getByRole('button', { name: 'Between' }));
        fireEvent.click(ops.getByRole('button', { name: 'Equals' }));
        expect(h.onUpdateFilter.mock.calls).toEqual([
            ['f1', { operation: 'less_than' }],
            ['f1', { operation: 'between' }],
            ['f1', { operation: 'equals' }],
        ]);
    });

    it('typing a value reports it; Remove reports the id; "Add condition" is the dashed button', () => {
        const h = setup();
        fireEvent.change(screen.getAllByPlaceholderText('value')[0], { target: { value: '15' } });
        expect(h.onUpdateFilter).toHaveBeenCalledWith('f1', { value1: '15' });
        fireEvent.click(screen.getAllByLabelText('Remove condition')[1]);
        expect(h.onRemoveFilter).toHaveBeenCalledWith('f2');
        const add = screen.getByTestId('rc-add-condition');
        expect(add.className).toContain('rcm-add');
        fireEvent.click(add);
        expect(h.onAddFilter).toHaveBeenCalledTimes(1);
    });

    it('"between" shows min / max fields (the unit on the max side)', () => {
        const h = setup({ filters: [f('f1', 'I_MOT_A', 'between', '1', '5')] });
        const row = screen.getByTestId('rc-cond-1');
        expect(row.className).toContain('rcm-cond--between');
        expect(within(row).getByPlaceholderText('min')).toBeTruthy();
        expect(within(row).getByPlaceholderText('max')).toBeTruthy();
        fireEvent.change(within(row).getByPlaceholderText('max'), { target: { value: '9' } });
        expect(h.onUpdateFilter).toHaveBeenCalledWith('f1', { value2: '9' });
        expect(within(row).getByText('A')).toBeTruthy();
    });

    it('a row with an empty value is flagged (amber) so the missing value is visible', () => {
        setup({ filters: [f('f1', 'I_MOT_A', 'greater_than', '')] });
        expect(screen.getByTestId('rc-cond-1').className).toContain('rcm-cond--incomplete');
        expect(screen.getByPlaceholderText('value').closest('label')!.className).toContain('rcm-val--empty');
    });

    it('no conditions yet: the helper box explains what to add', () => {
        setup({ filters: [], configured: false });
        expect(screen.getByTestId('rc-no-conditions').textContent).toContain('Add a condition that tells running from idle');
    });

    it('Add condition is disabled with no sensors to pick from', () => {
        setup({ sensors: [] });
        expect((screen.getByTestId('rc-add-condition') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('RunningConditionPanel — AND / OR pill between rows', () => {
    it('one pill BETWEEN two rows (none before the first), with the "both must be true" caption', () => {
        setup();
        const pills = screen.getAllByTestId('rc-combine');
        expect(pills).toHaveLength(1);
        expect(pills[0].textContent).toBe('AND');
        expect(pills[0].className).toContain('rcm-joinbtn');
        expect(screen.getByTestId('rc-combine-caption').textContent).toBe('both must be true');
        const r1 = screen.getByTestId('rc-cond-1');
        const r2 = screen.getByTestId('rc-cond-2');
        // DOM order: row 1, pill, row 2
        expect(r1.compareDocumentPosition(pills[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(pills[0].compareDocumentPosition(r2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('clicking it switches AND -> OR and shows "either one is enough"; from OR it switches back', () => {
        const h = setup();
        fireEvent.click(screen.getByTestId('rc-combine'));
        expect(h.onCombineChange).toHaveBeenCalledWith('or');
        cleanup();
        const h2 = setup({ combine: 'or' });
        expect(screen.getByTestId('rc-combine').textContent).toBe('OR');
        expect(screen.getByTestId('rc-combine-caption').textContent).toBe('either one is enough');
        fireEvent.click(screen.getByTestId('rc-combine'));
        expect(h2.onCombineChange).toHaveBeenCalledWith('and');
    });

    it('a single condition has no pill, and the separate "Match" toggle is gone', () => {
        setup({ filters: [COND[0]] });
        expect(screen.queryByTestId('rc-combine')).toBeNull();
        expect(screen.queryByText('Match')).toBeNull();
        expect(screen.queryByRole('button', { name: 'OR' })).toBeNull();
    });
});

describe('RunningConditionPanel — Data used for training', () => {
    it('shows the row count, "of total rows · %" and a bar', () => {
        setup();
        const big = screen.getByTestId('rc-preview-count');
        expect(big.textContent).toBe('11,066of 52,340 rows · 21%');
        const bar = screen.getByTestId('rc-preview').querySelector('.rcm-meter span') as HTMLElement;
        expect(parseFloat(bar.style.width)).toBeCloseTo(21.14, 1);
    });

    it('loading keeps the previous numbers (dimmed) once there are some; first load says "Counting rows…"', () => {
        setup({ preview: { status: 'loading', used: 5, total: 10 } });
        expect(screen.getByTestId('rc-preview-count').querySelector('b')!.className).toContain('rcm-stale');
        cleanup();
        setup({ preview: { status: 'loading', used: null, total: null } });
        expect(screen.getByTestId('rc-preview-loading').textContent).toBe('Counting rows…');
    });

    it('a failed count says so instead of showing a number', () => {
        setup({ preview: { status: 'error', used: null, total: null } });
        expect(screen.getByTestId('rc-preview-error').textContent).toMatch(/Couldn't count the rows/);
    });

    it('0 rows used reads "0 of N rows · 0%"', () => {
        setup({ preview: { status: 'ok', used: 0, total: 100 } });
        expect(screen.getByTestId('rc-preview-count').textContent).toBe('0of 100 rows · 0%');
    });

    it('the summary sentence uses readable dates, sensor names and units, joined by OR (periods) / AND (conditions)', () => {
        setup();
        const s = screen.getByTestId('rule-sentence').textContent!;
        expect(s).toContain('1 Jan 2026 → 31 Mar 2026');
        expect(s).toContain('15 Apr 2026 → End');
        expect(s).toContain('Motor current > 12 A');
        expect(s).toContain('Pump pressure > 2.4 bar');
        expect(screen.getByTestId('rule-sentence').textContent).toMatch(/OR.*AND/);
    });

    it('an invalid period: red reason (from validatePeriods), no row count, "Fix the period" prompt', () => {
        setup({ periods: [P2[0], p('x', '2026-06-01T00:00', '2026-05-20T23:59')], preview: { status: 'idle', used: null, total: null } });
        expect(screen.getByTestId('rc-invalid-reason').textContent).toContain('Period 2 ends before it starts.');
        expect(screen.getByTestId('rc-invalid-reason').textContent).toContain("can't be built until it's fixed");
        expect(screen.getByTestId('rc-preview-idle').textContent).toBe('Fix the period to see the row count.');
    });

    it('not configured: the warning asks for a condition or "Use all rows"; configured: no warning', () => {
        setup({ configured: false, filters: [] });
        expect(screen.getByTestId('rc-unset-warning').textContent).toContain('Choose “Only when running” with a condition, or “Use all rows”');
        expect(screen.getByTestId('rule-sentence').textContent).toContain('not set yet');
        cleanup();
        setup();
        expect(screen.queryByTestId('rc-unset-warning')).toBeNull();
        expect(screen.queryByTestId('rc-invalid-reason')).toBeNull();
    });
});