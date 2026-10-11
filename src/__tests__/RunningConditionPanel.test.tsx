import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// The real picker lives in SensorPickers.tsx (tested in SensorPickers.test.tsx); this panel
// only needs "a sensor field with a label" (its own behaviour is tested there).
// The stand-in records the props it is given so the test can assert the panel
// still uses the REAL single-select picker (not a native <select>) and what it
// does on selection.
const pickerProps: any[] = [];
vi.mock('../components/windows/SensorPickers', () => ({
    SensorPickerModal: (props: any) => {
        pickerProps.push(props);
        return (
            <button data-testid="picker" data-single={String(!!props.single)} onClick={() => props.onSelect('PICKED')}>
                {props.value}
            </button>
        );
    },
}));

import RunningConditionPanel, { RunningConditionPills } from '../components/windows/RunningConditionPanel';
import type { PeriodCounts } from '../types/periodCounts';
import type { PeriodCountsState } from '../utils/periodCounts';
import type { TestPeriod, TimeHighlight, WorkspaceSensorFilter } from '../types';

afterEach(() => { cleanup(); pickerProps.length = 0; });

/*
 * The Running-condition settings body (workbench redesign SPEC §5): ONE column —
 * timeline hero, then Train periods · Scoring periods · When the plant is
 * running, each with one eyebrow line. No right-hand preview column, no callout
 * boxes. The same panel is a Custom model's own running condition
 * (`scope="custom"`). The rows are tested in TimePeriodsEditor / TestPeriodsEditor,
 * the hero in RunningConditionTimeline.
 */

const bounds = { min: '2026-01-01 00:00:00', max: '2026-05-01 00:00:00' };
const p = (id: string, start: string, end: string) => ({ id, start, end });
const P1 = p('a', '2026-01-01T00:00', '2026-01-31T00:00');
const P2 = p('b', '2026-03-02T00:00', '2026-04-01T00:00');
const S1: TestPeriod = { id: 's', start: '2026-04-01T00:00', end: '2026-04-16T00:00' };
const f = (id: string, sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, value2 = ''): WorkspaceSensorFilter =>
    ({ id, sensor, operation, value1, value2 });
const COND = [f('f1', 'I_MOT_A', 'greater_than', '12'), f('f2', 'PT_2041', 'greater_than', '2.4')];
const UNIT: Record<string, string> = { I_MOT_A: 'A', PT_2041: 'bar' };

const one = (q: { start: string; end: string }, i: number, running_days: number) =>
    ({ index: i, start: q.start, end: q.end, valid: true, invalid_reason: null, rows_in_period: 8640, running_rows: 7000, running_days });
const TRAIN_COUNTS: PeriodCounts = {
    total_rows: 25_880, interval_secs: 300,
    periods: [one(P1, 0, 26), one(P2, 1, 24)],
    union: { rows_in_period: 17_280, running_rows: 14_391, running_days: 50 },
};
const SCORE_COUNTS: PeriodCounts = {
    total_rows: 25_880, interval_secs: 300, periods: [one(S1, 0, 13)],
    union: { rows_in_period: 4320, running_rows: 3700, running_days: 13 },
};
const COUNTED: PeriodCountsState = { status: 'ok', train: TRAIN_COUNTS, scoring: SCORE_COUNTS, error: null, errorCode: null };

function setup(over: Partial<React.ComponentProps<typeof RunningConditionPanel>> = {}) {
    const handlers = {
        onPeriodsChange: vi.fn(), onNoneChange: vi.fn(), onCombineChange: vi.fn(),
        onAddFilter: vi.fn(), onUpdateFilter: vi.fn(), onRemoveFilter: vi.fn(),
        onTestPeriodsChange: vi.fn(),
    };
    render(
        <RunningConditionPanel
            configured
            periods={[P1, P2]}
            bounds={bounds}
            filters={COND}
            combine="and"
            noneConfirmed={false}
            sensors={['I_MOT_A', 'PT_2041']}
            getComponent={() => 'Pump'}
            getUnit={t => UNIT[t] ?? ''}
            testPeriods={[S1]}
            highlights={[]}
            {...handlers}
            {...over}
        />,
    );
    return handlers;
}

