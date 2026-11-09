import { useEffect, useRef, useState } from 'react';
import Portal from '../Portal';

/** How long an "… — Undo" toast stays up, in seconds (the Dashboard's model
 *  deletion and Import step 3's group removal). */
export const UNDO_SECONDS = 7;

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
    // Fades out for --dur-exit before it expires (an Undo click removes it at once).
    const [leaving, setLeaving] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => expireRef.current(toast.id), durationMs);
        const fade = setTimeout(() => setLeaving(true), Math.max(0, durationMs - 160));
        return () => { clearTimeout(timer); clearTimeout(fade); };
    }, [toast.id, durationMs]);

    return (
        <div className="fg-undo-toast" data-testid="fg-undo-toast" data-leaving={leaving || undefined}>
            <i className="fg-undo-toast-dot" aria-hidden="true" />
            <span className="fg-undo-toast-msg">{toast.message}</span>
            <button type="button" className="fg-undo-toast-btn" onClick={() => onUndo(toast.id)}>Undo</button>
        </div>
    );
}

/** Bottom-right stack of 'deleted - Undo' toasts via Portal; data-fg-sheet-keep keeps Undo from counting as a click outside the assignment sheet. */
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
