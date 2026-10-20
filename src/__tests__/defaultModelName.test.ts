import { describe, it, expect } from 'vitest';
import { defaultModelName } from '../components/dashboard/defaultModelName';

const named = (...names: string[]) => names.map(name => ({ name }));

describe('defaultModelName (a new model never starts as a name twin)', () => {
    it('keeps the plain name when no model in the project uses it', () => {
        expect(defaultModelName(named('Other'), 'Pump Pressure', 'individual')).toBe('Pump Pressure');
        expect(defaultModelName([], '  Pump Pressure ', 'relationship')).toBe('Pump Pressure');
    });

    it('adds the kind word when the plain name is taken (case-insensitive)', () => {
        expect(defaultModelName(named('pump pressure'), 'Pump Pressure', 'relationship')).toBe('Pump Pressure (Relation model)');
        expect(defaultModelName(named('Pump Pressure'), 'Pump Pressure', 'clustering')).toBe('Pump Pressure (Clustering)');
        expect(defaultModelName(named('Pump Pressure'), 'Pump Pressure', 'individual')).toBe('Pump Pressure (Individual)');
    });

    it('counts on past names already used, including the older "(Relationship)" spelling', () => {
        expect(defaultModelName(named('Pump Pressure', 'Pump Pressure (Relation model)'), 'Pump Pressure', 'relationship')).toBe('Pump Pressure (Relation model) 2');
        expect(defaultModelName(named('Pump Pressure', 'Pump Pressure (Relationship)'), 'Pump Pressure', 'relationship')).toBe('Pump Pressure (Relation model) 2');
    });

    it('never names the algorithm', () => {
        expect(defaultModelName(named('X'), 'X', 'relationship')).not.toMatch(/gam/i);
    });
});
