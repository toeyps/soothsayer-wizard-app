import { useMemo } from 'react';
import { SensorMetadata } from '../types';

/** Normalizes a sensor tag the same way every lookup site needs to —
 *  trimmed, case-insensitive — so the map key and every query agree. */
export function normalizeSensorTag(tag: string): string {
    return tag.trim().toLowerCase();
}

/**
 * O(1)-lookup sensor-metadata map, built once per `sensorMetadata` array
 * instead of the `Array.find()` scan every panel (Sensor list, Filter
 * dropdown, Selected Sensor tab) used to repeat on every render/keystroke.
 * Also the single place the tag-normalization rule lives, so the three
 * panels can no longer drift apart on how a tag is matched.
 */
export function useSensorMetaMap(sensorMetadata: SensorMetadata[] | null | undefined): Map<string, SensorMetadata> {
    return useMemo(() => {
        const map = new Map<string, SensorMetadata>();
        if (!sensorMetadata) return map;
        for (const m of sensorMetadata) {
            map.set(normalizeSensorTag(m.tag), m);
        }
        return map;
    }, [sensorMetadata]);
}
