import { useState, useEffect, useSyncExternalStore } from 'react';
import { AlertCircle, X, ChevronDown, ChevronUp } from 'lucide-react';
import {
    getErrors,
    subscribeErrors,
    dismissError,
    dismissAllErrors,
    getErrorLogPath,
    type AppError,
} from '../errorReporter';

/**
 * Bottom-right alert stack fed by the global error reporter. Errors stay on
 * screen until dismissed (auto-hiding would defeat the point: in production
 * this is the only way to see WHY something silently failed). Each toast can
 * expand to the full stack trace, and the footer shows where the persistent
 * log file lives.
 */
function Toast({ error }: { error: AppError }) {
    const [open, setOpen] = useState(false);

    return (
        <div className="pointer-events-auto w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-red-800/70 bg-slate-900/95 shadow-xl backdrop-blur">
            <div className="flex items-start gap-2 p-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-300">
                            {error.source}
                        </span>
                        {error.count > 1 && (
                            <span className="text-[10px] text-slate-500">×{error.count}</span>
                        )}
                    </div>
                    <p className={`mt-1 break-words text-xs text-slate-200 ${open ? '' : 'line-clamp-3'}`}>
                        {error.message}
                    </p>
                    {open && error.detail && (
                        <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-950 p-2 text-[10px] leading-relaxed text-slate-400">
                            {error.detail}
                        </pre>
                    )}
                    {error.detail && (
                        <button
                            onClick={() => setOpen(o => !o)}
                            className="mt-1 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                        >
                            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            {open ? 'Hide details' : 'Details'}
                        </button>
                    )}
                </div>
                <button
                    onClick={() => dismissError(error.id)}
                    className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
                    title="Dismiss"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}

export function ErrorToasts() {
    const errors = useSyncExternalStore(subscribeErrors, getErrors);
    const [logPath, setLogPath] = useState<string | null>(null);

    // Resolve the log location once there's something to show it under.
    useEffect(() => {
        if (errors.length > 0 && logPath === null) {
            getErrorLogPath().then(setLogPath).catch(() => setLogPath(''));
        }
    }, [errors.length, logPath]);

    if (errors.length === 0) return null;

    return (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex flex-col items-end gap-2">
            {errors.map(e => <Toast key={e.id} error={e} />)}
            <div className="pointer-events-auto flex w-96 max-w-[calc(100vw-2rem)] items-center justify-between gap-2 px-1">
                {logPath ? (
                    <span className="min-w-0 flex-1 truncate text-[10px] text-slate-500" title={logPath}>
                        log: {logPath}
                    </span>
                ) : <span />}
                {errors.length > 1 && (
                    <button
                        onClick={dismissAllErrors}
                        className="shrink-0 text-[11px] text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
                    >
                        Dismiss all
                    </button>
                )}
            </div>
        </div>
    );
}

export default ErrorToasts;
