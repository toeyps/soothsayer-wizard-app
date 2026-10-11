import { fireEvent, within } from '@testing-library/react';

/**
 * The Dashboard LANDS on its Failure Groups
 * tab right after Import step 3 and whenever the project has no failure group
 * yet. Tests written for the Sensor tab open it the way the user does — one
 * click on "Sensor (N)". A no-op when that tab is already showing or the
 * Dashboard is not mounted under `root`.
 */
export function showSensorTab(root: HTMLElement = document.body): void {
    const tab = within(root).queryByRole('button', { name: /^Sensor \(\d+\)$/ });
    if (tab) fireEvent.click(tab);
}
