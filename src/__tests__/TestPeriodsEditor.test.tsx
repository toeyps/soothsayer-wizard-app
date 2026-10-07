import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import TestPeriodsEditor, { nextDefaultTestPeriod, toInputValue } from '../components/windows/TestPeriodsEditor';
import type { TestPeriod, TimeHighlight, TimePeriod } from '../types';

afterEach(cleanup);

/*
 * Train/Test validation (SPEC FINAL 2026-10-07, rules 3, 5, 6): the Test
 * periods list of the Running condition modal / a Custom model's settings.
 */

const bounds = { min: '2026-01-01 00:00:00', max: '2026-06-30 23:50:00' };
const TRAIN: TimePeriod[] = [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }];
const t = (id: string, start: string, end: string, over: Partial<TestPeriod> = {}): TestPeriod => ({ id, start, end, label: 'normal', ...over });
const HL: TimeHighlight[] = [
    { id: 'h1', start: '2026-03-01 00:00:00', end: '2026-03-10 00:00:00', label: 'Bearing trip', color: '#f43f5e', enabled: true },
    { id: 'h2', start: '2026-04-01 00:00:00', end: '2026-04-02 00:00:00', label: 'Hidden', color: '#888', enabled: false },
];

function setup(over: Partial<React.ComponentProps<typeof TestPeriodsEditor>> = {}) {
    const onChange = vi.fn();
    render(<TestPeriodsEditor tests={[]} train={TRAIN} onChange={onChange} highlights={HL} bounds={bounds} {...over} />);
    return onChange;
}

