import { expect } from 'vitest';
import { act, fireEvent, screen, waitFor, type BoundFunctions, type queries } from '@testing-library/react';

/**
 * Drives the Build Model Workbench's Health score page from an integration
 * test: since 3b-2 a model is completed ONLY there
 * ("Mark complete" no longer exists on the Model fit page), so every test that
 * used to click the old footer button goes through these.
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

/** Page tab ② "Health score" — the door to the page. It is CLOSED (aria-disabled, still
 *  focusable, its reason in place of the caption) until the model is trained and fresh
 *  (and the gate passes), exactly when the old footer "Mark complete" could be enabled. */
export const healthPageTab = (q: Q = screen) => q.getByTestId('page-tab-health') as HTMLButtonElement;

/** True while the Health score page cannot be opened. "Next: Health score →" is then
 *  never a pressable button either (it is rendered only when it is the next step or can
 *  be pressed — Workbench detail v2 §1). */
export const healthPageClosed = (q: Q = screen): boolean => {
    const closed = healthPageTab(q).getAttribute('aria-disabled') === 'true';
    const next = q.queryByTestId('next-health-score') as HTMLButtonElement | null;
    if (closed) expect(next === null || next.disabled, 'no pressable "Next: Health score" while page tab ② is closed').toBe(true);
    return closed;
};

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

/** Opens the Health score page and waits for its first answer. */
export async function openHealthPage(q: Q = screen) {
    expect(healthPageClosed(q), `the Health score page is closed: ${healthPageTab(q).title}`).toBe(false);
    fireEvent.click(healthPageTab(q));
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
