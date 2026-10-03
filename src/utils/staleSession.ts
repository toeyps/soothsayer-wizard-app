import type { Invoker } from './specialSensorRecompute';

/**
 * Binding a caller to the dataset it was handed (2026-10-03).
 *
 * There is ONE Rust session, shared by every window. `load_csv` replaces it and
 * stamps it with a strictly increasing `generation`. A window that was opened
 * for workspace A and outlived it (its close was lost or late, or two loads
 * overlapped) used to run `evaluate_formula` / `calculate_new_sensor` /
 * `remove_sensor_columns` against whatever session was current -- workspace
 * B's. Those three commands now take an optional `expectedGeneration`
 * (camelCase JS key -- they keep Tauri's default casing); when it is not the
 * session's generation they mutate NOTHING and fail with a message starting
 * `STALE_SESSION`.
 *
 * Everything here is the frontend half: stamp the generation on those calls,
 * and turn that refusal into a typed error so callers can stop (no retry, and
 * above all no rollback/cleanup commands -- the data is not ours any more).
 */

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

/** A queued task noticed (after an await) that its window was re-pointed,
 *  closed or invalidated, and stopped without touching anything else. */
export class TaskAbortedError extends Error {
    constructor() {
        super('Cancelled: the project this change belonged to is no longer open.');
        this.name = 'TaskAbortedError';
    }
}

/** True for a rejection whose text starts with `STALE_SESSION` (Tauri rejects
 *  with the command's `Err(String)` itself, not an `Error`). */
export function isStaleSessionText(err: unknown): boolean {
    const text = err instanceof Error ? err.message : String(err ?? '');
    return text.startsWith(STALE_SESSION_PREFIX);
}

/** Either kind of "this work is no longer ours": stop, do not roll back. */
export function isSessionLostError(err: unknown): boolean {
    return err instanceof StaleSessionError || err instanceof TaskAbortedError;
}

/** The commands that take `expectedGeneration`. */
const GENERATION_GUARDED = new Set(['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns']);

/**
 * Wrap `invoker` so every guarded command carries `expectedGeneration`, and a
 * `STALE_SESSION` rejection becomes a `StaleSessionError`. With no generation
 * (a caller that was never told one) the arguments are left exactly as given.
 */
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
