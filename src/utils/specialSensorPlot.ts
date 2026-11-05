import type { SensorMetadata, SensorOperationConfig, SpecialSensorRecipe } from '../types';

/** What the Add Special Sensor window sends the Dashboard in `add-sensor-selection`. `sensors` is a DELTA: tags to ADD to what the Dashboard plots now (the window's own copy is learned once, at open). */
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

/** Merge `toAdd` into the plotted selection: case-insensitive dedupe, `current`'s order kept, `toAdd` appended. Past `cap` (Pair Plot's `MAX_PAIR_PLOT_SENSORS`) the rest go to `blocked` instead of being dropped silently. */
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
