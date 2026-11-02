/**
 * jsdom has no layout, so every name reads as "fits". `stubNamesCut` makes every element report less room than its
 * content, which is how long names measure when they are really cut; `restoreNames` puts it back.
 */
const origClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');

export function stubNamesCut() {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 500 });
}

export function restoreNames() {
    if (origClient) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClient);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (origScroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origScroll);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
}

/** Names of one family: long, sharing "Crosshead (P-P Trend) - Vibration crosshead slide 11A". */
export const longName = (n: number, end = 'avg') => `Crosshead (P-P Trend) - Vibration crosshead slide 11A - SegmentNo ${n} - ${end}`;
