import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockMenuItemNew = vi.fn(async (opts: any) => ({ ...opts, __kind: 'MenuItem' }));
const mockPredefinedNew = vi.fn(async (opts: any) => ({ ...opts, __kind: 'Predefined' }));
const mockSubmenuNew = vi.fn(async (opts: any) => ({ ...opts, __kind: 'Submenu' }));
const mockSetAsAppMenu = vi.fn().mockResolvedValue(undefined);
const mockSetAsWindowMenu = vi.fn().mockResolvedValue(undefined);
const mockMenuNew = vi.fn(async (opts: any) => ({
    ...opts,
    setAsAppMenu: mockSetAsAppMenu,
    setAsWindowMenu: mockSetAsWindowMenu,
}));
const mockGetCurrentWindow = vi.fn(() => ({ label: 'main' }));

vi.mock('@tauri-apps/api/menu', () => ({
    Menu: { new: (opts: any) => mockMenuNew(opts) },
    Submenu: { new: (opts: any) => mockSubmenuNew(opts) },
    MenuItem: { new: (opts: any) => mockMenuItemNew(opts) },
    PredefinedMenuItem: { new: (opts: any) => mockPredefinedNew(opts) },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => mockGetCurrentWindow(),
}));

import { useAppMenu } from '../hooks/useAppMenu';
import type { AppMenuHandlers } from '../hooks/useAppMenu';

function findSubmenu(menuOpts: any, text: string) {
    return menuOpts.items.find((s: any) => s.text === text);
}
function findItem(submenu: any, id: string) {
    return submenu.items.find((i: any) => i?.id === id);
}

function makeHandlers(overrides: Partial<AppMenuHandlers> = {}): AppMenuHandlers {
    return {
        hasWorkspace: false,
        onNew: vi.fn(),
        onCloseWorkspace: vi.fn(),
        onRename: vi.fn(),
        onAbout: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    mockMenuItemNew.mockClear();
    mockPredefinedNew.mockClear();
    mockSubmenuNew.mockClear();
    mockMenuNew.mockClear();
    mockSetAsAppMenu.mockClear();
    mockSetAsWindowMenu.mockClear().mockResolvedValue(undefined);
    mockGetCurrentWindow.mockClear();
});

describe('useAppMenu', () => {
    it('builds a File/Edit/Help menu and installs it as the app + window menu', async () => {
        renderHook(() => useAppMenu(makeHandlers()));
        await waitFor(() => expect(mockSetAsAppMenu).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        expect(['File', 'Edit', 'Help']).toEqual(
            built.items.map((s: any) => s.text),
        );
        expect(mockSetAsWindowMenu).toHaveBeenCalledWith(mockGetCurrentWindow());
    });

    it('disables Close Workspace / Rename Workspace when hasWorkspace is false', async () => {
        renderHook(() => useAppMenu(makeHandlers({ hasWorkspace: false })));
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        const closeItem = findItem(findSubmenu(built, 'File'), 'menu-close-ws');
        const renameItem = findItem(findSubmenu(built, 'Edit'), 'menu-rename');
        expect(closeItem.enabled).toBe(false);
        expect(renameItem.enabled).toBe(false);
    });

    it('enables Close Workspace / Rename Workspace when hasWorkspace is true', async () => {
        renderHook(() => useAppMenu(makeHandlers({ hasWorkspace: true })));
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        const closeItem = findItem(findSubmenu(built, 'File'), 'menu-close-ws');
        const renameItem = findItem(findSubmenu(built, 'Edit'), 'menu-rename');
        expect(closeItem.enabled).toBe(true);
        expect(renameItem.enabled).toBe(true);
    });

    it('rebuilds only when hasWorkspace changes, not on every render', async () => {
        const { rerender } = renderHook(
            ({ handlers }) => useAppMenu(handlers),
            { initialProps: { handlers: makeHandlers({ hasWorkspace: false }) } },
        );
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        // Same hasWorkspace value, new handler function identities.
        rerender({ handlers: makeHandlers({ hasWorkspace: false }) });
        expect(mockMenuNew).toHaveBeenCalledTimes(1);

        rerender({ handlers: makeHandlers({ hasWorkspace: true }) });
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(2));
    });

    it('menu item actions always call the latest handler via ref, even without a rebuild', async () => {
        const firstOnNew = vi.fn();
        const { rerender } = renderHook(
            ({ handlers }) => useAppMenu(handlers),
            { initialProps: { handlers: makeHandlers({ hasWorkspace: false, onNew: firstOnNew }) } },
        );
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));
        const builtItem = findItem(
            findSubmenu(mockMenuNew.mock.calls[0][0], 'File'),
            'menu-new',
        );

        const secondOnNew = vi.fn();
        rerender({ handlers: makeHandlers({ hasWorkspace: false, onNew: secondOnNew }) });
        expect(mockMenuNew).toHaveBeenCalledTimes(1); // no rebuild — hasWorkspace unchanged

        builtItem.action();
        expect(firstOnNew).not.toHaveBeenCalled();
        expect(secondOnNew).toHaveBeenCalledTimes(1);
    });

    it('swallows a setAsWindowMenu failure (macOS: per-window menu unsupported)', async () => {
        mockSetAsWindowMenu.mockRejectedValueOnce(new Error('not supported'));
        renderHook(() => useAppMenu(makeHandlers()));
        await waitFor(() => expect(mockSetAsAppMenu).toHaveBeenCalledTimes(1));
        // No unhandled rejection / thrown error should escape the hook.
    });
});
