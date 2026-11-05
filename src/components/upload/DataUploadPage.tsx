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
  updateWorkspaceData,
  loadWorkspaceData,
  getRecentWorkspaces,
  deleteWorkspace,
  saveLegacyFormulaConversion,
} from "../../workspaceManager";
import { formatDateTime } from "../../utils/dateFormat";
import { logToFile, reportError } from "../../errorReporter";
import { replaySpecialSensorRecipes } from "../../utils/specialSensorReplay";
import { removeTagsFromFilters } from "../../utils/specialSensorRename";
import { buildSensorLookup, sensorPlainLabel } from "../sensor/sensorInfo";
import { convertLegacyFormulaRecipes, legacyConversionMessage } from "../../utils/legacyFormulaConversion";
import { bindToGeneration, StaleSessionError } from "../../utils/staleSession";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { normalizeConditionSpelling } from "../../utils/workspaceMigrations";
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
import { PROJECT_NAME_MAX, formatCount, tagFileBlockReason } from "./setupHelpers";
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
  /** Bumped by App on File > New Workspace (Ctrl/Cmd+N); starts a new project only on step 0 while no workspace is loading, otherwise ignored. */
  newProjectSignal?: number;
  onDataReady: (
    metadata: CsvMetadata,
    workspaceState: WorkspaceState,
    sensorMetadata?: SensorMetadata[] | null
  ) => void;
}

/** Rebuilds special-sensor columns after load_csv on a reopen; failed ones are skipped and shown in one toast. Returns the tags with no data. Commands are pinned to `generation`, so an overlapping load fails with StaleSessionError. */
async function restoreSpecialSensors(
  recipes: SpecialSensorRecipe[],
  generation: number | undefined,
  metadata: SensorMetadata[] | undefined,
): Promise<string[]> {
  const lookup = buildSensorLookup(null, metadata);
  const nameOf = (tag: string) => sensorPlainLabel(lookup(tag));
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
            .map(tag => (errors?.[tag] ? `${nameOf(tag)} (${errors[tag]})` : nameOf(tag)))
            .join(', ')}.`
        : null,
      skipped.length > 0
        ? `Skipped because they are built on a sensor that couldn't be restored: ${skipped.map(nameOf).join(', ')}.`
        : null,
      // What to DO: the fix is editing the broken recipe, and it
      // works even when a model uses the sensor (only its name stays locked).
      failed.length > 0
        ? `To fix: on the Dashboard open Add Special Sensor > Manage and edit ${failed.length === 1 ? 'it' : 'each one'} (pencil) to correct the formula.`
          // Only for a skipped sensor whose own recipe is still accepted; a refused one is listed in Manage.
          + (skipped.length > 0
            ? ' Fixing it also rebuilds the skipped ones whose own formulas are still accepted; any that are not are then marked in Manage to fix the same way.'
            : '')
        : null,
    ].filter(Boolean);
    reportError(
      'special-sensor-restore',
      parts.join(' '),
      'A source sensor may have been renamed or removed since they were created, or the formula is no longer accepted. ' +
        'They have no data until fixed: they are left off the chart, and any filter condition on them is removed. Models that use a fixed sensor are set back to Incomplete and must be trained again.'
    );
  }
  return [...failed, ...skipped];
}

