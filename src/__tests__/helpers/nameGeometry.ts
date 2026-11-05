/** jsdom has no layout, so every name fits. `stubNamesCut` makes elements report less room than content; `restoreNames` undoes it. */
const origClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');

export function stubNamesCut() {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 500 });
}

/** Measured and fits: takes a name through the fit branch (no stub means width 0 = not rendered). */
export function stubNamesFit() {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 400 });
}

/** Measures one rule per element: `cut(el)` says whether this element's text is cut. */
export function stubNamesCutWhere(cut: (el: HTMLElement) => boolean) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get(this: HTMLElement) { return cut(this) ? 500 : 50; },
    });
}

export function restoreNames() {
    if (origClient) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClient);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (origScroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origScroll);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
}

/** Names of one family: long, sharing "Crosshead (P-P Trend) - Vibration crosshead slide 11A". */
export const longName = (n: number, end = 'avg') => `Crosshead (P-P Trend) - Vibration crosshead slide 11A - SegmentNo ${n} - ${end}`;
