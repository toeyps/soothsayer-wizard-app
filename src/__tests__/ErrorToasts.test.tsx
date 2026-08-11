import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

async function freshModules() {
    vi.resetModules();
    const errorReporter = await import('../errorReporter');
    const { ErrorToasts } = await import('../components/ErrorToasts');
    return { errorReporter, ErrorToasts };
}

beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue('/logs/frontend-errors.log');
});

afterEach(() => {
    cleanup();
});

describe('ErrorToasts', () => {
    it('renders nothing when there are no errors', async () => {
        const { ErrorToasts } = await freshModules();
        const { container } = render(<ErrorToasts />);
        expect(container.firstChild).toBeNull();
    });

    it('shows a toast with the source badge and message once an error is reported', async () => {
        const { errorReporter, ErrorToasts } = await freshModules();
        render(<ErrorToasts />);
        act(() => { errorReporter.reportError('chart-data', 'fetch failed'); });
        expect(screen.getByText('chart-data')).toBeTruthy();
        expect(screen.getByText('fetch failed')).toBeTruthy();
    });

    it('shows a repeat counter once the same error recurs', async () => {
        const { errorReporter, ErrorToasts } = await freshModules();
        render(<ErrorToasts />);
        act(() => {
            errorReporter.reportError('chart-data', 'fetch failed');
            errorReporter.reportError('chart-data', 'fetch failed');
        });
        expect(screen.getByText('×2')).toBeTruthy();
    });

    it('toggles the stack-trace detail panel', async () => {
        const { errorReporter, ErrorToasts } = await freshModules();
        render(<ErrorToasts />);
        act(() => { errorReporter.reportError('chart-data', new Error('boom')); });
        expect(screen.queryByText(/Error: boom/)).toBeNull();

        fireEvent.click(screen.getByText('Details'));
        expect(screen.getByText(/Error: boom/)).toBeTruthy();

        fireEvent.click(screen.getByText('Hide details'));
        expect(screen.queryByText(/Error: boom/)).toBeNull();
    });

    it('dismissing a toast removes only that one', async () => {
        const { errorReporter, ErrorToasts } = await freshModules();
        render(<ErrorToasts />);
        act(() => { errorReporter.reportError('a', 'first'); });
        act(() => { errorReporter.reportError('b', 'second'); });
        expect(screen.getByText('first')).toBeTruthy();
        expect(screen.getByText('second')).toBeTruthy();

        fireEvent.click(screen.getAllByTitle('Dismiss')[0]); // newest-first: dismisses "second"
        expect(screen.getByText('first')).toBeTruthy();
        expect(screen.queryByText('second')).toBeNull();
    });

    it('shows "Dismiss all" only with more than one error, and it clears everything', async () => {
        const { errorReporter, ErrorToasts } = await freshModules();
        render(<ErrorToasts />);
        act(() => { errorReporter.reportError('a', 'first'); });
        expect(screen.queryByText('Dismiss all')).toBeNull();

        act(() => { errorReporter.reportError('b', 'second'); });
        expect(screen.getByText('Dismiss all')).toBeTruthy();

        fireEvent.click(screen.getByText('Dismiss all'));
        const { container } = render(<ErrorToasts />);
        expect(screen.queryByText('first')).toBeNull();
        expect(container).toBeTruthy();
    });

    it('resolves and displays the error log path once an error exists', async () => {
        const { errorReporter, ErrorToasts } = await freshModules();
        render(<ErrorToasts />);
        await act(async () => {
            errorReporter.reportError('a', 'first');
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mockInvoke).toHaveBeenCalledWith('get_error_log_path', {});
        expect(screen.getByText(/\/logs\/frontend-errors\.log/)).toBeTruthy();
    });
});
