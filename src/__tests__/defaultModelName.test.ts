import { describe, it, expect } from 'vitest';
import { defaultModelName } from '../components/dashboard/defaultModelName';

const named = (...names: string[]) => names.map(name => ({ name }));

describe('defaultModelName (a new model never starts as a name twin)', () => {
    it('always adds the kind word, the Individual model included, even when the plain name is free', () => {
        expect(defaultModelName(named('Other'), 'Pump Pressure', 'individual')).toBe('Pump Pressure (Individual)');
        expect(defaultModelName([], '  Pump Pressure ', 'relationship')).toBe('Pump Pressure (Relation model)');
        expect(defaultModelName([], 'Pump Pressure', 'clustering')).toBe('Pump Pressure (Clustering)');
        expect(defaultModelName([], '   ', 'individual')).toBe('');
    });

    it('counts on when the kind name is already used (case-insensitive), including the older "(Relationship)" spelling', () => {
        expect(defaultModelName(named('pump pressure (individual)'), 'Pump Pressure', 'individual')).toBe('Pump Pressure (Individual) 2');
        expect(defaultModelName(named('Pump Pressure', 'Pump Pressure (Relation model)'), 'Pump Pressure', 'relationship')).toBe('Pump Pressure (Relation model) 2');
        expect(defaultModelName(named('Pump Pressure', 'Pump Pressure (Relationship)'), 'Pump Pressure', 'relationship')).toBe('Pump Pressure (Relation model) 2');
    });

    it('never names the algorithm', () => {
        expect(defaultModelName(named('X'), 'X', 'relationship')).not.toMatch(/gam/i);
    });
});
