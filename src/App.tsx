import { useState, useEffect, useRef } from "react";
import { Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { DataUploadPage } from "./components/upload";
import { Dashboard, DashboardRef } from "./components/dashboard";
import { CsvMetadata, SensorMetadata, WorkspaceState } from "./types";
import { buildSensorMetadataFromMapping } from "./hooks/useMappingData";
import type { MappingData, MappingResult } from "./types/dataUpload";
import { getLastWorkspaceId, loadWorkspaceData, setLastWorkspaceId } from "./workspaceManager";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import TitleBar from "./components/TitleBar";
import { useAppMenu } from "./hooks/useAppMenu";

function App() {
  const [metadata, setMetadata] = useState<CsvMetadata | null>(null);
  const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
  const [initialWorkspaceState, setInitialWorkspaceState] = useState<WorkspaceState | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string>("");
  const [isInitializing, setIsInitializing] = useState(true);
  const [renameTrigger, setRenameTrigger] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'dark';
  });

  const dashboardRef = useRef<DashboardRef>(null);

  // Set to `true` as soon as auto-resume decides we're booting straight into a
  // sub-window (failure-group / predictive-model). The splash effect reads this
  // ref so it does NOT call `main.show()` after the 2-second timer — otherwise
  // the user briefly sees the main window flash before it closes itself when
  // the sub-window's data handshake completes (race against `load_csv`, etc.).
  const resumingToSubWindowRef = useRef(false);

  useEffect(() => {
    const unlisten = listen<{ newName: string }>('workspace-renamed-internal', (event) => {
        setWorkspaceName(event.payload.newName);
    });
    return () => {
        unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Handle Auto-Resume
  useEffect(() => {
    const autoResume = async () => {
      console.log("Starting auto-resume check...");
      try {
        const lastId = await getLastWorkspaceId();
        console.log("Last Workspace ID from store:", lastId);
        if (lastId) {
          const state = await loadWorkspaceData(lastId);
          console.log("Loaded Workspace State:", state);
          const resumingToStep2Or3 = state && (state.lastRoute === 'failure-group' || state.lastRoute === 'predictive-model') && state.dataFilePaths.length > 0;
          if (resumingToStep2Or3 && state) {
            // Mark BEFORE the slow load_csv so the splash effect (which fires when
            // `isInitializing` flips false) skips `main.show()` and we don't get a
            // visible flash of the import page on top of the sub-window resume.
            resumingToSubWindowRef.current = true;

            // ── Idempotency guard ────────────────────────────────────────
            // If FG (or PM) already exists — e.g. because this is a re-mount
            // after Vite HMR reconnect, macOS WebView resume, or a duplicate
            // autoResume run — skip the entire spawn flow and just shut down
            // main + splash. Spawning a new sub-window with the same label
            // would either error out or stack a second instance, which is
            // exactly the "เด้งออก แล้วเปิดขึ้นมาใหม่" symptom.
            const existingFG = await WebviewWindow.getByLabel('failure-group');
            const existingPM = await WebviewWindow.getByLabel('predictive-model');
            if (existingFG || existingPM) {
                console.log("Sub-window already exists; skipping spawn.", {
                    existingFG: !!existingFG, existingPM: !!existingPM,
                });
                try {
                    const splash = await Window.getByLabel("splashscreen");
                    if (splash) await splash.close();
                } catch { /* ignore */ }
                // `destroy()` skips close-requested handlers — guarantees main
                // is gone even if some race re-armed a handler.
                try { await Window.getCurrent().destroy(); } catch { /* ignore */ }
                return;
            }

            // Load CSV + sensor metadata, spawn step-2 window, close main. FailureGroupCreation itself
            // re-spawns the predictive-model window if lastRoute points there.
            const dataMetadata = await invoke<CsvMetadata>("load_csv", { paths: state.dataFilePaths });
            let sm: SensorMetadata[] | null = null;
            if (state.mappingFilePath && state.mappingKeyColumn) {
                try {
                    const mappingData = await invoke<MappingData>("load_mapping_csv", { path: state.mappingFilePath });
                    const mappingResult = await invoke<MappingResult>("apply_sensor_mapping", {
                        keyColumn: state.mappingKeyColumn,
                        mappingData,
                        datasetHeaders: dataMetadata.headers,
                    });
                    sm = buildSensorMetadataFromMapping(mappingData, mappingResult, state.mappingKeyColumn);
                } catch (mappingErr) { console.warn("Failed to reload mapping on resume:", mappingErr); }
            }
            if (!sm && state.metadataFilePath) {
                try { sm = await invoke<SensorMetadata[]>("load_metadata_command", { path: state.metadataFilePath }); } catch { /* ignore */ }
            }
            const sensorHeaders = dataMetadata.headers.filter(h => {
                const lower = h.trim().toLowerCase();
                return lower !== 'timestamp' && lower !== 'time';
            });
            const screenW = window.screen.width;
            const screenH = window.screen.height;
            const isMac = /mac/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent);
            const fgWindow = new WebviewWindow('failure-group', {
                url: '/?window=failure-group',
                title: 'Predictive Mode - Failure Group Creation',
                width: Math.round(screenW * 0.8),
                height: Math.round(screenH * 0.8),
                center: true,
                decorations: isMac,
            });
            const unlisten = await listen('request-failure-group-data', async () => {
                await emit('failure-group-data', {
                    workspaceId: state.id,
                    sensorHeaders,
                    sensorMetadata: sm,
                    metadata: dataMetadata,
                    dashboardSnapshot: state.dashboardSnapshot,
                });
                unlisten();
                try {
                    const splash = await Window.getByLabel("splashscreen");
                    if (splash) await splash.close();
                } catch { /* ignore */ }
                // `destroy()` (not `close()`) so main can NEVER be unhidden
                // by a later macOS reactivation event — there's no window to
                // unhide.
                try { await Window.getCurrent().destroy(); } catch { /* ignore */ }
            });
            fgWindow.once('tauri://error', (e) => console.error('Failed to create failure group window on resume:', e));
            return; // skip the normal dashboard render path
          }
          if (state && state.lastRoute === 'dashboard' && state.dataFilePaths.length > 0) {
            console.log("Resuming to dashboard with files:", state.dataFilePaths);
            // Re-invoke backend to load data since backend state is cleared on app restart
            const dataMetadata = await invoke<CsvMetadata>("load_csv", { paths: state.dataFilePaths });
            let sm: SensorMetadata[] | null = null;
            // Reload mapping data if saved with workspace
            if (state.mappingFilePath && state.mappingKeyColumn) {
                try {
                    const mappingData = await invoke<MappingData>("load_mapping_csv", { path: state.mappingFilePath });
                    const mappingResult = await invoke<MappingResult>("apply_sensor_mapping", {
                        keyColumn: state.mappingKeyColumn,
                        mappingData,
                        datasetHeaders: dataMetadata.headers,
                    });
                    sm = buildSensorMetadataFromMapping(mappingData, mappingResult, state.mappingKeyColumn);
                } catch (mappingErr) {
                    console.warn("Failed to reload mapping on resume:", mappingErr);
                }
            }
            // Fallback to metadata file
            if (!sm && state.metadataFilePath) {
                try {
                    sm = await invoke<SensorMetadata[]>("load_metadata_command", { path: state.metadataFilePath });
                } catch { /* ignore */ }
            }
            setMetadata(dataMetadata);
            setSensorMetadata(sm);
            setInitialWorkspaceState(state);
            setWorkspaceName(state.name);
          }
        }
      } catch (e) {
        console.error("Auto-resume failed:", e);
      } finally {
        console.log("Auto-resume check complete.");
        setIsInitializing(false);
      }
    };
    autoResume();
  }, []);

  // Handle Splash Screen
  useEffect(() => {
    const initSplash = async () => {
      // Add a small delay for the splash screen to be visible
      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        const splash = await Window.getByLabel("splashscreen");
        if (splash) {
          await splash.close();
        }

        // When auto-resume is taking us straight into a sub-window (FG / PM),
        // do NOT show or focus the main window — `autoResume` will close it
        // itself once the sub-window's data handshake completes. Showing main
        // here causes a visible "flash → disappear" when CSV load is slow.
        if (resumingToSubWindowRef.current) {
          return;
        }

        const main = await Window.getByLabel("main");
        if (main) {
          await main.show();
          await main.setFocus();
        }
      } catch (error) {
        console.warn("Could not manage windows (not in Tauri?)", error);
      }
    };

    if (!isInitializing) {
        initSplash();
    }
  }, [isInitializing]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleBackToImport = async () => {
    setMetadata(null);
    setSensorMetadata(null);
    setInitialWorkspaceState(null);
    setWorkspaceName("");
    await setLastWorkspaceId(null);
  };

  const handleManualSave = () => {
    if (dashboardRef.current) {
        dashboardRef.current.saveWorkspace();
    }
  };

  const handleManualSaveAs = () => {
    if (dashboardRef.current) {
        dashboardRef.current.saveWorkspaceAs();
    }
  };

  const handleRename = (newName: string) => {
    setWorkspaceName(newName);
    if (dashboardRef.current) {
        dashboardRef.current.renameWorkspace(newName);
    }
  };

  useAppMenu({
    hasWorkspace: !!metadata,
    onNew: handleBackToImport,
    onSave: handleManualSave,
    onSaveAs: handleManualSaveAs,
    onCloseWorkspace: handleBackToImport,
    onRename: () => setRenameTrigger(t => t + 1),
    onToggleTheme: toggleTheme,
    onAbout: async () => {
        try {
            await message(
                'Soothsayer-Wizard\nVersion 0.1.0\n\nA desktop tool for CSV sensor data exploration and predictive modeling.',
                { title: 'About', kind: 'info' }
            );
        } catch {
            alert('Soothsayer-Wizard v0.1.0');
        }
    },
  });

  if (isInitializing) {
    return <div style={{ background: 'var(--bg-primary)', width: '100vw', height: '100vh' }} />;
  }

  return (
    <>
      <TitleBar
        theme={theme}
        toggleTheme={toggleTheme}
        onSave={metadata ? handleManualSave : undefined}
        onSaveAs={metadata ? handleManualSaveAs : undefined}
        workspaceName={metadata ? workspaceName : undefined}
        onRename={handleRename}
        renameTrigger={renameTrigger}
      />
      <main className="app-container">
        {!metadata ? (
          <DataUploadPage
            onDataReady={(data, workspaceState, sm) => {
              setMetadata(data);
              setSensorMetadata(sm ?? null);
              setInitialWorkspaceState(workspaceState);
              setWorkspaceName(workspaceState.name);
            }}
          />
        ) : (
          <Dashboard
            ref={dashboardRef}
            metadata={metadata}
            sensorMetadata={sensorMetadata}
            onBack={handleBackToImport}
            initialState={initialWorkspaceState}
          />
        )}
      </main>
    </>
  );
}

export default App;
