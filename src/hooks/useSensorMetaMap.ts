import { useMemo } from 'react';
import { SensorMetadata } from '../types';

/** Normalizes a tag for lookups: trimmed, case-insensitive. */
export function normalizeSensorTag(tag: string): string {
    return tag.trim().toLowerCase();
}

/** O(1) metadata map built once per array instead of `find()` per render; the single home of the tag-normalization rule. */
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
