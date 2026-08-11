import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

import ErrorBoundary from '../components/ErrorBoundary';

function Bomb(): never {
    throw new Error('kaboom');
}

beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue('/logs/frontend-errors.log');
    // React logs the caught error to console.error — silence it so the
    // test output isn't flooded with the expected stack trace.
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
    it('renders children normally when nothing throws', () => {
        render(<ErrorBoundary><div>All good</div></ErrorBoundary>);
        expect(screen.getByText('All good')).toBeTruthy();
    });

    it('catches a render crash and shows the fallback UI with the error message', () => {
        render(<ErrorBoundary><Bomb /></ErrorBoundary>);
        expect(screen.getByText(/Something went wrong/)).toBeTruthy();
        expect(screen.getByText('kaboom')).toBeTruthy();
    });

    it('resolves and displays the error log path', async () => {
        await act(async () => {
            render(<ErrorBoundary><Bomb /></ErrorBoundary>);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mockInvoke).toHaveBeenCalledWith('get_error_log_path', {});
        expect(screen.getByText(/frontend-errors\.log/)).toBeTruthy();
    });

    it('Reload app reloads the window', () => {
        const reloadSpy = vi.fn();
        const originalLocation = window.location;
        Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload: reloadSpy } });

        render(<ErrorBoundary><Bomb /></ErrorBoundary>);
        fireEvent.click(screen.getByText('Reload app'));
        expect(reloadSpy).toHaveBeenCalled();

        Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    });

    it('Copy details writes the error text to the clipboard and shows confirmation', async () => {
        vi.useFakeTimers();
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

        render(<ErrorBoundary><Bomb /></ErrorBoundary>);
        await act(async () => {
            fireEvent.click(screen.getByText('Copy details'));
            await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Error: kaboom'));
        expect(screen.getByText('Copied!')).toBeTruthy();

        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(screen.getByText('Copy details')).toBeTruthy();
        vi.useRealTimers();
    });
});
