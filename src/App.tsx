import { useState, useEffect, useRef } from "react";
import { Window } from "@tauri-apps/api/window";
import { DataUploadPage } from "./components/upload";
import { Dashboard, DashboardRef } from "./components/dashboard";
import { CsvMetadata, SensorMetadata, WorkspaceState } from "./types";
import { buildSensorMetadataFromMapping } from "./hooks/useMappingData";
import type { MappingData, MappingResult } from "./types/dataUpload";
import { getLastWorkspaceId, loadWorkspaceData, setLastWorkspaceId } from "./workspaceManager";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./components/TitleBar";

function App() {
  const [metadata, setMetadata] = useState<CsvMetadata | null>(null);
  const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
  const [initialWorkspaceState, setInitialWorkspaceState] = useState<WorkspaceState | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string>("");
  const [isInitializing, setIsInitializing] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'dark';
  });

  const dashboardRef = useRef<DashboardRef>(null);

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
