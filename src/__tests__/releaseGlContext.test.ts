import { describe, it, expect, vi } from 'vitest';
import { destroyReleasingContext } from '../components/charts/releaseGlContext';

describe('destroyReleasingContext', () => {
    it('destroys the instance, then releases its context', () => {
        const order: string[] = [];
        const canvas = {
            getContext: () => ({ getExtension: () => ({ loseContext: () => order.push('lose') }) }),
        } as unknown as HTMLCanvasElement;
        destroyReleasingContext({ get: () => ({ canvas }), destroy: () => order.push('destroy') });
        expect(order).toEqual(['destroy', 'lose']);
    });

    it('still destroys when the instance exposes no canvas', () => {
        const destroy = vi.fn();
        destroyReleasingContext({ destroy });
        expect(destroy).toHaveBeenCalledTimes(1);
    });
});
