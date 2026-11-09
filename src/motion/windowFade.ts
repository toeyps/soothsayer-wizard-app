// Sub-window close: the content fades out for --dur-exit, then the caller closes the window for real.
/** The fade length in ms; 0 under reduced motion (nothing to wait for). */
export const exitMs = (doc: Document = document) => {
    try {
        const p = doc.createElement('i');
        p.style.cssText = 'position:absolute;visibility:hidden;transition-duration:var(--dur-exit)';
        doc.body.appendChild(p);
        const v = parseFloat(getComputedStyle(p).transitionDuration) || 0;
        p.remove();
        return v * 1000;
    } catch { return 0; }
};

/** Fades the window's content out; resolves when it is gone (at once under reduced motion). */
export async function fadeOutWindow(doc: Document = document): Promise<void> {
    const ms = exitMs(doc);
    if (ms <= 0) return;
    doc.documentElement.classList.add('m-leaving');
    await new Promise(r => setTimeout(r, ms));
}

/** The close did not happen (a guard kept the window): show the content again. */
export function undoFadeOutWindow(doc: Document = document): void {
    doc.documentElement.classList.remove('m-leaving');
}
