import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Loader2, AlertTriangle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { subscribe } from "../../utils/tauriEvents";
import { useDataUpload } from "../../hooks/useDataUpload";
import { useMappingData, buildSensorMetadataFromMapping } from "../../hooks/useMappingData";
import type { CsvMetadata, MachineDetails, SensorMetadata, SpecialSensorRecipe, WorkspaceState, WorkspaceMetadata } from "../../types";
import {
  saveWorkspaceData,
  loadWorkspaceData,
  getRecentWorkspaces,
  deleteWorkspace,
  renameWorkspaceFile,
  saveLegacyFormulaConversion,
} from "../../workspaceManager";
import { formatDateTime } from "../../utils/dateFormat";
import { logToFile, reportError } from "../../errorReporter";
import { replaySpecialSensorRecipes } from "../../utils/specialSensorReplay";
import { convertLegacyFormulaRecipes, legacyConversionMessage } from "../../utils/legacyFormulaConversion";
import { bindToGeneration, StaleSessionError } from "../../utils/staleSession";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { buildInitialFailureGroups } from "../dashboard/failureGroupOps";
import { DARK, mono } from "./uploadTheme";
import HomeStep from "./HomeStep";
import SetupRail from "./SetupRail";
import ProjectNameStep from "./ProjectNameStep";
import SensorDataPanel from "./SensorDataPanel";
import TagNamesPanel from "./TagNamesPanel";
import FailureGroupsStep, { type DraftGroup } from "./FailureGroupsStep";
import { BackButton, PrimaryButton } from "./SetupPrimitives";
import { useCsvLoadProgress } from "./useCsvLoadProgress";
import { PROJECT_NAME_MAX, formatCount } from "./setupHelpers";
import { DUPLICATE_PAIR_REASON, missingFieldsReason } from "./MachineFields";
import { ProjectDetailsModal } from "../windows/ProjectDetailsModal";
import {
  EMPTY_MACHINE,
  ensureDataUtcOffset,
  isDuplicatePlantMachine,
  missingMachineFields,
  pcOffsetMin,
  projectDescription as describeMachine,
  projectDisplayName,
} from "../../utils/projectDetails";

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
 * Every replay command is pinned to `generation` -- the generation
 * of the `load_csv` that produced THIS dataset -- so a second load that
 * overlapped this one (and replaced the Rust session) makes the replay fail
 * with `StaleSessionError` instead of building this workspace's sensors on
 * another workspace's data. The caller reloads and retries.
 */
