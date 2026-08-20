import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockGetCurrentWindow = vi.fn(() => ({ close: mockClose }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => mockGetCurrentWindow(),
}));

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
const mockListen = vi.fn((event: string, cb: (e: any) => void) => {
    (listenCallbacks[event] ??= []).push(cb);
    return Promise.resolve(() => {});
});
const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => mockListen(event, cb),
    emit: (event: string, payload?: any) => mockEmit(event, payload),
}));

import SaveAsWindow from '../components/windows/SaveAsWindow';

beforeEach(() => {
    listenCallbacks = {};
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
    window.history.pushState({}, '', '/');
});

async function respondWithCurrentName(name: string) {
    await act(async () => {
        for (const cb of listenCallbacks['request-save-as-data-response'] ?? []) {
            cb({ payload: { currentName: name } });
        }
    });
}

describe('SaveAsWindow', () => {
    it('emits request-save-as-data on mount', async () => {
        render(<SaveAsWindow />);
        await act(async () => { await Promise.resolve(); });
        expect(mockEmit).toHaveBeenCalledWith('request-save-as-data', undefined);
    });

    describe('save-as mode (default)', () => {
        it('prefills the name with a "(Copy)" suffix and shows Save-Copy labeling', async () => {
            render(<SaveAsWindow />);
            await respondWithCurrentName('My Workspace');
            expect(screen.getByText('Save Workspace As')).toBeTruthy();
            expect((screen.getByPlaceholderText('Enter workspace name...') as HTMLInputElement).value).toBe('My Workspace (Copy)');
            expect(screen.getByText('Save Copy')).toBeTruthy();
        });

        it('Save emits save-as-submit and closes the window', async () => {
            render(<SaveAsWindow />);
            await respondWithCurrentName('My Workspace');
            await act(async () => {
                fireEvent.click(screen.getByText('Save Copy'));
                await Promise.resolve();
            });
            expect(mockEmit).toHaveBeenCalledWith('save-as-submit', { newName: 'My Workspace (Copy)' });
            expect(mockClose).toHaveBeenCalled();
        });
    });

    describe('rename mode (?mode=rename)', () => {
        beforeEach(() => {
            window.history.pushState({}, '', '/?mode=rename');
        });

        it('prefills the name with no suffix and shows Rename labeling', async () => {
            render(<SaveAsWindow />);
            await respondWithCurrentName('My Workspace');
            expect(screen.getByText('Rename Workspace')).toBeTruthy();
            expect((screen.getByPlaceholderText('Enter workspace name...') as HTMLInputElement).value).toBe('My Workspace');
            expect(screen.getByText('Rename')).toBeTruthy();
        });

        it('Save emits rename-submit and closes the window', async () => {
            render(<SaveAsWindow />);
            await respondWithCurrentName('My Workspace');
            await act(async () => {
                fireEvent.click(screen.getByText('Rename'));
                await Promise.resolve();
            });
            expect(mockEmit).toHaveBeenCalledWith('rename-submit', { newName: 'My Workspace' });
            expect(mockClose).toHaveBeenCalled();
        });
    });

    it('disables Save while the name is blank', async () => {
        render(<SaveAsWindow />);
        await respondWithCurrentName('My Workspace');
        const input = screen.getByPlaceholderText('Enter workspace name...');
        fireEvent.change(input, { target: { value: '   ' } });
        expect((screen.getByText('Save Copy') as HTMLButtonElement).disabled).toBe(true);
    });

    it('Enter in the input also submits', async () => {
        render(<SaveAsWindow />);
        await respondWithCurrentName('My Workspace');
        await act(async () => {
            fireEvent.keyDown(screen.getByPlaceholderText('Enter workspace name...'), { key: 'Enter' });
            await Promise.resolve();
        });
        expect(mockEmit).toHaveBeenCalledWith('save-as-submit', { newName: 'My Workspace (Copy)' });
    });

    it('Cancel closes the window without emitting a submit event', async () => {
        render(<SaveAsWindow />);
        await respondWithCurrentName('My Workspace');
        await act(async () => {
            fireEvent.click(screen.getByText('Cancel'));
            await Promise.resolve();
        });
        expect(mockClose).toHaveBeenCalled();
        expect(mockEmit).not.toHaveBeenCalledWith('save-as-submit', expect.anything());
        expect(mockEmit).not.toHaveBeenCalledWith('rename-submit', expect.anything());
    });
});
