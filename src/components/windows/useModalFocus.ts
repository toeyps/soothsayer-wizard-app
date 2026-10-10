import { useEffect, type RefObject } from 'react';
import { isPickerSurfaceOpen } from '../sensor/SensorPicker';

/** What Tab can land on inside a dialog. */
const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The dialog's focusable elements, in document order (roving `tabindex="-1"`
 *  members — e.g. the unchecked radio of a radio row — are left out). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.getAttribute('tabindex') !== '-1');
}

/**
 * Keyboard focus of a modal dialog (workbench redesign SPEC §5 "Keyboard"):
 *
 *  - on open, focus the first field — the first focusable element inside
 *    `initialSelector` (the dialog's body), else the first one of the dialog;
 *  - Tab / Shift+Tab stay inside the dialog (they wrap at its ends);
 *  - on close, focus goes back to where it was.
 *
 * A sensor / colour picker opened from inside the dialog draws its popover
 * outside it (a portal): while one is open (`isPickerSurfaceOpen`) Tab is left
 * alone, so the popover's own search box and rows stay reachable.
 *
 * Esc is NOT handled here — the dialog's owner decides what Esc does (the
 * Running-condition modal asks before discarding a dirty draft).
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, initialSelector?: string): void {
    useEffect(() => {
        if (!open) return;
        const root = ref.current;
        if (!root) return;
        const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const body = initialSelector ? root.querySelector<HTMLElement>(initialSelector) : null;
        const first = (body ? focusableIn(body)[0] : undefined) ?? focusableIn(root)[0];
        // The dialog itself (tabIndex -1) when it has nothing to focus yet.
        (first ?? root).focus({ preventScroll: true });

        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab' || isPickerSurfaceOpen()) return;
            const list = focusableIn(root);
            if (list.length === 0) { e.preventDefault(); return; }
            const head = list[0];
            const tail = list[list.length - 1];
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || !root.contains(active)) {
                e.preventDefault();
                head.focus();
            } else if (e.shiftKey && (active === head || active === root)) {
                e.preventDefault();
                tail.focus();
            } else if (!e.shiftKey && active === tail) {
                e.preventDefault();
                head.focus();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            // Back to the control that opened the dialog, when it is still there.
            if (before && before.isConnected) before.focus({ preventScroll: true });
        };
        // `ref` is a stable ref object; the dialog mounts with `open`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialSelector]);
}
