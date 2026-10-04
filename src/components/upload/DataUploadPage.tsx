import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Loader2, AlertTriangle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { subscribe } from "../../utils/tauriEvents";
import { useDataUpload } from "../../hooks/useDataUpload";
import { useMappingData, buildSensorMetadataFromMapping } from "../../hooks/useMappingData";
import type { CsvMetadata, SensorMetadata, SpecialSensorRecipe, WorkspaceState, WorkspaceMetadata } from "../../types";
import {
  saveWorkspaceData,
  loadWorkspaceData,
  getRecentWorkspaces,
  deleteWorkspace,
  renameWorkspaceFile,
} from "../../workspaceManager";
import { formatDateTime } from "../../utils/dateFormat";
import { reportError } from "../../errorReporter";
import { replaySpecialSensorRecipes } from "../../utils/specialSensorReplay";
import { bindToGeneration, StaleSessionError } from "../../utils/staleSession";
import { DARK, mono } from "./uploadTheme";
import HomeStep from "./HomeStep";
import SetupRail from "./SetupRail";
import ProjectNameStep from "./ProjectNameStep";
import SensorDataPanel from "./SensorDataPanel";
import TagNamesPanel from "./TagNamesPanel";
import { BackButton, PrimaryButton } from "./SetupPrimitives";
import { useCsvLoadProgress } from "./useCsvLoadProgress";
import { PROJECT_NAME_MAX, formatCount } from "./setupHelpers";

interface DataUploadPageProps {
  /**
   * Bumped by App each time the native File > New Workspace menu item (or its
   * Ctrl/Cmd+N accelerator) fires while this page is showing. On step 0 that
   * starts a new project, like the "New project" button; on steps 1-2 it is
   * ignored. Idempotent with HomeStep's own Ctrl+N key handler.
   */
  newProjectSignal?: number;
  onDataReady: (
    metadata: CsvMetadata,
    workspaceState: WorkspaceState,
    sensorMetadata?: SensorMetadata[] | null
  ) => void;
}

/**
 * Rebuilds every "Add Special Sensor" column in the Rust backend's
 * in-memory session right after `load_csv` on a workspace reopen -- see
 * `WorkspaceState.specialSensorRecipes`'s own doc comment for why this is
 * necessary at all: `calculate_new_sensor`/`evaluate_formula` push the
 * computed column straight onto that session's memory, which is wiped on
 * every app restart and re-created fresh from the ORIGINAL CSV (no calculated
 * columns) -- without this replay, a special sensor's name/description would
 * still show up (from `extraSensorMetadata`) but plot no data at all,
 * silently.
 *
 * The replay itself (dependency order, `customName` forced to the recipe's own
 * tag, skipping everything built on a recipe that failed) lives in
 * `utils/specialSensorReplay.ts`. This wrapper adds the user-facing part:
 * recipes that fail are skipped, not fatal for the whole workspace open, and
 * all failures are surfaced together as ONE toast via the global error
 * reporter. Returns the tags that have no data this session (failed +
 * skipped) so the caller can keep them off the plot.
 *
 * 2026-10-03: every replay command is pinned to `generation` -- the generation
 * of the `load_csv` that produced THIS dataset -- so a second load that
 * overlapped this one (and replaced the Rust session) makes the replay fail
 * with `StaleSessionError` instead of building this workspace's sensors on
 * another workspace's data. The caller reloads and retries.
 */
async function restoreSpecialSensors(recipes: SpecialSensorRecipe[], generation: number | undefined): Promise<string[]> {
  const { failed, skipped } = await replaySpecialSensorRecipes(
    recipes,
    bindToGeneration((cmd, args) => invoke<unknown>(cmd, args), generation),
  );
  if (failed.length + skipped.length > 0) {
    const parts = [
      failed.length > 0
        ? `${failed.length} special sensor${failed.length !== 1 ? 's' : ''} couldn't be restored: ${failed.join(', ')}.`
        : null,
      skipped.length > 0
        ? `Skipped because they are built on a sensor that couldn't be restored: ${skipped.join(', ')}.`
        : null,
    ].filter(Boolean);
    reportError(
      'special-sensor-restore',
      parts.join(' '),
      'Their source sensor(s) may have been renamed or removed since they were created. ' +
        'They have no data until fixed in Special Sensors > Manage, and are left off the chart.'
    );
  }
  return [...failed, ...skipped];
}

