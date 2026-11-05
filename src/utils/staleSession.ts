import type { Invoker } from './specialSensorRecompute';

/** Binds a caller to its dataset: `load_csv` bumps the shared Rust session `generation`. Guarded commands take `expectedGeneration` (camelCase), mutate nothing on mismatch and fail with `STALE_SESSION`; here that becomes a typed error so callers stop (no retry, no rollback). */

/** Rust's `STALE_SESSION_ERROR` starts with this; match on the prefix only. */
export const STALE_SESSION_PREFIX = 'STALE_SESSION';

/** What the Add Special Sensor window tells the user. */
export const STALE_SESSION_MESSAGE =
    'This project was closed or reloaded — reopen Add Special Sensor from the Dashboard.';

/** Rust refused a command because the dataset changed since the caller was bound. */
export class StaleSessionError extends Error {
    constructor(message = STALE_SESSION_MESSAGE) {
        super(message);
        this.name = 'StaleSessionError';
    }
}

/** A queued task noticed after an await that its window was re-pointed, closed or invalidated, and stopped without touching anything. */
export class TaskAbortedError extends Error {
    constructor() {
        super('Cancelled: the project this change belonged to is no longer open.');
        this.name = 'TaskAbortedError';
    }
}

/** True when the rejection text starts with `STALE_SESSION` (Tauri rejects with the command's `Err(String)`, not an `Error`). */
export function isStaleSessionText(err: unknown): boolean {
    const text = err instanceof Error ? err.message : String(err ?? '');
    return text.startsWith(STALE_SESSION_PREFIX);
}

/** Either kind of "this work is no longer ours": stop, do not roll back. */
export function isSessionLostError(err: unknown): boolean {
    return err instanceof StaleSessionError || err instanceof TaskAbortedError;
}

/** Commands that take `expectedGeneration`, including the read-only validate/preview ones, so a stale window can't answer from another project's columns. */
const GENERATION_GUARDED = new Set([
    'evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns', 'validate_formula', 'preview_formula',
]);

/** Wraps `invoker` so guarded commands carry `expectedGeneration` and a `STALE_SESSION` rejection becomes `StaleSessionError`; with no generation, args are left as given. */
export function bindToGeneration(invoker: Invoker, generation: number | undefined): Invoker {
    return async (cmd, args) => {
        const guarded = generation !== undefined && GENERATION_GUARDED.has(cmd);
        try {
            return await invoker(cmd, guarded ? { ...args, expectedGeneration: generation } : args);
        } catch (err) {
            if (isStaleSessionText(err)) throw new StaleSessionError();
            throw err;
        }
    };
}
