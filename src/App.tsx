import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { DataUploadPage } from "./components/upload";
import type { DashboardRef } from "./components/dashboard";
import { CsvMetadata, SensorMetadata, WorkspaceState } from "./types";

// Dashboard pulls in echarts + regl-scatterplot (the app's two heaviest
// dependencies) — deferring it until a workspace is actually open keeps
// those out of the initial bundle the upload screen has to parse.
const Dashboard = lazy(() =>
  import("./components/dashboard").then((m) => ({ default: m.Dashboard })),
);
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { message } from "@tauri-apps/plugin-dialog";
import TitleBar from "./components/TitleBar";
import { useAppMenu } from "./hooks/useAppMenu";
import ErrorBoundary from "./components/ErrorBoundary";
import ErrorToasts from "./components/ErrorToasts";
import { initErrorReporter } from "./errorReporter";

// Install window.onerror / unhandledrejection hooks before the first render
// so even a crash during initial mount is captured and shown.
initErrorReporter();

function App() {
  const [metadata, setMetadata] = useState<CsvMetadata | null>(null);
  const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
  const [initialWorkspaceState, setInitialWorkspaceState] = useState<WorkspaceState | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string>("");
  const [renameTrigger, setRenameTrigger] = useState(0);

  const dashboardRef = useRef<DashboardRef>(null);

  useEffect(() => {
    const unlisten = listen<{ newName: string }>('workspace-renamed-internal', (event) => {
        setWorkspaceName(event.payload.newName);
    });
    return () => {
        unlisten.then(f => f());
    };
  }, []);

  // No auto-resume: the app always boots into the Import page. Users navigate
  // into past work by clicking a Recent Workspace in the sidebar — that flow
  // lives in `DataUploadPage.handleLoadWorkspace`, which decides per-workspace
  // whether to land in Dashboard, Failure Group, or Predictive Model.

  const handleBackToImport = () => {
    setMetadata(null);
    setSensorMetadata(null);
    setInitialWorkspaceState(null);
    setWorkspaceName("");
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
    onCloseWorkspace: handleBackToImport,
    onRename: () => setRenameTrigger(t => t + 1),
    onAbout: async () => {
        // Version comes from tauri.conf.json at runtime so this dialog can
        // never drift from the shipped bundle version again.
        let version = '';
        try {
            version = await getVersion();
        } catch { /* non-Tauri context (plain browser) — omit the number */ }
        const title = `Wizard${version ? `\nVersion ${version}` : ''}`;
        try {
            await message(
                `${title}\n\nA desktop tool for CSV sensor data exploration and predictive modeling.`,
                { title: 'About', kind: 'info' }
            );
        } catch {
            alert(`Wizard${version ? ` v${version}` : ''}`);
        }
    },
  });

  return (
    <>
      <ErrorBoundary>
        <TitleBar
          workspaceName={metadata ? workspaceName : undefined}
          onRename={handleRename}
          renameTrigger={renameTrigger}
        />
        <main className="app-container">
          {!metadata ? (
            <div className="app-page-transition">
              <DataUploadPage
                onDataReady={(data, workspaceState, sm) => {
                  setMetadata(data);
                  setSensorMetadata(sm ?? null);
                  setInitialWorkspaceState(workspaceState);
                  setWorkspaceName(workspaceState.name);
                }}
              />
            </div>
          ) : (
            <div className="app-page-transition">
              <Suspense fallback={null}>
                <Dashboard
                  ref={dashboardRef}
                  metadata={metadata}
                  sensorMetadata={sensorMetadata}
                  onBack={handleBackToImport}
                  initialState={initialWorkspaceState}
                />
              </Suspense>
            </div>
          )}
        </main>
      </ErrorBoundary>
      {/* Outside the boundary so alerts survive even a full React-tree crash. */}
      <ErrorToasts />
    </>
  );
}

export default App;
