import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SensorMetadata } from '../types';
import { useSensorMetaMap, normalizeSensorTag } from '../hooks/useSensorMetaMap';

const meta = (tag: string): SensorMetadata => ({
    tag, description: `desc-${tag}`, unit: 'C', component: 'Pump',
});

describe('normalizeSensorTag', () => {
    it('trims whitespace and lowercases', () => {
        expect(normalizeSensorTag('  Tag.A  ')).toBe('tag.a');
    });
});

describe('useSensorMetaMap', () => {
    it('returns an empty map for null/undefined input', () => {
        const { result: r1 } = renderHook(() => useSensorMetaMap(null));
        expect(r1.current.size).toBe(0);

        const { result: r2 } = renderHook(() => useSensorMetaMap(undefined));
        expect(r2.current.size).toBe(0);
    });

    it('keys entries by normalized tag', () => {
        const { result } = renderHook(() => useSensorMetaMap([meta('Tag.A'), meta('tag b')]));
        expect(result.current.get('tag.a')?.description).toBe('desc-Tag.A');
        expect(result.current.get('tag b')?.description).toBe('desc-tag b');
        expect(result.current.get('TAG.A')).toBeUndefined(); // map key itself isn't normalized on read
    });

    it('later entries win when two tags normalize to the same key', () => {
        const { result } = renderHook(() =>
            useSensorMetaMap([meta('Tag'), { ...meta('TAG'), description: 'second' }]),
        );
        expect(result.current.get('tag')?.description).toBe('second');
    });

    it('rebuilds the map when the sensorMetadata array reference changes', () => {
        const { result, rerender } = renderHook(
            ({ list }) => useSensorMetaMap(list),
            { initialProps: { list: [meta('A')] } },
        );
        expect(result.current.has('a')).toBe(true);
        expect(result.current.has('b')).toBe(false);

        rerender({ list: [meta('B')] });
        expect(result.current.has('a')).toBe(false);
        expect(result.current.has('b')).toBe(true);
    });
});
