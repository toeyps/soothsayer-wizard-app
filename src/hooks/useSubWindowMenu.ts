import { useEffect, useRef } from 'react';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen, emit } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import {
    loadWorkspaceData,
    saveWorkspaceData,
    renameWorkspaceFile,
} from '../workspaceManager';
import type { WorkspaceState } from '../types';

export interface SubWindowMenuHandlers {
    workspaceId: string | null;
    // Optional: extra local "Save" item (e.g. Save Groups as CSV). If provided, appears above
    // the File separator, distinct from the workspace-level Save.
    localSaveLabel?: string;
    onLocalSave?: () => void;
}

// Returns a bridge to the main window: focuses it if it exists, otherwise spawns a fresh main
// window (always pointed at the import page — there is no auto-resume). Closes the current window
// so the user always lands somewhere.
//
// When the existing main window is REUSED (show + setFocus), its React state still holds whatever
// values were set right before the user navigated away (e.g. `loadingWorkspace=true` from the
// click on a Recent Workspace). Emit `upload-page-resumed` so DataUploadPage can reset that
// transient state — fresh-spawn path doesn't need this because React state starts clean.
async function openMainAndClose() {
    try {
        const existing = await WebviewWindow.getByLabel('main');
        if (existing) {
            await existing.show();
            await existing.setFocus();
            try { await emit('upload-page-resumed'); } catch { /* ignore */ }
        } else {
            // `decorations` MUST be set explicitly: `tauri.windows.conf.json`
            // only configures windows declared in the config, so a window
            // created at runtime defaults to `decorations: true` and ends up
            // with a native Windows frame stacked on top of the app's own
            // custom titlebar.
            const isMac = /mac/i.test(
                (navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent
            );
            new WebviewWindow('main', {
                url: '/',
                title: 'Wizard',
                width: 1200,
                height: 800,
                center: true,
                maximized: true,
                decorations: isMac,
            });
        }
    } catch (e) {
        console.warn('Failed to reopen main window:', e);
    }
    try { await getCurrentWindow().close(); } catch { /* ignore */ }
}

// Cross-platform native menu for secondary windows (currently just Predictive
// Model — the other former caller, FailureGroupCreation.tsx, was folded into
// the Dashboard window and deleted).
// Mirrors the main app's File/Edit/View/Help structure so behavior is consistent regardless of
// which window the user has focus on. Workspace-level actions (New/Save/Close/Rename)
// are implemented here directly against workspaceManager since the sub-windows don't share
// React state with the main App. ("Save As" — duplicate workspace under a new
// name — was removed app-wide; only plain Rename remains, reusing SaveAsWindow.tsx
// in `mode=rename`.)
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
            await openMainAndClose();
        };

        const doSave = async () => {
            const state = await getCurrentState();
            if (!state) return;
            await saveWorkspaceData(state);
            try { await message(`Workspace "${state.name}" saved.`, { title: 'Saved', kind: 'info' }); }
            catch { /* ignore */ }
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
                // Broadcast so the caller window's UI (PM's own workspace label)
                // updates without needing a reload. Same event name the main
                // window's TitleBar already listens for.
                try { await emit('workspace-renamed-internal', { newName: event.payload.newName }); }
                catch { /* ignore */ }
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

                const helpItems = [
                    await MenuItem.new({
                        id: 'sub-about', text: 'About Wizard',
                        action: async () => {
                            try { await message('Wizard v0.1.0', { title: 'About', kind: 'info' }); }
                            catch { /* ignore */ }
                        },
                    }),
                ];

                const menu = await Menu.new({
                    items: [
                        await Submenu.new({ text: 'File', items: fileItems }),
                        await Submenu.new({ text: 'Edit', items: editItems }),
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
