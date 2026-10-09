/**
 * The colour a Failure Group is drawn in, derived from its number alone — the
 * same rule `Dashboard.tsx` and `BuildModelWindow.tsx` each carry a private
 * copy of (`FG_GROUP_PALETTE` / `getFgGroupColor`). FG-1 amber, FG-2 violet,
 * FG-3 green, FG-4 blue, then the cycle repeats; group 0 ("Not in Group") is
 * slate. The names are the suffixes of the `.fg-group-color-*` classes in
 * `App.css`, which set `--fg-dot` / `--fg-tint` — so a component paints a
 * swatch with `className={`fg-group-color-${getFgGroupColor(no)}`}` and
 * `background: var(--fg-dot)` instead of hard-coding colours.
 *
 * Pure and Tauri-free, so the Import page's recent-project chip (which has no
 * Dashboard module to borrow from) draws the same colours the Dashboard does.
 */
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
