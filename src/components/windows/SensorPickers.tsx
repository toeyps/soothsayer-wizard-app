import { useMemo, type ReactNode } from "react";
import { SensorPickerMulti, SensorPickerSingle } from "../sensor/SensorPicker";

// Shared by the Build Model Workbench (BuildModelWindow, RunningConditionPanel).
//
// There is ONE sensor picker — `src/components/sensor/SensorPicker.tsx`.
// `SensorPickerModal` is a thin adapter kept so the Workbench call sites and
// their tests keep one seam:
//   - single → `SensorPickerSingle`: a select-like trigger and an anchored popover; one click
//     picks and closes; no OK.
//   - multi  → `SensorPickerMulti`: chips with × plus a dashed "Add…" opening a modal with
//     checkboxes; nothing changes until OK; Cancel / Esc / scrim discard.
// Labels (description first, then tag) come from the window's `SensorMetaProvider`.
export interface SensorPickerModalProps {
    sensors: string[];
    /** Groups the list by component (defaults to the metadata's component). */
    getComponent?: (tag: string) => string;
    /** Never offered (e.g. the model's own target sensor) — say why in `scope`. */
    excluded?: string[];
    /** Accessible name / modal title noun, e.g. "predictors", "Y sensor". */
    noun: string;
    disabled?: boolean;
    /** false (default) = multi-select; true = single-select. */
    single?: boolean;

    // ── multi ──
    /** The last CONFIRMED selection — what the modal starts from every time it opens. */
    selected?: string[];
    /** Fires once with the full new selection on OK (or when a chip's × removes one). */
    onConfirm?: (tags: string[]) => void;
    /** Locked: chips without ×, "Add…" disabled showing the reason. */
    lockedReason?: string;

    // ── single ──
    value?: string;
    onSelect?: (tag: string) => void;
    /** Adds a "None" row that clears the selection. */
    allowNone?: boolean;
    /** Empty-trigger text (default "Pick {noun}…"). */
    placeholder?: string;
    /** Why it is disabled — tooltip, and the placeholder when empty. */
    disabledReason?: string;
    /** 24 px trigger (chart toolbars). */
    compact?: boolean;

    /** Required-and-empty: dashed amber trigger / amber "Add …". */
    invalid?: boolean;
    /** Says which list this is when it is not "all sensors". */
    scope?: ReactNode;
}

export function SensorPickerModal({
    sensors, getComponent, excluded, noun, disabled = false, single = false,
    selected = [], onConfirm, lockedReason, value = '', onSelect, allowNone = false, placeholder,
    disabledReason, compact, invalid = false, scope,
}: SensorPickerModalProps) {
    const list = useMemo(
        () => (excluded && excluded.some(Boolean) ? sensors.filter(s => !excluded.includes(s)) : sensors),
        [sensors, excluded],
    );
    if (single) {
        return (
            <SensorPickerSingle
                sensors={list}
                value={value}
                onSelect={(t) => onSelect?.(t)}
                allowNone={allowNone}
                placeholder={placeholder ?? `Pick ${noun}…`}
                required={invalid}
                disabled={disabled}
                disabledReason={disabledReason}
                getComponent={getComponent}
                scope={scope}
                compact={compact}
                ariaLabel={noun}
            />
        );
    }
    return (
        <SensorPickerMulti
            sensors={list}
            selected={selected}
            onConfirm={(t) => onConfirm?.(t)}
            noun={noun}
            required={invalid}
            disabled={disabled}
            lockedReason={lockedReason}
            getComponent={getComponent}
            scope={scope}
        />
    );
}
