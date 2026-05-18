import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen, emit } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { CsvMetadata, SensorMetadata, DashboardSnapshot, FailureGroup, FailureSensorRow as SensorRow } from "../../types";
import { Upload, Download, Save, Plus, Trash2, ChevronDown, ChevronRight, AlertTriangle, X, Edit3, FolderPlus, Minus, Square, GripVertical, Play, ArrowLeft } from "lucide-react";
import { useIsMacOS } from "../../hooks/useIsMacOS";
import { useSubWindowMenu } from "../../hooks/useSubWindowMenu";
import { updateWorkspaceData, loadWorkspaceData, setLastWorkspaceId } from "../../workspaceManager";
import { ask } from "@tauri-apps/plugin-dialog";

// ── Types ──────────────────────────────────────────────────────────────

interface FailureGroupData {
    workspaceId: string;
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
    dashboardSnapshot?: DashboardSnapshot;
}

// ── Helpers ────────────────────────────────────────────────────────────

let _rowId = 0;
const nextId = () => `row-${++_rowId}`;

function getSensorName(tag: string, meta: SensorMetadata[] | null): string {
    if (!meta || !tag) return "";
    const found = meta.find(m => m.tag.toLowerCase() === tag.toLowerCase());
    return found ? found.description : tag;
}

const GROUP_PALETTE = ['amber', 'violet', 'green', 'blue'] as const;
const getGroupColor = (no: number): string => no === 0 ? 'slate' : GROUP_PALETTE[(no - 1) % GROUP_PALETTE.length];

// ── Component ──────────────────────────────────────────────────────────

