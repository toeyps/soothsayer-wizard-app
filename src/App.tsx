import { useState, useEffect, useRef } from "react";
import { DataUploadPage } from "./components/upload";
import { Dashboard, DashboardRef } from "./components/dashboard";
import { CsvMetadata, SensorMetadata, WorkspaceState } from "./types";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import TitleBar from "./components/TitleBar";
import { useAppMenu } from "./hooks/useAppMenu";

function App() {
  const [metadata, setMetadata] = useState<CsvMetadata | null>(null);
  const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
  const [initialWorkspaceState, setInitialWorkspaceState] = useState<WorkspaceState | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string>("");
  const [renameTrigger, setRenameTrigger] = useState(0);
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

  // No auto-resume: the app always boots into the Import page. Users navigate
  // into past work by clicking a Recent Workspace in the sidebar — that flow
  // lives in `DataUploadPage.handleLoadWorkspace`, which decides per-workspace
  // whether to land in Dashboard, Failure Group, or Predictive Model.

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleBackToImport = () => {
    setMetadata(null);
    setSensorMetadata(null);
    setInitialWorkspaceState(null);
    setWorkspaceName("");
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
