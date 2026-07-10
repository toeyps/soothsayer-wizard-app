import { invoke } from '@tauri-apps/api/core';

/**
 * Central error funnel for production builds, where there are no DevTools:
 * every uncaught error / unhandled rejection / React render crash flows
 * through `reportError()`, which
 *   1. keeps a small in-memory list that <ErrorToasts /> renders as visible
 *      alerts (the user's "why is the screen black" answer), and
 *   2. appends the full detail to `<app-log-dir>/frontend-errors.log` via the
 *      `log_frontend_error` command, so errors survive an app restart and can
 *      be sent back for debugging.
 *
 * The reporter must never throw or recurse: logging failures are swallowed,
 * and duplicate errors (same source+message) are coalesced within a window.
 */

export interface AppError {
    id: number;
    source: string;
    message: string;
    detail: string | null;
    /** How many times this exact error repeated while it was on screen. */
    count: number;
    at: number;
}

type Listener = () => void;

const MAX_VISIBLE = 4;
const DEDUPE_WINDOW_MS = 5_000;

let nextId = 1;
let installed = false;
let errors: AppError[] = [];
const listeners = new Set<Listener>();

/** Snapshot getter for useSyncExternalStore — identity changes on mutation. */
export function getErrors(): AppError[] {
    return errors;
}

export function subscribeErrors(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function dismissError(id: number): void {
    errors = errors.filter(e => e.id !== id);
    listeners.forEach(fn => fn());
}

export function dismissAllErrors(): void {
    errors = [];
    listeners.forEach(fn => fn());
}

function toMessage(err: unknown): { message: string; detail: string | null } {
    if (err instanceof Error) {
        return { message: err.message || String(err), detail: err.stack ?? null };
    }
    if (typeof err === 'string') return { message: err, detail: null };
    try {
        return { message: JSON.stringify(err), detail: null };
    } catch {
        return { message: String(err), detail: null };
    }
}

/**
 * Report an error: show it in the toast stack and persist it to the log
 * file. Safe to call from anywhere, including inside catch blocks of the
 * logging path itself (re-entry is cut by the dedupe window).
 */
export function reportError(source: string, err: unknown, extraDetail?: string): void {
    const { message, detail } = toMessage(err);
    const fullDetail = [detail, extraDetail].filter(Boolean).join('\n') || null;
    const now = Date.now();

    // Coalesce repeats (e.g. every pair-plot cell failing the same way):
    // bump the counter on the existing toast instead of stacking clones.
    const dup = errors.find(e => e.source === source && e.message === message);
    if (dup && now - dup.at < DEDUPE_WINDOW_MS) {
        dup.count += 1;
        dup.at = now;
        errors = [...errors];
        listeners.forEach(fn => fn());
        return;
    }

    errors = [
        { id: nextId++, source, message, detail: fullDetail, count: 1, at: now },
        ...errors,
    ].slice(0, MAX_VISIBLE);
    listeners.forEach(fn => fn());

    // Fire-and-forget persistence; the logger must never throw.
    invoke<string>('log_frontend_error', {
        message: `[${source}] ${message}`,
        detail: fullDetail,
    }).catch(() => { /* logging is best-effort */ });
}

export function getErrorLogPath(): Promise<string> {
    return invoke<string>('get_error_log_path', {});
}

/**
 * Install the global hooks once (module-scope call from App.tsx). Captures
 * errors that would otherwise blank the screen with no trace in production.
 */
export function initErrorReporter(): void {
    if (installed) return;
    installed = true;

    window.addEventListener('error', (event) => {
        // Plain `error` events also fire for failed <img>/<script> resources
        // (no ErrorEvent/`error` payload) — only surface real JS errors.
        if (event instanceof ErrorEvent && (event.error || event.message)) {
            reportError('uncaught', event.error ?? event.message);
        }
    });

    window.addEventListener('unhandledrejection', (event) => {
        reportError('unhandled-promise', event.reason);
    });
}
