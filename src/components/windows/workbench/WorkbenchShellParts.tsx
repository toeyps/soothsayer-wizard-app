import { Check, RotateCw } from 'lucide-react';
import type { WorkbenchPage } from './workbenchTypes';

/*
 * Small shared pieces of the Workbench shell that both pages sit under:
 * the "1 Model fit / 2 Health score" page switch (detail header, right side)
 * and the stale banner. Presentational only.
 */

interface PageSwitchProps {
    page: WorkbenchPage;
    /** Model fit is done (trained and up to date) -> a tick instead of "1". */
    modelFitDone: boolean;
    /** Marked complete and up to date -> a tick instead of "2". */
    healthDone: boolean;
    /** The Health score page cannot be opened right now. */
    healthDisabled: boolean;
    /** Hover text of the disabled "Health score" button ("Re-train first"). */
    healthDisabledTitle?: string;
    onPage: (page: WorkbenchPage) => void;
}

export function PageSwitch({ page, modelFitDone, healthDone, healthDisabled, healthDisabledTitle, onPage }: PageSwitchProps) {
    return (
        <div className="wb2-pages" role="group" aria-label="Model pages" data-testid="page-switch">
            <button
                type="button"
                className={`wb2-pg${page === 'model' ? ' wb2-pg--on' : ''}${modelFitDone ? ' wb2-pg--ok' : ''}`}
                data-testid="page-model"
                aria-pressed={page === 'model'}
                onClick={() => onPage('model')}
            >
                <b>{modelFitDone ? <Check size={11} strokeWidth={3} aria-hidden="true" data-testid="page-model-done" /> : '1'}</b>
                Model fit
            </button>
            <button
                type="button"
                className={`wb2-pg${page === 'health' ? ' wb2-pg--on' : ''}${healthDone ? ' wb2-pg--ok' : ''}`}
                data-testid="page-health"
                aria-pressed={page === 'health'}
                disabled={healthDisabled}
                title={healthDisabled ? healthDisabledTitle : undefined}
                onClick={() => onPage('health')}
            >
                <b>{healthDone ? <Check size={11} strokeWidth={3} aria-hidden="true" data-testid="page-health-done" /> : '2'}</b>
                Health score
            </button>
        </div>
    );
}

interface StaleBannerProps {
    /** A (re-)train is already running. */
    training?: boolean;
    /** Re-train is not possible (the model's gate blocks it). */
    disabled?: boolean;
    disabledTitle?: string;
    onRetrain: () => void;
}

/** "Settings changed — this model is Incomplete again. Re-train…" (mockup `.stale`). */
export function StaleBanner({ training, disabled, disabledTitle, onRetrain }: StaleBannerProps) {
    return (
        <div className="wb2-stale" role="status" data-testid="stale-banner">
            <span>
                <b>Settings changed — this model is Incomplete again.</b>{' '}
                Re-train to update the charts and re-check the set points. Your set points are kept.
            </span>
            <span className="wb2-sp" />
            <button
                type="button"
                className="rcx-btn rcx-btn--pri rcx-btn--sm"
                data-testid="stale-retrain"
                disabled={disabled || training}
                title={disabled ? disabledTitle : undefined}
                onClick={onRetrain}
            >
                <RotateCw size={12} aria-hidden="true" />
                {training ? 'Training…' : 'Re-train'}
            </button>
        </div>
    );
}
