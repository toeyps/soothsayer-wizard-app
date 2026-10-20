import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { DataUploadPage } from "./components/upload";
import type { DashboardRef } from "./components/dashboard";
import { CsvMetadata, PROJECT_DETAILS_CHANGED, SensorMetadata, WorkspaceMetadata, WorkspaceState, type ProjectDetailsChangedPayload } from "./types";

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
import { ProjectDetailsModal } from "./components/windows/ProjectDetailsModal";
import { getRecentWorkspaces, loadWorkspaceData } from "./workspaceManager";
import { subscribe } from "./utils/tauriEvents";
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
  // Project details, opened from the title bar's project menu: the project as
  // it is on disk plus the other projects (the Plant · Machine pair is unique).
  const [details, setDetails] = useState<{ ws: WorkspaceState; others: WorkspaceMetadata[] } | null>(null);
  const workspaceIdRef = useRef<string | undefined>(undefined);
  workspaceIdRef.current = metadata ? initialWorkspaceState?.id : undefined;

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

  // File > New Workspace (Ctrl/Cmd+N). With a workspace open it returns to the
  // Import page as before; already on the Import page it asks DataUploadPage to
  // start a new project (it acts only on step 0 -- see its `newProjectSignal`).
  const [newProjectSignal, setNewProjectSignal] = useState(0);

  const handleBackToImport = () => {
    setDetails(null);
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

  // A Project details save -- from this window or another (Build Model) --
  // renames the open project. Only THIS project's: a payload for another
  // workspace (or with no id) is dropped.
  const handleRenameRef = useRef(handleRename);
  handleRenameRef.current = handleRename;
  useEffect(() => subscribe<ProjectDetailsChangedPayload>(PROJECT_DETAILS_CHANGED, (event) => {
    const p = event.payload;
    if (!p?.workspaceId || p.workspaceId !== workspaceIdRef.current) return;
    handleRenameRef.current(p.name);
  }), []);

  const openDetails = async () => {
    const id = workspaceIdRef.current;
    if (!id) return;
    let ws: WorkspaceState | null = null;
    try {
      ws = await loadWorkspaceData(id);
    } catch (e) {
      console.warn('Could not read the project for Project details:', e);
    }
    if (!ws || ws.id !== workspaceIdRef.current) return;
    let others: WorkspaceMetadata[] = [];
    try { others = await getRecentWorkspaces(); } catch { /* list unavailable: no duplicate check */ }
    setDetails({ ws, others });
  };

  useAppMenu({
    hasWorkspace: !!metadata,
    onNew: () => { if (metadata) handleBackToImport(); else setNewProjectSignal((n) => n + 1); },
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
                `${title}\n\nA desktop tool for exploring CSV sensor data and finding abnormal machine behaviour.`,
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
          onOpenDetails={metadata ? () => { void openDetails(); } : undefined}
        />
        {details && (
          <ProjectDetailsModal
            workspace={details.ws}
            existing={details.others}
            onSaved={(p) => { if (p.workspaceId === workspaceIdRef.current) handleRename(p.name); }}
            onClose={() => setDetails(null)}
          />
        )}
        <main className="app-container">
          {!metadata ? (
            <div className="app-page-transition">
              <DataUploadPage
                newProjectSignal={newProjectSignal}
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
                  key={initialWorkspaceState?.id}
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
