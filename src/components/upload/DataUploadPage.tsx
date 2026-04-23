import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Search,
  ChevronRight,
  Check,
  X,
  Download,
  Info,
  ArrowRight,
  Sun,
  Moon,
  Filter as FilterIcon,
  Activity,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import type { MappingResult } from "../../types/dataUpload";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useDataUpload } from "../../hooks/useDataUpload";
import { useMappingData, buildSensorMetadataFromMapping } from "../../hooks/useMappingData";
import type { CsvMetadata, SensorMetadata, WorkspaceState, WorkspaceMetadata } from "../../types";
import {
  saveWorkspaceData,
  loadWorkspaceData,
  getRecentWorkspaces,
  deleteWorkspace,
} from "../../workspaceManager";

type SelectedMode = "free_exploration" | "soothsayer";

interface DataUploadPageProps {
  onDataReady: (
    metadata: CsvMetadata,
    workspaceState: WorkspaceState,
    sensorMetadata?: SensorMetadata[] | null
  ) => void;
}

/* ---------------------------------------------------------------- */
/* Theme tokens (ported from design handoff)                        */
/* ---------------------------------------------------------------- */

interface Tokens {
  bg: string;
  surface: string;
  surfaceHi: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentHi: string;
  accentMuted: string;
  ok: string;
  warn: string;
  danger: string;
  hover: string;
  chipBg: string;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
}

const DARK: Tokens = {
  bg: "#0a0a0b",
  surface: "#101012",
  surfaceHi: "#16161a",
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.12)",
  text: "#ededef",
  textMuted: "#8c8c94",
  textFaint: "#5b5b63",
  accent: "oklch(0.68 0.17 245)",
  accentHi: "oklch(0.74 0.17 245)",
  accentMuted: "oklch(0.4 0.1 245 / 0.18)",
  ok: "oklch(0.72 0.15 150)",
  warn: "oklch(0.78 0.14 75)",
  danger: "oklch(0.68 0.2 25)",
  hover: "rgba(255,255,255,0.04)",
  chipBg: "rgba(255,255,255,0.05)",
  s1: "oklch(0.72 0.16 245)",
  s2: "oklch(0.74 0.15 155)",
  s3: "oklch(0.78 0.14 70)",
  s4: "oklch(0.7 0.15 310)",
};

const LIGHT: Tokens = {
  bg: "#f6f6f7",
  surface: "#ffffff",
  surfaceHi: "#fafafa",
  border: "rgba(10,10,15,0.08)",
  borderStrong: "rgba(10,10,15,0.14)",
  text: "#0a0a0b",
  textMuted: "#64646d",
  textFaint: "#94949c",
  accent: "oklch(0.58 0.19 245)",
  accentHi: "oklch(0.52 0.2 245)",
  accentMuted: "oklch(0.58 0.19 245 / 0.1)",
  ok: "oklch(0.58 0.17 150)",
  warn: "oklch(0.68 0.16 70)",
  danger: "oklch(0.58 0.2 25)",
  hover: "rgba(10,10,15,0.04)",
  chipBg: "rgba(10,10,15,0.04)",
  s1: "oklch(0.55 0.2 245)",
  s2: "oklch(0.55 0.17 155)",
  s3: "oklch(0.65 0.16 70)",
  s4: "oklch(0.55 0.18 310)",
};

const mono = 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';

const fmt = (n: number | undefined | null) =>
  typeof n === "number" ? n.toLocaleString() : String(n ?? "");

/* ---------------------------------------------------------------- */
/* Page                                                             */
/* ---------------------------------------------------------------- */

