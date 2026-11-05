import { fireEvent, within } from '@testing-library/react';

/** Open the Dashboard's Sensor tab (it lands on Failure Groups by default); no-op if already showing or not mounted. */
export function showSensorTab(root: HTMLElement = document.body): void {
    const tab = within(root).queryByRole('button', { name: /^Sensor \(\d+\)$/ });
    if (tab) fireEvent.click(tab);
}