async function restoreSpecialSensors(recipes: SpecialSensorRecipe[], generation: number | undefined): Promise<string[]> {
  const { failed, skipped, errors } = await replaySpecialSensorRecipes(
    recipes,
    bindToGeneration((cmd, args) => invoke<unknown>(cmd, args), generation),
  );
  if (failed.length + skipped.length > 0) {
    const parts = [
      failed.length > 0
        // Each with the backend's reason (a removed source, or a formula
        // Rust refuses, e.g. `$A * pi`).
        ? `${failed.length} special sensor${failed.length !== 1 ? 's' : ''} couldn't be restored: ${failed
            .map(tag => (errors?.[tag] ? `${tag} (${errors[tag]})` : tag))
            .join(', ')}.`
        : null,
      skipped.length > 0
        ? `Skipped because they are built on a sensor that couldn't be restored: ${skipped.join(', ')}.`
        : null,
      // What to DO: the fix is editing the broken recipe, and it
      // works even when a model uses the sensor (only its name stays locked).
      failed.length > 0
        ? `To fix: on the Dashboard open Add Special Sensor > Manage and edit ${failed.length === 1 ? 'it' : 'each one'} (pencil) to correct the formula.`
          // Only true for a skipped sensor whose OWN recipe is still accepted:
          // one that is refused too is then listed in Manage as needing its own fix.
          + (skipped.length > 0
            ? ' Fixing it also rebuilds the skipped ones whose own formulas are still accepted; any that are not are then marked in Manage to fix the same way.'
            : '')
        : null,
    ].filter(Boolean);
    reportError(
      'special-sensor-restore',
      parts.join(' '),
      'A source sensor may have been renamed or removed since they were created, or the formula is no longer accepted. ' +
        'They have no data and are left off the chart until fixed. Models that use a fixed sensor are set back to Incomplete and must be trained again.'
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
  // sensor data (+ optional tag names), (3) name the failure groups (customer
  // batch 2026-10, item 5; skippable), then (4) "Opening the Dashboard…" — a
  // rail-only state for the moment the new workspace is saved and handed off.
  // Name/description/groups live in local state until "Open Dashboard" (or
  // "Skip for now") on step 3 persists them into the WorkspaceState. Step 0 is
  // left only by New project or by picking a recent workspace — and
  // handleLoadWorkspace never touches `step` (a reopened project is never
  // walked through step 3; it navigates away from this page entirely).
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  // The project IS the machine: named "Plant · Machine", described "tag ·
  // notes" (both derived -- see utils/projectDetails.ts). The data's time zone
  // is picked on step 2 (default: this PC's offset).
  const [machine, setMachine] = useState<MachineDetails>(EMPTY_MACHINE);
  const [dataTz, setDataTz] = useState<number>(() => pcOffsetMin());
  const projectName = projectDisplayName(machine);
  const projectDescription = describeMachine(machine);
  const [draftGroups, setDraftGroups] = useState<DraftGroup[]>([]);
  const [groupsSkipped, setGroupsSkipped] = useState(false);
  // A step-3 card shows a duplicate name it could not save: Open Dashboard
  // waits until it is fixed (or Esc'd back), so the old name is never saved
  // silently in its place. Skip stays available — it saves no groups at all.
  const [groupsInvalid, setGroupsInvalid] = useState(false);
  // A Plant · Machine pair another project already uses is checked FIRST and
  // blocks Continue; then every required field must be filled.
  const pairTaken = isDuplicatePlantMachine(machine, workspaces);
  const createWhy = pairTaken ? DUPLICATE_PAIR_REASON : missingFieldsReason(missingMachineFields(machine), "continue");
  const canCreateProject = createWhy === null;
  // Rename on a recent-project card opens Project details for that project
  // (read fresh from disk right before opening).
  const [detailsFor, setDetailsFor] = useState<WorkspaceState | null>(null);
  const openDetails = async (id: string) => {
    try {
      const ws = await loadWorkspaceData(id);
      if (ws) setDetailsFor(ws);
      else setWorkspaceError("Workspace not found");
    } catch (err) {
      setWorkspaceError(String(err));
    }
  };
  const continuingRef = useRef(false);
  const startNewProject = () => {
    continuingRef.current = false;
    setDraftGroups([]);
    setGroupsSkipped(false);
    setStep(1);
  };

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

  // "Latest click wins". Every open-workspace click takes the next
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

  // Step 3's "Open Dashboard" (skip = false) and "Skip for now" (skip = true).
  const handleContinue = async (skip: boolean) => {
    // One save per click: a second click before the re-render must not create a second workspace.
    if (!report || continuingRef.current) return;
    continuingRef.current = true;
    // The rail stays on screen with step 4 current ("Opening the Dashboard…")
    // while the new workspace is saved. Saving a fresh workspace's JSON is
    // near-instant (<50ms), so without a floor the swap flickers past and
    // reads as abrupt; MIN_TRANSITION_MS is a short bridging pause (not
    // longer — nothing may get slower).
    const MIN_TRANSITION_MS = 500;
    setGroupsSkipped(skip);
    setStep(4);
    try {
      const workspaceId = `ws_${Date.now()}`;
      const metadata: CsvMetadata = {
        headers: report.headers,
        total_rows: report.total_rows,
        // The dataset this Dashboard sits on -- special-sensor commands are
        // pinned to it (see `utils/staleSession.ts`).
        generation: report.generation,
      };
      const base: WorkspaceState = {
        id: workspaceId,
        name: projectName.trim() || `Workspace ${formatDateTime(new Date())}`,
        description: projectDescription.trim() || undefined,
        machine: {
          plant: machine.plant.trim(),
          name: machine.name.trim(),
          tag: machine.tag.trim(),
          notes: machine.notes.trim(),
        },
        dataUtcOffsetMin: dataTz,
        // The Dashboard opens on its Failure Groups tab, where sensors are
        // assigned to the groups just named (or the first group is created).
        lastRoute: "failure-group",
        dataFilePaths: dataUpload.selectedFiles,
        metadataFilePath: null,
        selectedSensors: [],
        visibleSensors: [],
        operationConfig: null,
        mappingFilePath: mapping.mappingFilePath,
        mappingKeyColumn: mapping.keyColumn,
      };
      // Groups built by the same helpers the Dashboard's FG tab uses, so they
      // are identical in shape to ones created there ("Not in Group" first,
      // FG-1 … in the order typed). Skip → only "Not in Group": the recent
      // project then reads "No failure groups" (count 0), not "no chip".
      const state = withFailureGroupState(base, {
        groups: buildInitialFailureGroups(skip ? [] : draftGroups),
      });
      await Promise.all([
        saveWorkspaceData(state),
        new Promise((resolve) => setTimeout(resolve, MIN_TRANSITION_MS)),
      ]);
      onDataReady(metadata, state, mapping.sensorMetadata);
    } catch (err) {
      setWorkspaceError(String(err));
      setGroupsSkipped(false);
      setStep(3);
      continuingRef.current = false;
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

      // A legacy spreadsheet-style `round($A, 2)` is rewritten to the engine
      // form `round($A * 100) / 100` BEFORE the replay (pure text, no dataset --
      // once per open, outside the retry loop), so the sensor restores instead
      // of being refused. The rewrite (and the models it sends back to
      // Incomplete) is saved after the loop, in one write.
      const { recipes: recipesToReplay, converted } = await convertLegacyFormulaRecipes(
        state.specialSensorRecipes,
        (c, a) => invoke<unknown>(c, a),
      );
      if (!isLatest()) return;
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
        if (recipesToReplay.length) {
          try {
            noData = await restoreSpecialSensors(recipesToReplay, loaded.generation);
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

      // Persist the conversion (new formula text + the demotion of every model
      // trained on a converted sensor, in ONE write against disk), and hand the
      // Dashboard the WRITTEN state -- its full-overwrite autosave would
      // otherwise write the old `round($A, 2)` text straight back. Nothing
      // converted = no write.
      let opened: WorkspaceState = state;
      let notice: Awaited<ReturnType<typeof saveLegacyFormulaConversion>> = null;
      if (converted.length > 0) {
        try {
          notice = await saveLegacyFormulaConversion(id, converted);
        } catch (err) {
          console.warn("Could not save the converted special-sensor rounding:", err);
        }
        if (!isLatest()) return;
      }
      // What to tell the user (shown once the Dashboard is up, below). An
      // information message, not an error: nothing failed, the values changed.
      let roundingNotice: { text: string; trace: string } | null = null;
      if (notice) {
        opened = notice.state;
        roundingNotice = {
          text: notice.message,
          trace: `Converted: ${notice.converted.map(c => `${c.tag}: ${c.from} → ${c.to}`).join('; ')}`
            + (notice.retrainModelIds.length > 0 ? `. Models set back to Incomplete: ${notice.retrainModelIds.length}.` : '.'),
        };
      } else if (converted.length > 0) {
        // The file could not be written: the replay used the converted text, so
        // the Dashboard must hold it too (its autosave then saves it -- and
        // sends the models trained on these sensors back to Incomplete).
        opened = { ...state, specialSensorRecipes: recipesToReplay };
        roundingNotice = {
          text: `${legacyConversionMessage(converted, 0)} The change will be saved with the project.`,
          trace: `Converted (not written yet, saved by the Dashboard): ${converted.map(c => `${c.tag}: ${c.from} → ${c.to}`).join('; ')}.`,
        };
      }

      // A project made before the data's time zone existed gets this PC's
      // offset, once -- the ONE caller of ensureDataUtcOffset. Only after the
      // data really loaded (a failed open leaves the file untouched), and
      // never fatal.
      let dataUtcOffsetMin: number | null = null;
      try {
        dataUtcOffsetMin = await ensureDataUtcOffset(id);
      } catch (err) {
        console.warn("Could not set the data's time zone:", err);
      }
      if (!isLatest()) return;

      let stateForDashboard: WorkspaceState = dataUtcOffsetMin !== null && opened.dataUtcOffsetMin === undefined
        ? { ...opened, dataUtcOffsetMin }
        : opened;
      if (opened.specialSensorRecipes?.length) {
        if (noData.length > 0) {
          // A sensor with no column behind it must not stay plotted: its chart
          // series would be empty (or the scatter/pair cell blank). Its recipe
          // and metadata are kept so it can still be fixed in Manage.
          const gone = new Set(noData.map(t => t.trim().toLowerCase()));
          const keep = (tags: string[] | undefined) =>
            tags?.filter(t => !gone.has(t.trim().toLowerCase()));
          stateForDashboard = {
            ...opened,
            selectedSensors: keep(opened.selectedSensors) ?? [],
            visibleSensors: keep(opened.visibleSensors) ?? [],
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

      // `lastRoute === 'failure-group'` renders Dashboard normally, like
      // `'dashboard'` does; Dashboard itself reads `initialState.lastRoute`
      // to decide whether to land on the Failure Groups tab — see
      // Dashboard.tsx.
      // Only the newest click hands over (a mapping load above may have taken
      // long enough for another workspace to be clicked).
      if (!isLatest()) return;
      onDataReady(dataMetadata, stateForDashboard, sm);
      if (roundingNotice) {
        logToFile('special-sensor-rounding', roundingNotice.text, roundingNotice.trace);
        // Not awaited: the Dashboard opens behind it.
        const text = roundingNotice.text;
        void Promise.resolve()
          .then(() => message(text, { title: 'Rounding updated', kind: 'info' }))
          .catch(e => console.warn('Could not show the rounding notice:', e));
      }
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
  // cannot be undone -- so the UI asks first: the confirmation is IN THE ROW
  // ("Delete this project? [Delete] [Cancel]", RecentProjectCard /
  // WorkspaceRow); this handler only runs once the user has confirmed.
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
    if (stepRef.current === 0 && !loadingWorkspaceRef.current) startNewProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          onNewProject={startNewProject}
          onOpenWorkspace={handleLoadWorkspace}
          onRenameWorkspace={handleRenameWorkspace}
          onEditWorkspace={(id) => { void openDetails(id); }}
          onDeleteWorkspace={handleDeleteWorkspace}
        />
        {loadingOverlay}
        {detailsFor && (
          <ProjectDetailsModal
            workspace={detailsFor}
            existing={workspaces}
            onSaved={() => refreshWorkspaces()}
            onClose={() => setDetailsFor(null)}
          />
        )}
      </div>
    );
  }

  const mappedCount = mapping.mappingResult?.matched.length ?? 0;
  const rowsText = formatCount(report?.total_rows);
  // Sensor columns read (the first column is the timestamp).
  const tagCount = report?.headers?.length ? report.headers.length - 1 : 0;
  // "2 files · 159,264 rows · 132 tags" — may wrap to a second rail line.
  const dataSummary = isReady
    ? [
        `${files.length} file${files.length === 1 ? "" : "s"}`,
        rowsText ? `${rowsText} rows` : null,
        tagCount > 0 ? `${formatCount(tagCount)} tag${tagCount === 1 ? "" : "s"}` : null,
      ].filter(Boolean).join(" · ")
    : null;
  const groupCount = draftGroups.length;
  const groupsSummary = groupsSkipped
    ? "Skipped · 0 groups"
    : `${groupCount} group${groupCount === 1 ? "" : "s"}`;

  const statusStyle: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 7,
    fontSize: 11.5, color: T.textFaint, fontFamily: mono, letterSpacing: "0.02em",
  };

  return (
    <div style={pageStyle}>
      <div style={{ display: "grid", gridTemplateColumns: "268px minmax(0, 1fr)", background: T.bg, flex: 1, minHeight: 0 }}>
        {/* The step (content + footer) comes FIRST in DOM order and the rail
            after it, placed back into the left column by the grid — so on
            every step Tab reaches the step's own controls before the rail. */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, gridColumn: 2, gridRow: 1 }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "34px 40px 24px", display: "flex", flexDirection: "column" }}>
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
                machine={machine}
                onMachineChange={setMachine}
                existing={workspaces}
              />
            )}

            {step === 2 && (
              <div data-testid="sensor-data-step">
                <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: T.textFaint }}>
                  Step 2 of 3 · {projectName.trim().slice(0, PROJECT_NAME_MAX)}
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
                    tzOffsetMin={dataTz}
                    onTzChange={setDataTz}
                  />
                  <TagNamesPanel T={T} locked={!isReady} mapping={mapping} />
                </div>
              </div>
            )}

            {step === 3 && (
              <FailureGroupsStep
                T={T}
                projectName={projectName}
                groups={draftGroups}
                onChange={setDraftGroups}
                onInvalidChange={setGroupsInvalid}
              />
            )}

            {step === 4 && (
              <div className="fg-step-opening" data-testid="opening-dashboard" role="status" aria-live="polite">
                <span className="fg-step-spin" aria-hidden="true" />
                <b>Opening the Dashboard…</b>
                <span>{projectName.trim()} · {formatCount(tagCount) ?? "0"} sensor{tagCount === 1 ? "" : "s"}</span>
                <span className="fg-step-opening-note">
                  It opens on the Failure Groups tab, so the first group is one click away.
                </span>
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
                <span style={pairTaken ? { ...statusStyle, color: T.danger } : statusStyle} data-testid="step1-status">
                  {createWhy ?? "Ready to continue"}
                </span>
                <div style={{ flex: 1 }} />
                <BackButton T={T} onClick={() => setStep(0)} />
                <PrimaryButton T={T} enabled={canCreateProject} onClick={() => setStep(2)}>Continue</PrimaryButton>
              </>
            ) : step === 2 ? (
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
                <PrimaryButton T={T} enabled={isReady} onClick={() => setStep(3)}>Continue</PrimaryButton>
              </>
            ) : step === 3 ? (
              <>
                {/* --text-secondary, never green: naming groups is optional. */}
                <span style={{ ...statusStyle, color: groupsInvalid ? T.danger : T.textMuted }} data-testid="fg-step-status">
                  {groupsInvalid
                    ? "Fix the duplicate group name (or press Esc on it) to open the Dashboard"
                    : groupCount > 0
                    ? `${groupCount} failure group${groupCount === 1 ? "" : "s"} · sensors are assigned in the Dashboard`
                    : "Add at least one failure group, or skip for now"}
                </span>
                <div style={{ flex: 1 }} />
                <BackButton T={T} onClick={() => setStep(2)} />
                <button type="button" className="fg-step-skip" onClick={() => void handleContinue(true)}>
                  Skip for now
                </button>
                <PrimaryButton T={T} enabled={groupCount > 0 && !groupsInvalid} onClick={() => void handleContinue(false)}>Open Dashboard</PrimaryButton>
              </>
            ) : (
              <span style={statusStyle}>Opening the Dashboard…</span>
            )}
          </div>
        </div>

        <div style={{ gridColumn: 1, gridRow: 1, display: "grid", minHeight: 0 }}>
          <SetupRail
            T={T}
            step={step}
            projectName={projectName}
            dataSummary={dataSummary}
            groupsSummary={groupsSummary}
            groupsSkipped={groupsSkipped}
            onStepClick={(s) => {
              // Only ever navigate BACKWARD by clicking a step — every later
              // step is gated by its own Continue — and never while the
              // Dashboard is opening.
              if (s < step && step !== 4) setStep(s);
            }}
            onAllProjects={() => { if (step !== 4) setStep(0); }}
          />
        </div>
      </div>

      {loadingOverlay}
    </div>
  );
}
