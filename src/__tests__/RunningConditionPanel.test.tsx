import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// The real picker lives in the heavy PredictiveModelBuild module; this panel
// only needs "a sensor field with a label" (its own behaviour is tested there).
vi.mock('../components/windows/PredictiveModelBuild', () => ({
    SensorPickerModal: (props: { value?: string; mutedTag?: boolean }) => (
        <button data-testid="picker" data-muted={String(!!props.mutedTag)}>{props.value}</button>
    ),
}));

import RunningConditionPanel from '../components/windows/RunningConditionPanel';
import type { WorkspaceSensorFilter } from '../types';

afterEach(cleanup);

const bounds = { min: '2025-01-01 00:00:00', max: '2026-03-31 23:50:00' };
const p = (id: string, start: string, end: string) => ({ id, start, end });
const P3 = [
    p('a', '2025-01-01T00:00', '2025-02-28T23:59'),
    p('b', '2025-06-01T00:00', '2025-07-31T23:59'),
    p('c', '2025-11-03T06:00', '2025-12-19T18:00'),
];
const f = (id: string, sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string): WorkspaceSensorFilter =>
    ({ id, sensor, operation, value1, value2: '' });
const COND = [f('f1', 'I_MOT_A', 'greater_than', '12'), f('f2', 'PT_2041', 'greater_than', '2.4')];
const desc = (t: string) => ({ I_MOT_A: 'Motor current', PT_2041: 'Pump pressure' } as Record<string, string>)[t] ?? '';

function setup(over: Partial<React.ComponentProps<typeof RunningConditionPanel>> = {}) {
    const handlers = {
        onToggle: vi.fn(), onPeriodsChange: vi.fn(), onNoneChange: vi.fn(), onCombineChange: vi.fn(),
        onAddFilter: vi.fn(), onUpdateFilter: vi.fn(), onRemoveFilter: vi.fn(),
    };
    render(
        <RunningConditionPanel
            open={false}
            configured
            periods={P3}
            bounds={bounds}
            filters={COND}
            combine="and"
            noneConfirmed={false}
            sensors={['I_MOT_A', 'PT_2041']}
            getDesc={desc}
            getComponent={() => 'Pump'}
            {...handlers}
            {...over}
        />,
    );
    return handlers;
}

