import { fireEvent } from '@testing-library/react';

/**
 * Drives the REAL shared sensor picker (`src/components/sensor/SensorPicker.tsx`, customer item 3,
 * 2026-10-09) from tests: single = trigger + anchored popover, multi = "Add…" + modal + OK.
 * Rows render through `Portal` (`#wizard-portal-root`), so lookups go through `document`.
 */

/** The tag a picker row / label shows: `.sl-tag`, or the description slot when there is no description. */
export function rowTag(row: Element): string | null {
    const tag = row.querySelector('.sl-tag');
    if (tag) return tag.textContent;
    return row.querySelector('.sl-desc')?.textContent ?? null;
}

/** The open picker surface (single popover or multi modal) — the most recently opened one. */
export function openPickerSurface(): HTMLElement {
    const all = [...document.querySelectorAll<HTMLElement>('.pk-pop, .pk-modal')];
    const el = all[all.length - 1];
    if (!el) throw new Error('no sensor picker is open');
    return el;
}

/** The search box of the open picker. */
export function pickerSearch(): HTMLInputElement {
    return openPickerSurface().querySelector('input[role="combobox"]') as HTMLInputElement;
}

/** Every option row currently rendered in the open picker (groups excluded). */
export function pickerRows(): HTMLElement[] {
    return [...openPickerSurface().querySelectorAll<HTMLElement>('[role="option"]')];
}

/** The option row for `tag`; searches for it first so a collapsed group is opened. */
export function findPickerRow(tag: string): HTMLElement {
    fireEvent.change(pickerSearch(), { target: { value: tag } });
    const row = pickerRows().find(r => rowTag(r) === tag);
    if (!row) throw new Error(`no picker row for ${tag}; rows: ${pickerRows().map(rowTag).join(', ')}`);
    return row;
}

/** Single picker: open it from its trigger and pick `tag` ('' = the "None" row). */
export function pickSingle(trigger: HTMLElement, tag: string): void {
    fireEvent.click(trigger);
    if (tag === '') {
        const none = pickerRows().find(r => r.classList.contains('pk-item--none'));
        if (!none) throw new Error('the picker has no "None" row');
        fireEvent.click(none);
        return;
    }
    fireEvent.click(findPickerRow(tag));
}

/** Multi picker: open it from its "Add…" button, tick each tag, press OK. */
export function pickMulti(addButton: HTMLElement, tags: string[]): void {
    fireEvent.click(addButton);
    for (const t of tags) fireEvent.click(findPickerRow(t));
    const ok = [...openPickerSurface().querySelectorAll<HTMLButtonElement>('.pk-foot button')].find(b => /OK/.test(b.textContent ?? ''));
    if (!ok) throw new Error('no OK button');
    fireEvent.click(ok);
}
