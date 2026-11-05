import { invoke } from '@tauri-apps/api/core';
import type {
    ExportErrorCode,
    WorkspaceExportPlan,
    WorkspaceExportRequest,
    WorkspaceExportResult,
} from '../types/export';

/* Export results Tauri bindings (`workspace_export.rs`; every command is `rename_all = "snake_case"`) and pure helpers. */

/** Dry run: what the export would write, and every issue that blocks it. Writes nothing. */
export function planWorkspaceExport(request: WorkspaceExportRequest): Promise<WorkspaceExportPlan> {
    return invoke<WorkspaceExportPlan>('plan_workspace_export', { request });
}

/** Writes into `<destDir>/<folderName>` (Rust picks `_2`..`_99` if taken). Rust re-plans first: any error issue rejects with `NOT_READY:` and nothing is written. `exportId` tags progress events and cancel. */
export function exportWorkspaceResults(
    request: WorkspaceExportRequest,
    destDir: string,
    folderName: string,
    exportId: string,
): Promise<WorkspaceExportResult> {
    return invoke<WorkspaceExportResult>('export_workspace_results', {
        request,
        dest_dir: destDir,
        folder_name: folderName,
        export_id: exportId,
    });
}

/** Ask a running export to stop. `true` when an export with that id was running. */
export function cancelWorkspaceExport(exportId: string): Promise<boolean> {
    return invoke<boolean>('cancel_workspace_export', { export_id: exportId });
}

/** Open a folder this app exported in the system file manager. */
export async function revealExportFolder(path: string): Promise<void> {
    await invoke<null>('reveal_export_folder', { path });
}

const ERROR_CODES: readonly ExportErrorCode[] = ['NO_DATA', 'STALE_SESSION', 'BAD_REQUEST', 'NOT_READY', 'CANCELLED', 'WRITE_FAILED'];

export interface ParsedExportError {
    /** The stable prefix, or `null` for an error without a known one. */
    code: ExportErrorCode | null;
    /** The readable text after the prefix (the whole text when there is none). */
    message: string;
    /** `NOT_READY: <n> problem(s)`: the number of problems. */
    problems?: number;
}

/** Split an export command's rejection (`"CODE: message"`) into its code and text. */
export function parseExportError(err: unknown): ParsedExportError {
    const text = err instanceof Error ? err.message : String(err ?? '');
    const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(text);
    if (!m || !(ERROR_CODES as readonly string[]).includes(m[1])) return { code: null, message: text };
    const code = m[1] as ExportErrorCode;
    const message = m[2].trim() || text;
    if (code === 'NOT_READY') {
        const n = /^(\d+)/.exec(m[2].trim());
        if (n) return { code, message, problems: Number(n[1]) };
    }
    return { code, message };
}

/** The longest folder name Rust accepts (`^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`). */
const MAX_FOLDER_NAME = 120;
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Reduces `s` to folder-name characters (accents dropped, other non-ASCII removed, other runs become one `_`, starts with a letter or digit); `''` if nothing is left. */
export function asciiFolderPart(s: string): string {
    const out = (s ?? '')
        .normalize('NFKD')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[^A-Za-z0-9]+/, '')
        .replace(/[._-]+$/, '');
    return /[A-Za-z0-9]/.test(out) ? out : '';
}

/** `_YYYY-MM-DD_HHMM` of `date` in the PC's local time. */
export function exportStamp(date: Date): string {
    return `_${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/** Export folder name: ASCII project name + `_YYYY-MM-DD_HHMM`; falls back to the machine tag, then 'Workspace'. Matches Rust's folder-name rule. */
export function exportFolderName(workspaceName: string, machineTag: string, date: Date): string {
    const stamp = exportStamp(date);
    const base = asciiFolderPart(workspaceName) || asciiFolderPart(machineTag) || 'Workspace';
    const cut = base.slice(0, MAX_FOLDER_NAME - stamp.length).replace(/[._-]+$/, '');
    return `${cut || 'Workspace'}${stamp}`;
}