describe('RunningConditionPanel — one column (workbench redesign §5)', () => {
    it('timeline hero first, then three sections in order; no right-hand preview column', () => {
        setup();
        const panel = screen.getByTestId('rc-panel');
        expect(panel.className).toBe('rcm-body');
        const kids = [...panel.children].map(c => c.getAttribute('data-testid'));
        expect(kids).toEqual(['rc-timeline', 'rc-periods', 'rc-scoring', 'rc-condition']);
        // what the two-column layout had and this one must not
        expect(screen.queryByTestId('rc-preview')).toBeNull();
        expect(panel.querySelector('aside')).toBeNull();
        expect(screen.queryByTestId('rule-sentence')).toBeNull();
        expect(screen.queryByTestId('rc-preview-tests')).toBeNull();
        expect(screen.queryByTestId('rc-invalid-reason')).toBeNull();
        expect(panel.textContent).not.toContain('Data used for training');
    });

    it('each section has ONE eyebrow line: its name and one sentence — no numbered steps, no callout boxes', () => {
        setup();
        const heads = [...screen.getByTestId('rc-panel').querySelectorAll('.rcx-sec-h')];
        expect(heads.map(h => h.querySelector('b')!.textContent)).toEqual(['Train periods', 'Scoring periods', 'When the plant is running']);
        for (const h of heads) expect(h.querySelectorAll('span')).toHaveLength(1);
        expect(screen.getByTestId('rc-train-head').textContent).toBe('Train periodsonly healthy, normal running time — the model learns what normal looks like from it. At least one.');
        expect(screen.getByTestId('rc-test-head').textContent).toBe('Scoring periodsthe trained model gives a health score for this time — you read it on the score chart. Needed before Mark complete; may include train time.');
        expect(screen.queryByTestId('rc-train-callout')).toBeNull();
        expect(document.querySelector('.tpe-callout, .rcm-num, .rcm-step, .f4-callout')).toBeNull();
        expect(screen.getByTestId('rc-panel').textContent).not.toMatch(/Which time/);
    });

    it('the timeline draws the lists it is given; the row editors sit in their sections', () => {
        setup();
        expect(within(screen.getByTestId('rc-timeline-train')).getByTestId('rc-tl-P2')).toBeTruthy();
        expect(within(screen.getByTestId('rc-timeline-score')).getByTestId('rc-tl-S1')).toBeTruthy();
        expect(within(screen.getByTestId('rc-periods')).getByTestId('time-periods-editor')).toBeTruthy();
        expect(within(screen.getByTestId('rc-scoring')).getByTestId('test-periods-editor')).toBeTruthy();
        // the old coverage strip is gone from the modal (the hero replaces it)
        expect(screen.queryByTestId('period-coverage')).toBeNull();
    });

    it('the counts feed the caption AND every row ("30 d · 26 d running")', () => {
        setup({ counts: COUNTED });
        expect(screen.getByTestId('rc-caption').textContent).toBe('60 d train (about 50 d running time)15 d scoring14,391 of 25,880 rows (56%) used for training≥ 30 d recommended');
        expect(screen.getByTestId('period-days-1').textContent).toBe('30 d · 26 d running');
        expect(screen.getByTestId('period-days-2').textContent).toBe('30 d · 24 d running');
        expect(screen.getByTestId('test-days-1').textContent).toBe('15 d · 13 d running');
    });

    // The count of an unset condition is a count of every row.
    it('not configured ("Only when running", no complete condition): the caption asks for the condition and no row claims running days', () => {
        setup({ configured: false, filters: [], counts: COUNTED });
        expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('no-condition');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('set the condition to count the rows');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('60 d train');
        expect(screen.getByTestId('period-days-1').textContent).toBe('30 d');
        expect(screen.getByTestId('test-days-1').textContent).toBe('15 d');
        expect(screen.queryByTestId('period-running-1')).toBeNull();
        expect(screen.queryByTestId('test-running-1')).toBeNull();
    });

    // A half-typed date is reported per list, a complete one arrives at once.
    it('a date being typed: a complete one goes to the host on change; a half-typed one only names its row (per list)', () => {
        const typed = setup();
        fireEvent.change(screen.getByLabelText('P1 end'), { target: { value: '2026-01-20T00:00' } });
        expect(typed.onPeriodsChange).toHaveBeenLastCalledWith([{ ...P1, end: '2026-01-20T00:00' }, P2]);
        cleanup();

        const onPendingDate = vi.fn();
        const h = setup({ onPendingDate });
        fireEvent.change(screen.getByLabelText('P2 end'), { target: { value: '' } });
        expect(onPendingDate).toHaveBeenLastCalledWith('train', 'P2');
        expect(h.onPeriodsChange).not.toHaveBeenCalled(); // a half value never reaches the host
        fireEvent.change(screen.getByLabelText('Scoring period 1 start'), { target: { value: '' } });
        expect(onPendingDate).toHaveBeenLastCalledWith('scoring', 'S1');
        expect(h.onTestPeriodsChange).not.toHaveBeenCalled();
        fireEvent.blur(screen.getByLabelText('Scoring period 1 start'));
        expect(onPendingDate).toHaveBeenLastCalledWith('scoring', null);
        expect(h.onTestPeriodsChange).not.toHaveBeenCalled();
    });

    it('without counts the caption has the calendar parts only and the rows their days', () => {
        setup();
        expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('idle');
        expect(screen.getByTestId('period-days-1').textContent).toBe('30 d');
    });

    it('no train period: the amber line in the Train section, the caption says to add one', () => {
        setup({ periods: [] });
        expect(screen.getByTestId('periods-empty').textContent).toBe('No train period yet — add at least one');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('add a train period to count the rows');
    });

    it('no scoring period: one quiet grey note in the Scoring section', () => {
        setup({ testPeriods: [] });
        const note = within(screen.getByTestId('rc-scoring')).getByTestId('tests-empty');
        expect(note.className).toBe('rcx-line');
        expect(note.textContent).toBe('No scoring period yet — you can train and apply now; Mark complete needs at least one.');
    });

    it('an invalid train period: the row is red with its reason, the timeline block is red — nothing else repeats it', () => {
        setup({ periods: [P1, p('b', '2026-05-11T00:00', '2026-05-01T00:00')] });
        expect(screen.getByTestId('period-invalid-2').textContent).toBe('P2 ends before it starts — pick an end after 11 May 2026');
        expect(screen.getAllByRole('alert')).toHaveLength(1);
        expect(screen.getByTestId('rc-panel').textContent).not.toMatch(/Period 2|can't be built/);
    });

    it('a train period overlapping a Dashboard highlight: one amber line under the train rows; "Remove the overlap" hands back the split list', () => {
        const hl = { id: 'h1', label: 'Trip', start: '2026-01-10T00:00', end: '2026-01-12T00:00', color: '#f00', enabled: true } as TimeHighlight;
        const h = setup({ highlights: [hl] });
        const line = within(screen.getByTestId('rc-periods')).getByTestId('train-hl-warning');
        expect(line.textContent).toContain('Train P1 overlaps the highlight “Trip”');
        fireEvent.click(within(line).getByTestId('train-hl-split'));
        expect(h.onPeriodsChange).toHaveBeenCalledTimes(1);
        expect(h.onPeriodsChange.mock.calls[0][0]).toHaveLength(3);
    });
});

describe('RunningConditionPanel — running mode (one radio row)', () => {
    it('two radios in one row: "Only when running · keep rows that meet a condition" | "Use all rows · idle and shutdown time included"', () => {
        setup();
        const group = screen.getByRole('radiogroup', { name: 'Condition mode' });
        expect(group.className).toBe('rcx-mode');
        const radios = within(group).getAllByRole('radio');
        expect(radios.map(r => r.textContent)).toEqual([
            'Only when running· keep rows that meet a condition',
            'Use all rows· idle and shutdown time included',
        ]);
        expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
        // one tab stop for the row (the checked one)
        expect(radios.map(r => r.tabIndex)).toEqual([0, -1]);
        expect(document.querySelector('.rcm-mcard')).toBeNull();
    });

    it('clicking the other radio reports it; clicking the active one does nothing', () => {
        const h = setup();
        fireEvent.click(screen.getByTestId('rc-mode-condition'));
        expect(h.onNoneChange).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('rc-mode-none'));
        expect(h.onNoneChange).toHaveBeenCalledWith(true);
    });

    it('arrow keys move the choice, like a native radio group', () => {
        const h = setup();
        fireEvent.keyDown(screen.getByTestId('rc-mode-condition'), { key: 'ArrowRight' });
        expect(h.onNoneChange).toHaveBeenCalledWith(true);
        cleanup();
        const h2 = setup({ noneConfirmed: true });
        fireEvent.keyDown(screen.getByTestId('rc-mode-none'), { key: 'ArrowLeft' });
        expect(h2.onNoneChange).toHaveBeenCalledWith(false);
        fireEvent.keyDown(screen.getByTestId('rc-mode-none'), { key: 'a' });
        expect(h2.onNoneChange).toHaveBeenCalledTimes(1);
    });

    it('"Use all rows": one quiet line (the periods still limit the time), no condition rows, no Add condition', () => {
        setup({ noneConfirmed: true });
        expect(screen.getByTestId('rc-mode-none').getAttribute('aria-checked')).toBe('true');
        const note = screen.getByTestId('rc-none-note');
        expect(note.className).toBe('rcx-line');
        expect(note.textContent).toBe('Every row inside the train periods is used, idle time included. The 2 train periods above still limit the time. Your saved conditions are kept but not applied.');
        expect(screen.queryByTestId('rc-cond-1')).toBeNull();
        expect(screen.queryByTestId('rc-add-condition')).toBeNull();
        cleanup();
        setup({ noneConfirmed: true, periods: [], filters: [] });
        expect(screen.getByTestId('rc-none-note').textContent).toBe('Every row inside the train periods is used, idle time included. There is no train period yet — add one above.');
    });

    it('not configured: one amber line asks for a condition or "Use all rows"; configured: none', () => {
        setup({ configured: false, filters: [] });
        const warn = screen.getByTestId('rc-unset-warning');
        expect(warn.className).toBe('rcx-line rcx-line--warn');
        expect(warn.textContent).toBe('Choose “Only when running” with a condition, or “Use all rows”, before training a model.');
        expect(screen.getByTestId('rc-no-conditions').textContent).toContain('Add a condition that tells running from idle');
        cleanup();
        setup();
        expect(screen.queryByTestId('rc-unset-warning')).toBeNull();
    });
});

