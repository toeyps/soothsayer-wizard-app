import { useEffect, useRef } from 'react';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface AppMenuHandlers {
    hasWorkspace: boolean;
    onNew: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    onCloseWorkspace: () => void;
    onRename: () => void;
    onToggleTheme: () => void;
    onAbout: () => void;
}

// Builds a native cross-platform menu (app menu bar on macOS, window menu on Windows/Linux)
// using the Tauri v2 menu API. Rebuilt only when the enabled/disabled state changes; action
// closures read latest handlers via a ref so we don't rebuild on every render.
export function useAppMenu(handlers: AppMenuHandlers) {
    const handlersRef = useRef(handlers);
    useEffect(() => { handlersRef.current = handlers; }, [handlers]);

    const { hasWorkspace } = handlers;

    useEffect(() => {
        let disposed = false;

        const build = async () => {
            try {
                const sepFile1 = await PredefinedMenuItem.new({ item: 'Separator' });
                const sepFile2 = await PredefinedMenuItem.new({ item: 'Separator' });
                const quit = await PredefinedMenuItem.new({ item: 'Quit' });

                const fileItems = [
                    await MenuItem.new({
                        id: 'menu-new', text: 'New Workspace', accelerator: 'CmdOrCtrl+N',
                        action: () => handlersRef.current.onNew(),
                    }),
                    sepFile1,
                    await MenuItem.new({
                        id: 'menu-save', text: 'Save', accelerator: 'CmdOrCtrl+S',
                        enabled: hasWorkspace,
                        action: () => handlersRef.current.onSave(),
                    }),
                    await MenuItem.new({
                        id: 'menu-save-as', text: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S',
                        enabled: hasWorkspace,
                        action: () => handlersRef.current.onSaveAs(),
                    }),
                    sepFile2,
                    await MenuItem.new({
                        id: 'menu-close-ws', text: 'Close Workspace',
                        enabled: hasWorkspace,
                        action: () => handlersRef.current.onCloseWorkspace(),
                    }),
                    quit,
                ];

                const editItems = [
                    await MenuItem.new({
                        id: 'menu-rename', text: 'Rename Workspace',
                        enabled: hasWorkspace,
                        action: () => handlersRef.current.onRename(),
                    }),
                ];

                const viewItems = [
                    await MenuItem.new({
                        id: 'menu-toggle-theme', text: 'Toggle Theme', accelerator: 'CmdOrCtrl+T',
                        action: () => handlersRef.current.onToggleTheme(),
                    }),
                ];

                const helpItems = [
                    await MenuItem.new({
                        id: 'menu-about', text: 'About Soothsayer-Wizard',
                        action: () => handlersRef.current.onAbout(),
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
                console.warn('Failed to set up app menu:', e);
            }
        };

        build();
        return () => { disposed = true; };
    }, [hasWorkspace]);
}
