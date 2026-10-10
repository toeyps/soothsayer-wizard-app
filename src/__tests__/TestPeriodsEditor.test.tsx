import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TestPeriodsEditor, { nextDefaultTestPeriod, toInputValue } from '../components/windows/TestPeriodsEditor';
import type { TestPeriod, TimePeriod } from '../types';

afterEach(cleanup);

/*
 * The Scoring periods list of the Running condition modal / a Custom model's
 * settings ("test periods" until 2026-10-10; the component keeps its name).
 * SPEC docs/design/handoff/workbench-redesign/README.md §2 "just score it": a
 * scoring period is only start → end — no Normal / Known problem label, no
 * event time, no "From Highlights".
 */

const bounds = { min: '2026-01-01 00:00:00', max: '2026-06-30 23:50:00' };
const TRAIN: TimePeriod[] = [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }];
const t = (id: string, start: string, end: string): TestPeriod => ({ id, start, end });
/** A period as a workspace saved BEFORE 2026-10-10 stored it. */
const legacy = (id: string, start: string, end: string, over: Partial<TestPeriod> = {}): TestPeriod =>
    ({ id, start, end, label: 'problem', eventTime: '2026-02-10T08:00', fromHighlight: 'Bearing trip', ...over });

function setup(over: Partial<React.ComponentProps<typeof TestPeriodsEditor>> = {}) {
    const onChange = vi.fn();
    const view = render(<TestPeriodsEditor tests={[]} train={TRAIN} onChange={onChange} bounds={bounds} {...over} />);
    return Object.assign(onChange, { view });
}

describe('TestPeriodsEditor (scoring periods)', () => {
    it('empty: an amber note — you can train, Mark complete needs a scoring period', () => {
        setup();
        const box = screen.getByTestId('tests-empty');
        expect(box.className).toContain('rcm-none--warn');
        expect(box.textContent).toBe('No scoring period yet. You can train, but every model needs a scoring period before Mark complete.');
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
        expect(row.querySelectorAll('button')).toHaveLength(1);
        expect(row.hasAttribute('data-label')).toBe(false);
        expect(screen.queryByText('Normal')).toBeNull();
        expect(screen.queryByText('Known problem')).toBeNull();
        expect(screen.queryByText(/event time/i)).toBeNull();
        expect(screen.queryByText(/From Highlights/i)).toBeNull();
        fireEvent.click(screen.getByLabelText('Remove scoring period 1'));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    it('the only button under the list is "Add scoring period" (no From Highlights button or menu)', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const editor = screen.getByTestId('test-periods-editor');
        const buttons = Array.from(editor.querySelectorAll('button')).map(b => b.getAttribute('aria-label') ?? b.textContent);
        expect(buttons).toEqual(['Remove scoring period 1', 'Add scoring period']);
    });

    it('dates commit on blur, not per keystroke (a half-typed date must not reach the draft)', () => {
        const onChange = setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const end = screen.getByLabelText('Scoring period 1 end');
        fireEvent.change(end, { target: { value: '2026-02-20T00:00' } });
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.blur(end);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toEqual([{ id: 'a', start: '2026-02-01T00:00', end: '2026-02-20T00:00' }]);
    });

    it('Enter commits too; a blur with nothing changed does not call onChange', () => {
        const onChange = setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const start = screen.getByLabelText('Scoring period 1 start');
        fireEvent.blur(start);
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.change(start, { target: { value: '2026-02-02T00:00' } });
        fireEvent.keyDown(start, { key: 'Enter' });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0][0].start).toBe('2026-02-02T00:00');
    });

    it('the inline reason names what it blocks: "to apply" (Running condition modal, default) or "to save" (a Custom model\'s settings)', () => {
        const bad = [t('a', '2026-02-01T00:00', '2026-02-15T00:00'), t('b', '2026-02-15T00:00', '2026-02-01T00:00')];
        setup({ tests: bad });
        expect(screen.getByTestId('test-invalid-2').textContent).toContain('Fix it to apply.');
        expect(screen.queryByTestId('test-invalid-1')).toBeNull();
        cleanup();
        setup({ tests: bad, blocks: 'save' });
        expect(screen.getByTestId('test-invalid-2').textContent).toContain('Fix it to save.');
    });

    it('an invalid period (missing end / reversed) is red with the reason, named by its S-number', () => {
        setup({ tests: [t('a', '2026-02-15T00:00', '2026-02-01T00:00')] });
        const msg = screen.getByTestId('test-invalid-1');
        expect(msg.getAttribute('role')).toBe('alert');
        expect(msg.textContent).toContain('S1 ends before it starts.');
        expect(screen.getByTestId('test-row-1').className).toContain('rcm-per--bad');
        expect(screen.getByLabelText('Scoring period 1 end').closest('.f4-dtw')!.className).toContain('f4-dtw--bad');
        cleanup();
        setup({ tests: [t('a', '2026-02-15T00:00', '')] });
        expect(screen.getByTestId('test-invalid-1').textContent).toContain('S1 needs an end date.');
    });

    it('a scoring period that includes train time gets the one quiet grey note — never an error', () => {
        setup({ tests: [t('a', '2026-01-21T00:00', '2026-02-10T00:00')] });
        const note = screen.getByTestId('test-overlap-1');
        expect(note.className).toContain('tpe-info');
        expect(note.textContent).toBe('S1 includes 11 d of train running time — results include rows the model was trained on.');
        expect(screen.queryByTestId('test-invalid-1')).toBeNull();
        expect(screen.getByTestId('test-row-1').className).not.toContain('rcm-per--bad');
    });

    it('less than a day of train time still gets the note, with the S-number', () => {
        setup({ tests: [t('a', '2026-01-31T20:00', '2026-02-10T00:00')] });
        expect(screen.getByTestId('test-overlap-1').textContent).toBe('S1 includes less than 1 d of train running time — results include rows the model was trained on.');
    });

    it('no note when the scoring period does not touch train time', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-10T00:00')] });
        expect(screen.queryByTestId('test-overlap-1')).toBeNull();
    });

    it('the list stays in time order (S1 is the earliest)', () => {
        const onChange = setup({ tests: [t('a', '2026-03-01T00:00', '2026-03-10T00:00'), t('b', '2026-04-01T00:00', '2026-04-10T00:00')] });
        const start = screen.getByLabelText('Scoring period 1 start');
        fireEvent.change(start, { target: { value: '2026-05-01T00:00' } });
        fireEvent.change(screen.getByLabelText('Scoring period 1 end'), { target: { value: '2026-05-10T00:00' } });
        fireEvent.blur(start);
        expect(onChange.mock.calls[0][0].map((x: TestPeriod) => x.id)).toEqual(['b', 'a']);
        expect((screen.getByLabelText('Scoring period 1 start') as HTMLInputElement).value).toBe('2026-04-01T00:00');
    });

    it('compact variant (Custom model settings) uses the narrow layout', () => {
        setup({ compact: true, tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        expect(screen.getByTestId('test-periods-editor').className).toContain('tpe-periods--compact');
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
            const onChange = setup({ tests: OLD });
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
