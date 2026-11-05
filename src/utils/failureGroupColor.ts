/** Colour of a Failure Group from its number alone: FG-1 amber, FG-2 violet, FG-3 green, FG-4 blue, then repeating; group 0 ('Not in Group') slate. Names are suffixes of the `.fg-group-color-*` classes in `App.css`, which set `--fg-dot` / `--fg-tint`. Pure and Tauri-free. */
export const FG_GROUP_PALETTE = ['amber', 'violet', 'green', 'blue'] as const;

export type FgGroupColor = (typeof FG_GROUP_PALETTE)[number] | 'slate';

export function getFgGroupColor(no: number): FgGroupColor {
    if (!Number.isFinite(no) || no === 0) return 'slate';
    const n = FG_GROUP_PALETTE.length;
    // Positive modulo: a malformed negative number still lands on a palette
    // entry rather than `undefined`.
    const i = (((Math.trunc(no) - 1) % n) + n) % n;
    return FG_GROUP_PALETTE[i];
}
