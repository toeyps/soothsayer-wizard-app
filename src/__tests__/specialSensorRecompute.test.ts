import { describe, it, expect, vi } from 'vitest';
import type { SpecialSensorRecipe } from '../types';
import { recomputeCall, recomputeSpecialSensors } from '../utils/specialSensorRecompute';

const formula: SpecialSensorRecipe = { kind: 'formula', tag: 'CALC1', formula: '$TAG1 * 2' };
const operation: SpecialSensorRecipe = {
    kind: 'operation',
    tag: 'CALC2',
    sourceSensors: ['TAG1', 'TAG2'],
    operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'something else' },
};

describe('recomputeCall', () => {
    it('rebuilds a formula in place', () => {
        expect(recomputeCall(formula)).toEqual({
            cmd: 'evaluate_formula',
            args: { formula: '$TAG1 * 2', customName: 'CALC1', replace: true },
        });
    });

    it('rebuilds an operation in place', () => {
        const { cmd, args } = recomputeCall(operation);
        expect(cmd).toBe('calculate_new_sensor');
        expect(args.sensors).toEqual(['TAG1', 'TAG2']);
        expect(args.replace).toBe(true);
    });

    it('forces the recipe tag back as the name, so a recompute can never rename the column', () => {
        // Everything pointing at this sensor — other formulas, model fields,
        // the chart's colour and axis entries — is keyed by the name.
        const { args } = recomputeCall(operation);
        expect((args.config as { customName: string }).customName).toBe('CALC2');
    });

    it('always asks for replacement — appending would leave the new values unreachable', () => {
        expect(recomputeCall(formula).args.replace).toBe(true);
        expect(recomputeCall(operation).args.replace).toBe(true);
    });
});

describe('recomputeSpecialSensors', () => {
    it('runs recipes one at a time, in the order given', async () => {
        const seen: string[] = [];
        const invoker = vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
            seen.push(String(args.customName ?? (args.config as { customName: string }).customName));
            return undefined;
        });
        await recomputeSpecialSensors([formula, operation], invoker);
        expect(seen).toEqual(['CALC1', 'CALC2']);
    });

    it('waits for each one before starting the next, since a later recipe may read an earlier one', async () => {
        let inFlight = 0;
        let overlapped = false;
        const invoker = async () => {
            inFlight++;
            if (inFlight > 1) overlapped = true;
            await Promise.resolve();
            inFlight--;
        };
        await recomputeSpecialSensors([formula, operation], invoker);
        expect(overlapped).toBe(false);
    });

    it('stops at the first failure and names the recipe that failed', async () => {
        const invoker = vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
            if (args.customName === 'CALC1') throw 'Sensor not found: TAG1';
            return undefined;
        });
        await expect(recomputeSpecialSensors([formula, operation], invoker))
            .rejects.toThrow(/Could not recompute "CALC1".*Sensor not found/);
        expect(invoker).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an empty list', async () => {
        const invoker = vi.fn();
        await recomputeSpecialSensors([], invoker);
        expect(invoker).not.toHaveBeenCalled();
    });
});
