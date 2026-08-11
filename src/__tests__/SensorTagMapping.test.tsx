import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SensorTagMapping from '../components/upload/SensorTagMapping';

describe('SensorTagMapping', () => {
    it('lists every header as a select option', () => {
        render(
            <SensorTagMapping
                headers={['Tag', 'Description']}
                keyColumn={null}
                isLoading={false}
                onSetKeyColumn={vi.fn()}
                onApply={vi.fn()}
            />,
        );
        expect(screen.getByText('Tag')).toBeTruthy();
        expect(screen.getByText('Description')).toBeTruthy();
    });

    it('selecting a column calls onSetKeyColumn', () => {
        const onSetKeyColumn = vi.fn();
        render(
            <SensorTagMapping
                headers={['Tag', 'Description']}
                keyColumn={null}
                isLoading={false}
                onSetKeyColumn={onSetKeyColumn}
                onApply={vi.fn()}
            />,
        );
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Tag' } });
        expect(onSetKeyColumn).toHaveBeenCalledWith('Tag');
    });

    it('Apply Mapping is disabled until a key column is chosen', () => {
        const { rerender } = render(
            <SensorTagMapping
                headers={['Tag']}
                keyColumn={null}
                isLoading={false}
                onSetKeyColumn={vi.fn()}
                onApply={vi.fn()}
            />,
        );
        expect((screen.getByText('Apply Mapping') as HTMLButtonElement).disabled).toBe(true);

        rerender(
            <SensorTagMapping
                headers={['Tag']}
                keyColumn="Tag"
                isLoading={false}
                onSetKeyColumn={vi.fn()}
                onApply={vi.fn()}
            />,
        );
        expect((screen.getByText('Apply Mapping') as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows a loading state and disables the button while applying', () => {
        render(
            <SensorTagMapping
                headers={['Tag']}
                keyColumn="Tag"
                isLoading
                onSetKeyColumn={vi.fn()}
                onApply={vi.fn()}
            />,
        );
        expect(screen.getByText('Applying...')).toBeTruthy();
        expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('clicking Apply Mapping calls onApply', () => {
        const onApply = vi.fn();
        render(
            <SensorTagMapping
                headers={['Tag']}
                keyColumn="Tag"
                isLoading={false}
                onSetKeyColumn={vi.fn()}
                onApply={onApply}
            />,
        );
        fireEvent.click(screen.getByText('Apply Mapping'));
        expect(onApply).toHaveBeenCalled();
    });
});
