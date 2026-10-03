import type { SensorMetadata, SensorOperationConfig, SpecialSensorRecipe } from '../types';

/**
 * What the Add Special Sensor window tells the Dashboard through
 * `add-sensor-selection`.
 *
 * `sensors` is a DELTA, not a selection: the tags the Dashboard should ADD to
 * whatever it is plotting right now. It used to be the window's own whole copy
 * of the selection, which the Dashboard swapped in wholesale -- so the SOURCE
 * sensors got plotted along with the new one, and any change the user made to
 * the plot after the window opened was thrown away (the window only learns the
 * plotted list once, when it opens).
 *
 *   created sensor -> just its own tag (never the sensors it was built from)
 *   "add as-is"    -> the raw sensors that were picked (nothing new to create)
 */
export interface AddSensorSelectionPayload {
    workspaceId?: string;
    sensors: string[];
    operation: SensorOperationConfig | null;
    newMetadata?: SensorMetadata[];
    newRecipes?: SpecialSensorRecipe[];
}

export interface PlotMerge {
    /** The selection after merging. */
    next: string[];
    /** Tags that were actually appended. */
    added: string[];
    /** Tags that were not plotted because the chart's sensor cap was reached. */
    blocked: string[];
}

const key = (tag: string) => tag.trim().toLowerCase();

/**
 * Merge `toAdd` into the current plotted selection: case-insensitive dedupe
 * (against `current` and within `toAdd`), preserving `current`'s order, with
 * `toAdd` appended in the order given. `cap` is the chart type's maximum
 * number of sensors (Pair Plot's `MAX_PAIR_PLOT_SENSORS`); once reached, the
 * rest are reported in `blocked` instead of silently dropped.
 */
export function mergeIntoPlot(current: string[], toAdd: string[], cap?: number): PlotMerge {
    const next = [...current];
    const seen = new Set(current.map(key));
    const added: string[] = [];
    const blocked: string[] = [];
    for (const tag of toAdd) {
        const k = key(tag);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        if (cap !== undefined && next.length >= cap) {
            blocked.push(tag);
            continue;
        }
        next.push(tag);
        added.push(tag);
    }
    return { next, added, blocked };
}
