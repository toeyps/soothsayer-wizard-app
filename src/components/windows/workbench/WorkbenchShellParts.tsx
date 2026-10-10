import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import type { WorkbenchPage } from './workbenchTypes';

/*
 * Small shared pieces of the Workbench shell that both pages sit under:
 * the "Model fit | Health score" page switch (detail header, right side),
 * the scroll area of the page body, the stale banner, and the ONE board shape of
 * every chart-less state with its "Train sensor ↑" text link. Presentational only.
 */

/** "Train sensor ↑": the text link every sentence uses to point at the ONE place
 *  to train — `onClick` moves the focus to the header's Train sensor button. Never
 *  a train button of its own. */
export function TrainSensorLink({ testId, onClick }: { testId: string; onClick: () => void }) {
    return (
        <button type="button" className="tq-inline-link" data-testid={testId} onClick={onClick}>
            Train sensor ↑
        </button>
    );
}

/**
 * The ONE board shape of every chart-less state (SPEC workbench-redesign §1): a
 * title, one sentence and an optional mono line. Its actions are text links to
 * the one place for them ("Train sensor ↑", "Model settings", "Running
 * condition ↑") — never a button of its own.
 */
export function StateBoard({ testId, tone = 'plain', title, text, detail, className }: {
    testId: string;
    tone?: 'plain' | 'bad' | 'run';
    title: ReactNode;
    text?: ReactNode;
    detail?: ReactNode;
    className?: string;
}) {
    return (
        <div className={`bmw-stage-empty wbx-msg${tone === 'plain' ? '' : ` wbx-msg--${tone}`}${className ? ` ${className}` : ''}`} data-testid={testId}>
            <div className="wbx-msg-in">
                <b className="wbx-msg-t">
                    {tone === 'run' && <Loader2 size={14} className="pm-spin" aria-hidden="true" />}
                    {title}
                </b>
                {text && <span className="wbx-msg-s">{text}</span>}
                {detail && <span className="wbx-msg-d">{detail}</span>}
            </div>
        </div>
    );
}

/** What the "Fit no longer in memory" board of both pages can do about it. */
export interface FitGoneActions {
    /** "Load it again": fit the same Relation model again from the same settings.
     *  Nothing about the model changed, so nothing is saved and its status stays
     *  (a Complete model stays Complete). Must be stable (the pages are memoised). */
    onReload: () => void;
    /** Why "Load it again" cannot run right now (a training run owns the engine). */
    reloadDisabledReason?: string;
    /** "Train sensor ↑" — only for a model Train sensor really trains (not Complete:
     *  a Complete model is "up to date" there and is never trained by it). */
    onGoTrainSensor?: () => void;
    /** Why the last load did not work, or null. */
    error?: string | null;
}

/** Title of the board, the tab tooltip and the start of the footer sentence. */
export const FIT_GONE_WORDS = 'Fit no longer in memory';

/**
 * The Relation-model fit Rust held is gone (NOT_FITTED). ONE board for both pages:
 * the model itself did not change, so the way back is "Load it again" (a text
 * link — the board has no button of its own). `tail` says what comes back.
 */
export function FitGoneBoard({ testId, linkTestId, trainTestId, className, tail, actions }: {
    testId: string;
    linkTestId: string;
    trainTestId: string;
    className?: string;
    tail: string;
    actions: FitGoneActions;
}) {
    const { onReload, reloadDisabledReason, onGoTrainSensor, error } = actions;
    return (
        <StateBoard
            testId={testId}
            className={className}
            tone={error ? 'bad' : 'plain'}
            title={FIT_GONE_WORDS}
            text={(
                <>
                    The fitted Relation model is no longer in memory (the data was reloaded, a special sensor changed, or many Relation models were opened). Nothing about the model changed —{' '}
                    <button
                        type="button"
                        className="tq-inline-link"
                        data-testid={linkTestId}
                        disabled={!!reloadDisabledReason}
                        title={reloadDisabledReason}
                        onClick={onReload}
                    >
                        Load it again
                    </button>
                    {onGoTrainSensor && <>, or re-train it with <TrainSensorLink testId={trainTestId} onClick={onGoTrainSensor} /></>}
                    . {tail}
                </>
            )}
            detail={error ? `The last attempt did not work: ${error}` : undefined}
        />
    );
}

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
