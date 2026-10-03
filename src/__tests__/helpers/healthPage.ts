import { expect } from 'vitest';
import { act, fireEvent, screen, waitFor, type BoundFunctions, type queries } from '@testing-library/react';

/**
 * Drives the Build Model Workbench's Health score page from an integration
 * test (health score phase 3b-2): since 3b-2 a model is completed ONLY there
 * ("Mark complete" no longer exists on the Model fit page), so every test that
 * used to click the footer button goes through these.
 *
 * `q` is the query scope (the default `screen`, or a `within(container)` when two
 * windows are mounted side by side).
 *
 * The mocked `invoke` of the test must answer `compute_health_preview` with
 * `makeSetPointAwarePreview` and `export_model_files` with a successful result
 * (see `EXPORT_RESULT_OK` below) for the flow to complete.
 */

type Q = BoundFunctions<typeof queries>;

/** A successful `export_model_files` answer. */
export const EXPORT_RESULT_OK = {
    ok: true,
    files: [{ kind: 'info', file_name: 'INDV_INFO_TAG1.json', path: 'C:/data/workspaces/ws1/output/TAG1/INDV_INFO_TAG1.json' }],
    output_dir: 'C:/data/workspaces/ws1/output',
    validation: [],
    warnings: [],
};

/** Values the `makeSetPointAwarePreview` fixture accepts (Individual 3SD band is 2..8). */
const VALID_INPUTS: Record<string, Record<string, string>> = {
    individual: { 'sp-lower': '1', 'sp-upper': '9' },
    relationship: {
        'sp-residual_at_80_lower': '-2', 'sp-residual_at_80_upper': '2',
        'sp-residual_at_0_lower': '-3', 'sp-residual_at_0_upper': '3',
    },
    clustering: { 'sp-outer_sd': '5' },
};

/** The "2 Health score" page switch - disabled until the model is trained and fresh
 *  (and the gate passes), exactly when the old footer "Mark complete" could be enabled. */
export const healthPageButton = (q: Q = screen) => q.getByTestId('page-health') as HTMLButtonElement;

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

/** Opens the Health score page and waits for its first answer. */
export async function openHealthPage(q: Q = screen) {
    fireEvent.click(healthPageButton(q));
    await waitFor(() => expect(q.getByTestId('set-points-card')).toBeTruthy());
}

/** Types valid set points of `kind` and commits them (blur). */
export async function fillValidSetPoints(kind: 'individual' | 'relationship' | 'clustering', q: Q = screen) {
    for (const [id, value] of Object.entries(VALID_INPUTS[kind])) {
        const input = q.getByTestId(id);
        fireEvent.change(input, { target: { value } });
        fireEvent.blur(input);
    }
    await settle();
}

/** Open the Health score page, enter valid set points, press "Mark complete" and wait until saved. */
export async function markCompleteFromHealthPage(kind: 'individual' | 'relationship' | 'clustering', q: Q = screen) {
    await openHealthPage(q);
    await fillValidSetPoints(kind, q);
    await waitFor(() => expect((q.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(q.getByTestId('mark-complete')); });
    await waitFor(() => expect(q.getByTestId('save-ok')).toBeTruthy());
    await settle();
}

/** Open the Health score page of a Complete model and press "Mark incomplete". */
export async function markIncompleteFromHealthPage(q: Q = screen) {
    if (!q.queryByTestId('mark-incomplete')) await openHealthPage(q);
    await act(async () => { fireEvent.click(q.getByTestId('mark-incomplete')); });
    await settle();
}
