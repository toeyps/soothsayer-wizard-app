import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';

const dataUploadProps: any[] = [];
vi.mock('../components/upload', () => ({
    DataUploadPage: (props: any) => {
        dataUploadProps.push(props);
        return (
            <button
                onClick={() => props.onDataReady(
                    { headers: ['A'], total_rows: 10 },
                    { id: 'ws1', name: 'Loaded WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null, selectedSensors: [], visibleSensors: [], operationConfig: null },
                    [{ tag: 'A', description: 'Sensor A', unit: '', component: '' }],
                )}
            >
                trigger-data-ready
            </button>
        );
    },
}));

const dashboardProps: any[] = [];
const mockRenameWorkspace = vi.fn();
vi.mock('../components/dashboard', () => ({
    Dashboard: forwardRef((props: any, ref: any) => {
        dashboardProps.push(props);
        useImperativeHandle(ref, () => ({ renameWorkspace: mockRenameWorkspace }));
        return <button onClick={props.onBack}>trigger-back</button>;
    }),
}));

const titleBarProps: any[] = [];
vi.mock('../components/TitleBar', () => ({
    default: (props: any) => {
        titleBarProps.push(props);
        return (
            <div data-testid="titlebar">
                <button onClick={props.toggleTheme}>toggle-theme</button>
                <button onClick={() => props.onRename?.('Renamed via TitleBar')}>trigger-rename</button>
            </div>
        );
    },
}));

vi.mock('../components/ErrorBoundary', () => ({
    default: (props: any) => <>{props.children}</>,
}));
vi.mock('../components/ErrorToasts', () => ({
    default: () => null,
}));

const { mockInitErrorReporter } = vi.hoisted(() => ({ mockInitErrorReporter: vi.fn() }));
vi.mock('../errorReporter', () => ({
    initErrorReporter: () => mockInitErrorReporter(),
}));

let capturedMenuHandlers: any = null;
const mockUseAppMenu = vi.fn((handlers: any) => { capturedMenuHandlers = handlers; });
vi.mock('../hooks/useAppMenu', () => ({
    useAppMenu: (handlers: any) => mockUseAppMenu(handlers),
}));

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
const mockListen = vi.fn((event: string, cb: (e: any) => void) => {
    (listenCallbacks[event] ??= []).push(cb);
    return Promise.resolve(() => {});
});
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => mockListen(event, cb),
}));

const mockGetVersion = vi.fn().mockResolvedValue('1.2.3');
vi.mock('@tauri-apps/api/app', () => ({
    getVersion: () => mockGetVersion(),
}));

const mockMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/plugin-dialog', () => ({
    message: (text: string, opts: unknown) => mockMessage(text, opts),
}));

import App from '../App';

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

