import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { WorkbenchPage } from './workbenchTypes';

/* Shared pieces of the Workbench shell under both pages; presentational only. */

/** 'Train sensor ↑': text link that moves focus to the header's Train sensor button; never a train button of its own. */
export function TrainSensorLink({ testId, onClick }: { testId: string; onClick: () => void }) {
    return (
        <button type="button" className="tq-inline-link" data-testid={testId} onClick={onClick}>
            Train sensor ↑
        </button>
    );
}

/** The one board shape of every chart-less state: title, one sentence, optional mono line. Actions are text links, never a button. */
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
    /** Refit the same Relation model from the same settings; saves nothing, status stays. Must be stable (pages are memoised). */
    onReload: () => void;
    /** Why "Load it again" cannot run right now (a training run owns the engine). */
    reloadDisabledReason?: string;
    /** Only for a model Train sensor really trains (not Complete: it is 'up to date' there). */
    onGoTrainSensor?: () => void;
    /** Why the last load did not work, or null. */
    error?: string | null;
    /** The window knows the fit is gone (NOT_FITTED seen, not fitted since), even if the page's own request no longer says so. */
    gone?: boolean;
}

/** Title of the board, the tab tooltip and the start of the footer sentence. */
export const FIT_GONE_WORDS = 'Fit no longer in memory';

/** The Relation-model fit Rust held is gone (NOT_FITTED). 'Load it again' is the way back; `tail` says what comes back. */
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

/** The one scroll area of the detail pane (footer stays outside). A new `resetKey` scrolls to top by writing only `scrollTop`; no remount. */
export function WorkbenchScroll({ resetKey, page, children }: { resetKey: string; page: WorkbenchPage; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (ref.current) ref.current.scrollTop = 0;
    }, [resetKey]);
    return <div ref={ref} className="wb2-scroll" data-testid="wb-scroll" data-page={page}>{children}</div>;
}

/** Why "Train sensor ↑" would not train an out-of-date model right now. */
export interface StaleCantTrain {
    /** `reason`: the model can't train (`text` = why). `run`: a run is active. `stale`: window data is out of date (`text` = whole sentence). */
    kind: 'reason' | 'run' | 'stale';
    text: string;
}

interface StaleBannerProps {
    /** The model is being trained again right now. */
    training?: boolean;
    /** The model is waiting in a training run. */
    queued?: boolean;
    /** Why Train sensor won't train this model now; the banner says why or when instead of linking to nothing. */
    cantTrain?: StaleCantTrain;
    /** "Train sensor ↑": focus the header's Train sensor button. */
    onGoTrainSensor: () => void;
}

/** Banner for a model made Incomplete by a change; set points are kept. Links to Train sensor unless `cantTrain` says why not. */
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

/** A trained model's result couldn't be loaded when opened (a lost fit is `FitGoneBoard`). Ways out: 'Load it again' and, if given, the train menu row. */
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

/** 'The model was not marked complete' notice on Model fit after a refused or failed Mark complete. Dismissible. */
export function SaveErrorNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return (
        <div className="wb2-stale" role="alert" data-testid="save-notice">
            <span><b>The model was not marked complete.</b> {message}</span>
            <span className="wb2-sp" />
            <button type="button" className="rcx-btn rcx-btn--sm" data-testid="save-notice-dismiss" onClick={onDismiss}>Dismiss</button>
        </div>
    );
}