describe('TestPeriodsEditor', () => {
    it('empty: an amber note — you can train, Mark complete needs a test period', () => {
        setup();
        const box = screen.getByTestId('tests-empty');
        expect(box.className).toContain('rcm-none--warn');
        expect(box.textContent).toBe('No test period yet. You can train, but every model needs a test period before Mark complete.');
    });

    it('Add test period: 14 days starting right after the last train period, labelled Normal', () => {
        const onChange = setup();
        fireEvent.click(screen.getByTestId('test-add'));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0][0]).toMatchObject({ start: '2026-02-01T00:00', end: '2026-02-15T00:00', label: 'normal' });
    });

    it('nextDefaultTestPeriod clamps to the dataset end and falls back to the data start', () => {
        expect(nextDefaultTestPeriod([{ id: 'a', start: '', end: '2026-06-25T00:00' }], [], bounds)).toMatchObject({ start: '2026-06-25T00:01', end: '2026-06-30T23:50' });
        expect(nextDefaultTestPeriod([{ id: 'a', start: '', end: '' }], [], bounds)).toMatchObject({ start: '2026-01-01T00:00', end: '2026-01-15T00:00' });
        expect(nextDefaultTestPeriod([], [], null)).toMatchObject({ start: '', end: '' });
        expect(toInputValue('2026-03-01 06:30:00')).toBe('2026-03-01T06:30');
        expect(toInputValue('2026-03-01')).toBe('2026-03-01T00:00');
    });

    it('a row: T#, start → end, Normal / Known problem, the day count, remove', () => {
        const onChange = setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const row = screen.getByTestId('test-row-1');
        expect(row.textContent).toContain('T1');
        expect((screen.getByLabelText('Test period 1 start') as HTMLInputElement).value).toBe('2026-02-01T00:00');
        expect((screen.getByLabelText('Test period 1 end') as HTMLInputElement).value).toBe('2026-02-15T00:00');
        expect(screen.getByTestId('test-days-1').textContent).toBe('14 d');
        expect(screen.getByTestId('test-label-normal-1').getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByLabelText('Remove test period 1'));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    it('Known problem shows the optional event time field; Normal does not', () => {
        const onChange = setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        expect(screen.queryByLabelText('Test period 1 event time')).toBeNull();
        fireEvent.click(screen.getByTestId('test-label-problem-1'));
        expect(onChange.mock.calls[0][0][0].label).toBe('problem');
        cleanup();
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00', { label: 'problem' })] });
        expect(screen.getByLabelText('Test period 1 event time')).toBeTruthy();
        expect(screen.getByTestId('test-row-1').getAttribute('data-label')).toBe('problem');
    });

    it('dates commit on blur, not per keystroke (a half-typed date must not reach the draft)', () => {
        const onChange = setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        const end = screen.getByLabelText('Test period 1 end');
        fireEvent.change(end, { target: { value: '2026-02-20T00:00' } });
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.blur(end);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0][0].end).toBe('2026-02-20T00:00');
    });

    it('an event time outside its period is red with an inline reason (it blocks Apply upstream)', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00', { label: 'problem', eventTime: '2026-03-01T00:00' })] });
        const msg = screen.getByTestId('test-event-invalid-1');
        expect(msg.getAttribute('role')).toBe('alert');
        expect(msg.textContent).toContain('The event time must be inside T1.');
        expect(screen.getByTestId('test-row-1').className).toContain('rcm-per--bad');
        expect(screen.getByLabelText('Test period 1 event time').closest('.f4-dtw')!.className).toContain('f4-dtw--bad');
    });

    it('the inline reason names what it blocks: "to apply" (Running condition modal, default) or "to save" (a Custom model\'s settings)', () => {
        const bad = [t('a', '2026-02-01T00:00', '2026-02-15T00:00', { label: 'problem', eventTime: '2026-03-01T00:00' }), t('b', '2026-02-15T00:00', '2026-02-01T00:00')];
        setup({ tests: bad });
        expect(screen.getByTestId('test-event-invalid-1').textContent).toContain('Fix it, or clear it, to apply.');
        expect(screen.getByTestId('test-invalid-2').textContent).toContain('Fix it to apply.');
        cleanup();
        setup({ tests: bad, blocks: 'save' });
        expect(screen.getByTestId('test-event-invalid-1').textContent).toContain('Fix it, or clear it, to save.');
        expect(screen.getByTestId('test-invalid-2').textContent).toContain('Fix it to save.');
    });

    it('a valid event time inside the period shows no error', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00', { label: 'problem', eventTime: '2026-02-10T08:00' })] });
        expect(screen.queryByTestId('test-event-invalid-1')).toBeNull();
        expect(screen.getByTestId('test-row-1').className).not.toContain('rcm-per--bad');
    });

    it('an invalid period (missing end / reversed) is red with the reason', () => {
        setup({ tests: [t('a', '2026-02-15T00:00', '2026-02-01T00:00')] });
        expect(screen.getByTestId('test-invalid-1').textContent).toContain('T1 ends before it starts.');
        cleanup();
        setup({ tests: [t('a', '2026-02-15T00:00', '')] });
        expect(screen.getByTestId('test-invalid-1').textContent).toContain('T1 needs an end date.');
    });

    it('a test that includes train time gets the neutral grey note — never an error', () => {
        setup({ tests: [t('a', '2026-01-21T00:00', '2026-02-10T00:00')] });
        const note = screen.getByTestId('test-overlap-1');
        expect(note.className).toContain('tpe-info');
        expect(note.textContent).toBe('T1 includes 11 d of train running time — results include rows the model was trained on.');
        expect(screen.queryByTestId('test-invalid-1')).toBeNull();
    });

    it('no note when the test does not touch train time', () => {
        setup({ tests: [t('a', '2026-02-01T00:00', '2026-02-10T00:00')] });
        expect(screen.queryByTestId('test-overlap-1')).toBeNull();
    });

    it('From Highlights: lists the ENABLED highlights; picking one copies its range with the chosen label', () => {
        const onOpen = vi.fn();
        const onChange = setup({ onHighlightsMenuOpen: onOpen });
        fireEvent.click(screen.getByTestId('test-from-hl'));
        expect(onOpen).toHaveBeenCalledTimes(1);
        const menu = screen.getByTestId('test-hl-menu');
        expect(within(menu).getByText('Bearing trip')).toBeTruthy();
        expect(within(menu).queryByText('Hidden')).toBeNull(); // disabled highlight
        fireEvent.click(screen.getByTestId('test-hl-problem-h1'));
        expect(onChange.mock.calls[0][0][0]).toMatchObject({
            start: '2026-03-01T00:00', end: '2026-03-10T00:00', label: 'problem', fromHighlight: 'Bearing trip',
        });
        expect(screen.queryByTestId('test-hl-menu')).toBeNull();
    });

    it('a highlight already used as a test period offers no buttons; "From highlight" is shown on the row', () => {
        setup({ tests: [t('a', '2026-03-01T00:00', '2026-03-10T00:00', { fromHighlight: 'Bearing trip' })] });
        expect(screen.getByTestId('test-row-1').textContent).toContain('From highlight “Bearing trip”');
        fireEvent.click(screen.getByTestId('test-from-hl'));
        expect(screen.getByTestId('test-hl-item-h1').textContent).toContain('already a test period');
        expect(screen.queryByTestId('test-hl-normal-h1')).toBeNull();
    });

    it('From Highlights is disabled when the Dashboard has no (enabled) highlight', () => {
        setup({ highlights: [] });
        const btn = screen.getByTestId('test-from-hl') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.title).toBe('No highlights on the Dashboard yet');
    });

    it('the list stays in time order (T1 is the earliest)', () => {
        const onChange = setup({ tests: [t('b', '2026-04-01T00:00', '2026-04-10T00:00')] });
        fireEvent.click(screen.getByTestId('test-from-hl'));
        fireEvent.click(screen.getByTestId('test-hl-normal-h1'));
        expect(onChange.mock.calls[0][0].map((x: TestPeriod) => x.start)).toEqual(['2026-03-01T00:00', '2026-04-01T00:00']);
    });

    it('compact variant (Custom model settings) uses the narrow layout', () => {
        setup({ compact: true, tests: [t('a', '2026-02-01T00:00', '2026-02-15T00:00')] });
        expect(screen.getByTestId('test-periods-editor').className).toContain('tpe-periods--compact');
    });
});