/* ---------------------------------------------------------------- */
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

  // Steps: 0 new or recent, 1 name, 2 sensor data, 3 failure groups (skippable), 4 opening the Dashboard; the project is saved when step 3 continues.
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  // The project is the machine, named 'Plant . Machine'; the data's time zone is picked on step 2 (default: this PC's offset).
  const [machine, setMachine] = useState<MachineDetails>(EMPTY_MACHINE);
  const [dataTz, setDataTz] = useState<number>(() => pcOffsetMin());
  const projectName = projectDisplayName(machine);
  const projectDescription = describeMachine(machine);
  const [draftGroups, setDraftGroups] = useState<DraftGroup[]>([]);
  const [groupsSkipped, setGroupsSkipped] = useState(false);
  // A duplicate group name that could not be saved blocks Open Dashboard until fixed; Skip saves no groups.
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
  // Kept across retries: a save can write the file, then fail on Recents.
  const newProjectIdRef = useRef<string | null>(null);
  const startNewProject = () => {
    continuingRef.current = false;
    newProjectIdRef.current = null;
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

  // Latest click wins: only the newest load replays and hands over. An older load_csv landing late would replace the newer dataset (one Rust session), so the newer waits on loadCsvInFlightRef.
  // backendPhaseRef counts loads in flight so a focus event doesn't clear a live spinner.
  const loadSeqRef = useRef(0);
  const loadCsvInFlightRef = useRef(new Map<number, Promise<unknown>>());
  const backendPhaseRef = useRef(0);

  const clearLoadingState = () => {
    setLoadingWorkspace(false);
    setActiveWorkspaceId(null);
    setWorkspaceError(null);
    loadingStartedAtRef.current = null;
  };

  // Reset the loading spinner when a sub-window returns focus to main (main survives with a stale loadingWorkspace=true).
  // Primary: `upload-page-resumed`; fallback: `tauri://focus` after more than 2 s. Both refresh the workspace list.
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
      // A load in the backend isn't stuck; clearing its overlay would let a second workspace interleave on the one Rust session.
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
  // Ready = a report exists and the file selection still matches the parse snapshot; editing the files demotes it.
  const isReady = hasReport && !isStale && hasFiles;
  // Progress of this page's own parse only (the event is a global broadcast).
  const readProgress = useCsvLoadProgress(dataUpload.isLoading);

  const handleApplyMapping = async () => {
    if (!report) return;
    await mapping.applyMapping(report.headers);
  };

  // Re-apply the mapping when the report changes: a previous read's result must not decide whether this data may continue.
  useEffect(() => {
    if (report && mapping.mappingData && mapping.keyColumn) {
      void handleApplyMapping();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, mapping.mappingData, mapping.keyColumn]);

  // Step 3's "Open Dashboard" (skip = false) and "Skip for now" (skip = true).
  const handleContinue = async (skip: boolean) => {
    // One save per click: a second click before the re-render must not create a second workspace.
    if (!report || continuingRef.current) return;
    continuingRef.current = true;
    setWorkspaceError(null);
    // 500 ms minimum so the swap after a near-instant save doesn't flicker.
    const MIN_TRANSITION_MS = 500;
    setGroupsSkipped(skip);
    setStep(4);
    try {
      const workspaceId = (newProjectIdRef.current ??= `ws_${Date.now()}`);
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
        // Opens on the Failure Groups tab to assign sensors to the groups just named.
        lastRoute: "failure-group",
        dataFilePaths: dataUpload.selectedFiles,
        metadataFilePath: null,
        selectedSensors: [],
        visibleSensors: [],
        operationConfig: null,
        mappingFilePath: mapping.mappingFilePath,
        mappingKeyColumn: mapping.keyColumn,
      };
      // Groups built by the same helpers as the Dashboard FG tab; Skip gives only 'Not in Group'.
      const state = withFailureGroupState(base, {
        groups: buildInitialFailureGroups(skip ? [] : draftGroups),
      });
      await Promise.all([
        saveWorkspaceData(state),
        new Promise((resolve) => setTimeout(resolve, MIN_TRANSITION_MS)),
      ]);
      newProjectIdRef.current = null;
      onDataReady(metadata, state, mapping.sensorMetadata);
    } catch (err) {
      console.warn("Could not save the new project:", err);
      setWorkspaceError("Could not save the new project. Check that the disk has free space, then try again.");
      setGroupsSkipped(false);
      setStep(3);
      continuingRef.current = false;
    }
  };

  const handleLoadWorkspace = async (id: string) => {
    const seq = ++loadSeqRef.current;
    const isLatest = () => seq === loadSeqRef.current;
    let inBackendPhase = false;
    // What to tell the user (a message, not an error: nothing failed, the values changed).
    let projectName = "";
    let roundingNotice: { text: string; trace: string } | null = null;
    let roundingWritten = false;
    let conditionNotice: { text: string; trace: string } | null = null;
    let handedOver = false;
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
      projectName = state.name;

      backendPhaseRef.current += 1;
      inBackendPhase = true;

      // Rewrite `round($A, 2)` to `round($A * 100) / 100` before replay so the sensor restores; saved once after the loop.
      const { recipes: recipesToReplay, converted } = await convertLegacyFormulaRecipes(
        state.specialSensorRecipes,
        (c, a) => invoke<unknown>(c, a),
      );
      if (!isLatest()) return;
      // A step-2 parse lands before this session, but its report no longer describes it; keep it off the screen.
      dataUpload.abandonParse();
      const olderLoads = () =>
        [...loadCsvInFlightRef.current.entries()].filter(([k]) => k < seq).map(([, p]) => p);

      // Retry load_csv + replay when an older, slower load_csv replaces the session; each attempt is bound to its own generation.
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

        // An older load_csv still running replaces the session when it lands; let it land, then check the session is still ours.
        const before = olderLoads();
        if (before.length > 0) {
          await Promise.allSettled(before);
          if (!isLatest()) return;
          let current: unknown;
          try { current = await invoke<number | null>("get_session_generation"); } catch { current = undefined; }
          if (typeof current === "number" && typeof loaded.generation === "number" && current !== loaded.generation) continue;
        }

        // Must run before onDataReady so the first chart render already has data for every special sensor.
        if (recipesToReplay.length) {
          try {
            noData = await restoreSpecialSensors(recipesToReplay, loaded.generation, state.extraSensorMetadata);
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

      // Save the conversion in one write and hand the Dashboard that state, or its autosave would write the old text back.
      let opened: WorkspaceState = state;
      let notice: Awaited<ReturnType<typeof saveLegacyFormulaConversion>> = null;
      if (converted.length > 0) {
        try {
          notice = await saveLegacyFormulaConversion(id, converted);
        } catch (err) {
          console.warn("Could not save the converted special-sensor rounding:", err);
        }
      }
      if (notice) {
        opened = notice.state;
        roundingNotice = {
          text: notice.message,
          trace: `Converted: ${notice.converted.map(c => `${c.tag}: ${c.from} → ${c.to}`).join('; ')}`
            + (notice.retrainModelIds.length > 0 ? `. Models set back to Incomplete: ${notice.retrainModelIds.length}.` : '.'),
        };
        // Written: the next open finds nothing to change, so it is logged now.
        roundingWritten = true;
        logToFile('special-sensor-rounding', roundingNotice.text, roundingNotice.trace);
      } else if (converted.length > 0) {
        // The write failed: the Dashboard must still hold the converted text so its autosave saves it.
        opened = { ...state, specialSensorRecipes: recipesToReplay };
        roundingNotice = {
          text: `${legacyConversionMessage(converted, 0)} The change will be saved with the project.`,
          trace: `Converted (not written yet, saved by the Dashboard): ${converted.map(c => `${c.tag}: ${c.from} → ${c.to}`).join('; ')}.`,
        };
      }
      if (converted.length > 0 && !isLatest()) return;

      // A condition spelled differently from its header was ignored by Rust (all rows used).
      // Copy only the slice: `opened` may hold converted recipes the file lacks.
      try {
        const headers = await invoke<string[]>("get_all_sensors"); // includes replayed special sensors
        if (!isLatest()) return;
        const wasComplete = new Set<string>();
        const written = await updateWorkspaceData(id, s => {
          for (const m of s.failureGroupState?.models ?? []) if (m.status) wasComplete.add(m.id);
          return normalizeConditionSpelling(s, headers);
        });
        if (written) {
          opened = { ...opened, failureGroupState: written.failureGroupState };
          const retrain = (written.failureGroupState?.models ?? []).filter(m => wasComplete.has(m.id) && !m.status).length;
          if (retrain > 0) {
            conditionNotice = {
              text: retrain === 1
                ? "1 Complete model went back to Incomplete. The running condition was not applied when it was trained, so it needs training again."
                : `${retrain} Complete models went back to Incomplete. The running condition was not applied when they were trained, so they need training again.`,
              trace: `Running condition spelling corrected. Models set back to Incomplete: ${retrain}.`,
            };
            // Written: the next open finds nothing to change, so it is logged now.
            logToFile('running-condition-spelling', conditionNotice.text, conditionNotice.trace);
          }
        }
        if (!isLatest()) return;
      } catch (err) {
        console.warn("Could not correct running-condition spelling:", err);
      }

      // A project with no data time zone yet gets this PC's offset once; only after data loaded, never fatal.
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
          // A sensor with no column must not stay plotted (empty series); its recipe and metadata are kept for Manage.
          // Its filter condition goes too: Rust ignores a condition on a missing column, so every row would show as filtered.
          const gone = new Set(noData.map(t => t.trim().toLowerCase()));
          const keep = (tags: string[] | undefined) =>
            tags?.filter(t => !gone.has(t.trim().toLowerCase()));
          stateForDashboard = {
            ...stateForDashboard,
            selectedSensors: keep(opened.selectedSensors) ?? [],
            visibleSensors: keep(opened.visibleSensors) ?? [],
            ...(opened.filters
              ? { filters: { ...opened.filters, sensorFilters: removeTagsFromFilters(opened.filters.sensorFilters, noData) } }
              : {}),
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

      // 'failure-group' renders Dashboard like 'dashboard'; only the newest click hands over.
      if (!isLatest()) return;
      handedOver = true;
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
      // Also when this load was overtaken or failed after a write; an unwritten rounding conversion is redone on the next open.
      const rounding = roundingWritten || handedOver ? roundingNotice : null;
      if (rounding && !roundingWritten) logToFile('special-sensor-rounding', rounding.text, rounding.trace);
      if (rounding || conditionNotice) {
        // One dialog, not awaited: the Dashboard opens behind it.
        const body = [rounding?.text, conditionNotice?.text].filter(Boolean).join('\n\n');
        const text = handedOver ? body : `Project "${projectName}":\n\n${body}`;
        const title = !conditionNotice ? 'Rounding updated' : !rounding ? 'Running condition corrected' : 'Project updated';
        void Promise.resolve()
          .then(() => message(text, { title, kind: 'info' }))
          .catch(e => console.warn('Could not show the notice:', e));
      }
    }
  };

  // Deleting a workspace also removes its output folder (irreversible); this runs only after the in-row confirmation.
  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteWorkspace(id);
    } catch (err) {
      setWorkspaceError(String(err));
    }
    refreshWorkspaces();
  };

  // File > New Workspace: starts a project on step 0; no-op on any other step or while loading; idempotent with HomeStep's Ctrl+N.
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


  const pageStyle: CSSProperties = {
    width: "100%", height: "100vh", background: T.bg, color: T.text,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
    display: "flex", flexDirection: "column", overflow: "hidden",
  };

  // Full-screen overlay absorbs pointer events and shows a wait cursor while a workspace loads.
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

  // Step 0 ("Get started") is its own full-bleed screen, no rail or action bar. The later steps share the setup rail + footer.
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
  const tagFileBlock = isReady ? tagFileBlockReason(mapping.mappingFilePath, mapping.keyColumn, mapping.mappingResult) : null;
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
        {/* Step content is first in DOM order, the rail after it (placed left by the grid), so Tab reaches the step's controls first. */}
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
                  Drop one or more CSV exports. Files are merged on their timestamps. Then add the tag-name file, which must list the same sensors as the data.
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
                <span style={{ ...statusStyle, color: tagFileBlock ? (mapping.mappingResult ? T.danger : T.textMuted) : isReady ? T.ok : T.textFaint }} data-testid="step2-status">
                  {isReady && !tagFileBlock && <Check size={12} />}
                  {tagFileBlock
                    ? tagFileBlock
                    : isReady
                    ? `Ready · ${rowsText ?? "0"} rows · ${mappedCount} names mapped`
                    : isStale
                      ? "Selection changed · re-parse required"
                      : dataUpload.isLoading
                        ? "Reading files…"
                        : "Awaiting data"}
                </span>
                <div style={{ flex: 1 }} />
                <BackButton T={T} onClick={() => setStep(1)} />
                <PrimaryButton T={T} enabled={isReady && !tagFileBlock} onClick={() => setStep(3)}>Continue</PrimaryButton>
              </>
            ) : step === 3 ? (
              <>
                {/* Muted, never green: naming groups is optional. */}
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
              // Only backward navigation by clicking a step (later steps are gated by Continue), and never while the Dashboard is opening.
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
