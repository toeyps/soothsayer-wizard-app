import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

const mockGetRecentWorkspaces = vi.fn();
const mockDeleteWorkspace = vi.fn().mockResolvedValue(undefined);
const mockDuplicateWorkspace = vi.fn().mockResolvedValue(undefined);
const mockRenameWorkspaceFile = vi.fn().mockResolvedValue(undefined);
vi.mock('../workspaceManager', () => ({
    getRecentWorkspaces: () => mockGetRecentWorkspaces(),
    deleteWorkspace: (id: string) => mockDeleteWorkspace(id),
    duplicateWorkspace: (id: string) => mockDuplicateWorkspace(id),
    renameWorkspaceFile: (id: string, name: string) => mockRenameWorkspaceFile(id, name),
}));

import RecentWorkspaces from '../components/upload/RecentWorkspaces';

const workspaces = [
    { id: 'ws1', name: 'Alpha', description: '', lastModified: 1700000000000, filePath: 'a.json' },
    { id: 'ws2', name: 'Beta', description: '', lastModified: 1700000100000, filePath: 'b.json' },
];

beforeEach(() => {
    mockGetRecentWorkspaces.mockReset().mockResolvedValue(workspaces);
    mockDeleteWorkspace.mockClear().mockResolvedValue(undefined);
    mockDuplicateWorkspace.mockClear().mockResolvedValue(undefined);
    mockRenameWorkspaceFile.mockClear().mockResolvedValue(undefined);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

async function renderLoaded(onLoadWorkspace = vi.fn()) {
    const utils = render(<RecentWorkspaces onLoadWorkspace={onLoadWorkspace} />);
    await act(async () => { await Promise.resolve(); });
    return { ...utils, onLoadWorkspace };
}

describe('RecentWorkspaces', () => {
    it('shows "No workspaces found." when the list is empty', async () => {
        mockGetRecentWorkspaces.mockResolvedValue([]);
        await renderLoaded();
        expect(screen.getByText('No workspaces found.')).toBeTruthy();
    });

    it('lists each workspace by name', async () => {
        await renderLoaded();
        expect(screen.getByText('Alpha')).toBeTruthy();
        expect(screen.getByText('Beta')).toBeTruthy();
    });

    it('clicking a workspace row calls onLoadWorkspace with its id', async () => {
        const { onLoadWorkspace } = await renderLoaded();
        fireEvent.click(screen.getByText('Alpha'));
        expect(onLoadWorkspace).toHaveBeenCalledWith('ws1');
    });

    it('opens a per-row action menu without triggering onLoadWorkspace', async () => {
        const { onLoadWorkspace } = await renderLoaded();
        const menuButtons = screen.getAllByRole('button');
        fireEvent.click(menuButtons[0]); // first row's kebab menu
        expect(screen.getByText('Rename')).toBeTruthy();
        expect(onLoadWorkspace).not.toHaveBeenCalled();
    });

    describe('Delete', () => {
        it('deletes and refreshes the list immediately on click, with no confirmation dialog (2026-08-31: no confirmations anywhere in the app, per explicit user request)', async () => {
            await renderLoaded();
            fireEvent.click(screen.getAllByRole('button')[0]);
            await act(async () => {
                fireEvent.click(screen.getByText('Delete'));
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mockDeleteWorkspace).toHaveBeenCalledWith('ws1');
            expect(mockGetRecentWorkspaces).toHaveBeenCalledTimes(2); // initial + refresh
        });
    });

    it('Duplicate calls duplicateWorkspace and refreshes', async () => {
        await renderLoaded();
        fireEvent.click(screen.getAllByRole('button')[0]);
        await act(async () => {
            fireEvent.click(screen.getByText('Duplicate'));
            await Promise.resolve();
        });
        expect(mockDuplicateWorkspace).toHaveBeenCalledWith('ws1');
    });

    describe('Rename', () => {
        it('renames when a non-empty, changed name is entered', async () => {
            (window.prompt as any).mockReturnValue('Alpha Renamed');
            await renderLoaded();
            fireEvent.click(screen.getAllByRole('button')[0]);
            await act(async () => {
                fireEvent.click(screen.getByText('Rename'));
                await Promise.resolve();
            });
            expect(mockRenameWorkspaceFile).toHaveBeenCalledWith('ws1', 'Alpha Renamed');
        });

        it('does nothing when the prompt is cancelled or unchanged', async () => {
            (window.prompt as any).mockReturnValue(null);
            await renderLoaded();
            fireEvent.click(screen.getAllByRole('button')[0]);
            fireEvent.click(screen.getByText('Rename'));
            expect(mockRenameWorkspaceFile).not.toHaveBeenCalled();
        });
    });

    it('clicking outside the open menu closes it', async () => {
        await renderLoaded();
        fireEvent.click(screen.getAllByRole('button')[0]);
        expect(screen.getByText('Rename')).toBeTruthy();

        fireEvent.mouseDown(document.body);
        expect(screen.queryByText('Rename')).toBeNull();
    });
});
