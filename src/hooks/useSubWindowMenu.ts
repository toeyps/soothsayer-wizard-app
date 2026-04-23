import { useEffect, useRef } from 'react';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen, emit } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import {
    loadWorkspaceData,
    saveWorkspaceData,
    setLastWorkspaceId,
    renameWorkspaceFile,
} from '../workspaceManager';
import type { WorkspaceState } from '../types';

export interface SubWindowMenuHandlers {
    workspaceId: string | null;
    onToggleTheme: () => void;
    // Optional: extra local "Save" item (e.g. Save Groups as CSV). If provided, appears above
    // the File separator, distinct from the workspace-level Save.
    localSaveLabel?: string;
    onLocalSave?: () => void;
}

// Returns a bridge to the main window: focuses it if it exists, otherwise spawns a fresh main
// window (pointed at the import page since lastWorkspaceId was cleared). Closes the current window
// after a short delay so the user always lands somewhere.
async function openMainAndClose() {
    try {
        const existing = await WebviewWindow.getByLabel('main');
        if (existing) {
            await existing.show();
            await existing.setFocus();
        } else {
            new WebviewWindow('main', {
                url: '/',
                title: 'Soothsayer-Wizard',
                width: 1200,
                height: 800,
                center: true,
                maximized: true,
            });
        }
    } catch (e) {
        console.warn('Failed to reopen main window:', e);
    }
    try { await getCurrentWindow().close(); } catch { /* ignore */ }
}

