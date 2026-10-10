import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import type { WorkbenchPage } from './workbenchTypes';

/*
 * Small shared pieces of the Workbench shell that both pages sit under:
 * the "Model fit | Health score" page switch (detail header, right side),
 * the scroll area of the page body and the stale banner. Presentational only.
 */

interface PageSwitchProps {
    page: WorkbenchPage;
    /** The Health score page cannot be opened right now. */
    healthDisabled: boolean;
    /** Hover text of the disabled "Health score" button ("Re-train first"). */
    healthDisabledTitle?: string;
    onPage: (page: WorkbenchPage) => void;
}

/** A plain segmented control: it says WHERE you are, never how far (no numbers,
 *  no ticks — a model's status is said once, in the footer; SPEC workbench-redesign §1). */
export function PageSwitch({ page, healthDisabled, healthDisabledTitle, onPage }: PageSwitchProps) {
    return (
        <div className="wb2-pages" role="group" aria-label="Model pages" data-testid="page-switch">
            <button
                type="button"
                className={`wb2-pg${page === 'model' ? ' wb2-pg--on' : ''}`}
                data-testid="page-model"
                aria-pressed={page === 'model'}
                onClick={() => onPage('model')}
            >
                Model fit
            </button>
            <button
                type="button"
                className={`wb2-pg${page === 'health' ? ' wb2-pg--on' : ''}`}
                data-testid="page-health"
                aria-pressed={page === 'health'}
                disabled={healthDisabled}
                title={healthDisabled ? healthDisabledTitle : undefined}
                onClick={() => onPage('health')}
            >
                Health score
            </button>
        </div>
    );
}

/**
 * The ONE scroll area of the detail pane (settings + banners + the page body;
 * the footer stays outside it). Switching the page or the kind tab — a new
 * `resetKey` — puts it back at the top. Only `scrollTop` is written: the
 * children are never remounted, so the charts are not rebuilt.
 */
export function WorkbenchScroll({ resetKey, page, children }: { resetKey: string; page: WorkbenchPage; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (ref.current) ref.current.scrollTop = 0;
    }, [resetKey]);
    return <div ref={ref} className="wb2-scroll" data-testid="wb-scroll" data-page={page}>{children}</div>;
}

interface StaleBannerProps {
    /** A (re-)train is already running. */
    training?: boolean;
    /** The model is waiting in a training run (customer items 8 + 9). */
    queued?: boolean;
    /** Re-train is not possible (the model's gate blocks it). */
    disabled?: boolean;
    disabledTitle?: string;
    onRetrain: () => void;
}

/** "Settings changed — this model is Incomplete again. Re-train…" (mockup `.stale`). */
export function StaleBanner({ training, queued, disabled, disabledTitle, onRetrain }: StaleBannerProps) {
    return (
        <div className="wb2-stale" role="status" data-testid="stale-banner">
            <span>
                <b>Settings changed — this model is Incomplete again.</b>{' '}
                Re-train to update the charts and re-check the set points. Your set points are kept.
            </span>
            <span className="wb2-sp" />
            <button
                type="button"
                className="rcx-btn rcx-btn--sm"
                data-testid="stale-retrain"
                disabled={disabled || training || queued}
                title={disabled ? disabledTitle : undefined}
                onClick={onRetrain}
            >
                <RotateCw size={12} aria-hidden="true" />
                {training ? 'Training…' : queued ? 'Queued' : 'Re-train'}
            </button>
        </div>
    );
}

/**
 * "The model was not saved. <why>" — shown on the Model fit page when a "Mark
 * complete" was refused or failed (QA fix, 2026-10-04). The Health score page
 * renders the same message in its own banner, but that page cannot be shown for
 * a model that went stale during the export (the usual reason the save is
 * refused AFTER the files were written), so without this the user never learned
 * that their Mark complete did not take effect. Dismissible.
 */
export function SaveErrorNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return (
        <div className="wb2-stale" role="alert" data-testid="save-notice">
            <span><b>The model was not marked complete.</b> {message}</span>
            <span className="wb2-sp" />
            <button type="button" className="rcx-btn rcx-btn--sm" data-testid="save-notice-dismiss" onClick={onDismiss}>Dismiss</button>
        </div>
    );
}
