import type { WorkspaceState, FailureGroupStateSlice } from '../types';

/**
 * The ONLY way a writer should change `failureGroupState`. Spreads whatever is
 * already there and applies `patch` on top, so a field the writer doesn't know
 * about (the workspace time range, and every field added after this writer was
 * written) is carried through instead of erased. Every writer used to rebuild
 * the slice from an explicit field list, and each new field was silently
 * dropped by the ones not updated (2026-09-23: the workspace time range
 * vanished ~250ms after any Dashboard edit). Don't write a
 * `failureGroupState: { groups, models, … }` literal — call this.
 *
 * Lives in `utils/` (pure, no Tauri imports) rather than `workspaceManager.ts`
 * so tests that mock that module don't have to re-provide it.
 */
export function withFailureGroupState(
    prev: WorkspaceState,
    patch: Partial<FailureGroupStateSlice>,
): WorkspaceState {
    const current = prev.failureGroupState;
    return {
        ...prev,
        failureGroupState: {
            groups: current?.groups ?? [],
            models: current?.models ?? [],
            ...current,
            ...patch,
        },
    };
}
