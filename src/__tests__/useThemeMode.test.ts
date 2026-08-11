import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useThemeMode } from '../hooks/useThemeMode';

afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
});

describe('useThemeMode', () => {
    it('defaults to "dark" when data-theme is absent', () => {
        const { result } = renderHook(() => useThemeMode());
        expect(result.current).toBe('dark');
    });

    it('reads the initial data-theme attribute if already set to "light"', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        const { result } = renderHook(() => useThemeMode());
        expect(result.current).toBe('light');
    });

    it('updates when data-theme changes on the document element', async () => {
        const { result } = renderHook(() => useThemeMode());
        expect(result.current).toBe('dark');

        act(() => {
            document.documentElement.setAttribute('data-theme', 'light');
        });
        await waitFor(() => expect(result.current).toBe('light'));

        act(() => {
            document.documentElement.setAttribute('data-theme', 'dark');
        });
        await waitFor(() => expect(result.current).toBe('dark'));
    });

    it('treats any non-"light" value as dark', async () => {
        const { result } = renderHook(() => useThemeMode());
        act(() => {
            document.documentElement.setAttribute('data-theme', 'something-else');
        });
        await waitFor(() => expect(result.current).toBe('dark'));
    });
});
