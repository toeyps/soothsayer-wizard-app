/** Tooltip rows for long sensor names: box at most 440 px, row at most 418 px; the description gets room first, the tag the rest, the value never overlaps the name. A row that fits is unchanged. Whole name, at most two lines. */
import { displayedName, splitName, type NamedSensor } from './sensorNames';
import { monoFontFamily, textWidth, uiFontFamily, type MeasureText } from './textMeasure';

export const TOOLTIP_ROW_MAX_PX = 418;
export const TOOLTIP_VALUE_GAP_PX = 18;
const SWATCH_PX = 16;
const TAG_GAP_PX = 5;
/** Room reserved for a value not known yet (the shared-prefix decision runs before the values). */
const UNKNOWN_VALUE_PX = 84;
/** Under this much room a tag is dropped rather than clipped to nothing. */
const TAG_MIN_PX = 24;
/** Canvas reads the name slightly narrower than the DOM. */
const NAME_SAFETY = 1.03;
/** Two lines hold a little less than twice the room: a line breaks at a word. */
const TWO_LINES = 1.8;
/** The end kept from a name with no separator to cut at. */
const CUT_TAIL_CHARS = 24;

export interface TooltipRowInput extends NamedSensor {
    /** The tag only re-spells the description (rule 3b). */
    tagHidden?: boolean;
    valueText?: string;
    /** What tells this row from one with the same description (`tooltipDistinctEnds`): printed after the name, in
     *  place of the tag. */
    distinct?: string;
}

export interface TooltipMeasureOptions {
    measure?: MeasureText;
    uiFamily?: string;
    monoFamily?: string;
}

export interface TooltipRowLayout {
    /** The text the row prints as its name. */
    name: string;
    /** The whole row on one line. */
    onePx: number;
    /** It would pass the row limit on one line: the name may take a second line. */
    wraps: boolean;
    /** Room for one line of name (the description gets the room first). */
    nameRoomPx: number;
    /** What is left for the tag, 0 when it is not printed. */
    tagRoomPx: number;
    /** False when the tag has no line of its own to print (no description, rule 3b, or no room). */
    tagShown: boolean;
}

/** A name too long for two lines keeps its start and its end, cut in the middle at a word. */
function fitTwoLines(name: string, room: number, width: (text: string) => number): string {
    const budget = room * TWO_LINES;
    if (width(name) <= budget) return name;
    const sp = splitName(name);
    const tail = (sp.head ? sp.tail : name.slice(-CUT_TAIL_CHARS)).trim();
    const left = budget - width(` … ${tail}`);
    let head = '';
    for (const word of name.split(' ')) {
        const next = head ? `${head} ${word}` : word;
        if (width(next) > left) break;
        head = next;
    }
    if (!head) {
        const perChar = width(name) / name.length;
        head = name.slice(0, Math.max(1, Math.floor(left / perChar)));
    }
    return `${head} … ${tail}`;
}

/** The layout of one tooltip row. Fonts as rendered: a tag printed as the name is mono. */
export function layoutTooltipRow(row: TooltipRowInput, options: TooltipMeasureOptions = {}): TooltipRowLayout {
    const measure = options.measure ?? textWidth;
    const ui = options.uiFamily ?? uiFontFamily();
    const mono = options.monoFamily ?? monoFontFamily();
    const raw = displayedName(row);
    const full = row.distinct ? `${raw} · ${row.distinct}` : raw;
    const font = `500 11.5px ${row.description ? ui : mono}`;
    const width = (text: string) => measure(text, font) * NAME_SAFETY;
    const nameW = width(full);
    const hasTag = !!row.description && !row.tagHidden && !row.distinct;
    const tagW = hasTag ? measure(row.tag, `10px ${mono}`) : 0;
    const valueW = row.valueText ? measure(row.valueText, `600 11.5px ${mono}`) : UNKNOWN_VALUE_PX;
    const room = TOOLTIP_ROW_MAX_PX - SWATCH_PX - TOOLTIP_VALUE_GAP_PX - valueW;
    const onePx = SWATCH_PX + nameW + (hasTag ? TAG_GAP_PX + tagW : 0) + TOOLTIP_VALUE_GAP_PX + valueW;
    const left = hasTag ? Math.max(0, room - nameW - TAG_GAP_PX) : 0;
    const tagShown = hasTag && left >= Math.min(TAG_MIN_PX, tagW);
    const wraps = onePx > TOOLTIP_ROW_MAX_PX;
    return {
        name: wraps ? fitTwoLines(full, Math.max(1, room), width) : full,
        onePx,
        wraps,
        nameRoomPx: Math.max(0, Math.min(nameW, room)),
        tagRoomPx: tagShown ? Math.min(left, tagW) : 0,
        tagShown,
    };
}

/** The end of a tag once the text all the tags share is gone, back to the last word break. */
function endAfterShared(tag: string, tags: readonly string[]): string {
    let i = 0;
    while (i < tag.length && tags.every(t => t[i] === tag[i])) i++;
    while (i > 0 && !/[\s_.\-]/.test(tag[i - 1])) i--;
    return tag.slice(i).replace(/^[\s_.\-]+/, '');
}

/** Rows with the same description differ only by tag; when a tag has no room, the group gets its distinguishing tag ends. Decided from names alone so it doesn't flip as values change. */
export function tooltipDistinctEnds(rows: readonly TooltipRowInput[], options: TooltipMeasureOptions = {}): Map<string, string> {
    const ends = new Map<string, string>();
    const measure = options.measure ?? textWidth;
    const mono = options.monoFamily ?? monoFontFamily();
    const groups = new Map<string, TooltipRowInput[]>();
    for (const row of rows) {
        if (!row.description || row.tagHidden) continue;
        groups.set(row.description, [...(groups.get(row.description) ?? []), row]);
    }
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const allFit = group.every(row => {
            const layout = layoutTooltipRow(row, options);
            return layout.tagShown && layout.tagRoomPx >= measure(row.tag, `10px ${mono}`);
        });
        if (allFit) continue;
        const tags = group.map(row => row.tag);
        for (const tag of tags) {
            const end = endAfterShared(tag, tags);
            if (end) ends.set(tag, end);
        }
    }
    return ends;
}