describe('RunningConditionPanel — condition rows (ONE line each)', () => {
    it('a row is [sensor] [> < ↔ =] [value unit] [x]: the shared single picker, NO component chip', () => {
        setup();
        const row = screen.getByTestId('rc-cond-1');
        expect([...row.children].map(c => c.className.split(' ')[0])).toEqual(['rcm-cond-s', 'rcm-ops', 'rcm-vals', 'rcm-ib']);
        const picker = within(row).getByTestId('picker');
        expect(picker.getAttribute('data-single')).toBe('true');
        expect(picker.textContent).toBe('I_MOT_A');
        expect(row.querySelector('.comp-chip')).toBeNull();
        expect(row.textContent).not.toContain('Pump');
        // the picker still groups by component inside its own list
        expect(pickerProps[0].getComponent('I_MOT_A')).toBe('Pump');
        expect(pickerProps[0].noun).toBe('sensor');
        expect(within(row).getAllByRole('button', { pressed: true }).map(b => b.textContent)).toEqual(['>']);
        expect((within(row).getByLabelText('Value') as HTMLInputElement).value).toBe('12');
        expect(row.querySelector('.rcm-val span')!.textContent).toBe('A');
    });

    it('picking a sensor, an operator, typing a value and removing each report to the host', () => {
        const h = setup();
        const row = within(screen.getByTestId('rc-cond-1'));
        fireEvent.click(row.getByTestId('picker'));
        expect(h.onUpdateFilter).toHaveBeenLastCalledWith('f1', { sensor: 'PICKED' });
        fireEvent.click(row.getByLabelText('Less than'));
        expect(h.onUpdateFilter).toHaveBeenLastCalledWith('f1', { operation: 'less_than' });
        fireEvent.click(row.getByLabelText('Greater than')); // already active: nothing
        expect(h.onUpdateFilter).toHaveBeenCalledTimes(2);
        fireEvent.change(row.getByLabelText('Value'), { target: { value: '15' } });
        expect(h.onUpdateFilter).toHaveBeenLastCalledWith('f1', { value1: '15' });
        fireEvent.click(row.getByLabelText('Remove condition'));
        expect(h.onRemoveFilter).toHaveBeenCalledWith('f1');
    });

    it('"between" has min – max (the unit after max) and a wider value column', () => {
        const h = setup({ filters: [f('f1', 'I_MOT_A', 'between', '10', '20')] });
        const row = screen.getByTestId('rc-cond-1');
        expect(row.className).toContain('rcm-cond--between');
        expect((within(row).getByLabelText('Minimum value') as HTMLInputElement).value).toBe('10');
        expect((within(row).getByLabelText('Maximum value') as HTMLInputElement).value).toBe('20');
        expect([...row.querySelectorAll('.rcm-val span')].map(s => s.textContent)).toEqual(['A']);
        fireEvent.change(within(row).getByLabelText('Maximum value'), { target: { value: '25' } });
        expect(h.onUpdateFilter).toHaveBeenLastCalledWith('f1', { value2: '25' });
    });

    it('an empty value is marked (amber field) and the row is flagged incomplete', () => {
        setup({ filters: [f('f1', 'I_MOT_A', 'greater_than', '')] });
        const row = screen.getByTestId('rc-cond-1');
        expect(row.getAttribute('data-incomplete')).toBe('true');
        expect(row.querySelector('.rcm-val')!.className).toContain('rcm-val--empty');
    });

    it('the AND / OR pill sits between rows and switches the mode', () => {
        const h = setup();
        const pill = screen.getByTestId('rc-combine');
        expect(pill.textContent).toBe('AND');
        expect(screen.getByTestId('rc-combine-caption').textContent).toBe('both must be true');
        fireEvent.click(pill);
        expect(h.onCombineChange).toHaveBeenCalledWith('or');
        cleanup();
        setup({ combine: 'or' });
        expect(screen.getByTestId('rc-combine').textContent).toBe('OR');
        expect(screen.getByTestId('rc-combine-caption').textContent).toBe('either one is enough');
    });

    it('Add condition reports to the host; it is disabled without sensors', () => {
        const h = setup();
        fireEvent.click(screen.getByTestId('rc-add-condition'));
        expect(h.onAddFilter).toHaveBeenCalledTimes(1);
        cleanup();
        setup({ sensors: [] });
        expect((screen.getByTestId('rc-add-condition') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('RunningConditionPanel — scope="custom" (a model\'s own running condition)', () => {
    it('the same timeline, rows and states under the model\'s own test ids, ending with the footnote', () => {
        setup({ scope: 'custom', counts: COUNTED });
        expect(screen.queryByTestId('rc-panel')).toBeNull();
        const panel = screen.getByTestId('custom-rc-panel');
        expect([...panel.children].map(c => c.getAttribute('data-testid'))).toEqual([
            'rc-timeline', 'custom-periods', 'custom-test-periods', 'custom-condition', 'custom-rc-footnote',
        ]);
        expect(screen.getByTestId('custom-rc-footnote').textContent).toBe('Only this model · the workspace default is untouched · saved with Save changes');
        expect(within(screen.getByTestId('custom-periods')).getByTestId('period-days-1').textContent).toBe('30 d · 26 d running');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('14,391 of 25,880 rows (56%) used for training');
        expect(within(screen.getByTestId('custom-condition')).getByRole('radiogroup')).toBeTruthy();
    });

    it('its empty scoring note says "save" (it is saved with Save changes, not applied)', () => {
        setup({ scope: 'custom', testPeriods: [] });
        expect(screen.getByTestId('tests-empty').textContent).toBe('No scoring period yet — you can train and save now; Mark complete needs at least one.');
    });

    it('the workspace panel has no footnote', () => {
        setup();
        expect(screen.queryByTestId('custom-rc-footnote')).toBeNull();
    });
});

describe('RunningConditionPills (modal header)', () => {
    const pills = (over: Partial<React.ComponentProps<typeof RunningConditionPills>> = {}) =>
        render(<RunningConditionPills configured noneConfirmed={false} conditionCount={2} periodInvalid={false} {...over} />);

    it('"N conditions" when configured with conditions; "No condition" for use-all-rows; "Required" when unset', () => {
        pills();
        expect(screen.getByTestId('rc-count-pill').textContent).toBe('2 conditions');
        cleanup();
        pills({ conditionCount: 1 });
        expect(screen.getByTestId('rc-count-pill').textContent).toBe('1 condition');
        cleanup();
        pills({ noneConfirmed: true });
        expect(screen.getByTestId('rc-none-pill').textContent).toBe('No condition');
        cleanup();
        pills({ configured: false });
        expect(screen.getByTestId('rc-required-pill').textContent).toBe('Required');
    });

    it('"Fix period" is added while a period is invalid', () => {
        pills({ periodInvalid: true });
        expect(screen.getByTestId('rc-fix-period-pill').textContent).toBe('Fix period');
        expect(screen.getByTestId('rc-count-pill')).toBeTruthy();
    });
});
