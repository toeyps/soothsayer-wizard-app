/*
 * The label of a Failure Group in lists and chips: "FG-2 · Bearing wear". A new
 * group is named "FG-<no>" by default, so writing "FG-<no> · <name>" showed
 * "FG-1 · FG-1" — the name is left out when it is empty or only repeats the
 * number. Group 0 is "Not in Group".
 */
export function fgLabel(no: number, name: string | null | undefined): string {
    if (no === 0) return 'Not in Group';
    const id = `FG-${no}`;
    const n = (name ?? '').trim();
    return n === '' || n.toLowerCase() === id.toLowerCase() ? id : `${id} · ${n}`;
}