describe('RunningConditionPanel - collapsed header (approved mockup)', () => {
    it('shows the first two periods as chips, "+1 more", then the condition summary and a "2 conditions" pill', () => {
        setup();
        const head = screen.getByTestId('rc-summary');
        expect(within(head).getAllByTestId('period-chip').map(c => c.textContent)).toEqual(['1 Jan – 28 Feb 2025', '1 Jun – 31 Jul 2025']);
        expect(within(head).getByTestId('period-chips-more').textContent).toBe('+1 more');
        expect(head.textContent).toContain('Motor current > 12 AND Pump pressure > 2.4');
        expect(screen.getByTestId('rc-panel').textContent).toContain('2 conditions');
        expect(screen.getByTestId('rc-panel').className).toContain('f4-rc--set');
        expect(screen.queryByTestId('rc-required-pill')).toBeNull();
    });

    it('Match OR joins the summary with OR', () => {
        setup({ combine: 'or' });
        expect(screen.getByTestId('rc-summary').textContent).toContain('Motor current > 12 OR Pump pressure > 2.4');
    });

    it('no periods: "Any time ·" instead of chips', () => {
        setup({ periods: [] });
        expect(screen.getByTestId('rc-summary').textContent).toContain('Any time ·');
        expect(screen.queryAllByTestId('period-chip')).toHaveLength(0);
    });

    it('"No condition" reads as a grey pill and "every row in the periods"', () => {
        setup({ noneConfirmed: true });
        expect(screen.getByTestId('rc-summary').textContent).toContain('No condition — every row in the periods');
        const pill = screen.getByTestId('rc-panel').querySelector('.f4-pill--grey');
        expect(pill!.textContent).toBe('No condition');
    });

    it('unset: amber panel, warn icon state, "Required" pill and the warn-coloured hint', () => {
        setup({ configured: false, filters: [], periods: [] });
        expect(screen.getByTestId('rc-panel').className).toContain('f4-rc--req');
        expect(screen.getByTestId('rc-required-pill').textContent).toBe('Required');
        expect(screen.getByTestId('rc-summary').querySelector('.f4-hline-cx--warn')!.textContent).toMatch(/^Not set — add a condition/);
    });

    it('an invalid period adds a red "Fix period" pill and keeps invalid ones out of the chips', () => {
        setup({ periods: [P3[0], p('x', '2025-06-01T00:00', '2025-05-20T23:59')] });
        expect(screen.getByTestId('rc-fix-period-pill').textContent).toBe('Fix period');
        expect(screen.getAllByTestId('period-chip')).toHaveLength(1);
    });

    it('the header toggles on click and on Enter / Space, and exposes aria-expanded', () => {
        const h = setup();
        const header = screen.getByRole('button', { name: /Running Condition Filter/ });
        expect(header.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(header);
        fireEvent.keyDown(header, { key: 'Enter' });
        fireEvent.keyDown(header, { key: ' ' });
        expect(h.onToggle).toHaveBeenCalledTimes(3);
    });
});

describe('RunningConditionPanel - expanded (approved mockup)', () => {
    it('Training periods block: title, count badge and the helper text', () => {
        setup({ open: true });
        const blk = screen.getByTestId('rc-periods');
        expect(blk.textContent).toContain('Training periods');
        expect(blk.querySelector('.f4-count')!.textContent).toBe('3');
        expect(blk.textContent).toContain('optional · a row inside any period is used · none = full dataset');
        expect(within(blk).getByTestId('period-coverage-days').textContent).toBe('166 of 455 days used');
        expect(within(blk).getAllByTestId(/^period-row-/)).toHaveLength(3);
    });

    it('Running condition block: "N conditions" pill, "required to build" hint, full-width segmented switch', () => {
        setup({ open: true });
        const panel = screen.getByTestId('rc-panel');
        expect(panel.textContent).toContain('required to build · applied inside the periods above');
        const seg = screen.getByRole('group', { name: 'Condition mode' });
        expect(seg.className).toContain('f4-seg--full');
        expect(within(seg).getByRole('button', { name: 'Filter by condition' }).getAttribute('aria-pressed')).toBe('true');
        expect(within(seg).getByRole('button', { name: 'No condition — use all rows' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('Match AND/OR with the "periods always combine with OR" note; toggling reports the mode', () => {
        const h = setup({ open: true });
        expect(screen.getByText('— value conditions only; periods always combine with OR')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'OR' }));
        expect(h.onCombineChange).toHaveBeenCalledWith('or');
    });

    it('conditions are bordered cards: sensor field (muted tag), operator, value, remove', () => {
        const h = setup({ open: true });
        const cards = document.querySelectorAll('.f4-cond');
        expect(cards).toHaveLength(2);
        expect((screen.getAllByTestId('picker')[0]).getAttribute('data-muted')).toBe('true');
        expect(screen.getAllByLabelText('Operator')).toHaveLength(2);
        fireEvent.change(screen.getAllByPlaceholderText('val')[0], { target: { value: '15' } });
        expect(h.onUpdateFilter).toHaveBeenCalledWith('f1', { value1: '15' });
        fireEvent.click(screen.getAllByLabelText('Remove condition')[1]);
        expect(h.onRemoveFilter).toHaveBeenCalledWith('f2');
        fireEvent.click(screen.getByText('Add condition'));
        expect(h.onAddFilter).toHaveBeenCalledTimes(1);
    });

    it('"between" shows a second value field', () => {
        setup({ open: true, filters: [{ ...f('f1', 'I_MOT_A', 'between', '1'), value2: '5' }] });
        expect(screen.getByPlaceholderText('max')).toBeTruthy();
    });

    it('the rule line and the "default for every model" footer are shown', () => {
        setup({ open: true });
        expect(screen.getByTestId('rule-formula').textContent).toContain('P1ORP2ORP3');
        expect(screen.getByText('Default for every model — override per model on its own Build page.')).toBeTruthy();
        expect(screen.getByText('Workspace default for every model. A model can override all of it on its own Build page (Custom).')).toBeTruthy();
    });

    it('"No condition": dashed box explaining the periods still limit the time, a Confirmed pill, no condition rows', () => {
        setup({ open: true, noneConfirmed: true });
        const note = screen.getByTestId('rc-none-note');
        expect(note.textContent).toContain('Every row inside the training periods is used, idle time included.');
        expect(note.textContent).toContain('The 3 periods above still limit the time.');
        expect(screen.getByText('✓ Confirmed').className).toContain('f4-pill--ok');
        expect(screen.queryByText('Add condition')).toBeNull();
        expect(screen.getByTestId('rule-formula').textContent).toContain('no condition (every row)');
    });

    it('"No condition" with no periods says it means the full dataset; saved conditions are noted as kept', () => {
        setup({ open: true, noneConfirmed: true, periods: [] });
        expect(screen.getByTestId('rc-none-note').textContent).toContain('No periods are set, so that means the full dataset.');
        expect(screen.getByTestId('rc-none-note').textContent).toContain('Your saved conditions are kept but not applied.');
    });

    it('the segmented switch reports the chosen side once (no-op on the active side)', () => {
        const h = setup({ open: true });
        fireEvent.click(screen.getByRole('button', { name: 'Filter by condition' }));
        expect(h.onNoneChange).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'No condition — use all rows' }));
        expect(h.onNoneChange).toHaveBeenCalledWith(true);
    });

    it('an invalid period shows the red reason under the rule line', () => {
        setup({ open: true, periods: [P3[0], p('x', '2025-06-01T00:00', '2025-05-20T23:59')] });
        expect(screen.getByTestId('rc-invalid-reason').textContent).toContain("Period 2 is invalid — models that follow the workspace can't be built until it's fixed.");
    });

    it('unset: the body shows Required in the Running condition block too, and an empty rule line', () => {
        setup({ open: true, configured: false, filters: [], periods: [] });
        expect(screen.getByTestId('rc-required-pill-inline').textContent).toBe('Required');
        expect(screen.getByTestId('rule-formula').textContent).toContain('no condition yet');
        expect(screen.getByTestId('periods-empty')).toBeTruthy();
    });

    it('Add condition is disabled with no sensors to pick from', () => {
        setup({ open: true, sensors: [] });
        expect((screen.getByText('Add condition').closest('button') as HTMLButtonElement).disabled).toBe(true);
    });
});
