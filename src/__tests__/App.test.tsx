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
                {props.onOpenDetails && <button onClick={() => props.onOpenDetails()}>trigger-details</button>}
            </div>
        );
    },
}));

const detailsProps: any[] = [];
vi.mock('../components/windows/ProjectDetailsModal', () => ({
    ProjectDetailsModal: (props: any) => {
        detailsProps.push(props);
        return (
            <div role="dialog" aria-label="Project details">
                <span>details-for-{props.workspace.name}</span>
                <button onClick={() => { props.onSaved({ workspaceId: props.workspace.id, name: 'Plant · Machine', description: 'T-1' }); props.onClose(); }}>details-save</button>
                <button onClick={props.onClose}>details-close</button>
            </div>
        );
    },
}));

const mockLoadWorkspaceData = vi.fn();
const mockGetRecentWorkspaces = vi.fn();
vi.mock('../workspaceManager', () => ({
    loadWorkspaceData: (id: string) => mockLoadWorkspaceData(id),
    getRecentWorkspaces: () => mockGetRecentWorkspaces(),
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
    detailsProps.length = 0;
    mockLoadWorkspaceData.mockReset().mockResolvedValue({
        id: 'ws1', name: 'Loaded WS (disk)', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
    });
    mockGetRecentWorkspaces.mockReset().mockResolvedValue([{ id: 'ws9', name: 'Other · Machine', lastModified: 1, filePath: '' }]);
    mockRenameWorkspace.mockClear();
    listenCallbacks = {};
    mockListen.mockClear();
    mockGetVersion.mockClear().mockResolvedValue('1.2.3');
    mockMessage.mockClear().mockResolvedValue(undefined);
    capturedMenuHandlers = null;
    window.localStorage.clear();
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

    it('the TitleBar gets no rename writer: Project details is the only place that renames', async () => {
        render(<App />);
        fireEvent.click(screen.getByText('trigger-data-ready'));
        await screen.findByText('trigger-back');
        expect(last(titleBarProps)).not.toHaveProperty('onRename');
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

        it('onNew while the Import page is showing bumps newProjectSignal each time (File > New Workspace / Ctrl+N starts a new project on step 0)', () => {
            render(<App />);
            expect(last(dataUploadProps).newProjectSignal).toBe(0);

            act(() => { capturedMenuHandlers.onNew(); });
            expect(last(dataUploadProps).newProjectSignal).toBe(1);
            act(() => { capturedMenuHandlers.onNew(); });
            expect(last(dataUploadProps).newProjectSignal).toBe(2);
            expect(screen.getByText('trigger-data-ready')).toBeTruthy();
        });

        it('onNew with a workspace open only goes back to the Import page -- it does not also start a project', async () => {
            render(<App />);
            fireEvent.click(screen.getByText('trigger-data-ready'));
            expect(await screen.findByText('trigger-back')).toBeTruthy();

            act(() => { capturedMenuHandlers.onNew(); });
            expect(screen.getByText('trigger-data-ready')).toBeTruthy();
            expect(last(dataUploadProps).newProjectSignal).toBe(0);
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

        it('onAbout shows a version-stamped About dialog', async () => {
            render(<App />);
            await act(async () => {
                await capturedMenuHandlers.onAbout();
            });
            expect(mockMessage).toHaveBeenCalledWith(
                expect.stringContaining('Version 1.2.3'),
                expect.objectContaining({ title: 'About' }),
            );
            const text = mockMessage.mock.calls[0][0] as string;
            expect(text).toContain('finding abnormal machine behaviour');
            expect(text).not.toMatch(/predict/i);
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

    describe('Project details', () => {
        it('no project open: the TitleBar gets no onOpenDetails', () => {
            render(<App />);
            expect(last(titleBarProps).onOpenDetails).toBeUndefined();
        });

        it('the title bar opens Project details with the project read fresh from disk and the other projects; a save renames the open project', async () => {
            render(<App />);
            fireEvent.click(screen.getByText('trigger-data-ready'));
            await screen.findByText('trigger-back');
            await act(async () => { fireEvent.click(screen.getByText('trigger-details')); });

            expect(mockLoadWorkspaceData).toHaveBeenCalledWith('ws1');
            expect(screen.getByText('details-for-Loaded WS (disk)')).toBeTruthy();
            expect(last(detailsProps).existing).toEqual([{ id: 'ws9', name: 'Other · Machine', lastModified: 1, filePath: '' }]);

            fireEvent.click(screen.getByText('details-save'));
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(last(titleBarProps).workspaceName).toBe('Plant · Machine');
            expect(mockRenameWorkspace).toHaveBeenCalledWith('Plant · Machine');
        });

        it('subscribes to PROJECT_DETAILS_CHANGED and adopts only the new name of the open project (another id, or none, is dropped)', async () => {
            render(<App />);
            fireEvent.click(screen.getByText('trigger-data-ready'));
            await screen.findByText('trigger-back');
            const fire = async (payload: unknown) => {
                await act(async () => {
                    for (const cb of listenCallbacks['project-details-changed'] ?? []) cb({ payload });
                });
            };
            expect(listenCallbacks['project-details-changed']).toHaveLength(1);

            await fire({ workspaceId: 'ws_other', name: 'Foreign', description: '' });
            await fire({ name: 'No id', description: '' });
            expect(last(titleBarProps).workspaceName).toBe('Loaded WS');
            expect(mockRenameWorkspace).not.toHaveBeenCalled();

            await fire({ workspaceId: 'ws1', name: 'Bang Pakong · GEG 4', description: 'U-1' });
            expect(last(titleBarProps).workspaceName).toBe('Bang Pakong · GEG 4');
            expect(mockRenameWorkspace).toHaveBeenCalledWith('Bang Pakong · GEG 4');
        });

        it('a payload arriving after the project was closed is dropped', async () => {
            render(<App />);
            fireEvent.click(screen.getByText('trigger-data-ready'));
            fireEvent.click(await screen.findByText('trigger-back'));
            await act(async () => {
                for (const cb of listenCallbacks['project-details-changed'] ?? []) cb({ payload: { workspaceId: 'ws1', name: 'Late', description: '' } });
            });
            expect(last(titleBarProps).workspaceName).toBeUndefined();
        });
    });

    it('installs the global error reporter once at module load', () => {
        expect(mockInitErrorReporter).toHaveBeenCalled();
    });
});