export default function DataUploadPage({ onDataReady }: DataUploadPageProps) {
  const dataUpload = useDataUpload();
  const mapping = useMappingData();
  const [dark, setDark] = useState(() => (localStorage.getItem("theme") ?? "dark") !== "light");
  const T = dark ? DARK : LIGHT;

  const [mode, setMode] = useState<SelectedMode>("soothsayer");
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceMetadata[]>([]);
  const [wsSearch, setWsSearch] = useState("");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const refreshWorkspaces = () => {
    getRecentWorkspaces().then(setWorkspaces).catch(console.error);
  };

  useEffect(() => {
    refreshWorkspaces();
  }, []);

  const files = dataUpload.selectedFiles;
  const report = dataUpload.loadReport;
  const hasFiles = files.length > 0;
  const isReady = !!report;
  const totalRows = report?.total_rows ?? 0;
  const totalCols = report?.columns.length ?? 0;

  const filteredWs = useMemo(
    () =>
      workspaces.filter(
        (w) => !wsSearch || w.name.toLowerCase().includes(wsSearch.toLowerCase())
      ),
    [workspaces, wsSearch]
  );

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
    const workspaceId = `ws_${Date.now()}`;
    const metadata: CsvMetadata = {
      headers: report.headers,
      total_rows: report.total_rows,
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

  const handleLoadWorkspace = async (id: string) => {
    setLoadingWorkspace(true);
    setWorkspaceError(null);
    setActiveWorkspaceId(id);
    try {
      const state = await loadWorkspaceData(id);
      if (!state) throw new Error("Workspace not found");
      const dataMetadata = await invoke<CsvMetadata>("load_csv", { paths: state.dataFilePaths });

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
      onDataReady(dataMetadata, state, sm);
    } catch (err) {
      setWorkspaceError(String(err));
      setLoadingWorkspace(false);
      setActiveWorkspaceId(null);
    }
  };

  const handleDeleteWorkspace = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await ask(
      "Are you sure you want to delete this workspace? This action cannot be undone.",
      { title: "Delete Workspace", kind: "warning" }
    );
    if (confirmed) {
      await deleteWorkspace(id);
      refreshWorkspaces();
    }
  };

  const formatWhen = (ts: number) => {
    const d = new Date(ts);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yy} ${hh}:${mi}`;
  };

  /* ----------------- Render ----------------- */

  return (
    <div style={{ width: "100%", height: "100vh", background: T.bg, color: T.text, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Command bar */}
      <div style={{
        height: 52, display: "flex", alignItems: "center", padding: "0 18px",
        borderBottom: `1px solid ${T.border}`, background: T.surface, gap: 12, flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: mono }}>
          <span style={{ color: T.textFaint, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase" }}>Workspace</span>
          <ChevronRight size={12} style={{ color: T.textFaint }} />
          <span style={{ color: T.text, fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>New</span>
        </div>
        <Pill T={T} tone="info">Step 1</Pill>

        <div style={{ width: 1, height: 22, background: T.border, margin: "0 4px" }} />

        <Stepper
          T={T}
          current={1}
          steps={[
            { n: 1, label: "Prepare Dataset" },
            { n: 2, label: "Failure Groups" },
            { n: 3, label: "Predictive Model" },
          ]}
        />

        <div style={{ flex: 1 }} />

        {isReady && (
          <span style={{ fontSize: 11, color: T.textFaint, fontFamily: mono }}>
            {files.length} file{files.length !== 1 ? "s" : ""} · {fmt(totalRows)} rows · {totalCols} cols
          </span>
        )}

        <button
          onClick={() => setDark((d) => !d)}
          style={{
            background: "none", border: `1px solid ${T.border}`, color: T.textMuted,
            cursor: "pointer", width: 30, height: 28, borderRadius: 7,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      {/* Main grid: sidebar + content */}
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", background: T.bg, flex: 1, minHeight: 0 }}>
        {/* Sidebar */}
        <aside style={{ borderRight: `1px solid ${T.border}`, background: T.surface, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "16px 14px 10px" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "6px 9px", background: T.surfaceHi,
              border: `1px solid ${T.border}`, borderRadius: 7,
            }}>
              <Search size={12} style={{ color: T.textFaint }} />
              <input
                value={wsSearch}
                onChange={(e) => setWsSearch(e.target.value)}
                placeholder="Find workspace…"
                style={{
                  flex: 1, background: "transparent", border: "none", outline: "none",
                  color: T.text, fontSize: 12, fontFamily: "inherit",
                }}
              />
            </div>
          </div>

          <div style={{
            padding: "4px 10px", fontSize: 10.5, fontWeight: 600, color: T.textFaint,
            letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: mono,
          }}>
            Recent
          </div>
          <div style={{
            display: "flex", flexDirection: "column", padding: "4px 8px",
            gap: 1, overflowY: "auto", flex: 1,
          }}>
            {filteredWs.map((w) => (
              <WorkspaceRow
                key={w.id}
                T={T}
                name={w.name}
                when={formatWhen(w.lastModified)}
                active={w.id === activeWorkspaceId}
                onClick={() => handleLoadWorkspace(w.id)}
                onDelete={(e) => handleDeleteWorkspace(w.id, e)}
              />
            ))}
            {filteredWs.length === 0 && (
              <div style={{
                padding: 20, textAlign: "center", color: T.textFaint, fontSize: 11.5,
              }}>
                {workspaces.length === 0 ? "No workspaces yet" : "No matches"}
              </div>
            )}
          </div>

        </aside>

        {/* Content */}
        <section style={{
          padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12,
          minWidth: 0, minHeight: 0, overflow: "hidden",
        }}>
          {loadingWorkspace && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 40, gap: 10, color: T.textMuted, fontSize: 13,
            }}>
              <Loader2 size={18} className="animate-spin" />
              Loading workspace…
            </div>
          )}

          {!loadingWorkspace && (
            <>
              {/* Title block */}
              <div style={{ flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 600, color: T.accentHi,
                    letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: mono,
                  }}>
                    Step 1 · Data Upload
                  </span>
                  <span style={{ width: 12, height: 1, background: T.accent, opacity: 0.5 }} />
                </div>
                <h1 style={{
                  margin: 0, fontSize: 19, fontWeight: 600, color: T.text,
                  letterSpacing: "-0.02em", lineHeight: 1.2,
                }}>
                  Prepare your dataset
                </h1>
                <p style={{
                  margin: "2px 0 0", fontSize: 12, color: T.textMuted,
                  maxWidth: 720, lineHeight: 1.4,
                }}>
                  Upload sensor CSV files, apply an optional tag-to-name mapping, then choose how you'd like to analyze the data.
                </p>
              </div>

              {workspaceError && (
                <div style={{
                  padding: "10px 14px", borderRadius: 8,
                  background: "oklch(0.68 0.2 25 / 0.1)",
                  border: `1px solid oklch(0.68 0.2 25 / 0.3)`,
                  display: "flex", alignItems: "center", gap: 10,
                  fontSize: 12.5, color: T.danger,
                }}>
                  <AlertTriangle size={14} />
                  <span>{workspaceError}</span>
                </div>
              )}

              {/* Upload row: 2fr + 1fr */}
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, flex: 1, minHeight: 0 }}>
                {/* Dataset files */}
                <Card T={T} style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <div style={{
                    padding: "10px 14px", borderBottom: `1px solid ${T.border}`,
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: 6,
                      background: T.accentMuted, color: T.accentHi,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Activity size={13} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: T.text, letterSpacing: "-0.005em" }}>
                        Dataset files
                      </div>
                      <div style={{ fontSize: 11, color: T.textFaint, marginTop: 1, fontFamily: mono }}>
                        CSV · timestamp index required
                      </div>
                    </div>
                    {isReady && (
                      <Pill T={T} tone="ok">
                        <Check size={9} /> {files.length} added
                      </Pill>
                    )}
                  </div>

                  <div style={{
                    padding: "6px 14px", background: T.bg,
                    borderBottom: `1px solid ${T.border}`,
                    display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                    fontSize: 10.5, color: T.textMuted, fontFamily: mono,
                  }}>
                    <Req T={T} ok>First column = datetime</Req>
                    <Req T={T} ok>No duplicate column names</Req>
                    <Req T={T} ok>Shared datetime index</Req>
                  </div>

                  <div style={{ padding: 12, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                    <button
                      onClick={dataUpload.selectFiles}
                      disabled={dataUpload.isLoading}
                      style={{
                        width: "100%", border: `1.5px dashed ${T.borderStrong}`, borderRadius: 9,
                        padding: "12px 14px", textAlign: "center",
                        background: `repeating-linear-gradient(135deg, transparent 0 10px, ${T.hover} 10px 11px)`,
                        cursor: dataUpload.isLoading ? "wait" : "pointer",
                        color: T.text, fontFamily: "inherit",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                        flexShrink: 0,
                      }}
                    >
                      <div style={{
                        width: 32, height: 32, borderRadius: 8,
                        background: T.surface, border: `1px solid ${T.border}`,
                        display: "flex", alignItems: "center", justifyContent: "center", color: T.accentHi,
                        flexShrink: 0,
                      }}>
                        <Download size={15} />
                      </div>
                      <div style={{ textAlign: "left" }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text, letterSpacing: "-0.005em" }}>
                          Drop CSV files or{" "}
                          <span style={{ color: T.accentHi, textDecoration: "underline", textUnderlineOffset: 3 }}>
                            browse
                          </span>
                        </div>
                        <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 1, fontFamily: mono }}>
                          Up to 2 GB · multi-select supported
                        </div>
                      </div>
                    </button>

                    {files.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, overflowY: "auto", minHeight: 0, flex: 1 }}>
                        {files.map((path) => {
                          const name = path.split(/[/\\]/).pop() ?? path;
                          return (
                            <div key={path} style={{
                              display: "grid",
                              gridTemplateColumns: "auto 1fr auto",
                              gap: 12, alignItems: "center",
                              padding: "9px 10px", background: T.surfaceHi,
                              border: `1px solid ${T.border}`, borderRadius: 7,
                            }}>
                              <div style={{
                                width: 26, height: 26, borderRadius: 5,
                                background: T.accentMuted, color: T.accentHi,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 9, fontWeight: 700, fontFamily: mono,
                              }}>CSV</div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{
                                  fontSize: 12.5, fontWeight: 600, color: T.text,
                                  fontFamily: mono,
                                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                }}>{name}</div>
                                <div style={{
                                  fontSize: 10.5, color: T.textFaint,
                                  fontFamily: mono, marginTop: 3,
                                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                }}>{path}</div>
                              </div>
                              <button
                                onClick={() => dataUpload.removeFile(path)}
                                style={{
                                  background: "none", border: "none", color: T.textFaint,
                                  cursor: "pointer", padding: 4, display: "flex",
                                }}
                              >
                                <X size={13} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {hasFiles && !isReady && (
                      <button
                        onClick={dataUpload.uploadDataset}
                        disabled={dataUpload.isLoading}
                        style={{
                          width: "100%", padding: "8px 14px", flexShrink: 0,
                          background: T.accent, color: "#fff",
                          border: `1px solid ${T.accent}`, borderRadius: 8,
                          fontSize: 13, fontWeight: 600, cursor: "pointer",
                          fontFamily: "inherit",
                          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
                          opacity: dataUpload.isLoading ? 0.6 : 1,
                        }}
                      >
                        {dataUpload.isLoading ? (
                          <>
                            <Loader2 size={14} className="animate-spin" /> Parsing…
                          </>
                        ) : (
                          <>Parse files</>
                        )}
                      </button>
                    )}

                    {dataUpload.error && (
                      <div style={{
                        marginTop: 10, padding: "8px 10px", borderRadius: 7,
                        background: "oklch(0.68 0.2 25 / 0.1)",
                        border: `1px solid oklch(0.68 0.2 25 / 0.3)`,
                        display: "flex", alignItems: "center", gap: 8,
                        fontSize: 11.5, color: T.danger,
                      }}>
                        <AlertTriangle size={13} />
                        <span>{dataUpload.error}</span>
                      </div>
                    )}
                  </div>
                </Card>

                {/* Sensor mapping — locked until raw data is parsed */}
                <Card T={T} style={{ padding: 0, display: "flex", flexDirection: "column", opacity: isReady ? 1 : 0.55 }}>
                  <div style={{
                    padding: "10px 14px", borderBottom: `1px solid ${T.border}`,
                    display: "flex", alignItems: "center", gap: 10,
                  }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: 6,
                      background: "oklch(0.7 0.15 310 / 0.18)", color: T.s4,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <FilterIcon size={13} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: T.text, letterSpacing: "-0.005em" }}>
                        Sensor mapping
                        <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 500, color: T.textFaint, fontFamily: mono }}>
                          optional
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: T.textFaint, marginTop: 1, fontFamily: mono }}>
                        Tag → name lookup
                      </div>
                    </div>
                  </div>

                  <div style={{ padding: 12, flex: 1, display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto" }}>
                    <p style={{ margin: 0, fontSize: 11, color: T.textMuted, lineHeight: 1.4 }}>
                      Replace cryptic tags like{" "}
                      <span style={{
                        fontFamily: mono, color: T.text, background: T.surfaceHi,
                        padding: "1px 5px", borderRadius: 3, fontSize: 10.5,
                      }}>850P402.PV</span>{" "}
                      with human-readable sensor names.
                    </p>

                    {!isReady ? (
                      <div style={{
                        padding: "14px 12px",
                        border: `1px dashed ${T.borderStrong}`, borderRadius: 8,
                        background: "transparent",
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                        color: T.textFaint,
                      }}>
                        <Info size={15} />
                        <span style={{ fontSize: 12, fontWeight: 500, color: T.textMuted, textAlign: "center" }}>
                          Parse dataset first
                        </span>
                        <span style={{ fontSize: 10.5, color: T.textFaint, fontFamily: mono, textAlign: "center" }}>
                          Mapping becomes available after the CSV files are parsed
                        </span>
                      </div>
                    ) : mapping.mappingFilePath ? (
                      <div style={{
                        padding: "10px 12px", background: T.surfaceHi,
                        border: `1px solid ${T.border}`, borderRadius: 7,
                        display: "flex", alignItems: "center", gap: 10,
                      }}>
                        <div style={{
                          width: 24, height: 24, borderRadius: 5,
                          background: T.accentMuted, color: T.accentHi,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 9, fontWeight: 700, fontFamily: mono,
                        }}>CSV</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 12, fontWeight: 600, color: T.text, fontFamily: mono,
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          }}>
                            {mapping.mappingFilePath.split(/[/\\]/).pop()}
                          </div>
                          <div style={{ fontSize: 10.5, color: T.textFaint, fontFamily: mono, marginTop: 1 }}>
                            {mapping.mappingData
                              ? `${mapping.mappingData.rows.length} rows${mapping.mappingResult ? ` · ${mapping.mappingResult.matched.length} matched` : ""}`
                              : "loading…"}
                          </div>
                        </div>
                        <button
                          onClick={mapping.clearMapping}
                          style={{
                            background: "none", border: "none", color: T.textFaint,
                            cursor: "pointer", padding: 4, display: "flex",
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={mapping.selectMappingFile}
                        disabled={mapping.isLoading}
                        style={{
                          width: "100%", padding: "14px 12px",
                          border: `1px dashed ${T.borderStrong}`, borderRadius: 8,
                          background: "transparent", cursor: "pointer",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                          fontFamily: "inherit", color: T.text,
                        }}
                      >
                        <Download size={15} style={{ color: T.textMuted }} />
                        <span style={{ fontSize: 12.5, fontWeight: 500, color: T.text }}>
                          Select mapping CSV
                        </span>
                        <span style={{ fontSize: 10.5, color: T.textFaint, fontFamily: mono }}>
                          2 cols: tag, display_name
                        </span>
                      </button>
                    )}

                    {mapping.mappingData && !mapping.keyColumn && (
                      <div style={{
                        padding: 10, background: T.surfaceHi, border: `1px solid ${T.border}`,
                        borderRadius: 7, display: "flex", flexDirection: "column", gap: 6,
                      }}>
                        <div style={{ fontSize: 10, color: T.textFaint, fontFamily: mono, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                          Pick tag column
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {mapping.mappingData.headers.map((h) => (
                            <button
                              key={h}
                              onClick={() => mapping.setKeyColumn(h)}
                              style={{
                                padding: "3px 8px", fontSize: 11, fontFamily: mono,
                                background: T.surface, border: `1px solid ${T.border}`,
                                borderRadius: 4, color: T.text, cursor: "pointer",
                              }}
                            >{h}</button>
                          ))}
                        </div>
                      </div>
                    )}

                    {mapping.error && (
                      <div style={{
                        padding: "8px 10px", borderRadius: 7,
                        background: "oklch(0.68 0.2 25 / 0.1)",
                        border: `1px solid oklch(0.68 0.2 25 / 0.3)`,
                        fontSize: 11.5, color: T.danger,
                      }}>
                        {mapping.error}
                      </div>
                    )}

                    {mapping.mappingResult && (
                      <MappingResultDetails T={T} result={mapping.mappingResult} />
                    )}

                  </div>
                </Card>
              </div>

              {/* Mode choice */}
              <div style={{ flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 600, color: T.textFaint,
                    letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: mono,
                  }}>
                    Analysis mode
                  </span>
                  <span style={{ fontSize: 11, color: T.textFaint }}>
                    — pick how you want to work with this data. You can change later.
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <ModeCard
                    T={T}
                    selected={mode === "free_exploration"}
                    onClick={() => setMode("free_exploration")}
                    disabled={!isReady}
                    tone="s2"
                    glyph={<ExploreGlyph T={T} />}
                    tag="Exploratory"
                    title="Free exploration"
                    desc="Browse sensors freely with interactive charts, filters, and correlations. Ideal for discovery and ad-hoc analysis."
                    bullets={["Multi-sensor overlay", "Range + filter controls", "Export snapshots"]}
                  />
                  <ModeCard
                    T={T}
                    selected={mode === "soothsayer"}
                    onClick={() => setMode("soothsayer")}
                    disabled={!isReady}
                    tone="accent"
                    glyph={<PredictiveGlyph T={T} />}
                    tag="Guided"
                    title="Predictive model"
                    desc="Build fault-detection models by grouping sensors into failure categories, then training bounds or regressions per target."
                    bullets={["Failure group builder", "σ-boundary or kernel fit", "Residual alerting"]}
                  />
                </div>
              </div>

              {/* Empty-state hint */}
              {!isReady && (
                <div style={{
                  padding: "14px 16px", borderRadius: 10,
                  background: "oklch(0.78 0.14 75 / 0.08)",
                  border: `1px solid oklch(0.78 0.14 75 / 0.25)`,
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <Info size={14} style={{ color: T.warn, flexShrink: 0 }} />
                  <div style={{ fontSize: 12.5, color: T.text, flex: 1 }}>
                    {hasFiles
                      ? "Click Parse files to validate and unlock analysis modes."
                      : "Add at least one CSV file to unlock analysis modes and continue."}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Sticky action bar */}
      <div style={{
        position: "sticky", bottom: 0, zIndex: 5,
        background: T.surface, borderTop: `1px solid ${T.border}`,
        padding: "10px 24px", display: "grid", gridTemplateColumns: "240px 1fr",
      }}>
        <div />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{
            fontSize: 11, color: T.textFaint, fontFamily: mono, letterSpacing: "0.04em",
          }}>
            {isReady
              ? `Ready · ${fmt(totalRows)} rows · mode: ${mode === "soothsayer" ? "Predictive" : "Exploration"}`
              : "Awaiting data"}
          </span>
          <div style={{ flex: 1 }} />
          <ContinueButton T={T} enabled={isReady} mode={mode} onClick={handleContinue} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Sub-components                                                   */
/* ---------------------------------------------------------------- */

function Pill({ T, children, tone = "neutral" }: { T: Tokens; children: ReactNode; tone?: "neutral" | "info" | "ok" | "warn" }) {
  const tones: Record<string, { bg: string; fg: string; bd: string }> = {
    neutral: { bg: T.chipBg, fg: T.textMuted, bd: T.border },
    info: { bg: T.accentMuted, fg: T.accentHi, bd: "transparent" },
    ok: { bg: "oklch(0.7 0.15 150 / 0.12)", fg: T.ok, bd: "transparent" },
    warn: { bg: "oklch(0.75 0.14 75 / 0.14)", fg: T.warn, bd: "transparent" },
  };
  const t = tones[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 7px", fontSize: 10.5, fontWeight: 600,
      letterSpacing: "0.02em", textTransform: "uppercase",
      color: t.fg, background: t.bg, border: `1px solid ${t.bd}`,
      borderRadius: 4, fontFamily: mono,
    }}>{children}</span>
  );
}

function Card({ T, children, style = {} }: { T: Tokens; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: 10, ...style,
    }}>
      {children}
    </div>
  );
}

function Stepper({ T, current, steps }: { T: Tokens; current: number; steps: { n: number; label: string }[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {steps.map((s, i) => {
        const done = s.n < current;
        const active = s.n === current;
        return (
          <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {i > 0 && <div style={{ width: 14, height: 1, background: done ? T.ok : T.border }} />}
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: active ? "4px 9px" : "4px 6px",
              background: active ? T.accentMuted : "transparent",
              border: active ? `1px solid ${T.accent}` : "1px solid transparent",
              borderRadius: 999,
            }}>
              <div style={{
                width: 16, height: 16, borderRadius: "50%",
                background: done ? T.ok : active ? T.accent : "transparent",
                border: done || active ? "none" : `1.5px solid ${T.borderStrong}`,
                color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9.5, fontWeight: 700, fontFamily: mono,
              }}>
                {done ? <Check size={9} color="#fff" /> : <span style={{ color: active ? "#fff" : T.textFaint }}>{s.n}</span>}
              </div>
              <span style={{
                fontSize: 12, fontWeight: active ? 600 : 500,
                color: active ? T.text : done ? T.textMuted : T.textFaint,
                letterSpacing: "-0.005em",
              }}>{s.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Req({ T, ok, children }: { T: Tokens; ok: boolean; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        width: 12, height: 12, borderRadius: "50%",
        background: ok ? "oklch(0.72 0.15 150 / 0.2)" : T.surfaceHi,
        color: T.ok, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Check size={8} strokeWidth={2.5} color={T.ok} />
      </span>
      <span>{children}</span>
    </span>
  );
}

function ModeCard({
  T, selected, onClick, tone, disabled, glyph, tag, title, desc, bullets,
}: {
  T: Tokens; selected: boolean; onClick: () => void;
  tone: "accent" | "s2"; disabled: boolean;
  glyph: ReactNode; tag: string; title: string; desc: string; bullets: string[];
}) {
  const toneColor = tone === "accent" ? T.accent : T.s2;
  const toneHi = tone === "accent" ? T.accentHi : T.s2;
  const toneGlow = tone === "accent" ? T.accentMuted : "oklch(0.74 0.15 155 / 0.15)";
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        textAlign: "left", cursor: disabled ? "not-allowed" : "pointer",
        padding: 12, borderRadius: 10,
        background: selected && !disabled
          ? `linear-gradient(135deg, ${toneGlow} 0%, ${T.surface} 60%)`
          : T.surface,
        border: `1px solid ${selected && !disabled ? toneColor : T.border}`,
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
        display: "flex", alignItems: "center", gap: 12,
        position: "relative",
        boxShadow: selected && !disabled ? `0 0 0 2px ${toneGlow}` : "none",
        transition: "all 120ms ease",
        color: T.text,
      }}
    >
      <div style={{
        width: 42, height: 42, borderRadius: 8,
        background: T.bg, border: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>
        {glyph}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <Pill T={T} tone={tone === "accent" ? "info" : "ok"}>{tag}</Pill>
          {selected && !disabled && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 10, fontWeight: 600, color: toneHi,
              fontFamily: mono, letterSpacing: "0.04em",
            }}>
              <Check size={10} strokeWidth={2.5} color={toneHi} /> SELECTED
            </span>
          )}
        </div>
        <div style={{
          fontSize: 14, fontWeight: 600, color: T.text,
          letterSpacing: "-0.01em", lineHeight: 1.2,
        }}>{title}</div>
        <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 2, lineHeight: 1.4 }}>
          {desc}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {bullets.map((b) => (
            <span key={b} style={{
              fontSize: 10, padding: "2px 7px",
              background: T.surfaceHi, border: `1px solid ${T.border}`,
              borderRadius: 999, color: T.textMuted, fontFamily: mono,
            }}>{b}</span>
          ))}
        </div>
      </div>
    </button>
  );
}

function ExploreGlyph({ T }: { T: Tokens }) {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <path d="M3 24 L8 18 L13 21 L18 13 L23 16 L29 8" stroke={T.s2} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13" cy="21" r="1.8" fill={T.s2} />
      <circle cx="18" cy="13" r="1.8" fill={T.s2} />
      <circle cx="23" cy="16" r="1.8" fill={T.s2} />
      <path d="M3 28 H29" stroke={T.textFaint} strokeWidth="0.75" strokeDasharray="1.5 2" />
    </svg>
  );
}

function PredictiveGlyph({ T }: { T: Tokens }) {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <rect x="3" y="10" width="26" height="12" rx="1" stroke={T.textFaint} strokeWidth="0.75" strokeDasharray="2 2" />
      <path d="M3 16 C 8 16, 10 12, 14 12 S 20 20, 24 16 S 28 14, 29 14" stroke={T.accent} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M14 12 V 6" stroke={T.danger} strokeWidth="1.2" strokeDasharray="1.5 1.5" />
      <circle cx="14" cy="6" r="2" fill="none" stroke={T.danger} strokeWidth="1.2" />
      <circle cx="14" cy="6" r="0.8" fill={T.danger} />
    </svg>
  );
}

function WorkspaceRow({
  T, name, when, active, onClick, onDelete,
}: {
  T: Tokens; name: string; when: string; active: boolean;
  onClick: () => void; onDelete: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  const highlighted = active || hover;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "7px 8px", borderRadius: 6, cursor: "pointer",
        background: active ? T.surfaceHi : hover ? T.hover : "transparent",
        border: `1px solid ${active ? T.border : "transparent"}`,
        position: "relative",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: 2,
          background: T.accent, flexShrink: 0,
          opacity: highlighted ? 1 : 0.7,
        }} />
        <span style={{
          fontSize: 12.5, fontWeight: 600,
          color: highlighted ? T.text : T.textMuted,
          letterSpacing: "-0.005em", flex: 1, minWidth: 0,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          transition: "color 120ms ease",
        }}>
          {name}
        </span>
        <button
          onClick={onDelete}
          title="Delete workspace"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: hover ? T.danger : T.textFaint,
            padding: 2, display: "flex",
            opacity: hover ? 1 : 0.6,
            transition: "color 120ms ease, opacity 120ms ease",
          }}
        >
          <X size={11} />
        </button>
      </div>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        marginTop: 2, paddingLeft: 12, fontSize: 10,
        color: T.textFaint, fontFamily: mono,
      }}>
        <span>{when}</span>
      </div>
    </div>
  );
}

function MappingResultDetails({ T, result }: { T: Tokens; result: MappingResult }) {
  const blocks: { tone: "ok" | "warn" | "danger"; icon: ReactNode; label: string; items: string[] }[] = [];
  if (result.matched.length > 0) {
    blocks.push({
      tone: "ok",
      icon: <CheckCircle2 size={12} />,
      label: `${result.matched.length} column${result.matched.length !== 1 ? "s" : ""} matched`,
      items: [],
    });
  }
  if (result.not_in_dataset.length > 0) {
    blocks.push({
      tone: "warn",
      icon: <AlertTriangle size={12} />,
      label: `${result.not_in_dataset.length} key${result.not_in_dataset.length !== 1 ? "s" : ""} in mapping but not in dataset`,
      items: result.not_in_dataset,
    });
  }
  if (result.not_in_mapping.length > 0) {
    blocks.push({
      tone: "danger",
      icon: <XCircle size={12} />,
      label: `${result.not_in_mapping.length} dataset column${result.not_in_mapping.length !== 1 ? "s" : ""} not found in mapping`,
      items: result.not_in_mapping,
    });
  }

  const toneStyles: Record<string, { fg: string; bg: string; bd: string }> = {
    ok: { fg: T.ok, bg: "oklch(0.72 0.15 150 / 0.1)", bd: "oklch(0.72 0.15 150 / 0.3)" },
    warn: { fg: T.warn, bg: "oklch(0.78 0.14 75 / 0.1)", bd: "oklch(0.78 0.14 75 / 0.3)" },
    danger: { fg: T.danger, bg: "oklch(0.68 0.2 25 / 0.1)", bd: "oklch(0.68 0.2 25 / 0.3)" },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: T.textFaint,
        letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: mono,
      }}>
        Mapping results
      </div>
      {blocks.map((b, i) => {
        const s = toneStyles[b.tone];
        return (
          <div key={i} style={{
            padding: "7px 10px", borderRadius: 7,
            background: s.bg, border: `1px solid ${s.bd}`,
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 11, fontWeight: 600, color: s.fg,
            }}>
              {b.icon}
              <span>{b.label}</span>
            </div>
            {b.items.length > 0 && (
              <div style={{
                marginTop: 4, paddingLeft: 18, maxHeight: 72, overflowY: "auto",
                display: "flex", flexDirection: "column", gap: 1,
              }}>
                {b.items.map((col) => (
                  <div key={col} style={{
                    fontSize: 10.5, color: s.fg, opacity: 0.75,
                    fontFamily: mono,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>{col}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ContinueButton({
  T, enabled, mode, onClick,
}: {
  T: Tokens; enabled: boolean; mode: SelectedMode; onClick: () => void;
}) {
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "9px 16px", fontSize: 13, fontWeight: 600,
        color: "#fff",
        background: enabled ? T.accent : T.surfaceHi,
        border: `1px solid ${enabled ? T.accent : T.border}`,
        borderRadius: 8, cursor: enabled ? "pointer" : "not-allowed",
        fontFamily: "inherit", letterSpacing: "-0.005em",
        opacity: enabled ? 1 : 0.6,
        boxShadow: enabled ? `0 1px 0 0 rgba(255,255,255,0.15) inset, 0 4px 14px ${T.accentMuted}` : "none",
      }}
    >
      Continue to {mode === "soothsayer" ? "failure groups" : "exploration"}
      <ArrowRight size={13} />
    </button>
  );
}
