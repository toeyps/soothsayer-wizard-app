import { expect } from 'vitest';
import { act, fireEvent, screen, waitFor, type BoundFunctions, type queries } from '@testing-library/react';

/** Drives the Health score page from integration tests; a model is completed only there. `q` is the query scope (screen or within(container)). The test's mocked invoke must answer compute_health_preview with makeSetPointAwarePreview. */

type Q = BoundFunctions<typeof queries>;

/** Values the `makeSetPointAwarePreview` fixture accepts (Individual 3SD band is 2..8). */
const VALID_INPUTS: Record<string, Record<string, string>> = {
    individual: { 'sp-lower': '1', 'sp-upper': '9' },
    relationship: {
        'sp-residual_at_80_lower': '-2', 'sp-residual_at_80_upper': '2',
        'sp-residual_at_0_lower': '-3', 'sp-residual_at_0_upper': '3',
    },
    clustering: { 'sp-outer_sd': '5' },
};

/** Page tab 2 'Health score': aria-disabled (still focusable, reason shown) until the model is trained, fresh and passes the gate. */
export const healthPageTab = (q: Q = screen) => q.getByTestId('page-tab-health') as HTMLButtonElement;

/** True while the Health score page can't be opened; tab 2 is the only door (asserts there is no 'Next: Health score' button). */
export const healthPageClosed = (q: Q = screen): boolean => {
    const closed = healthPageTab(q).getAttribute('aria-disabled') === 'true';
    expect(q.queryByTestId('next-health-score'), 'no "Next: Health score" button in any state').toBeNull();
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

/** Open the Health score page, enter valid set points, press "Mark complete" and wait until it is Complete (it writes no files). */
export async function markCompleteFromHealthPage(kind: 'individual' | 'relationship' | 'clustering', q: Q = screen) {
    await openHealthPage(q);
    await fillValidSetPoints(kind, q);
    await waitFor(() => expect((q.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(q.getByTestId('mark-complete')); });
    await waitFor(() => expect(q.getByTestId('mark-incomplete')).toBeTruthy());
    await settle();
}

/** Open the Health score page of a Complete model and press "Mark incomplete". */
export async function markIncompleteFromHealthPage(q: Q = screen) {
    if (!q.queryByTestId('mark-incomplete')) await openHealthPage(q);
    await act(async () => { fireEvent.click(q.getByTestId('mark-incomplete')); });
    await settle();
}
