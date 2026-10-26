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
 * timeline hero, then Train periods · Scoring periods · When the machine is
 * running (ONE line, "Machine is running when [sensor] is above [value]" —
 * 2026-10-26), each with one eyebrow line. No right-hand preview column, no callout
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
const COND = f('f1', 'I_MOT_A', 'greater_than', '12');
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
        onPeriodsChange: vi.fn(), onConditionChange: vi.fn(), onTestPeriodsChange: vi.fn(),
    };
    render(
        <RunningConditionPanel
            configured
            periods={[P1, P2]}
            bounds={bounds}
            condition={COND}
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
        expect(heads.map(h => h.querySelector('b')!.textContent)).toEqual(['Train periods', 'Scoring periods', 'When the machine is running']);
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

    // User decision 2026-10-14: the count is read as running DAYS only — the number of rows
    // (14,391 of 25,880, 56%) is never printed in the settings.
    it('the counts feed the caption AND every row as running DAYS ("30 d · 26 d running") — no number of rows anywhere in the panel', () => {
        setup({ counts: COUNTED });
        expect(screen.getByTestId('rc-caption').textContent).toBe('60 d train (about 50 d running time)15 d scoring≥ 30 d recommended');
        expect(screen.queryByTestId('rc-caption-rows')).toBeNull();
        expect(screen.getByTestId('rc-panel').textContent).not.toMatch(/14,391|25,880|17,280|8,?640|7,?000|56%|\d rows|rows \(|Counting rows/);
        expect(screen.getByTestId('period-days-1').textContent).toBe('30 d · 26 d running');
        expect(screen.getByTestId('period-days-2').textContent).toBe('30 d · 24 d running');
        expect(screen.getByTestId('test-days-1').textContent).toBe('15 d · 13 d running');
    });

    // The count of an unset condition is a count of every row.
    it('not configured (its one line not complete): the caption claims no running time and no row claims running days', () => {
        setup({ configured: false, condition: undefined, counts: COUNTED });
        expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('no-condition');
        expect(screen.queryByTestId('rc-caption-rows')).toBeNull();
        expect(screen.getByTestId('rc-caption').textContent).toBe('60 d train15 d scoring≥ 30 d recommended');
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

    it('no train period: the amber line in the Train section says to add one; the caption reads "no train period" (nothing about rows)', () => {
        setup({ periods: [] });
        expect(screen.getByTestId('periods-empty').textContent).toBe('No train period yet — add at least one');
        expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('no-train');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('no train period');
        expect(screen.queryByTestId('rc-caption-rows')).toBeNull();
        expect(screen.getByTestId('rc-caption').textContent).not.toMatch(/rows/);
    });

    it('no scoring period: one quiet grey note in the Scoring section', () => {
        setup({ testPeriods: [] });
        const note = within(screen.getByTestId('rc-scoring')).getByTestId('tests-empty');
        expect(note.className).toBe('rcx-line');
        expect(note.textContent).toBe('No scoring period yet — you can train and apply now; Mark complete needs at least one.');
    });

    it('an invalid train period: the row is red with its reason, the timeline block is red — nothing else repeats it', () => {
        setup({ periods: [P1, p('b', '2026-05-11T00:00', '2026-05-01T00:00')] });
        expect(screen.getByTestId('period-invalid-2').textContent).toBe('P2 ends before it starts — pick an end after 2026/05/11 00:00');
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

describe('RunningConditionPanel — the ONE running condition line (2026-10-26)', () => {
    it('the section heading and its one sentence; no radios, no AND / OR, no operator buttons, no Add condition', () => {
        setup();
        const sec = screen.getByTestId('rc-condition');
        expect(sec.querySelector('.rcx-sec-h b')!.textContent).toBe('When the machine is running');
        expect(sec.querySelector('.rcx-sec-h span')!.textContent).toBe('only rows where the machine is running are used to train and score — and the export tells the monitoring system the same. Required.');
        expect(within(sec).queryByRole('radiogroup')).toBeNull();
        expect(screen.queryByTestId('rc-mode-none')).toBeNull();
        expect(screen.queryByTestId('rc-combine')).toBeNull();
        expect(screen.queryByTestId('rc-add-condition')).toBeNull();
        expect(screen.queryByTestId('rc-cond-1')).toBeNull();
        expect(within(sec).queryByLabelText('Less than')).toBeNull();
        expect(sec.textContent).not.toMatch(/Use all rows|between/i);
    });

    it('reads "Machine is running when [sensor] is above [value unit]": the shared single picker, NO component chip', () => {
        setup();
        const line = screen.getByTestId('rc-one');
        expect(line.textContent).toBe('Machine is running whenI_MOT_Ais aboveA');
        const picker = within(line).getByTestId('picker');
        expect(picker.getAttribute('data-single')).toBe('true');
        expect(picker.textContent).toBe('I_MOT_A');
        expect(line.querySelector('.comp-chip')).toBeNull();
        expect(pickerProps[0].getComponent('I_MOT_A')).toBe('Pump');
        expect(pickerProps[0].noun).toBe('sensor');
        const input = within(line).getByLabelText('Running above this value') as HTMLInputElement;
        expect(input.value).toBe('12');
        expect(input.placeholder).toBe('e.g. 1000');
        expect(line.querySelector('.rs-val span')!.textContent).toBe('A');
        expect(line.querySelector('.rc1-pick--empty')).toBeNull();
        expect(line.className).not.toContain('rc1-row--unset');
    });

    it('picking a sensor or typing a value hands the host the whole line {sensor, value}', () => {
        const h = setup();
        const line = within(screen.getByTestId('rc-one'));
        fireEvent.click(line.getByTestId('picker'));
        expect(h.onConditionChange).toHaveBeenLastCalledWith({ sensor: 'PICKED', value: '12' });
        fireEvent.change(line.getByLabelText('Running above this value'), { target: { value: '15' } });
        expect(h.onConditionChange).toHaveBeenLastCalledWith({ sensor: 'I_MOT_A', value: '15' });
        cleanup();
        const h2 = setup({ configured: false, condition: undefined });
        fireEvent.change(screen.getByLabelText('Running above this value'), { target: { value: '7' } });
        expect(h2.onConditionChange).toHaveBeenLastCalledWith({ sensor: '', value: '7' });
    });

    it('set: one quiet note with the value and unit — the export writes the same line', () => {
        setup();
        const note = screen.getByTestId('rc-one-note');
        expect(note.className).toBe('rcx-line');
        expect(note.textContent).toBe('At or below 12 A the machine counts as stopped — those rows are left out, and the export writes the same line as the machine’s running status.');
        expect(note.querySelector('.rc1-num')!.textContent).toBe('12 A');
        expect(screen.queryByTestId('rc-unset-warning')).toBeNull();
    });

    it('not set: an empty sensor field is dashed amber, the value field is marked, and the amber line says what is missing', () => {
        setup({ configured: false, condition: undefined });
        const line = screen.getByTestId('rc-one');
        expect(line.className).toContain('rc1-row--unset');
        expect(line.querySelector('.rs-pick')!.className).toContain('rc1-pick--empty');
        expect(line.querySelector('.rs-val')!.className).toContain('rs-val--empty');
        const warn = screen.getByTestId('rc-unset-warning');
        expect(warn.className).toBe('rcx-line rcx-line--warn');
        expect(warn.textContent).toBe('Pick the sensor that shows the machine is running, and the value above which it runs — for example generator active power above 1,000 kW. No model can be trained until it is set.');
        expect(screen.queryByTestId('rc-one-note')).toBeNull();
        cleanup();
        setup({ configured: false, condition: f('f1', '', 'greater_than', '5') });
        expect(screen.getByTestId('rc-unset-warning').textContent).toBe('Pick the sensor that shows the machine is running. No model can be trained until it is set.');
        cleanup();
        setup({ configured: false, condition: f('f1', 'I_MOT_A', 'greater_than', '') });
        expect(screen.getByTestId('rc-unset-warning').textContent).toBe('Type the value above which the machine is running. No model can be trained until it is set.');
        expect(screen.getByTestId('rc-one').querySelector('.rc1-pick--empty')).toBeNull();
    });

    it('a sensor that is not in the loaded data: a red line naming it (instead of the note)', () => {
        setup({ configured: false, condition: f('f1', 'GONE_TAG', 'greater_than', '5') });
        const warn = screen.getByTestId('rc-unset-warning');
        expect(warn.className).toBe('rcx-line rcx-line--bad');
        expect(warn.textContent).toContain('GONE_TAG');
        expect(warn.textContent).toContain('is not in the loaded data — pick another sensor.');
        expect(screen.queryByTestId('rc-one-note')).toBeNull();
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
        // …and, like the workspace settings, no number of rows (2026-10-14)
        expect(screen.getByTestId('rc-caption').textContent).toBe('60 d train (about 50 d running time)15 d scoring≥ 30 d recommended');
        expect(screen.queryByTestId('rc-caption-rows')).toBeNull();
        expect(panel.textContent).not.toMatch(/14,391|25,880|56%|\d rows|rows \(/);
        expect(within(screen.getByTestId('custom-condition')).getByTestId('custom-rc-one')).toBeTruthy();
        expect(screen.queryByTestId('rc-one')).toBeNull();
    });

    it('its own sentences say "this model": heading, set note and the not-set line', () => {
        setup({ scope: 'custom' });
        expect(screen.getByTestId('custom-condition').querySelector('.rcx-sec-h span')!.textContent).toBe('only rows where the machine is running are used to train and score this model. Required.');
        expect(screen.getByTestId('rc-one-note').textContent).toBe('At or below 12 A the machine counts as stopped — those rows are left out for this model.');
        cleanup();
        setup({ scope: 'custom', configured: false, condition: undefined });
        expect(screen.getByTestId('rc-unset-warning').textContent).toMatch(/ This model can’t be trained until it is set\.$/);
        expect(screen.getByTestId('custom-rc-one').querySelector('.rc1-pick--empty')).toBeTruthy();
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
        render(<RunningConditionPills configured periodInvalid={false} {...over} />);

    it('"Required" only while the condition is not set; no count / "No condition" pill any more', () => {
        pills();
        expect(screen.queryByTestId('rc-required-pill')).toBeNull();
        expect(screen.queryByTestId('rc-count-pill')).toBeNull();
        expect(screen.queryByTestId('rc-none-pill')).toBeNull();
        cleanup();
        pills({ configured: false });
        expect(screen.getByTestId('rc-required-pill').textContent).toBe('Required');
    });

    it('"Fix period" is added while a period is invalid', () => {
        pills({ periodInvalid: true });
        expect(screen.getByTestId('rc-fix-period-pill').textContent).toBe('Fix period');
    });
});