export default function FailureGroupCreation() {
    const isMacOS = useIsMacOS();
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [dashboardSnapshot, setDashboardSnapshot] = useState<DashboardSnapshot | null>(null);
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [metadata, setMetadata] = useState<CsvMetadata | null>(null);
    const [loading, setLoading] = useState(true);
    const hydratedRef = useRef(false);

    const [groups, setGroups] = useState<FailureGroup[]>([
        { no: 0, name: "Not in Group", isCollapsed: false }
    ]);
    const [rows, setRows] = useState<SensorRow[]>([]);
    const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

    const [showNewGroupDialog, setShowNewGroupDialog] = useState(false);
    const [newGroupName, setNewGroupName] = useState("");
    const newGroupInputRef = useRef<HTMLInputElement>(null);

    const [editingGroupNo, setEditingGroupNo] = useState<number | null>(null);
    const [editingGroupName, setEditingGroupName] = useState("");

    const [dropdownRowId, setDropdownRowId] = useState<string | null>(null);
    const [dropdownSearch, setDropdownSearch] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);

    const [showModelPanel, setShowModelPanel] = useState(false);
    const [isBuildModelOpen, setIsBuildModelOpen] = useState(false);
    // Latest value of `isBuildModelOpen` accessible from inside event/window handlers
    // (React state closures are stale otherwise — needed by `onCloseRequested`).
    const isBuildModelOpenRef = useRef(false);
    useEffect(() => { isBuildModelOpenRef.current = isBuildModelOpen; }, [isBuildModelOpen]);
    // Guard: only attempt the "auto-reopen predictive-model on resume" once per
    // workspaceId. Without this, the effect can re-fire when `isMacOS` resolves
    // late (it starts `false` then flips to `true`) and double-spawn the PM
    // window when the user has already closed it in between.
    const reopenedForWorkspaceRef = useRef<string | null>(null);

    // ── Setup ────────────────────────────────────────────────────

    useEffect(() => {
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        let unlistenData: (() => void) | undefined;
        const setup = async () => {
            unlistenData = await listen<FailureGroupData>('failure-group-data', async (event) => {
                const d = event.payload;
                setAllSensors(d.sensorHeaders);
                setSensorMetadata(d.sensorMetadata);
                setMetadata(d.metadata);
                setWorkspaceId(d.workspaceId);
                if (d.dashboardSnapshot) setDashboardSnapshot(d.dashboardSnapshot);

                // Restore failure-group slice from workspace file (per-workspace, not global).
                try {
                    const ws = await loadWorkspaceData(d.workspaceId);
                    if (ws?.failureGroupState) {
                        setGroups(ws.failureGroupState.groups);
                        setRows(ws.failureGroupState.rows);
                        // Keep _rowId counter ahead of restored rows.
                        const maxId = ws.failureGroupState.rows.reduce((max, r) => {
                            const num = parseInt(r.id.replace('row-', ''), 10);
                            return Number.isFinite(num) && num > max ? num : max;
                        }, 0);
                        if (maxId >= _rowId) _rowId = maxId;
                    }
                    if (ws?.dashboardSnapshot && !d.dashboardSnapshot) {
                        setDashboardSnapshot(ws.dashboardSnapshot);
                    }
                } catch (e) {
                    console.warn('Failed to hydrate failure-group state from workspace:', e);
                }
                hydratedRef.current = true;
                setLoading(false);
            });
            await emit('request-failure-group-data');
        };
        setup();
        return () => { if (unlistenData) unlistenData(); };
    }, []);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownRowId(null);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    useEffect(() => {
        if (showNewGroupDialog && newGroupInputRef.current) newGroupInputRef.current.focus();
    }, [showNewGroupDialog]);

    // ── Persist groups/rows into the workspace on change (debounced, per-workspace). ──────────
    // Intentionally does NOT touch lastRoute — that's managed by explicit transitions
    // (Save & Continue → 'failure-group', Build Model → 'predictive-model', window close → 'failure-group').
    useEffect(() => {
        if (!workspaceId || !hydratedRef.current) return;
        const timer = setTimeout(() => {
            updateWorkspaceData(workspaceId, (prev) => ({
                ...prev,
                failureGroupState: { groups, rows },
            })).catch(e => console.error('Failed to persist failure-group state:', e));
        }, 250);
        return () => clearTimeout(timer);
    }, [groups, rows, workspaceId]);

    // Auto-reopen Step 3 (predictive-model) window on app resume if that's where the user left off.
    //
    // Notes:
    //   • `isMacOS` is intentionally NOT in the deps array — it resolves async
    //     after mount and would re-fire this effect, racing the user closing the
    //     PM window and causing a duplicate spawn ("PM closes then a new PM
    //     appears"). We read the platform synchronously inline instead.
    //   • `reopenedForWorkspaceRef` ensures we only attempt the resume once per
    //     workspace, even if hydration deps change again later.
    useEffect(() => {
        if (!workspaceId || !hydratedRef.current || loading) return;
        if (reopenedForWorkspaceRef.current === workspaceId) return;
        let cancelled = false;
        (async () => {
            try {
                const ws = await loadWorkspaceData(workspaceId);
                if (cancelled) return;
                if (ws?.lastRoute === 'predictive-model' && ws.predictiveModelState?.targetSensor && metadata) {
                    // Sync claim — re-check + set the ref atomically AFTER the
                    // await. Multiple effect runs could have entered the IIFE
                    // while `loadWorkspaceData` was pending; whichever resumes
                    // first wins, the rest see the claim and bail before spawn.
                    if (reopenedForWorkspaceRef.current === workspaceId) return;
                    reopenedForWorkspaceRef.current = workspaceId;
                    // Avoid re-spawning if the window already exists.
                    const existing = await WebviewWindow.getByLabel('predictive-model');
                    if (existing) return;
                    pendingModelDataRef.current = {
                        targetSensor: ws.predictiveModelState.targetSensor,
                        predictorSensors: ws.predictiveModelState.predictorSensors,
                    };
                    const screenW = window.screen.width;
                    const screenH = window.screen.height;
                    // Synchronous platform sniff so window decorations are correct
                    // even before the async `useIsMacOS` hook resolves.
                    const isMac = /mac/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent);
                    const webview = new WebviewWindow('predictive-model', {
                        url: '/?window=predictive-model',
                        title: `Predictive Model — ${ws.predictiveModelState.targetSensor}`,
                        // width/height are kept as the un-maximized restore size
                        // so dragging the window out of maximized state yields a
                        // sensible default. `maximized: true` opens it fullscreen.
                        width: Math.round(screenW * 0.75),
                        height: Math.round(screenH * 0.85),
                        center: true,
                        maximized: true,
                        decorations: isMac,
                    });
                    webview.once('tauri://created', () => setIsBuildModelOpen(true));
                    webview.once('tauri://error', (e) => console.error('Failed to open predictive model window on resume:', e));
                    // PRIMARY signal: `tauri://destroyed` fires for ALL close paths
                    // (custom button, native red-close, force-quit, crash). Without
                    // this, our `isBuildModelOpen` flag can go stale and the FG
                    // close handler will preventDefault forever.
                    webview.once('tauri://destroyed', () => {
                        setIsBuildModelOpen(false);
                        isBuildModelOpenRef.current = false;
                        updateWorkspaceData(workspaceId, (prev) => ({ ...prev, lastRoute: 'failure-group' })).catch(() => {});
                    });
                    // Secondary (legacy) signal — keep for explicit flow ordering.
                    const unlistenClose = await listen('predictive-model-closed', () => {
                        setIsBuildModelOpen(false);
                        isBuildModelOpenRef.current = false;
                        updateWorkspaceData(workspaceId, (prev) => ({ ...prev, lastRoute: 'failure-group' })).catch(() => {});
                        unlistenClose();
                    });
                }
            } catch (e) {
                console.warn('Failed to check for predictive-model resume:', e);
            }
        })();
        return () => { cancelled = true; };
    }, [workspaceId, loading, metadata]);

    // No `onCloseRequested` handler — let close proceed unconditionally.
    // We previously prevented close on macOS native red-close while PM was
    // open, but that handler also turned out to silently block close in some
    // edge cases (async handler awaited indefinitely by Tauri 2). Trade-off:
    // on macOS, native red-close on FG while PM is still open will close FG
    // and leave PM as an orphan window. The user can still close PM directly.
    // The Windows/Linux custom-titlebar `handleClose` below keeps the
    // shake-while-PM-open behavior for those platforms.

    // ── Build Model ──────────────────────────────────────────────

    const pendingModelDataRef = useRef<{ targetSensor: string; predictorSensors: string[] } | null>(null);

    useEffect(() => {
        let unlistenReq: (() => void) | undefined;
        const setupModelListener = async () => {
            unlistenReq = await listen('request-predictive-data', async () => {
                if (pendingModelDataRef.current && metadata && workspaceId) {
                    await emit('predictive-model-data', {
                        workspaceId,
                        targetSensor: pendingModelDataRef.current.targetSensor,
                        predictorSensors: pendingModelDataRef.current.predictorSensors,
                        sensorHeaders: allSensors,
                        sensorMetadata,
                        metadata,
                        dashboardSnapshot,
                    });
                }
            });
        };
        setupModelListener();
        return () => { if (unlistenReq) unlistenReq(); };
    }, [allSensors, sensorMetadata, metadata, workspaceId, dashboardSnapshot]);

    const handleBuildModel = async (row: SensorRow) => {
        if (!row.mappedSensorTag || !workspaceId) return;
        // Preserve previously chosen predictors when reopening Build Model on
        // the same target — wiping them every click was the "predictors don't
        // save with the workspace" bug. Only reset when the target changes
        // (different model entirely, so the old predictor list is stale).
        const prevState = (await loadWorkspaceData(workspaceId))?.predictiveModelState;
        const sameTarget = prevState?.targetSensor === row.mappedSensorTag;
        const carriedPredictors = sameTarget ? (prevState?.predictorSensors ?? []) : [];
        pendingModelDataRef.current = {
            targetSensor: row.mappedSensorTag,
            predictorSensors: carriedPredictors,
        };
        // Flip lastRoute so auto-resume re-opens the predictive-model window.
        await updateWorkspaceData(workspaceId, (prev) => ({
            ...prev,
            lastRoute: 'predictive-model',
            predictiveModelState: {
                ...(prev.predictiveModelState ?? {
                    individualChecked: true,
                    rcMode: null,
                    scatterXSensor: "",
                    relModelName: "",
                    relStiffness: 1,
                    clusterModelName: "",
                    numClusters: 3,
                    criteriaSensor: "",
                    // Default to 3 equal-width ranges over [0, 100] — matches the
                    // numClusters default and gets resized to fit `numClusters`
                    // by the sync effect in PredictiveModelBuild.
                    clusterRanges: [
                        { min: 0, max: 33 },
                        { min: 33, max: 66 },
                        { min: 66, max: 100 },
                    ],
                    filterTimeStart: "",
                    filterTimeEnd: "",
                    filterSensorValue: "",
                }),
                targetSensor: row.mappedSensorTag,
                predictorSensors: carriedPredictors,
            },
        }));
        try {
            // Idempotency: if PM already exists, just focus it. Spawning a
            // duplicate with the same label is what produces the "เด้งออก
            // แล้วเปิดขึ้นมาใหม่" symptom on re-mount races.
            const existingPM = await WebviewWindow.getByLabel('predictive-model');
            if (existingPM) {
                try { await existingPM.setFocus(); } catch { /* ignore */ }
                setIsBuildModelOpen(true);
                isBuildModelOpenRef.current = true;
                return;
            }
            const screenW = window.screen.width;
            const screenH = window.screen.height;
            const webview = new WebviewWindow('predictive-model', {
                url: '/?window=predictive-model',
                title: `Predictive Model — ${row.mappedSensorTag}`,
                // width/height keep a sensible un-maximized restore size;
                // `maximized: true` opens fullscreen on launch.
                width: Math.round(screenW * 0.75),
                height: Math.round(screenH * 0.85),
                center: true,
                maximized: true,
                decorations: isMacOS,
            });
            webview.once('tauri://created', () => {
                setIsBuildModelOpen(true);
            });
            webview.once('tauri://error', (e) => {
                console.error('Failed to open predictive model window:', e);
            });
            // PRIMARY signal — fires for any close path (button / native / crash).
            webview.once('tauri://destroyed', () => {
                setIsBuildModelOpen(false);
                isBuildModelOpenRef.current = false;
                if (workspaceId) {
                    updateWorkspaceData(workspaceId, (prev) => ({
                        ...prev,
                        lastRoute: 'failure-group',
                    })).catch(() => { /* ignore */ });
                }
            });
            // Secondary signal — explicit ordering for state syncing.
            const unlistenClose = await listen('predictive-model-closed', () => {
                setIsBuildModelOpen(false);
                isBuildModelOpenRef.current = false;
                if (workspaceId) {
                    updateWorkspaceData(workspaceId, (prev) => ({
                        ...prev,
                        lastRoute: 'failure-group',
                    })).catch(() => { /* ignore */ });
                }
                unlistenClose();
            });
        } catch (err) {
            console.error('Error opening predictive model window:', err);
        }
    };

    // ── Group Actions ─────────────────────────────────────────────

    const handleClose = async () => {
        if (isBuildModelOpen) {
            // Focus the BuildModel window and trigger a shake animation.
            // Fire-and-forget so a slow IPC channel can't hang the click.
            WebviewWindow.getByLabel('predictive-model')
                .then(bm => bm?.setFocus())
                .catch(() => { /* ignore */ });
            emit('predictive-model-shake').catch(() => { /* ignore */ });
            return;
        }
        try { await getCurrentWindow().close(); } catch { /* ignore */ }
    };

    const createGroup = () => {
        const name = newGroupName.trim() || `Group ${groups.length}`;
        const maxNo = Math.max(...groups.map(g => g.no), 0);
        setGroups(prev => [...prev, { no: maxNo + 1, name, isCollapsed: false }]);
        setNewGroupName("");
        setShowNewGroupDialog(false);
    };

    const removeGroup = (groupNo: number) => {
        if (groupNo === 0) return;
        setRows(prev => prev.filter(r => r.groupNo !== groupNo));
        setGroups(prev => prev.filter(g => g.no !== groupNo));
    };

    const toggleGroupCollapse = (groupNo: number) => {
        setGroups(prev => prev.map(g => g.no === groupNo ? { ...g, isCollapsed: !g.isCollapsed } : g));
    };

    const startEditingGroupName = (groupNo: number) => {
        const group = groups.find(g => g.no === groupNo);
        if (!group || groupNo === 0) return;
        setEditingGroupNo(groupNo);
        setEditingGroupName(group.name);
    };

    const finishEditingGroupName = () => {
        if (editingGroupNo === null) return;
        const name = editingGroupName.trim();
        if (name) setGroups(prev => prev.map(g => g.no === editingGroupNo ? { ...g, name } : g));
        setEditingGroupNo(null);
        setEditingGroupName("");
    };

    // ── Row Actions ──────────────────────────────────────────────

    const addRowToGroup = (groupNo: number) => {
        const newRow: SensorRow = {
            id: nextId(), groupNo, conceptSensor: "", mappedSensorTag: "",
            mappedSensorName: "", modelType: "", modelNotes: "", additionalNotes: "", status: false,
        };
        setRows(prev => {
            const lastIdx = prev.map((r, i) => r.groupNo === groupNo ? i : -1).filter(i => i !== -1);
            const insertAt = lastIdx.length > 0 ? Math.max(...lastIdx) + 1 : prev.length;
            const next = [...prev];
            next.splice(insertAt, 0, newRow);
            return next;
        });
    };

    const removeRow = (id: string) => {
        setRows(prev => prev.filter(r => r.id !== id));
        if (selectedRowId === id) { setSelectedRowId(null); setShowModelPanel(false); }
    };

    const updateRow = (id: string, field: keyof SensorRow, value: string | number | boolean) => {
        setRows(prev => prev.map(r => {
            if (r.id !== id) return r;
            const updated = { ...r, [field]: value };
            if (field === 'mappedSensorTag') updated.mappedSensorName = getSensorName(value as string, sensorMetadata);
            return updated;
        }));
    };

    const selectSensorTag = (rowId: string, tag: string) => {
        // Prevent duplicate sensor tag within the same group
        const currentRow = rows.find(r => r.id === rowId);
        if (currentRow) {
            const groupRows = rows.filter(r => r.groupNo === currentRow.groupNo && r.id !== rowId);
            if (groupRows.some(r => r.mappedSensorTag.toLowerCase() === tag.toLowerCase())) {
                alert(`Sensor tag "${tag}" already exists in this group.`);
                return;
            }
        }
        updateRow(rowId, 'mappedSensorTag', tag);
        setDropdownRowId(null);
        setDropdownSearch("");
    };

    const handleRowClick = (rowId: string) => {
        setSelectedRowId(rowId);
        setShowModelPanel(true);
    };

    // ── Derived ──────────────────────────────────────────────────

    const getRowsForGroup = (groupNo: number) => rows.filter(r => r.groupNo === groupNo);
    const selectedRow = rows.find(r => r.id === selectedRowId);
    const getSensorDescription = (tag: string): string => {
        if (!sensorMetadata || !tag) return "";
        const found = sensorMetadata.find(m => m.tag.toLowerCase() === tag.toLowerCase());
        return found ? found.description : "";
    };
    const filteredSensors = allSensors.filter(s => {
        const q = dropdownSearch.toLowerCase();
        if (!q) return true;
        if (s.toLowerCase().includes(q)) return true;
        const desc = getSensorDescription(s).toLowerCase();
        return desc.includes(q);
    });
    const sortedGroups = [...groups].sort((a, b) => a.no - b.no);

    // Stats for progress strip
    const totalSensors = rows.length;
    const readyCount = rows.filter(r => r.status).length;
    const pendingCount = rows.filter(r => !r.status).length;
    const completionPct = totalSensors > 0 ? Math.round((readyCount / totalSensors) * 100) : 0;

    // ── CSV Helpers ────────────────────────────────────────────────

    const CSV_HEADERS = ["No.", "Group Name", "Concept Sensor", "Mapped Sensor Tag", "Mapped Sensor Name", "Model Type", "Model Notes", "Additional Notes", "Status"];

    /** Parse a CSV string into an array of Record objects using the header row as keys. Handles quoted fields with commas/newlines. */
    const parseCsv = (text: string): Record<string, string>[] => {
        const result: Record<string, string>[] = [];
        const lines: string[][] = [];
        let current: string[] = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else { field += ch; }
            } else {
                if (ch === '"') { inQuotes = true; }
                else if (ch === ',') { current.push(field); field = ''; }
                else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
                    current.push(field); field = '';
                    lines.push(current); current = [];
                    if (ch === '\r') i++;
                } else { field += ch; }
            }
        }
        if (field || current.length > 0) { current.push(field); lines.push(current); }

        if (lines.length < 2) return result;
        const headers = lines[0].map(h => h.trim());
        for (let i = 1; i < lines.length; i++) {
            const vals = lines[i];
            if (vals.length === 1 && vals[0].trim() === '') continue; // skip empty lines
            const row: Record<string, string> = {};
            headers.forEach((h, idx) => { row[h] = (vals[idx] ?? '').trim(); });
            result.push(row);
        }
        return result;
    };

    /** Escape a value for CSV output */
    const csvEscape = (v: string | number | boolean): string => {
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    // ── Upload / Download / Save (CSV) ───────────────────────────────

    const handleUpload = async () => {
        try {
            const selected = await openDialog({
                multiple: false,
                filters: [{ name: 'CSV Files', extensions: ['csv'] }],
            });
            if (!selected) return;
            const filePath = Array.isArray(selected) ? selected[0] : selected;
            if (!filePath) return;

            const csvText = await readTextFile(filePath);
            const jsonRows = parseCsv(csvText);
            if (jsonRows.length === 0) return;

            const newGroups: FailureGroup[] = [{ no: 0, name: "Not in Group", isCollapsed: false }];
            const newRows: SensorRow[] = [];
            const seenGroups = new Set<number>([0]);

            for (const raw of jsonRows) {
                const groupNo = Number(raw["No."] || raw["No"] || 0) || 0;
                const groupName = (raw["Group Name"] ?? "").trim();
                const tag = (raw["Mapped Sensor Tag"] ?? "").trim();
                const statusRaw = (raw["Status"] ?? "").trim().toLowerCase();

                if (groupNo !== 0 && !seenGroups.has(groupNo)) {
                    seenGroups.add(groupNo);
                    newGroups.push({ no: groupNo, name: groupName || `Group ${groupNo}`, isCollapsed: false });
                }

                newRows.push({
                    id: nextId(),
                    groupNo,
                    conceptSensor: (raw["Concept Sensor"] ?? "").trim(),
                    mappedSensorTag: tag,
                    mappedSensorName: getSensorName(tag, sensorMetadata),
                    modelType: (raw["Model Type"] ?? "").trim(),
                    modelNotes: (raw["Model Notes"] ?? "").trim(),
                    additionalNotes: (raw["Additional Notes"] ?? "").trim(),
                    status: statusRaw === "yes" || statusRaw === "true" || statusRaw === "1",
                });
            }

            setGroups(newGroups);
            setRows(newRows);
            setSelectedRowId(null);
            setShowModelPanel(false);
        } catch (err) {
            console.error('Failed to upload CSV:', err);
        }
    };

    const handleDownloadTemplate = () => {
        const blob = new Blob([CSV_HEADERS.join(",") + "\n"], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'failure_group_template.csv';
        link.click();
        URL.revokeObjectURL(link.href);
    };

    const handleSave = () => {
        const csvRows = rows.map(r => {
            const group = groups.find(g => g.no === r.groupNo);
            return [r.groupNo, group?.name || '', r.conceptSensor, r.mappedSensorTag, r.mappedSensorName, r.modelType, r.modelNotes, r.additionalNotes, r.status ? "Yes" : "No"]
                .map(csvEscape).join(",");
        });
        const blob = new Blob([[CSV_HEADERS.join(","), ...csvRows].join("\n")], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `failure_groups_${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    };

    // ── Back to Upload ────────────────────────────────────────────

    const handleBackToUpload = async () => {
        try {
            const confirmed = await ask(
                'Return to the Upload page? Your Failure Groups are already saved in this workspace — you can reopen it later.',
                { title: 'Back to Upload', kind: 'warning' }
            );
            if (!confirmed) return;
        } catch { /* fall through to confirm via window.confirm */ }

        // Reset workspace anchor so the main window lands on the import page.
        try { await setLastWorkspaceId(null); } catch { /* ignore */ }

        try {
            const existing = await WebviewWindow.getByLabel('main');
            if (existing) {
                await existing.show();
                await existing.setFocus();
            } else {
                new WebviewWindow('main', {
                    url: '/',
                    title: 'Soothsayer-Wizard',
                    width: 1200,
                    height: 800,
                    center: true,
                    maximized: true,
                });
            }
        } catch (e) {
            console.warn('Failed to reopen main window:', e);
        }

        try { await getCurrentWindow().close(); } catch { /* ignore */ }
    };

    // ── Native Menu ───────────────────────────────────────────────

    useSubWindowMenu({
        workspaceId,
        localSaveLabel: 'Export Groups as CSV',
        onLocalSave: () => handleSave(),
        onToggleTheme: () => {
            const current = localStorage.getItem('theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', next);
            document.documentElement.setAttribute('data-theme', next);
        },
    });

    // ── Render ────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="predictive-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>Loading data...</div>
            </div>
        );
    }

    return (
        <div className="predictive-container">
            {/* Title Bar — only render custom bar when the OS doesn't provide native decorations */}
            {!isMacOS && (
                <div data-tauri-drag-region className="predictive-titlebar">
                    <h2 className="predictive-title">Predictive Mode — Failure Group Creation</h2>
                    <div className="predictive-titlebar-actions">
                        <button className="predictive-window-btn" onClick={() => getCurrentWindow().minimize()} title="Minimize">
                            <Minus size={14} />
                        </button>
                        <button className="predictive-window-btn" onClick={() => getCurrentWindow().toggleMaximize()} title="Maximize">
                            <Square size={12} />
                        </button>
                        <button onClick={handleClose} className="predictive-close-btn">&times;</button>
                    </div>
                </div>
            )}

            {/* Command bar — toolbar with breadcrumb + actions */}
            <div className="fg-toolbar">
                <div className="fg-toolbar-left">
                    <button
                        className="fg-back-btn"
                        onClick={handleBackToUpload}
                        title="Back to Upload"
                    >
                        <ArrowLeft size={14} />
                        <span>Back to Upload</span>
                    </button>
                    <div className="fg-breadcrumb">
                        <span className="fg-breadcrumb-label">Predictive Mode</span>
                        <span className="fg-breadcrumb-sep">/</span>
                        <span className="fg-breadcrumb-title">Failure Groups</span>
                    </div>
                    <span className="fg-step-pill">Step 2 of 3</span>
                </div>
                <div className="fg-toolbar-right">
                    <button className="fg-upload-btn" onClick={handleUpload}>
                        <Upload size={13} /> Upload Filled
                    </button>
                    <button className="fg-download-btn" onClick={handleDownloadTemplate}>
                        <Download size={13} /> Template
                    </button>
                    <div className="fg-toolbar-divider" />
                    <button className="fg-save-btn" onClick={handleSave}>
                        <Save size={13} /> Save Groups
                    </button>
                </div>
            </div>

            {/* Progress strip */}
            <div className="fg-progress-strip">
                <div className="fg-stat-badge">
                    <span className="fg-stat-label">Total sensors</span>
                    <span className="fg-stat-value">{totalSensors}</span>
                </div>
                <div className="fg-strip-div" />
                <div className="fg-stat-badge">
                    <span className="fg-stat-label">Groups</span>
                    <span className="fg-stat-value">{groups.length}</span>
                </div>
                <div className="fg-strip-div" />
                <div className="fg-stat-badge">
                    <span className="fg-stat-label">Models ready</span>
                    <span className="fg-stat-value fg-stat-value--ok">{readyCount}</span>
                </div>
                <div className="fg-strip-div" />
                <div className="fg-stat-badge">
                    <span className="fg-stat-label">Pending</span>
                    <span className="fg-stat-value fg-stat-value--warn">{pendingCount}</span>
                </div>
                <div className="fg-strip-spacer" />
                <div className="fg-completion">
                    <span className="fg-completion-label">Completion</span>
                    <div className="fg-completion-bar">
                        <div className="fg-completion-fill" style={{ width: `${completionPct}%` }} />
                    </div>
                    <span className="fg-completion-pct">{completionPct}%</span>
                </div>
            </div>

            <div className="fg-body">
                <div className={`fg-table-area ${showModelPanel ? 'fg-table-area--split' : ''}`}>
                    <div className="fg-groups-container">
                        {sortedGroups.map(group => {
                            const groupRows = getRowsForGroup(group.no);
                            const isUngrouped = group.no === 0;
                            const gColor = getGroupColor(group.no);

                            return (
                                <div key={group.no} className={`fg-group-card fg-group-color-${gColor} ${isUngrouped ? 'fg-group-card--ungrouped' : ''}`}>
                                    {/* Group Header */}
                                    <div className="fg-group-card-header" onClick={() => toggleGroupCollapse(group.no)}>
                                        <div className="fg-group-card-header-left">
                                            {group.isCollapsed ? <ChevronRight size={14} className="fg-group-chevron" /> : <ChevronDown size={14} className="fg-group-chevron" />}
                                            <span className="fg-group-dot" />
                                            {editingGroupNo === group.no ? (
                                                <input className="fg-group-name-input" value={editingGroupName}
                                                    onChange={e => setEditingGroupName(e.target.value)}
                                                    onBlur={finishEditingGroupName}
                                                    onKeyDown={e => { if (e.key === 'Enter') finishEditingGroupName(); }}
                                                    onClick={e => e.stopPropagation()} autoFocus
                                                />
                                            ) : (
                                                <span className="fg-group-name">{group.name}</span>
                                            )}
                                            <span className="fg-group-count">{groupRows.length} sensor{groupRows.length !== 1 ? 's' : ''}</span>
                                        </div>
                                        <div className="fg-group-card-header-actions" onClick={e => e.stopPropagation()}>
                                            {!isUngrouped && (
                                                <button className="fg-icon-btn fg-icon-btn-edit" onClick={() => startEditingGroupName(group.no)} title="Rename group">
                                                    <Edit3 size={12} />
                                                </button>
                                            )}
                                            <button className="fg-icon-btn fg-icon-btn-add" onClick={() => addRowToGroup(group.no)} title="Add sensor">
                                                <Plus size={13} />
                                            </button>
                                            {!isUngrouped && (
                                                <button className="fg-icon-btn fg-icon-btn-danger" onClick={() => removeGroup(group.no)} title="Remove group">
                                                    <Trash2 size={12} />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Group Body — compact sensor chips */}
                                    {!group.isCollapsed && (
                                        <div className="fg-group-card-body">
                                            {groupRows.length === 0 ? (
                                                <div className="fg-group-empty">Drop sensors here</div>
                                            ) : (
                                                <div className="fg-sensor-cards">
                                                    {groupRows.map(row => {
                                                        const isSelected = selectedRowId === row.id;
                                                        const tagMissing = !!row.mappedSensorTag && !allSensors.some(s => s.toLowerCase() === row.mappedSensorTag.toLowerCase());
                                                        return (
                                                            <div
                                                                key={row.id}
                                                                className={`fg-sensor-chip ${isSelected ? 'fg-sensor-chip--selected' : ''} ${!row.status ? 'fg-sensor-chip--disabled' : ''}`}
                                                                onClick={() => handleRowClick(row.id)}
                                                            >
                                                                <div className="fg-sensor-chip-top">
                                                                    <GripVertical size={12} className="fg-sensor-grip" />
                                                                    <span className={`fg-sensor-chip-tag ${tagMissing ? 'fg-sensor-chip-tag--warning' : ''}`}>
                                                                        {row.mappedSensorTag || '— no tag —'}
                                                                    </span>
                                                                    {tagMissing && <AlertTriangle size={11} className="fg-warning-icon" />}
                                                                    <div className="fg-chip-spacer" />
                                                                    <label className="fg-toggle-label" onClick={e => e.stopPropagation()} title={row.status ? 'Ready' : 'Pending'}>
                                                                        <input type="checkbox" className="fg-status-switch-input" checked={row.status} onChange={e => updateRow(row.id, 'status', e.target.checked)} />
                                                                        <span className="fg-status-switch"><span className="fg-status-switch-thumb" /></span>
                                                                    </label>
                                                                </div>
                                                                <div className="fg-sensor-chip-name">
                                                                    {row.mappedSensorName || row.conceptSensor || 'Unnamed sensor'}
                                                                </div>
                                                                <div className="fg-sensor-chip-meta">
                                                                    <span className={`fg-status-pill fg-status-pill--${row.status ? 'ok' : 'neutral'}`}>
                                                                        {row.status ? 'Ready' : 'Pending'}
                                                                    </span>
                                                                    {row.modelType && <span className="fg-sensor-chip-model">· {row.modelType}</span>}
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                    <button className="fg-chip-add-tile" onClick={() => addRowToGroup(group.no)}>
                                                        <Plus size={12} /> Add sensor
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {/* New Group */}
                        {showNewGroupDialog ? (
                            <div className="fg-new-group-dialog">
                                <div className="fg-new-group-dialog-header"><FolderPlus size={16} /> Create New Failure Group</div>
                                <div className="fg-new-group-dialog-body">
                                    <label>Group Name</label>
                                    <input ref={newGroupInputRef} type="text" className="fg-new-group-input" value={newGroupName}
                                        onChange={e => setNewGroupName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') createGroup(); if (e.key === 'Escape') { setShowNewGroupDialog(false); setNewGroupName(""); } }}
                                        placeholder="e.g. crankcase condition"
                                    />
                                </div>
                                <div className="fg-new-group-dialog-actions">
                                    <button className="fg-new-group-cancel" onClick={() => { setShowNewGroupDialog(false); setNewGroupName(""); }}>Cancel</button>
                                    <button className="fg-new-group-create" onClick={createGroup}><Plus size={14} /> Create Group</button>
                                </div>
                            </div>
                        ) : (
                            <button className="fg-add-group-btn" onClick={() => setShowNewGroupDialog(true)}>
                                <Plus size={14} /> <span>Add New Failure Group</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Right: Inspector panel */}
                {showModelPanel && (
                <div className="fg-model-panel">
                    {selectedRow ? (
                        <>
                            <div className="fg-inspector-header">
                                <div className="fg-inspector-eyebrow">Configure</div>
                                <div className="fg-inspector-title-row">
                                    <div className="fg-sensor-tag-wrapper" onClick={e => e.stopPropagation()}>
                                        <button
                                            className={`fg-inspector-tag-btn ${selectedRow.mappedSensorTag ? 'fg-inspector-tag-btn--filled' : ''}`}
                                            onClick={() => { dropdownRowId === selectedRow.id ? setDropdownRowId(null) : (setDropdownRowId(selectedRow.id), setDropdownSearch("")); }}
                                        >
                                            <span>{selectedRow.mappedSensorTag || 'Select sensor tag…'}</span>
                                            <ChevronDown size={12} />
                                        </button>
                                        {dropdownRowId === selectedRow.id && (
                                            <div className="fg-sensor-dropdown" ref={dropdownRef}>
                                                <div className="fg-sensor-dropdown-search">
                                                    <input type="text" placeholder="Search sensor..." value={dropdownSearch} onChange={e => setDropdownSearch(e.target.value)} autoFocus />
                                                </div>
                                                <div className="fg-sensor-dropdown-list">
                                                    {filteredSensors.length === 0 ? (
                                                        <div className="fg-sensor-dropdown-empty">No sensors found</div>
                                                    ) : filteredSensors.map(s => {
                                                        const desc = getSensorDescription(s);
                                                        return (
                                                            <button key={s} className={`fg-sensor-dropdown-item ${selectedRow.mappedSensorTag === s ? 'selected' : ''}`} onClick={() => selectSensorTag(selectedRow.id, s)}>
                                                                <span className="fg-sensor-dropdown-item-tag">{s}</span>
                                                                {desc && <span className="fg-sensor-dropdown-item-desc">{desc}</span>}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <span className={`fg-status-pill fg-status-pill--${selectedRow.status ? 'ok' : 'neutral'}`}>
                                        {selectedRow.status ? 'Ready' : 'Pending'}
                                    </span>
                                </div>
                                <div className="fg-inspector-desc">{selectedRow.mappedSensorName || '—'}</div>
                            </div>

                            <div className="fg-inspector-body">
                                {/* Assigned Group */}
                                <div className="fg-inspector-field">
                                    <div className="fg-inspector-field-label-row">
                                        <label>Assigned Group</label>
                                    </div>
                                    <div className="fg-group-chip-grid">
                                        {sortedGroups.map(g => {
                                            const active = g.no === selectedRow.groupNo;
                                            const c = getGroupColor(g.no);
                                            const isEditing = editingGroupNo === g.no;
                                            const isUngrouped = g.no === 0;
                                            return (
                                                <div
                                                    key={g.no}
                                                    className={`fg-group-chip fg-group-color-${c} ${active ? 'fg-group-chip--active' : ''}`}
                                                >
                                                    <span className="fg-group-chip-dot" />
                                                    {isEditing ? (
                                                        <input
                                                            className="fg-group-chip-input"
                                                            value={editingGroupName}
                                                            onChange={e => setEditingGroupName(e.target.value)}
                                                            onBlur={finishEditingGroupName}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Enter') finishEditingGroupName();
                                                                if (e.key === 'Escape') { setEditingGroupNo(null); setEditingGroupName(''); }
                                                            }}
                                                            autoFocus
                                                        />
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className="fg-group-chip-move"
                                                            onClick={() => !active && updateRow(selectedRow.id, 'groupNo', g.no)}
                                                            disabled={active}
                                                            title={active ? 'Current group' : `Move to ${g.name}`}
                                                        >
                                                            <span className="fg-group-chip-name">{g.name}</span>
                                                        </button>
                                                    )}
                                                    {!isUngrouped && !isEditing && (
                                                        <div className="fg-group-chip-actions">
                                                            <button
                                                                type="button"
                                                                className="fg-group-chip-action"
                                                                onClick={() => startEditingGroupName(g.no)}
                                                                title="Rename group"
                                                            >
                                                                <Edit3 size={10} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="fg-group-chip-action fg-group-chip-action--danger"
                                                                onClick={() => {
                                                                    if (confirm(`Delete group "${g.name}"? All sensors in this group will also be removed.`)) {
                                                                        removeGroup(g.no);
                                                                    }
                                                                }}
                                                                title="Delete group"
                                                            >
                                                                <Trash2 size={10} />
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Concept + Model Type */}
                                <div className="fg-inspector-grid">
                                    <div className="fg-inspector-field">
                                        <div className="fg-inspector-field-label-row">
                                            <label>Concept Sensor</label>
                                            <span className="fg-field-hint">What physical concept this measures</span>
                                        </div>
                                        <input type="text" className="fg-inspector-input" value={selectedRow.conceptSensor} placeholder="e.g. crankcase vibration" onChange={e => updateRow(selectedRow.id, 'conceptSensor', e.target.value)} />
                                    </div>
                                    <div className="fg-inspector-field">
                                        <div className="fg-inspector-field-label-row">
                                            <label>Model Type</label>
                                            <span className="fg-field-hint">Forecasting model family</span>
                                        </div>
                                        <input type="text" className="fg-inspector-input" value={selectedRow.modelType} placeholder="e.g. I + R" onChange={e => updateRow(selectedRow.id, 'modelType', e.target.value)} />
                                    </div>
                                </div>

                                <div className="fg-inspector-field">
                                    <div className="fg-inspector-field-label-row">
                                        <label>Model Notes</label>
                                    </div>
                                    <textarea className="fg-inspector-textarea" rows={3} value={selectedRow.modelNotes} placeholder="Notes about training, features, thresholds…" onChange={e => updateRow(selectedRow.id, 'modelNotes', e.target.value)} />
                                </div>

                                <div className="fg-inspector-field">
                                    <div className="fg-inspector-field-label-row">
                                        <label>Additional Notes</label>
                                    </div>
                                    <textarea className="fg-inspector-textarea" rows={2} value={selectedRow.additionalNotes} placeholder="Operator remarks, caveats…" onChange={e => updateRow(selectedRow.id, 'additionalNotes', e.target.value)} />
                                </div>

                                {/* Meta */}
                                <div className="fg-meta-box">
                                    <div className="fg-meta-row">
                                        <span className="fg-meta-k">Group No.</span>
                                        <span className="fg-meta-v">{selectedRow.groupNo}</span>
                                    </div>
                                    <div className="fg-meta-row">
                                        <span className="fg-meta-k">Mapped Tag</span>
                                        <span className="fg-meta-v">{selectedRow.mappedSensorTag || '—'}</span>
                                    </div>
                                    <div className="fg-meta-row">
                                        <span className="fg-meta-k">Data points</span>
                                        <span className="fg-meta-v">{metadata?.total_rows?.toLocaleString?.() ?? '—'}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="fg-inspector-footer">
                                <button className="fg-icon-btn fg-icon-btn-danger" onClick={() => removeRow(selectedRow.id)} title="Remove sensor">
                                    <X size={14} />
                                </button>
                                <div className="fg-inspector-footer-spacer" />
                                <button className="fg-inspector-close-btn" onClick={() => { setShowModelPanel(false); setSelectedRowId(null); }}>
                                    Close
                                </button>
                                <button
                                    className="fg-build-model-btn"
                                    onClick={() => handleBuildModel(selectedRow)}
                                    disabled={!selectedRow.mappedSensorTag}
                                >
                                    <Play size={11} /> Build Model
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="fg-inspector-empty">Select a sensor to configure</div>
                    )}
                </div>
                )}
            </div>
        </div>
    );
}
