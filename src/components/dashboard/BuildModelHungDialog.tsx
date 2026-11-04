import { useEffect, useRef } from 'react';
import { useModalFocus } from '../windows/useModalFocus';

/** Build Model did not react to a close: forcing it is the user's call. Opens on "Cancel". */
export default function BuildModelHungDialog({ onCloseIt, onCancel }: { onCloseIt: () => void; onCancel: () => void }) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    useModalFocus(dialogRef, true);
    useEffect(() => { cancelRef.current?.focus(); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onCancel]);
    return (
        <div className="bmw-modal-backdrop tq-close-back" role="presentation">
            <div className="tq-confirm" ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="bm-hung-title" aria-describedby="bm-hung-body" data-testid="build-model-hung-dialog">
                <div className="tq-cb" id="bm-hung-body">
                    <b className="tq-ct" id="bm-hung-title">Build Model is not responding</b>
                    <span>It did not answer the request to close. If you close it, its unsaved work is lost.</span>
                </div>
                <div className="tq-cf">
                    <button type="button" className="rcx-btn tq-cancel tq-cf-left" data-testid="build-model-hung-close" onClick={onCloseIt}>Close it</button>
                    <button type="button" ref={cancelRef} className="rcx-btn rcx-btn--pri" data-testid="build-model-hung-cancel" onClick={onCancel}>Cancel</button>
                </div>
            </div>
        </div>
    );
}