/* ---------------------------------------------------------------- */
/* Page                                                             */
/* ---------------------------------------------------------------- */

export default function DataUploadPage({ onDataReady, newProjectSignal = 0 }: DataUploadPageProps) {
  const dataUpload = useDataUpload();
  const mapping = useMappingData();
  const T = DARK;

  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceMetadata[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

  // Onboarding: (0) choose new-vs-recent, (1) name the project, (2) add the
  // sensor data (+ optional tag names). Name/description live in local state
  // until "Open Dashboard" on step 2 persists them into the WorkspaceState.
  // Step 0 is skipped only by picking a recent workspace (handleLoadWorkspace
  // never touches `step` — it navigates away from this page entirely).
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const canCreateProject = projectName.trim().length > 0;

  const refreshWorkspaces = () => {
    getRecentWorkspaces()
      .then((list) => { setWorkspaces(list); setWorkspacesLoaded(true); })
      .catch((err) => { console.error(err); setWorkspacesLoaded(true); });
  };

  useEffect(() => {
    refreshWorkspaces();
  }, []);

  // Tracks when the current workspace-load started — used by the
  // focus-fallback below to decide whether to nuke a stuck loading state.
  const loadingStartedAtRef = useRef<number | null>(null);

  // 2026-10-03: "latest click wins". Every open-workspace click takes the next
  // sequence number; only the newest load may replay sensors and hand over to
  // the Dashboard -- an older one that finishes late is discarded. The Rust
  // session is ONE shared object, so an older load_csv that lands after a
  // newer one REPLACES the newer one's dataset: `loadCsvInFlightRef` lets the
  // newer load wait for those to land (then re-check / reload) before it
  // replays anything. `backendPhaseRef` counts loads between their first
  // `load_csv` and their end -- the window in which a focus event is NOT a
  // sign of a stuck spinner (see the focus fallback below).
  const loadSeqRef = useRef(0);
  const loadCsvInFlightRef = useRef(new Map<number, Promise<unknown>>());
  const backendPhaseRef = useRef(0);

  const clearLoadingState = () => {
    setLoadingWorkspace(false);
    setActiveWorkspaceId(null);
    setWorkspaceError(null);
    loadingStartedAtRef.current = null;
  };

  // Reset in-flight workspace-load state when a sub-window (FG / PM) hands
  // focus back to main. Without this the loading spinner sticks forever:
  //   1. User clicks a Recent Workspace → setLoadingWorkspace(true), then
  //      handleLoadWorkspace spawns the FG/PM sub-window and (in the
  //      handshake's success path) destroys main.
  //   2. If the user clicks "Back to Upload" BEFORE main is destroyed (or
  //      the destroy is swallowed), the sub-window reuses main via
  //      WebviewWindow.getByLabel('main') + show()+setFocus(). React state
  //      survives intact — including the stale `loadingWorkspace=true`.
  //
  // Two layers of defense:
  //   (a) Primary — sub-window emits `upload-page-resumed` right before
  //       closing; we listen and reset. Explicit, unambiguous.
  //   (b) Fallback — `tauri://focus` event. If main regains focus and
  //       `loadingWorkspace` is still true after the typical load duration
  //       (>2 s), the load has clearly handed off already → reset. Catches
  //       paths the explicit emit might miss (e.g. native red-close on
  //       macOS, force-quit of sub-window, IPC swallowed).
  //
  // We refresh the workspace list on either signal since the user may have
  // saved / renamed in the sub-window.
  useEffect(() => {
    let disposed = false;
    let disposeFocus: (() => void) | undefined;

    const disposeListen = subscribe('upload-page-resumed', () => {
      clearLoadingState();
      refreshWorkspaces();
    });

    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      const started = loadingStartedAtRef.current;
      // A load that is really talking to the backend (load_csv / replay) is
      // not "stuck": clearing its overlay would let a second workspace be
      // clicked mid-load and the two would interleave on the one Rust session.
      if (backendPhaseRef.current > 0) return;
      if (started !== null && Date.now() - started > 2000) {
        clearLoadingState();
        refreshWorkspaces();
      }
    }).then((fn) => { if (disposed) fn(); else disposeFocus = fn; });

    return () => {
      disposed = true;
      disposeListen();
      if (disposeFocus) disposeFocus();
    };
  }, []);

  const files = dataUpload.selectedFiles;
  const report = dataUpload.loadReport;
  const hasFiles = files.length > 0;
  const hasReport = !!report;
  const isStale = dataUpload.isStale;
  // "Ready" means: parsed report exists AND the current file selection still
  // matches the snapshot used for that parse. Editing the file list after
  // parse (add / remove / reorder) demotes the report back to not-ready so
  // the user is prompted to re-parse before continuing.
  const isReady = hasReport && !isStale && hasFiles;
  // Read progress of THIS page's own parse (the event is a global broadcast, so
  // it is only followed while `Parse files` is running -- see the hook).
  const readProgress = useCsvLoadProgress(dataUpload.isLoading);

  const handleApplyMapping = async () => {
    if (!report) return;
    await mapping.applyMapping(report.headers);
  };

  // Auto-apply mapping once dataset report and key column are both available.
  useEffect(() => {
    if (report && mapping.mappingData && mapping.keyColumn && !mapping.mappingResult && !mapping.isLoading) {
      void handleApplyMapping();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, mapping.mappingData, mapping.keyColumn]);

  const handleContinue = async () => {
    if (!report) return;
    // Same loading overlay handleLoadWorkspace uses for "open recent
    // workspace" — that path feels smooth because re-parsing the CSVs
    // takes long enough (hundreds of ms) for the overlay to actually
    // register. Saving a fresh workspace's JSON is near-instant (<50ms),
    // so without a floor the overlay flickers past unnoticed and the swap
    // still reads as abrupt. MIN_TRANSITION_MS forces the same bridging
    // pause the "smooth" path gets for free.
    const MIN_TRANSITION_MS = 500;
    setLoadingWorkspace(true);
    try {
      const workspaceId = `ws_${Date.now()}`;
      const metadata: CsvMetadata = {
        headers: report.headers,
        total_rows: report.total_rows,
        // The dataset this Dashboard sits on -- special-sensor commands are
        // pinned to it (see `utils/staleSession.ts`).
        generation: report.generation,
      };
      const state: WorkspaceState = {
        id: workspaceId,
        name: projectName.trim() || `Workspace ${formatDateTime(new Date())}`,
        description: projectDescription.trim() || undefined,
        lastRoute: "dashboard",
        dataFilePaths: dataUpload.selectedFiles,
        metadataFilePath: null,
        selectedSensors: [],
        visibleSensors: [],
        operationConfig: null,
        mappingFilePath: mapping.mappingFilePath,
        mappingKeyColumn: mapping.keyColumn,
      };
      await Promise.all([
        saveWorkspaceData(state),
        new Promise((resolve) => setTimeout(resolve, MIN_TRANSITION_MS)),
      ]);
      onDataReady(metadata, state, mapping.sensorMetadata);
    } catch (err) {
      setWorkspaceError(String(err));
      setLoadingWorkspace(false);
    }
  };

  const handleLoadWorkspace = async (id: string) => {
    const seq = ++loadSeqRef.current;
    const isLatest = () => seq === loadSeqRef.current;
    let inBackendPhase = false;
    setLoadingWorkspace(true);
    setWorkspaceError(null);
    setActiveWorkspaceId(id);
    loadingStartedAtRef.current = Date.now();
    try {
      const state = await loadWorkspaceData(id);
      // A newer click took over while the file was being read: this load never
      // touches the backend at all.
      if (!isLatest()) return;
      if (!state) throw new Error("Workspace not found");

      backendPhaseRef.current += 1;
      inBackendPhase = true;
      const olderLoads = () =>
        [...loadCsvInFlightRef.current.entries()].filter(([k]) => k < seq).map(([, p]) => p);

      // load_csv + replay, retried while the Rust session is replaced under it
      // (an older, slower load_csv landing after ours). Each attempt is bound
      // to the generation ITS load_csv returned.
      const MAX_ATTEMPTS = 3;
      let dataMetadata: CsvMetadata | null = null;
      let noData: string[] = [];
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !dataMetadata; attempt++) {
        const call = invoke<CsvMetadata>("load_csv", { paths: state.dataFilePaths });
        loadCsvInFlightRef.current.set(seq, call);
        let loaded: CsvMetadata;
        try {
          loaded = await call;
        } finally {
          if (loadCsvInFlightRef.current.get(seq) === call) loadCsvInFlightRef.current.delete(seq);
        }
        if (!isLatest()) return;

        // An older load_csv still running will replace the session the moment
        // it lands. Let it land, then make sure the session is still OURS.
        const before = olderLoads();
        if (before.length > 0) {
          await Promise.allSettled(before);
          if (!isLatest()) return;
          let current: unknown;
          try { current = await invoke<number | null>("get_session_generation"); } catch { current = undefined; }
          if (typeof current === "number" && typeof loaded.generation === "number" && current !== loaded.generation) continue;
        }

        // Must happen before `onDataReady` hands off to Dashboard, so the
        // very first chart render already has real data for every special
        // sensor instead of a "ghost" entry that only gets fixed on the next
        // manual refresh (see `replaySpecialSensorRecipes`'s own comment).
        if (state.specialSensorRecipes?.length) {
          try {
            noData = await restoreSpecialSensors(state.specialSensorRecipes, loaded.generation);
          } catch (err) {
            // The session was replaced mid-replay: reload and rebuild.
            if (err instanceof StaleSessionError) continue;
            throw err;
          }
          if (!isLatest()) return;
          // An older load that only just started landing: wait, then redo.
          const after = olderLoads();
          if (after.length > 0) {
            await Promise.allSettled(after);
            continue;
          }
        }
        dataMetadata = loaded;
      }
      if (!dataMetadata) {
        throw new Error("The dataset kept changing while the project was loading. Please try again.");
      }
      if (!isLatest()) return;

      let stateForDashboard = state;
      if (state.specialSensorRecipes?.length) {
        if (noData.length > 0) {
          // A sensor with no column behind it must not stay plotted: its chart
          // series would be empty (or the scatter/pair cell blank). Its recipe
          // and metadata are kept so it can still be fixed in Manage.
          const gone = new Set(noData.map(t => t.trim().toLowerCase()));
          const keep = (tags: string[] | undefined) =>
            tags?.filter(t => !gone.has(t.trim().toLowerCase()));
          stateForDashboard = {
            ...state,
            selectedSensors: keep(state.selectedSensors) ?? [],
            visibleSensors: keep(state.visibleSensors) ?? [],
          };
        }
      }

      let sm: SensorMetadata[] | null = null;
      if (state.mappingFilePath && state.mappingKeyColumn) {
        try {
          const mappingData = await invoke<import("../../types/dataUpload").MappingData>(
            "load_mapping_csv",
            { path: state.mappingFilePath }
          );
          const mappingResult = await invoke<import("../../types/dataUpload").MappingResult>(
            "apply_sensor_mapping",
            {
              keyColumn: state.mappingKeyColumn,
              mappingData,
              datasetHeaders: dataMetadata.headers,
            }
          );
          sm = buildSensorMetadataFromMapping(mappingData, mappingResult, state.mappingKeyColumn);
        } catch (err) {
          console.warn("Failed to reload mapping:", err);
        }
      }
      if (!sm && state.metadataFilePath) {
        try {
          sm = await invoke<SensorMetadata[]>("load_metadata_command", { path: state.metadataFilePath });
        } catch { /* ignore */ }
      }

      // Recent-workspace navigation used to branch here: `lastRoute ===
      // 'failure-group'` spawned the standalone FailureGroupCreation.tsx
      // window (destroying `main` first). That window is gone now —
      // failure-group management lives inline in Dashboard's Sensor panel,
      // so that route just renders Dashboard normally like `'dashboard'`
      // does. Dashboard itself reads `initialState.lastRoute` to decide
      // whether to land on the Failure Groups tab (`'failure-group'`) — see
      // Dashboard.tsx. (The Predictive Model page no longer has its own
      // route at all — it's reached only via Build Model's "Build Model →"
      // button and never auto-resumes on workspace open.)
      // Only the newest click hands over (a mapping load above may have taken
      // long enough for another workspace to be clicked).
      if (!isLatest()) return;
      onDataReady(dataMetadata, stateForDashboard, sm);
    } catch (err) {
      // An older load's failure is not the user's concern any more.
      if (!isLatest()) return;
      setWorkspaceError(String(err));
      setLoadingWorkspace(false);
      setActiveWorkspaceId(null);
      loadingStartedAtRef.current = null;
    } finally {
      if (inBackendPhase) backendPhaseRef.current -= 1;
    }
  };

  // Deleting a whole workspace also removes its model output folder, which
  // cannot be undone -- so the UI asks first. 2026-10-04: the confirmation is
  // IN THE ROW ("Delete this project? [Delete] [Cancel]", RecentProjectCard /
  // WorkspaceRow), replacing the earlier Tauri `ask` dialog; this handler only
  // runs once the user has confirmed.
  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteWorkspace(id);
    } catch (err) {
      setWorkspaceError(String(err));
    }
    refreshWorkspaces();
  };

  // Rename a workspace from the inline edit field on a Get-started card.
  // No-ops on empty / unchanged names to avoid pointless file rewrites.
  const handleRenameWorkspace = async (id: string, newName: string, currentName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) return;
    try {
      await renameWorkspaceFile(id, trimmed);
    } catch (err) {
      setWorkspaceError(String(err));
    }
    refreshWorkspaces();
  };

  // Native File > New Workspace (App bumps `newProjectSignal`): on step 0 it
  // starts a new project; on steps 1-2 and while a load is running it is a
  // no-op, same as before. Idempotent with HomeStep's own Ctrl+N handler --
  // whichever fires first moves to step 1, the other then finds step !== 0.
  const stepRef = useRef(step);
  stepRef.current = step;
  const loadingWorkspaceRef = useRef(loadingWorkspace);
  loadingWorkspaceRef.current = loadingWorkspace;
  const seenNewProjectSignalRef = useRef(newProjectSignal);
  useEffect(() => {
    if (newProjectSignal === seenNewProjectSignalRef.current) return;
    seenNewProjectSignalRef.current = newProjectSignal;
    if (stepRef.current === 0 && !loadingWorkspaceRef.current) setStep(1);
  }, [newProjectSignal]);

  /* ----------------- Render ----------------- */

  const pageStyle: CSSProperties = {
    width: "100%", height: "100vh", background: T.bg, color: T.text,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
    display: "flex", flexDirection: "column", overflow: "hidden",
  };

  // Full-screen loading overlay. Sits on top of EVERYTHING (rail, content,
  // footer) while a workspace is loading so the user can tell the app is
  // working, not frozen. The wrapping div absorbs all pointer events (default
  // for non-transparent divs) and we set cursor: 'wait' for a busy affordance.
  const loadingOverlay = loadingWorkspace ? (
    <div
      aria-busy="true"
      role="alert"
      aria-live="polite"
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(10,10,11,0.65)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "wait",
      }}
    >
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: 14, padding: "26px 36px",
        background: T.surface,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: 12,
        boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
        minWidth: 240,
      }}>
        <Loader2 size={26} className="animate-spin" style={{ color: T.accentHi }} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.text, letterSpacing: "-0.005em" }}>
            Loading workspace…
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>
            Reading dataset and metadata
          </div>
        </div>
      </div>
    </div>
  ) : null;

  // Step 0 ("Get started") is its own full-bleed screen -- no rail or action
  // bar. Steps 1-2 below share the setup rail + footer.
  if (step === 0) {
    return (
      <div style={pageStyle}>
        <HomeStep
          T={T}
          workspaces={workspaces}
          loaded={workspacesLoaded}
          activeWorkspaceId={activeWorkspaceId}
          busy={loadingWorkspace}
          error={workspaceError}
          onNewProject={() => setStep(1)}
          onOpenWorkspace={handleLoadWorkspace}
          onRenameWorkspace={handleRenameWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
        />
        {loadingOverlay}
      </div>
    );
  }

  const mappedCount = mapping.mappingResult?.matched.length ?? 0;
  const rowsText = formatCount(report?.total_rows);
  const dataSummary = isReady
    ? [`${files.length} file${files.length === 1 ? "" : "s"}`, rowsText ? `${rowsText} rows` : null]
        .filter(Boolean).join(" · ")
    : null;

  const statusStyle: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 7,
    fontSize: 11.5, color: T.textFaint, fontFamily: mono, letterSpacing: "0.02em",
  };

  return (
    <div style={pageStyle}>
      <div style={{ display: "grid", gridTemplateColumns: "268px minmax(0, 1fr)", background: T.bg, flex: 1, minHeight: 0 }}>
        <SetupRail
          T={T}
          step={step}
          projectName={projectName}
          dataSummary={dataSummary}
          onStepClick={(s) => {
            // Only ever navigate BACKWARD by clicking a step — step 2 requires
            // a project name, so forward navigation always goes through the
            // Continue button's validation.
            if (s < step) setStep(s);
          }}
          onAllProjects={() => setStep(0)}
        />

        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "34px 40px 24px" }}>
            {workspaceError && (
              <div style={{
                marginBottom: 16, padding: "10px 14px", borderRadius: 8,
                background: "oklch(0.68 0.2 25 / 0.1)",
                border: `1px solid oklch(0.68 0.2 25 / 0.3)`,
                display: "flex", alignItems: "center", gap: 10,
                fontSize: 12.5, color: T.danger,
              }}>
                <AlertTriangle size={14} />
                <span>{workspaceError}</span>
              </div>
            )}

            {step === 1 && (
              <ProjectNameStep
                T={T}
                name={projectName}
                onNameChange={setProjectName}
                description={projectDescription}
                onDescriptionChange={setProjectDescription}
                existing={workspaces}
              />
            )}

            {step === 2 && (
              <div data-testid="sensor-data-step">
                <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: T.textFaint }}>
                  Step 2 of 2 · {projectName.trim().slice(0, PROJECT_NAME_MAX)}
                </div>
                <h2 style={{ margin: "8px 0 0", fontSize: 28, fontWeight: 700, letterSpacing: "-0.025em", color: T.text }}>
                  Add your sensor data
                </h2>
                <p style={{ margin: "8px 0 0", maxWidth: "70ch", fontSize: 13.5, lineHeight: 1.5, color: T.textMuted }}>
                  Drop one or more CSV exports. Files are merged on their timestamps. Add a tag-name file to show readable names instead of tag codes.
                </p>
                <div style={{
                  marginTop: 22, display: "grid", gap: 16, alignItems: "start",
                  gridTemplateColumns: "minmax(0, 1.55fr) minmax(0, 1fr)",
                }}>
                  <SensorDataPanel
                    T={T}
                    files={files}
                    report={report}
                    isReady={isReady}
                    isStale={isStale}
                    isLoading={dataUpload.isLoading}
                    error={dataUpload.error}
                    progress={readProgress}
                    onBrowse={dataUpload.selectFiles}
                    onRemove={dataUpload.removeFile}
                    onParse={dataUpload.uploadDataset}
                  />
                  <TagNamesPanel T={T} locked={!isReady} mapping={mapping} />
                </div>
              </div>
            )}
          </div>

          {/* Action bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 24px", background: T.surface, borderTop: `1px solid ${T.border}`,
          }}>
            {step === 1 ? (
              <>
                <span style={statusStyle}>
                  {canCreateProject ? "Ready to continue" : "Enter a project name to continue"}
                </span>
                <div style={{ flex: 1 }} />
                <BackButton T={T} onClick={() => setStep(0)} />
                <PrimaryButton T={T} enabled={canCreateProject} onClick={() => setStep(2)}>Continue</PrimaryButton>
              </>
            ) : (
              <>
                <span style={{ ...statusStyle, color: isReady ? T.ok : T.textFaint }}>
                  {isReady && <Check size={12} />}
                  {isReady
                    ? `Ready · ${rowsText ?? "0"} rows · ${mappedCount > 0 ? `${mappedCount} names mapped` : "no tag names"}`
                    : isStale
                      ? "Selection changed · re-parse required"
                      : dataUpload.isLoading
                        ? "Reading files…"
                        : "Awaiting data"}
                </span>
                <div style={{ flex: 1 }} />
                <BackButton T={T} onClick={() => setStep(1)} />
                <PrimaryButton T={T} enabled={isReady} onClick={handleContinue}>Open Dashboard</PrimaryButton>
              </>
            )}
          </div>
        </div>
      </div>

      {loadingOverlay}
    </div>
  );
}
