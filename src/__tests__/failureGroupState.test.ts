import { describe, it, expect } from 'vitest';
import { withFailureGroupState } from '../utils/failureGroupState';

describe('withFailureGroupState', () => {
    it('applies the patch and keeps every field it was not given (the reason it exists: writers that listed fields by hand dropped the ones they did not know about)', () => {
                const prev: any = {
            id: 'ws1', name: 'A',
            failureGroupState: {
                groups: [{ no: 1, name: 'G' }], models: [{ id: 'm1' }],
                runningConditionTimeStart: '2026-01-01T00:00', someFutureField: 'keep-me',
            },
        };
        const next: any = withFailureGroupState(prev, { runningConditionCombine: 'or' });
        expect(next.failureGroupState.runningConditionCombine).toBe('or');
        expect(next.failureGroupState.runningConditionTimeStart).toBe('2026-01-01T00:00');
        expect(next.failureGroupState.someFutureField).toBe('keep-me');
        expect(next.failureGroupState.groups).toEqual([{ no: 1, name: 'G' }]);
        expect(next.name).toBe('A');
    });

    it('creates a valid slice when the workspace has none yet', () => {
                const next: any = withFailureGroupState({ id: 'ws1' } as any, { runningConditionTimeStart: 'x' });
        expect(next.failureGroupState).toEqual({ groups: [], models: [], runningConditionTimeStart: 'x' });
    });

    it('a patched field wins over the existing value', () => {
                const next: any = withFailureGroupState(
            { id: 'ws1', failureGroupState: { groups: [], models: [], runningConditionTimeStart: 'old' } } as any,
            { runningConditionTimeStart: 'new' },
        );
        expect(next.failureGroupState.runningConditionTimeStart).toBe('new');
    });
});
