import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import UndoToastStack from '../components/dashboard/UndoToastStack';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('UndoToastStack fade-out', () => {
    const toasts = [{ id: 'a', message: 'Model deleted' }];

    it('sets data-leaving 160 ms before it expires, then expires', () => {
        vi.useFakeTimers();
        const onExpire = vi.fn();
        render(<UndoToastStack toasts={toasts} onUndo={vi.fn()} onExpire={onExpire} durationMs={1000} />);
        const toast = screen.getByTestId('fg-undo-toast');
        act(() => { vi.advanceTimersByTime(839); });
        expect(toast.hasAttribute('data-leaving')).toBe(false);
        act(() => { vi.advanceTimersByTime(1); });
        expect(toast.hasAttribute('data-leaving')).toBe(true);
        expect(onExpire).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(160); });
        expect(onExpire).toHaveBeenCalledWith('a');
    });

    it('Undo still acts at once (no wait for the fade)', () => {
        const onUndo = vi.fn();
        render(<UndoToastStack toasts={toasts} onUndo={onUndo} onExpire={vi.fn()} durationMs={7000} />);
        fireEvent.click(screen.getByText('Undo'));
        expect(onUndo).toHaveBeenCalledWith('a');
    });
});
