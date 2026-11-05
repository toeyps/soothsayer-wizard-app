/** Failure Group delete confirmation: models used only by this group are deleted, the rest stay in their other groups. */
export function groupDeleteText(name: string, deleted: number, kept: number): string {
    const n = (k: number) => `${k} model${k === 1 ? '' : 's'}`;
    const parts: string[] = [];
    if (deleted > 0) parts.push(`${n(deleted)} used only by this group ${deleted === 1 ? 'is' : 'are'} deleted`);
    if (kept > 0) parts.push(`${n(kept)} ${kept === 1 ? 'stays' : 'stay'} in ${kept === 1 ? 'its' : 'their'} other groups`);
    return `Delete ${name}? ${parts.length ? `${parts.join(' · ')}.` : 'It has no models.'}`;
}