// Cross-platform native menu for secondary windows (Failure Group / Predictive Model).
// Mirrors the main app's File/Edit/View/Help structure so behavior is consistent regardless of
// which window the user has focus on. Workspace-level actions (New/Save/SaveAs/Close/Rename)
// are implemented here directly against workspaceManager since the sub-windows don't share
// React state with the main App.
export function useSubWindowMenu(handlers: SubWindowMenuHandlers) {
    const ref = useRef(handlers);
    useEffect(() => { ref.current = handlers; }, [handlers]);

    const hasWorkspace = !!handlers.workspaceId;
    const hasLocalSave = !!handlers.onLocalSave;
    const localSaveLabel = handlers.localSaveLabel ?? 'Save';

    useEffect(() => {
        let disposed = false;

        const getCurrentState = async (): Promise<WorkspaceState | null> => {
            const wsId = ref.current.workspaceId;
            if (!wsId) return null;
            return await loadWorkspaceData(wsId);
        };

        const doNewOrCloseWorkspace = async () => {
            await setLastWorkspaceId(null);
            await openMainAndClose();
        };

        const doSave = async () => {
            const state = await getCurrentState();
            if (!state) return;
            await saveWorkspaceData(state);
            try { await message(`Workspace "${state.name}" saved.`, { title: 'Saved', kind: 'info' }); }
            catch { /* ignore */ }
        };

        const doSaveAs = async () => {
            const state = await getCurrentState();
            if (!state) return;
            const webview = new WebviewWindow('save-as', {
                url: '/?window=save-as&mode=save-as',
                title: 'Save Workspace As',
                width: 450,
                height: 350,
                center: true,
                alwaysOnTop: true,
                decorations: false,
                resizable: false,
                skipTaskbar: true,
            });
            const unlistenReq = await listen('request-save-as-data', async () => {
                await emit('request-save-as-data-response', { currentName: state.name });
            });
            const unlistenSubmit = await listen<{ newName: string }>('save-as-submit', async (event) => {
                const fresh = await getCurrentState();
                if (!fresh) return;
                const newState: WorkspaceState = { ...fresh, id: `ws_${Date.now()}`, name: event.payload.newName };
                await saveWorkspaceData(newState);
                try { await message(`New workspace "${event.payload.newName}" created.`, { title: 'Saved As', kind: 'info' }); }
                catch { /* ignore */ }
                unlistenReq(); unlistenSubmit();
            });
            webview.once('tauri://error', (e) => console.error('Failed to open save-as window:', e));
        };

        const doRename = async () => {
            const state = await getCurrentState();
            if (!state) return;
            const webview = new WebviewWindow('save-as', {
                url: '/?window=save-as&mode=rename',
                title: 'Rename Workspace',
                width: 450,
                height: 350,
                center: true,
                alwaysOnTop: true,
                decorations: false,
                resizable: false,
                skipTaskbar: true,
            });
            const unlistenReq = await listen('request-save-as-data', async () => {
                await emit('request-save-as-data-response', { currentName: state.name });
            });
            const unlistenSubmit = await listen<{ newName: string }>('rename-submit', async (event) => {
                const wsId = ref.current.workspaceId;
                if (!wsId) return;
                await renameWorkspaceFile(wsId, event.payload.newName);
                try { await message(`Workspace renamed to "${event.payload.newName}".`, { title: 'Renamed', kind: 'info' }); }
                catch { /* ignore */ }
                unlistenReq(); unlistenSubmit();
            });
            webview.once('tauri://error', (e) => console.error('Failed to open rename window:', e));
        };

        const build = async () => {
            try {
                const fileItems: any[] = [
                    await MenuItem.new({
                        id: 'sub-new', text: 'New Workspace', accelerator: 'CmdOrCtrl+N',
                        action: () => { doNewOrCloseWorkspace(); },
                    }),
                    await PredefinedMenuItem.new({ item: 'Separator' }),
                    await MenuItem.new({
                        id: 'sub-save', text: 'Save', accelerator: 'CmdOrCtrl+S',
                        enabled: hasWorkspace,
                        action: () => { doSave(); },
                    }),
                    await MenuItem.new({
                        id: 'sub-save-as', text: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S',
                        enabled: hasWorkspace,
                        action: () => { doSaveAs(); },
                    }),
                ];

                if (hasLocalSave) {
                    fileItems.push(await PredefinedMenuItem.new({ item: 'Separator' }));
                    fileItems.push(await MenuItem.new({
                        id: 'sub-local-save', text: localSaveLabel,
                        action: () => ref.current.onLocalSave?.(),
                    }));
                }

                fileItems.push(await PredefinedMenuItem.new({ item: 'Separator' }));
                fileItems.push(await MenuItem.new({
                    id: 'sub-close-ws', text: 'Close Workspace',
                    enabled: hasWorkspace,
                    action: () => { doNewOrCloseWorkspace(); },
                }));
                fileItems.push(await MenuItem.new({
                    id: 'sub-close-win', text: 'Close Window', accelerator: 'CmdOrCtrl+W',
                    action: async () => { try { await getCurrentWindow().close(); } catch { /* ignore */ } },
                }));
                fileItems.push(await PredefinedMenuItem.new({ item: 'Quit' }));

                const editItems = [
                    await MenuItem.new({
                        id: 'sub-rename', text: 'Rename Workspace',
                        enabled: hasWorkspace,
                        action: () => { doRename(); },
                    }),
                ];

                const viewItems = [
                    await MenuItem.new({
                        id: 'sub-theme', text: 'Toggle Theme', accelerator: 'CmdOrCtrl+T',
                        action: () => ref.current.onToggleTheme(),
                    }),
                ];

                const helpItems = [
                    await MenuItem.new({
                        id: 'sub-about', text: 'About Soothsayer-Wizard',
                        action: async () => {
                            try { await message('Soothsayer-Wizard v0.1.0', { title: 'About', kind: 'info' }); }
                            catch { /* ignore */ }
                        },
                    }),
                ];

                const menu = await Menu.new({
                    items: [
                        await Submenu.new({ text: 'File', items: fileItems }),
                        await Submenu.new({ text: 'Edit', items: editItems }),
                        await Submenu.new({ text: 'View', items: viewItems }),
                        await Submenu.new({ text: 'Help', items: helpItems }),
                    ],
                });

                if (disposed) return;
                await menu.setAsAppMenu();
                try { await menu.setAsWindowMenu(getCurrentWindow()); } catch { /* macOS: per-window menu not supported */ }
            } catch (e) {
                console.warn('Failed to set up sub-window menu:', e);
            }
        };

        build();
        return () => { disposed = true; };
    }, [hasWorkspace, hasLocalSave, localSaveLabel]);
}
