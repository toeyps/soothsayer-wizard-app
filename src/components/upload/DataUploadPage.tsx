import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useDataUpload } from "../../hooks/useDataUpload";
import { useMappingData, buildSensorMetadataFromMapping } from "../../hooks/useMappingData";
import type { CsvMetadata, SensorMetadata, WorkspaceState } from "../../types";
import { saveWorkspaceData, loadWorkspaceData } from "../../workspaceManager";
import DatasetUpload from "./DatasetUpload";
import DataValidationSummary from "./DataValidationSummary";
import MappingUpload from "./MappingUpload";
import SensorTagMapping from "./SensorTagMapping";
import MappingResults from "./MappingResults";
import ModeSelection from "./ModeSelection";
import type { SelectedMode } from "./ModeSelection";
import RecentWorkspaces from "./RecentWorkspaces";

interface DataUploadPageProps {
  onDataReady: (
    metadata: CsvMetadata,
    workspaceState: WorkspaceState,
    sensorMetadata?: SensorMetadata[] | null
  ) => void;
}

export default function DataUploadPage({ onDataReady }: DataUploadPageProps) {
  const dataUpload = useDataUpload();
  const mapping = useMappingData();
  const [selectedMode, setSelectedMode] = useState<SelectedMode>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const handleApplyMapping = () => {
    if (!dataUpload.loadReport) return;
    mapping.applyMapping(dataUpload.loadReport.headers);
  };

  const handleModeSelect = async (mode: "free_exploration" | "soothsayer") => {
    setSelectedMode(mode);
    if (!dataUpload.loadReport) return;

    const workspaceId = `ws_${Date.now()}`;
    const metadata: CsvMetadata = {
      headers: dataUpload.loadReport.headers,
      total_rows: dataUpload.loadReport.total_rows,
    };
    const state: WorkspaceState = {
      id: workspaceId,
      name: `Workspace ${new Date().toLocaleString()}`,
      lastRoute: "dashboard",
      dataFilePaths: dataUpload.selectedFiles,
      metadataFilePath: null,
      selectedSensors: [],
      visibleSensors: [],
      operationConfig: null,
      mappingFilePath: mapping.mappingFilePath,
      mappingKeyColumn: mapping.keyColumn,
    };
    await saveWorkspaceData(state);
    onDataReady(metadata, state, mapping.sensorMetadata);
  };

  const handleLoadWorkspace = async (workspaceId: string) => {
    setLoadingWorkspace(true);
    setWorkspaceError(null);
    try {
      const state = await loadWorkspaceData(workspaceId);
      if (!state) throw new Error("Workspace not found");

      const dataMetadata = await invoke<CsvMetadata>("load_csv", {
        paths: state.dataFilePaths,
      });

      // Reload mapping if it was saved with the workspace
      let sm: SensorMetadata[] | null = null;
      if (state.mappingFilePath && state.mappingKeyColumn) {
        try {
          const mappingData = await invoke<import("../../types/dataUpload").MappingData>(
            "load_mapping_csv", { path: state.mappingFilePath }
          );
          const mappingResult = await invoke<import("../../types/dataUpload").MappingResult>(
            "apply_sensor_mapping", {
              keyColumn: state.mappingKeyColumn,
              mappingData,
              datasetHeaders: dataMetadata.headers,
            }
          );
          sm = buildSensorMetadataFromMapping(mappingData, mappingResult, state.mappingKeyColumn);
        } catch (mappingErr) {
          console.warn("Failed to reload mapping:", mappingErr);
        }
      }

      // Fallback to metadata file
      if (!sm && state.metadataFilePath) {
        try {
          sm = await invoke<SensorMetadata[]>("load_metadata_command", { path: state.metadataFilePath });
        } catch { /* ignore */ }
      }

      onDataReady(dataMetadata, state, sm);
    } catch (err) {
      setWorkspaceError(String(err));
      setLoadingWorkspace(false);
    }
  };

  return (
    <div className="flex w-full h-full bg-neutral-900 text-neutral-100">
      <RecentWorkspaces onLoadWorkspace={handleLoadWorkspace} />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="shrink-0 px-8 pt-6 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="bg-sky-500 w-5 h-1 rounded-full" />
            <span className="text-[11px] font-semibold tracking-widest text-sky-400 uppercase">
              Data Upload
            </span>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-neutral-100">
            Prepare Your Dataset
          </h1>
          <p className="text-sm text-neutral-500 mt-1">
            Upload sensor CSV files, apply an optional tag-to-name mapping, then
            choose your analysis mode.
          </p>
        </header>

        {loadingWorkspace && (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-3 text-neutral-400">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">Loading workspace...</span>
            </div>
          </div>
        )}

        {workspaceError && (
          <div className="mx-8 mb-3 flex items-center gap-2 text-red-400 text-xs bg-red-950/30 border border-red-800/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{workspaceError}</span>
          </div>
        )}

        {!loadingWorkspace && (
          <>
            <div className="flex flex-1 gap-6 px-8 pb-4 overflow-hidden min-h-0">
              <div className="flex-1 flex flex-col gap-0 overflow-y-auto pr-2 rounded-2xl bg-neutral-850/30 border border-neutral-800/60 p-5">
                <DatasetUpload
                  selectedFiles={dataUpload.selectedFiles}
                  isLoading={dataUpload.isLoading}
                  error={dataUpload.error}
                  onSelectFiles={dataUpload.selectFiles}
                  onRemoveFile={dataUpload.removeFile}
                  onUpload={dataUpload.uploadDataset}
                />
                {dataUpload.loadReport && (
                  <DataValidationSummary report={dataUpload.loadReport} />
                )}
              </div>

              <div className="flex-1 flex flex-col gap-0 overflow-y-auto pr-2 rounded-2xl bg-neutral-850/30 border border-neutral-800/60 p-5">
                <MappingUpload
                  mappingData={mapping.mappingData}
                  mappingFilePath={mapping.mappingFilePath}
                  isLoading={mapping.isLoading}
                  error={mapping.error}
                  onSelectFile={mapping.selectMappingFile}
                />
                {mapping.mappingData && (
                  <SensorTagMapping
                    headers={mapping.mappingData.headers}
                    keyColumn={mapping.keyColumn}
                    isLoading={mapping.isLoading}
                    onSetKeyColumn={mapping.setKeyColumn}
                    onApply={handleApplyMapping}
                  />
                )}
                {mapping.mappingResult && (
                  <MappingResults result={mapping.mappingResult} />
                )}
              </div>
            </div>

            <footer className="shrink-0 px-8 py-5 border-t border-neutral-800/60">
              <ModeSelection
                selectedMode={selectedMode}
                onSelect={handleModeSelect}
                disabled={dataUpload.loadReport === null}
              />
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
