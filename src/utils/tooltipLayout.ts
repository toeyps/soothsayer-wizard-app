/**
 * Tooltip row layout for long sensor names (DESIGN_SYSTEM §4 rule 4, SPEC FINAL addition 2): the box is at most
 * 440 px, a row at most 418 px, the description gets the room first, the tag takes what is left, the value
 * never overlaps the name. A row that fits is unchanged.
 */
import { afterPrefix, commonPrefix, displayedName, type NamedSensor } from './sensorNames';
import { monoFontFamily, textWidth, uiFontFamily, type MeasureText } from './textMeasure';

export const TOOLTIP_BOX_MAX_PX = 440;
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

export interface TooltipRowInput extends NamedSensor {
    /** The tag only re-spells the description (rule 3b). */
    tagHidden?: boolean;
    valueText?: string;
    /** A prefix printed once above the rows: the row prints the rest. */
    prefix?: string;
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

/** The layout of one tooltip row. Fonts as rendered: a tag printed as the name is mono. */
export function layoutTooltipRow(row: TooltipRowInput, options: TooltipMeasureOptions = {}): TooltipRowLayout {
    const measure = options.measure ?? textWidth;
    const ui = options.uiFamily ?? uiFontFamily();
    const mono = options.monoFamily ?? monoFontFamily();
    const raw = displayedName(row);
    const name = row.prefix ? afterPrefix(raw, row.prefix) : raw;
    const nameW = measure(name, `500 11.5px ${row.description ? ui : mono}`) * NAME_SAFETY;
    const hasTag = !!row.description && !row.tagHidden;
    const tagW = hasTag ? measure(row.tag, `10px ${mono}`) : 0;
    const valueW = row.valueText ? measure(row.valueText, `600 11.5px ${mono}`) : UNKNOWN_VALUE_PX;
    const room = TOOLTIP_ROW_MAX_PX - SWATCH_PX - TOOLTIP_VALUE_GAP_PX - valueW;
    const onePx = SWATCH_PX + nameW + (hasTag ? TAG_GAP_PX + tagW : 0) + TOOLTIP_VALUE_GAP_PX + valueW;
    const left = hasTag ? Math.max(0, room - nameW - TAG_GAP_PX) : 0;
    const tagShown = hasTag && left >= Math.min(TAG_MIN_PX, tagW);
    return {
        name,
        onePx,
        wraps: onePx > TOOLTIP_ROW_MAX_PX,
        nameRoomPx: Math.max(0, Math.min(nameW, room)),
        tagRoomPx: tagShown ? Math.min(left, tagW) : 0,
        tagShown,
    };
}

/** Rule 2 in a tooltip: the start the rows share, printed once, only when a row would pass the limit. */
export function tooltipSharedPrefix(rows: readonly TooltipRowInput[], options: TooltipMeasureOptions = {}): string {
    const cand = commonPrefix(rows.map(displayedName));
    return cand && rows.some(r => layoutTooltipRow({ ...r, prefix: undefined }, options).wraps) ? cand : '';
}
