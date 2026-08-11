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
const mockGetCurrentWindow = vi.fn(() => ({ label: 'sub', close: vi.fn().mockResolvedValue(undefined) }));

const mockGetByLabel = vi.fn();
const mockWebviewCtor = vi.fn();
const mockListen = vi.fn().mockResolvedValue(vi.fn());
const mockEmit = vi.fn().mockResolvedValue(undefined);
const mockMessage = vi.fn().mockResolvedValue(undefined);

const mockLoadWorkspaceData = vi.fn();
const mockSaveWorkspaceData = vi.fn().mockResolvedValue(undefined);
const mockRenameWorkspaceFile = vi.fn().mockResolvedValue(undefined);

vi.mock('@tauri-apps/api/menu', () => ({
    Menu: { new: (opts: any) => mockMenuNew(opts) },
    Submenu: { new: (opts: any) => mockSubmenuNew(opts) },
    MenuItem: { new: (opts: any) => mockMenuItemNew(opts) },
    PredefinedMenuItem: { new: (opts: any) => mockPredefinedNew(opts) },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => mockGetCurrentWindow(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class {
        constructor(...args: unknown[]) { mockWebviewCtor(...args); }
        static getByLabel = (...args: unknown[]) => mockGetByLabel(...args);
        once = vi.fn();
    },
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: (...args: unknown[]) => mockListen(...args),
    emit: (...args: unknown[]) => mockEmit(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: (...args: unknown[]) => mockMessage(...args),
}));

vi.mock('../workspaceManager', () => ({
    loadWorkspaceData: (...args: unknown[]) => mockLoadWorkspaceData(...args),
    saveWorkspaceData: (...args: unknown[]) => mockSaveWorkspaceData(...args),
    renameWorkspaceFile: (...args: unknown[]) => mockRenameWorkspaceFile(...args),
}));

import { useSubWindowMenu } from '../hooks/useSubWindowMenu';
import type { SubWindowMenuHandlers } from '../hooks/useSubWindowMenu';

function findSubmenu(menuOpts: any, text: string) {
    return menuOpts.items.find((s: any) => s.text === text);
}
function findItem(submenu: any, id: string) {
    return submenu.items.find((i: any) => i?.id === id);
}

function makeHandlers(overrides: Partial<SubWindowMenuHandlers> = {}): SubWindowMenuHandlers {
    return {
        workspaceId: null,
        onToggleTheme: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockMenuNew.mockImplementation(async (opts: any) => ({
        ...opts,
        setAsAppMenu: mockSetAsAppMenu,
        setAsWindowMenu: mockSetAsWindowMenu,
    }));
    mockSetAsAppMenu.mockResolvedValue(undefined);
    mockSetAsWindowMenu.mockResolvedValue(undefined);
    mockGetCurrentWindow.mockReturnValue({ label: 'sub', close: vi.fn().mockResolvedValue(undefined) });
    mockListen.mockResolvedValue(vi.fn());
    mockEmit.mockResolvedValue(undefined);
    mockMessage.mockResolvedValue(undefined);
    mockSaveWorkspaceData.mockResolvedValue(undefined);
    mockRenameWorkspaceFile.mockResolvedValue(undefined);
});

describe('useSubWindowMenu', () => {
    it('builds a File/Edit/View/Help menu and installs it', async () => {
        renderHook(() => useSubWindowMenu(makeHandlers()));
        await waitFor(() => expect(mockSetAsAppMenu).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        expect(['File', 'Edit', 'View', 'Help']).toEqual(built.items.map((s: any) => s.text));
    });

    it('disables workspace-scoped items when there is no workspace', async () => {
        renderHook(() => useSubWindowMenu(makeHandlers({ workspaceId: null })));
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        expect(findItem(findSubmenu(built, 'File'), 'sub-save').enabled).toBe(false);
        expect(findItem(findSubmenu(built, 'File'), 'sub-close-ws').enabled).toBe(false);
        expect(findItem(findSubmenu(built, 'Edit'), 'sub-rename').enabled).toBe(false);
    });

    it('enables workspace-scoped items when a workspace is open', async () => {
        renderHook(() => useSubWindowMenu(makeHandlers({ workspaceId: 'ws-1' })));
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        expect(findItem(findSubmenu(built, 'File'), 'sub-save').enabled).toBe(true);
        expect(findItem(findSubmenu(built, 'File'), 'sub-close-ws').enabled).toBe(true);
        expect(findItem(findSubmenu(built, 'Edit'), 'sub-rename').enabled).toBe(true);
    });

    it('only adds the local-save item when onLocalSave is provided', async () => {
        const { rerender } = renderHook(
            ({ h }) => useSubWindowMenu(h),
            { initialProps: { h: makeHandlers({ workspaceId: 'ws-1' }) } },
        );
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));
        let built = mockMenuNew.mock.calls[0][0];
        expect(findItem(findSubmenu(built, 'File'), 'sub-local-save')).toBeUndefined();

        rerender({ h: makeHandlers({ workspaceId: 'ws-1', onLocalSave: vi.fn(), localSaveLabel: 'Save Groups as CSV' }) });
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(2));
        built = mockMenuNew.mock.calls[1][0];
        const localSave = findItem(findSubmenu(built, 'File'), 'sub-local-save');
        expect(localSave.text).toBe('Save Groups as CSV');
    });

    it('"Save" loads current workspace state and calls saveWorkspaceData, then shows a confirmation', async () => {
        const state = { id: 'ws-1', name: 'My WS' } as any;
        mockLoadWorkspaceData.mockResolvedValue(state);
        renderHook(() => useSubWindowMenu(makeHandlers({ workspaceId: 'ws-1' })));
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        const saveItem = findItem(findSubmenu(built, 'File'), 'sub-save');
        saveItem.action(); // fire-and-forget wrapper around the async doSave()

        await waitFor(() => expect(mockSaveWorkspaceData).toHaveBeenCalledWith(state));
        expect(mockLoadWorkspaceData).toHaveBeenCalledWith('ws-1');
        expect(mockMessage).toHaveBeenCalledWith(
            expect.stringContaining('My WS'),
            expect.objectContaining({ title: 'Saved' }),
        );
    });

    it('"Save" is a no-op when there is no open workspace', async () => {
        renderHook(() => useSubWindowMenu(makeHandlers({ workspaceId: null })));
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        const saveItem = findItem(findSubmenu(built, 'File'), 'sub-save');
        await saveItem.action();

        expect(mockLoadWorkspaceData).not.toHaveBeenCalled();
        expect(mockSaveWorkspaceData).not.toHaveBeenCalled();
    });

    it('"Close Window" closes the current window', async () => {
        const closeFn = vi.fn().mockResolvedValue(undefined);
        mockGetCurrentWindow.mockReturnValue({ label: 'sub', close: closeFn });
        renderHook(() => useSubWindowMenu(makeHandlers()));
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));

        const built = mockMenuNew.mock.calls[0][0];
        const closeWinItem = findItem(findSubmenu(built, 'File'), 'sub-close-win');
        await closeWinItem.action();
        expect(closeFn).toHaveBeenCalledTimes(1);
    });

    it('"Toggle Theme" always calls the latest handler via ref', async () => {
        const firstToggle = vi.fn();
        const { rerender } = renderHook(
            ({ h }) => useSubWindowMenu(h),
            { initialProps: { h: makeHandlers({ onToggleTheme: firstToggle }) } },
        );
        await waitFor(() => expect(mockMenuNew).toHaveBeenCalledTimes(1));
        const built = mockMenuNew.mock.calls[0][0];
        const themeItem = findItem(findSubmenu(built, 'View'), 'sub-theme');

        const secondToggle = vi.fn();
        rerender({ h: makeHandlers({ onToggleTheme: secondToggle }) });
        expect(mockMenuNew).toHaveBeenCalledTimes(1); // no rebuild: hasWorkspace/hasLocalSave/label unchanged

        themeItem.action();
        expect(firstToggle).not.toHaveBeenCalled();
        expect(secondToggle).toHaveBeenCalledTimes(1);
    });
});
