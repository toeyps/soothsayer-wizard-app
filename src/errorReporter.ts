import { invoke } from '@tauri-apps/api/core';

/** Central error funnel: shows toasts and appends detail to `frontend-errors.log` via `log_frontend_error`. Never throws or recurses; repeats coalesce. */

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

/** Toast and log an error; safe anywhere (re-entry is cut by the dedupe window). */
export function reportError(source: string, err: unknown, extraDetail?: string): void {
    const { message, detail } = toMessage(err);
    const fullDetail = [detail, extraDetail].filter(Boolean).join('\n') || null;
    const now = Date.now();

    // Coalesce repeats by bumping the existing toast's counter.
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

const lastFileOnly = new Map<string, number>();

/** Log to file without a toast, for conditions handled safely but worth a trace; dedupes; never throws. */
export function logToFile(source: string, message: string, detail?: string): void {
    const key = `${source}|${message}`;
    const now = Date.now();
    const prev = lastFileOnly.get(key);
    if (prev !== undefined && now - prev < DEDUPE_WINDOW_MS) return;
    lastFileOnly.set(key, now);
    try {
        invoke<string>('log_frontend_error', {
            message: `[${source}] ${message}`,
            detail: detail ?? null,
        }).catch(() => { /* logging is best-effort */ });
    } catch { /* invoke unavailable (tests / plain browser) */ }
}

export function getErrorLogPath(): Promise<string> {
    return invoke<string>('get_error_log_path', {});
}

/** Install the global hooks once (called from App.tsx). */
export function initErrorReporter(): void {
    if (installed) return;
    installed = true;

    window.addEventListener('error', (event) => {
        // `error` events also fire for failed resources (no payload): report only real JS errors.
        if (event instanceof ErrorEvent && (event.error || event.message)) {
            reportError('uncaught', event.error ?? event.message);
        }
    });

    window.addEventListener('unhandledrejection', (event) => {
        reportError('unhandled-promise', event.reason);
    });
}
