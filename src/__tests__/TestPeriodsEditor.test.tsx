import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import TestPeriodsEditor, { nextDefaultTestPeriod, toInputValue } from '../components/windows/TestPeriodsEditor';
import type { TestPeriod, TimePeriod } from '../types';
import type { PeriodCounts } from '../types/periodCounts';
import type { PeriodCountsState } from '../utils/periodCounts';

afterEach(cleanup);

/*
 * The Scoring periods list of the Running condition modal / a Custom model's
 * settings.
 * SPEC docs/design/handoff/workbench-redesign/README.md §2 "just score it": a
 * scoring period is only start → end — no Normal / Known problem label, no
 * event time, no "From Highlights". §5: one quiet line per period (with Rust's
 * per-period running days), one reason line when invalid, no boxes.
 */

const bounds = { min: '2026-01-01 00:00:00', max: '2026-06-30 23:50:00' };
const TRAIN: TimePeriod[] = [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }];
const t = (id: string, start: string, end: string): TestPeriod => ({ id, start, end });
/** A period as a workspace saved BEFORE stored it. */
const legacy = (id: string, start: string, end: string, over: Partial<TestPeriod> = {}): TestPeriod =>
    ({ id, start, end, label: 'problem', eventTime: '2026-02-10T08:00', fromHighlight: 'Bearing trip', ...over });

function setup(over: Partial<React.ComponentProps<typeof TestPeriodsEditor>> = {}) {
    const onChange = vi.fn();
    const view = render(<TestPeriodsEditor tests={[]} train={TRAIN} onChange={onChange} bounds={bounds} {...over} />);
    return Object.assign(onChange, { view });
}

/** The editor inside a parent that keeps what it is handed, like the modal's draft. */
function Harness({ initial, onChange, onPending }: { initial: TestPeriod[]; onChange: (next: TestPeriod[]) => void; onPending?: (name: string | null) => void }) {
    const [tests, setTests] = useState(initial);
    return (
        <TestPeriodsEditor
            tests={tests}
            train={TRAIN}
            onChange={next => { onChange(next); setTests(next); }}
            bounds={bounds}
            onPendingChange={onPending}
        />
    );
}
/** `Harness` rendered; returns the `onChange` spy (and `onPending` on it). */
function live(initial: TestPeriod[]) {
    const onChange = vi.fn();
    const onPending = vi.fn();
    render(<Harness initial={initial} onChange={onChange} onPending={onPending} />);
    return Object.assign(onChange, { onPending });
}
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as TestPeriod[];

