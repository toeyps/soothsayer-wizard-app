import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
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
 * The ONE board shape of every chart-less state: a
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
    /** The window knows the fit is gone (it was told NOT_FITTED for this model and
     *  it has not been fitted again since) — also when the live answer of the page's
     *  own request no longer says so (the tab was left and opened again after a load
     *  that failed). */
    gone?: boolean;
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

/** Why "Train sensor ↑" would not train an out-of-date model right now. */
export interface StaleCantTrain {
    /** `reason`: the model itself cannot train (`text` = why — a missing setting, its
     *  running condition, a period outside the data). `run`: a training run is active
     *  on other models. `stale`: the data in this window is out of date (`text` = the
     *  whole sentence). */
    kind: 'reason' | 'run' | 'stale';
    text: string;
}

interface StaleBannerProps {
    /** The model is being trained again right now. */
    training?: boolean;
    /** The model is waiting in a training run. */
    queued?: boolean;
    /** Train sensor would NOT train this model right now: the banner says why (or
     *  when) instead of offering a link that would do nothing — or would start a run
     *  that skips this very model. */
    cantTrain?: StaleCantTrain;
    /** "Train sensor ↑": focus the header's Train sensor button. */
    onGoTrainSensor: () => void;
}

/**
 * "Settings or running condition changed — this model is Incomplete again. Train it
 * again with Train sensor ↑ to update the charts. Your set points are kept."
 * It has NO button of its own: the one place to train
 * is the header's Train sensor, and the sentence links there — unless Train sensor
 * would not train this model right now (`cantTrain`): then the sentence says why
 * ("It can't be trained yet: …"), or when ("…when the training run finishes").
 */
export function StaleBanner({ training, queued, cantTrain, onGoTrainSensor }: StaleBannerProps) {
    const state = training ? 'training' : queued ? 'queued' : cantTrain ? 'blocked' : 'stale';
    return (
        <div className="wb2-stale" role="status" data-testid="stale-banner" data-state={state}>
            <span>
                <b>Settings or running condition changed — this model is Incomplete again.</b>{' '}
                {training ? 'Training it again now… ' : queued ? 'It is queued in the training run. ' : cantTrain ? (
                    <span data-testid="stale-cant-train" data-kind={cantTrain.kind}>
                        {cantTrain.kind === 'run' ? 'Train it again when the training run finishes. '
                            : cantTrain.kind === 'stale' ? `${cantTrain.text} `
                            : `It can't be trained yet: ${cantTrain.text.trim().replace(/\.+$/, '')}. `}
                    </span>
                ) : (
                    <>
                        Train it again with{' '}
                        <button type="button" className="tq-inline-link" data-testid="stale-go-train" onClick={onGoTrainSensor}>
                            Train sensor ↑
                        </button>
                        {' '}to update the charts.{' '}
                    </>
                )}
                Your set points are kept.
            </span>
        </div>
    );
}

/**
 * A trained model's result could not be worked out again when it was opened (the
 * silent load failed — not a lost Relation-model fit, which has `FitGoneBoard`).
 * Shown for a COMPLETE model on both pages: Train sensor never trains an up-to-date
 * Complete model, so "Train sensor ↑" would be a dead end there. The ways out that
 * work: "Load it again" (the same silent load — nothing is written, the model stays
 * Complete) and, when given, the ▾ menu row that really trains it.
 */
export function LoadFailedBoard({ testId, linkTestId, className, kindName, tail, error, onReload, reloadDisabledReason, trainMenu }: {
    testId: string;
    linkTestId: string;
    className?: string;
    /** "Individual model", "Relation model", "Clustering model". */
    kindName: string;
    /** What comes back once it loads ("The charts come back when it is loaded."). */
    tail: string;
    /** Why the load did not work (the mono line). */
    error: string;
    onReload: () => void;
    reloadDisabledReason?: string;
    /** ", or train it from the Train sensor ▾ menu (…)" — a node with its own link. */
    trainMenu?: ReactNode;
}) {
    return (
        <StateBoard
            testId={testId}
            className={className}
            tone="bad"
            title={`Couldn't load the ${kindName}`}
            text={(
                <>
                    Nothing about the model changed and it stays Complete —{' '}
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
                    {trainMenu}
                    . {tail}
                </>
            )}
            detail={error}
        />
    );
}

/**
 * "The model was not saved. <why>" — shown on the Model fit page when a "Mark
 * complete" was refused or failed. The Health score page
 * renders the same message in its own banner, but that page cannot be shown for
 * a model that went stale during the export (the usual reason the save is
 * refused AFTER the files were written), so without this the user would never
 * learn that their Mark complete did not take effect. Dismissible.
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
