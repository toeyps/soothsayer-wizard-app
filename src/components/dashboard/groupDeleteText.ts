/**
 * The confirmation sentence of a Failure Group delete (Failure Groups tab and the
 * assign sheet): "Delete FG-1? 2 models used only by this group are deleted · 1
 * model stays in its other groups." Deleting a model removes no files any more —
 * the files are written by Export results — so nothing here says "saved files".
 * The counts come from `groupDeleteCounts` (`utils/modelOutputFiles.ts`).
 */
export function groupDeleteText(name: string, deleted: number, kept: number): string {
    const n = (k: number) => `${k} model${k === 1 ? '' : 's'}`;
    const parts: string[] = [];
    if (deleted > 0) parts.push(`${n(deleted)} used only by this group ${deleted === 1 ? 'is' : 'are'} deleted`);
    if (kept > 0) parts.push(`${n(kept)} ${kept === 1 ? 'stays' : 'stay'} in ${kept === 1 ? 'its' : 'their'} other groups`);
    return `Delete ${name}? ${parts.length ? `${parts.join(' · ')}.` : 'It has no models.'}`;
}