beforeEach(() => {
    dataUploadProps.length = 0;
    dashboardProps.length = 0;
    titleBarProps.length = 0;
    mockRenameWorkspace.mockClear();
    listenCallbacks = {};
    mockListen.mockClear();
    mockGetVersion.mockClear().mockResolvedValue('1.2.3');
    mockMessage.mockClear().mockResolvedValue(undefined);
    capturedMenuHandlers = null;
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('App', () => {
    it('boots into DataUploadPage with no workspace name shown in the TitleBar', () => {
        render(<App />);
        expect(screen.getByText('trigger-data-ready')).toBeTruthy();
        expect(last(titleBarProps).workspaceName).toBeUndefined();
    });

    // Dashboard is React.lazy-loaded (see App.tsx) to keep echarts/regl-scatterplot
    // out of the initial bundle, so it only mounts after its dynamic import()
    // resolves — even with the module mocked, that's still a microtask. Tests that
    // click through to it must await its appearance via findByText/find*, not
    // assert on it synchronously right after the click.
    it('switching to a loaded dataset renders Dashboard with the workspace name in the TitleBar', async () => {
        render(<App />);
        fireEvent.click(screen.getByText('trigger-data-ready'));
        expect(await screen.findByText('trigger-back')).toBeTruthy();
        expect(last(titleBarProps).workspaceName).toBe('Loaded WS');
        expect(last(dashboardProps).metadata).toEqual({ headers: ['A'], total_rows: 10 });
    });

    it('Dashboard\'s onBack returns to DataUploadPage and clears the workspace name', async () => {
        render(<App />);
        fireEvent.click(screen.getByText('trigger-data-ready'));
        fireEvent.click(await screen.findByText('trigger-back'));
        expect(screen.getByText('trigger-data-ready')).toBeTruthy();
        expect(last(titleBarProps).workspaceName).toBeUndefined();
    });

    describe('theme', () => {
        it('defaults to dark when localStorage has no saved theme', () => {
            render(<App />);
            expect(last(titleBarProps).theme).toBe('dark');
            expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        });

        it('toggling flips the theme and persists it to localStorage', () => {
            render(<App />);
            fireEvent.click(screen.getByText('toggle-theme'));
            expect(last(titleBarProps).theme).toBe('light');
            expect(window.localStorage.getItem('theme')).toBe('light');
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });
    });

    it('TitleBar\'s onRename updates the displayed name and forwards to the Dashboard ref', async () => {
        render(<App />);
        fireEvent.click(screen.getByText('trigger-data-ready'));
        await screen.findByText('trigger-back'); // wait for the lazy Dashboard (and its ref) to mount
        fireEvent.click(screen.getByText('trigger-rename'));
        expect(last(titleBarProps).workspaceName).toBe('Renamed via TitleBar');
        expect(mockRenameWorkspace).toHaveBeenCalledWith('Renamed via TitleBar');
    });

    describe('native app-menu wiring', () => {
        it('onNew / onCloseWorkspace both reset back to the import page', async () => {
            render(<App />);
            fireEvent.click(screen.getByText('trigger-data-ready'));
            expect(await screen.findByText('trigger-back')).toBeTruthy();

            act(() => { capturedMenuHandlers.onNew(); });
            expect(screen.getByText('trigger-data-ready')).toBeTruthy();

            fireEvent.click(screen.getByText('trigger-data-ready'));
            act(() => { capturedMenuHandlers.onCloseWorkspace(); });
            expect(screen.getByText('trigger-data-ready')).toBeTruthy();
        });

        it('hasWorkspace reflects whether a dataset is loaded', () => {
            render(<App />);
            expect(capturedMenuHandlers.hasWorkspace).toBe(false);
            fireEvent.click(screen.getByText('trigger-data-ready'));
            expect(capturedMenuHandlers.hasWorkspace).toBe(true);
        });

        it('onRename bumps renameTrigger, forwarded to the TitleBar', () => {
            render(<App />);
            const before = last(titleBarProps).renameTrigger;
            act(() => { capturedMenuHandlers.onRename(); });
            expect(last(titleBarProps).renameTrigger).toBe(before + 1);
        });

        it('onToggleTheme flips the theme the same way the TitleBar button does', () => {
            render(<App />);
            act(() => { capturedMenuHandlers.onToggleTheme(); });
            expect(last(titleBarProps).theme).toBe('light');
        });

        it('onAbout shows a version-stamped About dialog', async () => {
            render(<App />);
            await act(async () => {
                await capturedMenuHandlers.onAbout();
            });
            expect(mockMessage).toHaveBeenCalledWith(
                expect.stringContaining('Version 1.2.3'),
                expect.objectContaining({ title: 'About' }),
            );
        });

        it('onAbout falls back to a plain alert if the dialog API rejects', async () => {
            mockMessage.mockRejectedValue(new Error('no dialog plugin'));
            render(<App />);
            await act(async () => {
                await capturedMenuHandlers.onAbout();
            });
            expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('1.2.3'));
        });
    });

    it('picks up a rename via the workspace-renamed-internal event', async () => {
        render(<App />);
        fireEvent.click(screen.getByText('trigger-data-ready'));
        await act(async () => {
            for (const cb of listenCallbacks['workspace-renamed-internal'] ?? []) {
                cb({ payload: { newName: 'External Rename' } });
            }
        });
        expect(last(titleBarProps).workspaceName).toBe('External Rename');
    });

    it('installs the global error reporter once at module load', () => {
        expect(mockInitErrorReporter).toHaveBeenCalled();
    });
});
