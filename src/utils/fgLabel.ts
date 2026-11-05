/* Failure Group label 'FG-2 · Bearing wear'; the name is left out when empty or only repeats the number. Group 0 is 'Not in Group'. */
export function fgLabel(no: number, name: string | null | undefined): string {
    if (no === 0) return 'Not in Group';
    const id = `FG-${no}`;
    const n = (name ?? '').trim();
    return n === '' || n.toLowerCase() === id.toLowerCase() ? id : `${id} · ${n}`;
}
