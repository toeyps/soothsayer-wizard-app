import { hexToRgba, rgbaToHex } from './pairPlotColors';

/**
 * Pair Plot lasso clusters — naming and default-colour rules. Pure helpers so
 * the rules are testable without a WebGL cell. Clusters are session-only
 * (never persisted).
 */

type Rgba = [number, number, number, number];

/** Default cluster colours, in the order new clusters take them. Same hue
 *  order the Pair Plot always used (amber, emerald, fuchsia, rose, sky,
 *  orange, lime, violet), but each one is now the matching swatch of the
 *  shared ColourPicker palette, so opening the picker shows a check on the
 *  current colour instead of jumping to "Custom colour". */
export const CLUSTER_PALETTE_HEX = [
    '#f59e0b', // amber
    '#10b981', // emerald
    '#d946ef', // fuchsia
    '#f43f5e', // rose
    '#06b6d4', // sky (cyan)
    '#f97316', // orange
    '#84cc16', // lime
    '#8b5cf6', // violet
] as const;

export const CLUSTER_PALETTE: readonly Rgba[] = CLUSTER_PALETTE_HEX.map(h => hexToRgba(h));

/** Longest cluster name (characters, after trimming). */
export const CLUSTER_NAME_MAX = 40;

/** "Cluster N" with the smallest N not already taken. Only names that are
 *  still exactly "Cluster N" count as taken — a renamed cluster frees its
 *  number, and removing "Cluster 1" gives "Cluster 1" back on the next lasso. */
export function nextClusterName(existing: readonly { label: string }[]): string {
    const names = new Set(existing.map(c => c.label));
    let n = 1;
    while (names.has(`Cluster ${n}`)) n++;
    return `Cluster ${n}`;
}

/** First palette colour no current cluster uses; once all eight are in use
 *  it cycles by count, like before. */
export function nextClusterColour(existing: readonly { color: Rgba }[]): Rgba {
    const used = new Set(existing.map(c => rgbaToHex(c.color)));
    const free = CLUSTER_PALETTE.find(p => !used.has(rgbaToHex(p)));
    return [...(free ?? CLUSTER_PALETTE[existing.length % CLUSTER_PALETTE.length])] as Rgba;
}

/** The name to save from a rename field: trimmed and capped at
 *  CLUSTER_NAME_MAX; null when nothing is left (the old name stays). */
export function cleanClusterName(text: string): string | null {
    const name = text.trim().slice(0, CLUSTER_NAME_MAX).trim();
    return name === '' ? null : name;
}
