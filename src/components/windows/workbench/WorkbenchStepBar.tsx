import { Fragment } from 'react';
import { Check } from 'lucide-react';
import type { RcStepState } from '../RunningConditionCard';

/*
 * The Build Model header step bar (mockup `.steps`):
 *
 *   Running condition -> Model settings -> Train -> Health set points -> Complete
 *
 * Every step is a BUTTON that jumps to where that step lives (the container
 * decides where — see `BuildModelWindow.goToStep`). Replaces the old read-only
 * 3-step `RunningConditionStepBar`.
 */

export type StepKey = 'running-condition' | 'model-settings' | 'train' | 'health-set-points' | 'complete';
/** done = green tick · now = blue (what to do next) · todo = grey · bad = red "!" */
export type StepLook = 'done' | 'now' | 'todo' | 'bad';

export const STEP_ORDER: { key: StepKey; label: string }[] = [
    { key: 'running-condition', label: 'Running condition' },
    { key: 'model-settings', label: 'Model settings' },
    { key: 'train', label: 'Train' },
    { key: 'health-set-points', label: 'Health set points' },
    { key: 'complete', label: 'Complete' },
];

export interface StepInput {
    /** The workspace Running condition (Step 1). */
    rcState: RcStepState;
    /** A model is selected. */
    hasModel: boolean;
    /** The model's own settings are fine to train (no build-block reason). */
    settingsReady: boolean;
    /** Has a train record at all. */
    trained: boolean;
    /** Trained, but its inputs changed since. */
    stale: boolean;
    /** Marked complete and up to date. */
    complete: boolean;
    /** Health set points validity: true = valid, false = something to fix,
     *  null = not known (the Health score page has not computed it). */
    healthValid?: boolean | null;
}

/** Look of every step — the mockup's rules. */
export function workbenchStepLooks(i: StepInput): Record<StepKey, StepLook> {
    const rcOk = i.rcState === 'set';
    const ready = i.hasModel && rcOk && i.settingsReady;
    const fitDone = ready && i.trained && !i.stale;
    return {
        'running-condition': rcOk ? 'done' : i.rcState === 'invalid' ? 'bad' : 'now',
        'model-settings': !i.hasModel || !rcOk ? 'todo' : i.settingsReady ? 'done' : 'now',
        train: !ready ? 'todo' : fitDone ? 'done' : 'now',
        'health-set-points': !fitDone ? 'todo' : i.complete ? 'done' : i.healthValid === false ? 'bad' : i.healthValid === true ? 'done' : 'now',
        complete: i.complete && fitDone ? 'done' : 'todo',
    };
}

interface Props {
    looks: Record<StepKey, StepLook>;
    /** The steps whose page/section is on screen (highlighted) — Model settings
     *  and Train share the Model fit page, so there can be two. */
    current: StepKey[];
    /** Steps that cannot be used right now (greyed, not clickable). */
    disabled?: Partial<Record<StepKey, boolean>>;
    /** Hover text of a disabled step. */
    disabledTitle?: Partial<Record<StepKey, string>>;
    onStep: (key: StepKey) => void;
}

export default function WorkbenchStepBar({ looks, current, disabled = {}, disabledTitle = {}, onStep }: Props) {
    return (
        <ol className="wb2-steps" data-testid="wb-steps" aria-label="Build steps">
            {STEP_ORDER.map(({ key, label }, i) => {
                const look = looks[key];
                const off = !!disabled[key];
                return (
                    <Fragment key={key}>
                        {i > 0 && <li className="wb2-sline" aria-hidden="true" />}
                        <li>
                            <button
                                type="button"
                                className={`wb2-stp wb2-stp--${look}${current.includes(key) ? ' wb2-stp--cur' : ''}`}
                                data-testid={`wb-step-${key}`}
                                data-look={look}
                                disabled={off}
                                title={off ? disabledTitle[key] : undefined}
                                aria-current={current.includes(key) ? 'step' : undefined}
                                onClick={() => onStep(key)}
                            >
                                <span className="wb2-sn">
                                    {look === 'done' ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : look === 'bad' ? '!' : i + 1}
                                </span>
                                {label}
                            </button>
                        </li>
                    </Fragment>
                );
            })}
        </ol>
    );
}
