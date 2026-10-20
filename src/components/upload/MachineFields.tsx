import { type Ref } from 'react';
import type { MachineDetails } from '../../types';
import { TZ_OPTIONS, fmtOffset, pcOffsetMin } from '../../utils/projectDetails';

/*
 * The ONE set of machine fields — Step 1 ("Which machine is this?") and the
 * Project details dialog use this same component, so the labels, order and
 * placeholders are identical everywhere. UI only: the rules (required fields,
 * duplicate pair, derived name) live in `utils/projectDetails.ts`.
 */

/** "Enter the plant name, machine name and machine tag to continue". */
export function missingFieldsReason(missing: readonly string[], verb: 'continue' | 'save'): string | null {
    if (missing.length === 0) return null;
    const parts = missing.map(m => m.toLowerCase());
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `Enter the ${list} to ${verb}`;
}

/** The red line under a Plant · Machine pair another project already uses. */
export const DUPLICATE_PAIR_MESSAGE = 'Another project already uses this plant and machine — change one of them.';
/** The same, short — for a footer reason next to a disabled button. */
export const DUPLICATE_PAIR_REASON = 'Another project already uses this plant and machine';

export function MachineFields({ value, onChange, showMissing = false, autoFocus = false, duplicate = false, large = false }: {
    value: MachineDetails;
    onChange: (next: MachineDetails) => void;
    /** Mark the required fields that are still empty. */
    showMissing?: boolean;
    autoFocus?: boolean;
    /** The Plant · Machine pair already names another project (blocks Continue / Save). */
    duplicate?: boolean;
    /** Step 1: the two naming fields are big (they ARE the project's name). */
    large?: boolean;
}) {
    const set = (patch: Partial<MachineDetails>) => onChange({ ...value, ...patch });
    const req = (v: string) => (showMissing && !v.trim() ? ' mf-in--req' : '');
    const big = large ? ' mf-in--big' : '';
    const dup = duplicate ? ' mf-in--dup' : '';
    return (
        <div className="mf-grid" data-testid="machine-fields">
            <label className="mf-f">
                <span>Plant name <i className="mf-req">required</i></span>
                <input
                    className={`mf-in${big}${req(value.plant)}${dup}`}
                    autoFocus={autoFocus}
                    autoComplete="off"
                    maxLength={60}
                    value={value.plant}
                    placeholder="e.g. Bang Pakong"
                    aria-invalid={duplicate || undefined}
                    onChange={e => set({ plant: e.target.value })}
                />
            </label>
            <label className="mf-f">
                <span>Machine name <i className="mf-req">required</i></span>
                <input
                    className={`mf-in${big}${req(value.name)}${dup}`}
                    autoComplete="off"
                    maxLength={60}
                    value={value.name}
                    placeholder="e.g. Gas Engine Generator 4"
                    aria-invalid={duplicate || undefined}
                    onChange={e => set({ name: e.target.value })}
                />
            </label>
            {duplicate && (
                <div className="mf-f mf-f--full mf-dup" role="alert">{DUPLICATE_PAIR_MESSAGE}</div>
            )}
            <label className="mf-f">
                <span>Machine tag <i className="mf-req">required</i></span>
                <input
                    className={`mf-in mf-in--mono${req(value.tag)}`}
                    autoComplete="off"
                    maxLength={40}
                    value={value.tag}
                    placeholder="e.g. U-2010"
                    onChange={e => set({ tag: e.target.value })}
                />
            </label>
            <div className="mf-f mf-f--note">
                <span aria-hidden="true">&nbsp;</span>
                <div className="mf-cap">The tag or code of the machine at the plant, as in its records.</div>
            </div>
            <label className="mf-f mf-f--full">
                <span>Notes <i>optional</i></span>
                <textarea
                    className="mf-in mf-ta"
                    rows={3}
                    value={value.notes}
                    placeholder="What this project is about · nameplate data, rating, manufacturer, commissioning year, site notes"
                    onChange={e => set({ notes: e.target.value })}
                />
            </label>
        </div>
    );
}

/** The time-zone picker of the data: every offset in `TZ_OPTIONS`, this PC's marked. */
export function TimeZoneSelect({ value, onChange, id, selectRef, label = 'Time zone of the data' }: {
    value: number;
    onChange: (min: number) => void;
    id?: string;
    selectRef?: Ref<HTMLSelectElement>;
    /** Accessible name when no visible <label> wraps the select. */
    label?: string;
}) {
    const pc = pcOffsetMin();
    const options = TZ_OPTIONS.includes(value) ? TZ_OPTIONS : [...TZ_OPTIONS, value].sort((a, b) => a - b);
    return (
        <select
            id={id}
            ref={selectRef}
            aria-label={label}
            className="mf-in mf-in--mono mf-sel"
            value={value}
            onChange={e => onChange(Number(e.target.value))}
        >
            {options.map(o => (
                <option key={o} value={o}>UTC{fmtOffset(o)}{o === pc ? ' · this PC' : ''}</option>
            ))}
        </select>
    );
}
