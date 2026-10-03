import { useEffect, useRef } from 'react';
import Portal from '../Portal';

export interface UndoToastItem {
    id: string;
    message: string;
}

interface UndoToastStackProps {
    toasts: UndoToastItem[];
    onUndo: (id: string) => void;
    /** Called when a toast's own timer runs out (it is NOT an undo). */
    onExpire: (id: string) => void;
    /** How long each toast stays up before it expires. */
    durationMs: number;
}

function UndoToast({ toast, onUndo, onExpire, durationMs }: {
    toast: UndoToastItem;
    onUndo: (id: string) => void;
    onExpire: (id: string) => void;
    durationMs: number;
}) {
    // Latest callback without restarting the timer when the parent re-renders.
    const expireRef = useRef(onExpire);
    expireRef.current = onExpire;
    useEffect(() => {
        const timer = setTimeout(() => expireRef.current(toast.id), durationMs);
        return () => clearTimeout(timer);
    }, [toast.id, durationMs]);

    return (
        <div className="fg-undo-toast" data-testid="fg-undo-toast">
            <i className="fg-undo-toast-dot" aria-hidden="true" />
            <span className="fg-undo-toast-msg">{toast.message}</span>
            <button type="button" className="fg-undo-toast-btn" onClick={() => onUndo(toast.id)}>Undo</button>
        </div>
    );
}

/**
 * Bottom-right stack of "… deleted — Undo" toasts. Rendered through `Portal`
 * (so no overflow-hidden Dashboard panel can clip it) and marked
 * `data-fg-sheet-keep` so clicking Undo while the Failure Group Assignment
 * sheet is open does not count as "clicked outside" and dismiss the sheet.
 */
export default function UndoToastStack({ toasts, onUndo, onExpire, durationMs }: UndoToastStackProps) {
    if (toasts.length === 0) return null;
    return (
        <Portal>
            <div className="fg-undo-stack" role="status" aria-live="polite" data-fg-sheet-keep="true">
                {toasts.map(t => (
                    <UndoToast key={t.id} toast={t} onUndo={onUndo} onExpire={onExpire} durationMs={durationMs} />
                ))}
            </div>
        </Portal>
    );
}