describe('TestPeriodsEditor (scoring periods)', () => {
    it('empty: one quiet grey line (not a box, not amber) — it never blocks; the verb follows the form it sits in', () => {
        setup();
        const line = screen.getByTestId('tests-empty');
        expect(line.className).toBe('rcx-line');
        expect(line.textContent).toBe('No scoring period yet — you can train and apply now; Mark complete needs at least one.');
        cleanup();
        setup({ blocks: 'save' });
        expect(screen.getByTestId('tests-empty').textContent).toBe('No scoring period yet — you can train and save now; Mark complete needs at least one.');
    });

    it('Add scoring period: 14 days starting right after the last train period — id / start / end and nothing else', () => {
        const onChange = setup();
        const add = screen.getByTestId('test-add');
        expect(add.textContent).toBe('Add scoring period');
        fireEvent.click(add);
        expect(onChange).toHaveBeenCalledTimes(1);
        const added = onChange.mock.calls[0][0][0];
        expect(added).toMatchObject({ start: '2026-02-01T00:00', end: '2026-02-15T00:00' });
        expect(Object.keys(added).sort()).toEqual(['end', 'id', 'start']);
    });

    it('nextDefaultTestPeriod clamps to the dataset end, falls back to the data start, and never writes a label', () => {
        expect(nextDefaultTestPeriod([{ id: 'a', start: '', end: '2026-06-25T00:00' }], [], bounds)).toMatchObject({ start: '2026-06-25T00:01', end: '2026-06-30T23:50' });
        expect(nextDefaultTestPeriod([{ id: 'a', start: '', end: '' }], [], bounds)).toMatchObject({ start: '2026-01-01T00:00', end: '2026-01-15T00:00' });
        expect(nextDefaultTestPeriod([], [], null)).toMatchObject({ start: '', end: '' });
        for (const p of [nextDefaultTestPeriod(TRAIN, [], bounds), nextDefaultTestPeriod([], [], null)]) {
            expect(Object.keys(p).sort()).toEqual(['end', 'id', 'start']);
        }
        expect(toInputValue('2026-03-01 06:30:00')).toBe('2026-03-01T06:30');
        expect(toInputValue('2026-03-01')).toBe('2026-03-01T00:00');
    });

    it('a row: S#, start → end, the day count, remove — and nothing that labels or judges the period', () => {
        const onChange = setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const row = screen.getByTestId('test-row-1');
        expect(row.querySelector('.tpe-pn')!.textContent).toBe('S1');
        expect((screen.getByLabelText('Scoring period 1 start') as HTMLInputElement).value).toBe('2026-02-01T00:00');
        expect((screen.getByLabelText('Scoring period 1 end') as HTMLInputElement).value).toBe('2026-02-15T00:00');
        expect(screen.getByTestId('test-days-1').textContent).toBe('14 d');
        // The removed controls: label buttons, event time, From Highlights.
        expect(row.querySelectorAll('input')).toHaveLength(2);
        // one calendar button per date field, and Remove — nothing else
        expect(within(row).getAllByLabelText('Open date picker')).toHaveLength(2);
        expect(row.querySelectorAll('button')).toHaveLength(3);
        expect(row.hasAttribute('data-label')).toBe(false);
        expect(screen.queryByText('Normal')).toBeNull();
        expect(screen.queryByText('Known problem')).toBeNull();
        expect(screen.queryByText(/event time/i)).toBeNull();
        expect(screen.queryByText(/From Highlights/i)).toBeNull();
        fireEvent.click(screen.getByLabelText('Remove scoring period 1'));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    // Real-app bug: the scoring date fields had no calendar button (the shared field style hides
    // the browser's own icon), so a scoring date could only be typed — unlike a train date.
    it('each date field has a calendar button that opens the picker of ITS field', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const start = screen.getByLabelText('Scoring period 1 start') as HTMLInputElement;
        const end = screen.getByLabelText('Scoring period 1 end') as HTMLInputElement;
        start.showPicker = vi.fn();
        end.showPicker = vi.fn();
        const [calStart, calEnd] = screen.getAllByLabelText('Open date picker');
        expect(calStart.className).toContain('f4-dtw-cal');
        fireEvent.click(calEnd);
        expect(end.showPicker).toHaveBeenCalledTimes(1);
        expect(start.showPicker).not.toHaveBeenCalled();
        fireEvent.click(calStart);
        expect(start.showPicker).toHaveBeenCalledTimes(1);
    });

    it('the calendar button falls back to focusing the field when the picker cannot open', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const start = screen.getByLabelText('Scoring period 1 start') as HTMLInputElement;
        start.showPicker = vi.fn(() => { throw new Error('not allowed'); });
        fireEvent.click(screen.getAllByLabelText('Open date picker')[0]);
        expect(document.activeElement).toBe(start);
    });

    it('the only button under the list is "Add scoring period" (no From Highlights button or menu); a row has its two calendar buttons and Remove', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const editor = screen.getByTestId('test-periods-editor');
        const buttons = Array.from(editor.querySelectorAll('button')).map(b => b.getAttribute('aria-label') ?? b.textContent);
        expect(buttons).toEqual(['Open date picker', 'Open date picker', 'Remove scoring period 1', 'Add scoring period']);
    });

    // A COMPLETE date goes to the parent on change, so
    // the timeline, the counts and the impact line follow it before Apply can be pressed.
    it('a complete typed date is handed up at once; the blur after it hands nothing up again', () => {
        const onChange = live([t('a', '2026-02-01T00:00', '2026-02-15T00:00')]);
        const end = screen.getByLabelText('Scoring period 1 end');
        fireEvent.change(end, { target: { value: '2026-02-20T00:00' } });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(lastCall(onChange)).toEqual([{ id: 'a', start: '2026-02-01T00:00', end: '2026-02-20T00:00' }]);
        fireEvent.blur(end);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('a half-typed date (the field reports "") never reaches the parent: the row is named as pending and blur / Enter put the date back', () => {
        const onChange = live([t('a', '2026-02-01T00:00', '2026-02-15T00:00'), t('b', '2026-03-01T00:00', '2026-03-10T00:00')]);
        expect(onChange.onPending).toHaveBeenLastCalledWith(null);
        const end = screen.getByLabelText('Scoring period 2 end') as HTMLInputElement;
        fireEvent.change(end, { target: { value: '' } });
        expect(onChange).not.toHaveBeenCalled();
        expect(onChange.onPending).toHaveBeenLastCalledWith('S2');
        expect(end.value).toBe('');
        // the row is judged by the date the parent has: no red "S2 needs an end date" flash
        expect(screen.queryByTestId('test-invalid-2')).toBeNull();
        expect(screen.getByTestId('test-days-2').textContent).toBe('9 d');
        // no "S2 needs an end date" is written by leaving the field
        fireEvent.blur(end);
        expect(onChange).not.toHaveBeenCalled();
        expect((screen.getByLabelText('Scoring period 2 end') as HTMLInputElement).value).toBe('2026-03-10T00:00');
        expect(onChange.onPending).toHaveBeenLastCalledWith(null);

        const start = screen.getByLabelText('Scoring period 1 start') as HTMLInputElement;
        fireEvent.change(start, { target: { value: '' } });
        fireEvent.keyDown(start, { key: 'Enter' });
        expect(onChange).not.toHaveBeenCalled();
        expect((screen.getByLabelText('Scoring period 1 start') as HTMLInputElement).value).toBe('2026-02-01T00:00');
    });

    it('a blur or Enter with nothing changed does not call onChange', () => {
        const onChange = live([t('a', '2026-02-01T00:00', '2026-02-15T00:00')]);
        const start = screen.getByLabelText('Scoring period 1 start');
        fireEvent.blur(start);
        fireEvent.keyDown(start, { key: 'Enter' });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('a half-typed field is not carried along by Add or Remove', () => {
        const onChange = live([t('a', '2026-02-01T00:00', '2026-02-15T00:00'), t('b', '2026-03-01T00:00', '2026-03-10T00:00')]);
        fireEvent.change(screen.getByLabelText('Scoring period 1 end'), { target: { value: '' } });
        fireEvent.click(screen.getByLabelText('Remove scoring period 2'));
        expect(lastCall(onChange)).toEqual([{ id: 'a', start: '2026-02-01T00:00', end: '2026-02-15T00:00' }]);
    });

    it('an invalid period: thin red edge, the field that is wrong red, and ONE reason line named by its S-number', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00'), t('b', '2026-02-15T00:00', '2026-02-01T00:00')] });
        const msg = screen.getByTestId('test-invalid-2');
        expect(msg.getAttribute('role')).toBe('alert');
        expect(msg.textContent).toBe('S2 ends before it starts — pick an end after 2026/02/15 00:00');
        const row = screen.getByTestId('test-row-2');
        expect(row.className).toContain('rcm-per--bad');
        expect(row.getAttribute('data-invalid')).toBe('true');
        expect(screen.getByLabelText('Scoring period 2 end').closest('.f4-dtw')!.className).toContain('f4-dtw--bad');
        expect(screen.getByLabelText('Scoring period 2 start').closest('.f4-dtw')!.className).not.toContain('f4-dtw--bad');
        expect(screen.getByTestId('test-days-2').textContent).toBe('—');
        // the valid row carries nothing
        expect(screen.queryByTestId('test-invalid-1')).toBeNull();
        expect(screen.getByTestId('test-row-1').className).toBe('rcm-per');
    });

    it('a missing date: the reason says which one, and THAT field is the red one (no "Fix it to apply" tail any more)', () => {
        setup({ tests: [t('a', '2026-02-15T00:00', '')] });
        expect(screen.getByTestId('test-invalid-1').textContent).toBe('S1 needs an end date');
        expect(screen.getByLabelText('Scoring period 1 end').getAttribute('aria-invalid')).toBe('true');
        cleanup();
        setup({ tests: [t('a', '', '2026-02-15T00:00')], blocks: 'save' });
        expect(screen.getByTestId('test-invalid-1').textContent).toBe('S1 needs a start date');
        expect(screen.getByLabelText('Scoring period 1 start').closest('.f4-dtw')!.className).toContain('f4-dtw--bad');
        expect(screen.getByLabelText('Scoring period 1 end').closest('.f4-dtw')!.className).not.toContain('f4-dtw--bad');
    });

    it('a scoring period that includes train time gets the one quiet grey note — never an error', () => {
        setup({ tests: [t('a', '2026-01-21T00:00', '2026-02-10T00:00')] });
        const note = screen.getByTestId('test-overlap-1');
        expect(note.className).toBe('rcm-permsg'); // one small grey line under the row
        // "hours": the health score is computed on 1-hour averages, so the results are per hour.
        expect(note.textContent).toBe('S1 includes 11 d of train running time — results include hours the model was trained on');
        expect(note.textContent).not.toMatch(/include rows/);
        expect(screen.queryByTestId('test-invalid-1')).toBeNull();
        expect(screen.getByTestId('test-row-1').className).not.toContain('rcm-per--bad');
    });

    it('less than a day of train time still gets the note, with the S-number', () => {
        setup({ tests: [t('a', '2026-01-31T20:00', '2026-02-10T00:00')] });
        // the same ending as the note with days (the two never disagree on rows / hours)
        expect(screen.getByTestId('test-overlap-1').textContent).toBe('S1 includes less than 1 d of train running time — results include hours the model was trained on');
    });

    it('no note when the scoring period does not touch train time', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-10T00:00')] });
        expect(screen.queryByTestId('test-overlap-1')).toBeNull();
    });

    it('the list is put in time order on blur (S1 is the earliest) — never while a date is being typed, so the row and the focus stay put', () => {
        const onChange = live([t('a', '2026-03-01T00:00', '2026-03-10T00:00'), t('b', '2026-04-01T00:00', '2026-04-10T00:00')]);
        const start = screen.getByLabelText('Scoring period 1 start');
        fireEvent.change(start, { target: { value: '2026-05-01T00:00' } });
        // handed up at once, still as S1 (and S1 reads "ends before it starts" until its end follows)
        expect(lastCall(onChange).map(x => x.id)).toEqual(['a', 'b']);
        expect(screen.getByLabelText('Scoring period 1 start')).toBe(start);
        fireEvent.change(screen.getByLabelText('Scoring period 1 end'), { target: { value: '2026-05-10T00:00' } });
        expect(lastCall(onChange).map(x => x.id)).toEqual(['a', 'b']);
        fireEvent.blur(start);
        expect(lastCall(onChange).map(x => x.id)).toEqual(['b', 'a']);
        expect((screen.getByLabelText('Scoring period 1 start') as HTMLInputElement).value).toBe('2026-04-01T00:00');
    });

    describe('per-period running days (count_period_rows)', () => {
        const S1 = t('a', '2026-02-01T00:00', '2026-02-15T00:00');
        const S2 = t('b', '2026-03-01T00:00', '2026-03-10T00:00');
        const scoring: PeriodCounts = {
            total_rows: 25_880, interval_secs: 300,
            periods: [
                { index: 0, start: S1.start, end: S1.end, valid: true, invalid_reason: null, rows_in_period: 4032, running_rows: 3456, running_days: 12 },
                { index: 1, start: S2.start, end: S2.end, valid: true, invalid_reason: null, rows_in_period: 2592, running_rows: 144, running_days: 0.5 },
            ],
            union: { rows_in_period: 6624, running_rows: 3600, running_days: 12.5 },
        };
        const counts = (status: PeriodCountsState['status']): PeriodCountsState =>
            ({ status, train: null, scoring: status === 'error' ? null : scoring, error: null, errorCode: null });

        it('each row reads "14 d · 12 d running" (one decimal below 10 d)', () => {
            setup({ tests: [S1, S2], counts: counts('ok') });
            expect(screen.getByTestId('test-days-1').textContent).toBe('14 d · 12 d running');
            expect(screen.getByTestId('test-days-2').textContent).toBe('9 d · 0.5 d running');
        });

        it('a new count on its way keeps the old numbers, dimmed; a failed count leaves the calendar days', () => {
            setup({ tests: [S1], counts: counts('loading') });
            const running = screen.getByTestId('test-running-1');
            expect(running.textContent).toBe(' · 12 d running');
            expect(running.getAttribute('data-stale')).toBe('true');
            cleanup();
            setup({ tests: [S1], counts: counts('error') });
            expect(screen.getByTestId('test-days-1').textContent).toBe('14 d');
        });

        it('without counts (not asked) the row shows its calendar days only', () => {
            setup({ tests: [S1] });
            expect(screen.getByTestId('test-days-1').textContent).toBe('14 d');
            expect(screen.queryByTestId('test-running-1')).toBeNull();
        });
    });

    describe('a workspace saved before 2026-10-10 (periods with label / eventTime / fromHighlight)', () => {
        const OLD = [
            legacy('a', '2026-02-01T00:00', '2026-02-15T00:00'),
            legacy('b', '2026-03-01T00:00', '2026-03-10T00:00', { label: 'normal', eventTime: undefined, fromHighlight: undefined }),
        ];

        it('renders as plain S1 / S2 rows: no label, no event time, no "From highlight" caption, no error', () => {
            setup({ tests: OLD });
            for (const n of [1, 2]) {
                const row = screen.getByTestId(`test-row-${n}`);
                expect(row.querySelector('.tpe-pn')!.textContent).toBe(`S${n}`);
                expect(row.querySelectorAll('input')).toHaveLength(2);
                expect(row.className).not.toContain('rcm-per--bad');
                expect(row.hasAttribute('data-label')).toBe(false);
            }
            const text = screen.getByTestId('test-periods-editor').textContent ?? '';
            expect(text).not.toMatch(/Known problem|Normal|event|highlight|Bearing trip/i);
        });

        it('an event time outside its period is no longer an error (the event time is ignored)', () => {
            setup({ tests: [legacy('a', '2026-02-01T00:00', '2026-02-15T00:00', { eventTime: '2026-03-01T00:00' })] });
            expect(screen.queryByRole('alert')).toBeNull();
            expect(screen.getByTestId('test-row-1').className).not.toContain('rcm-per--bad');
        });

        it('opening it and blurring a field writes nothing (dropping the legacy keys is not an edit)', () => {
            const onChange = setup({ tests: OLD });
            const end = screen.getByLabelText('Scoring period 1 end');
            fireEvent.focus(end);
            fireEvent.blur(end);
            fireEvent.keyDown(end, { key: 'Enter' });
            expect(onChange).not.toHaveBeenCalled();
        });

        it('after editing ONE period, every period handed back has only id / start / end', () => {
            const onChange = live(OLD);
            const end = screen.getByLabelText('Scoring period 1 end');
            fireEvent.change(end, { target: { value: '2026-02-20T00:00' } });
            fireEvent.blur(end);
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange.mock.calls[0][0]).toEqual([
                { id: 'a', start: '2026-02-01T00:00', end: '2026-02-20T00:00' },
                { id: 'b', start: '2026-03-01T00:00', end: '2026-03-10T00:00' },
            ]);
        });

        it('adding and removing also hand back id / start / end only', () => {
            const onChange = setup({ tests: OLD });
            fireEvent.click(screen.getByTestId('test-add'));
            for (const p of onChange.mock.calls[0][0] as TestPeriod[]) expect(Object.keys(p).sort()).toEqual(['end', 'id', 'start']);
            fireEvent.click(screen.getByLabelText('Remove scoring period 1'));
            for (const p of onChange.mock.calls[1][0] as TestPeriod[]) expect(Object.keys(p).sort()).toEqual(['end', 'id', 'start']);
        });
    });
});
