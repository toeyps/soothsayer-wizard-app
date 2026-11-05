import type { FailureModel, HealthSetPoints } from '../../../types';
import type { HealthIssue } from '../../../types/health';
import type { UseHealthPreviewResult } from '../../../hooks/useHealthPreview';
import type { TestsChangedState } from '../../../utils/trainTestValidation';
import type { FitGoneActions } from './WorkbenchShellParts';

/* Contract of the Workbench's two per-model pages. `BuildModelWindow` holds the state; the pages are presentational (props in, callbacks out). */

export type WorkbenchPage = 'model' | 'health';

/** Props every page of the Workbench receives. */
export interface WorkbenchPageProps {
    /** The ACTIVE model merged with any unsaved draft: exactly what Train would train (`effectiveModelFor`), never the bare persisted record. */
    model: FailureModel;
    /** Trained, but its inputs changed since (`isModelStale`): every chart is "Out of date" and the page's only action is Re-train. */
    stale: boolean;
    /** `useHealthPreview` for this model (data / loading / error / `notFitted`); `preview.data` is only this model's, kept while stale. */
    preview: UseHealthPreviewResult;
    /** Unit text of the model's target sensor ("°C", "bar"; '' when unknown). */
    unit: string;
    /** S-number (1-based position in the user's full scoring-period list) of each period SENT (`testPeriodsWirePlan(...).numbers`). Maps a result's wire `index` back; absent = wire index shown. */
    testNumbers?: readonly number[] | null;
    /** A Relation-model preview has been loading a while: show "Calculating the health score … up to ~15 s". */
    slowScoring?: boolean;
}


/** State of the Mark complete save as the page shows it. */
export type SaveInfo =
    | { phase: 'idle' }
    | { phase: 'running' }
    | { phase: 'error'; message: string };

export interface HealthScorePageProps extends WorkbenchPageProps {
    /** The draft set points being edited (always this model's own kind). */
    setPoints: HealthSetPoints;
    /** Every edit; `commit` = persist right away (stepper, quick buttons, reset to master). */
    onSetPointsChange: (next: HealthSetPoints, commit?: boolean) => void;
    /** The user is done typing in an input (blur / Enter): persist the draft. */
    onSetPointsCommit: () => void;
    /** Why set points can't be edited now (an export is running), else null: the ruler's inputs are disabled with this as tooltip. */
    setPointsDisabledReason?: string | null;
    /** Issues Rust returned when the last Mark complete was refused (shown in Checks until set points change); null = the live preview's. */
    attemptIssues: HealthIssue[] | null;
    /** Only a FAILED or slow save shows on the page; a running or successful save is the footer sentence. */
    save: SaveInfo;
    /** The Relation-model fit is no longer in memory (`preview.notFitted`): the board offers "Load it again" and, if not Complete, "Train sensor ↑". Compared by value, so callbacks must be stable. */
    fitGone: FitGoneActions;
    /** This model's fit is loading right now (silent re-fit or "Load it again"): the board reads "Loading the Relation model…". */
    fitLoading?: boolean;
    /** The error banner's Retry: ask `compute_health_preview` again. */
    onRetryPreview?: () => void;
    /** `test_scoring_failed` notice's "Try again": like retry, but also tells Rust to retry the remembered failed scoring-period prediction. Falls back to `onRetryPreview`. */
    onRetryTestScoring?: () => void;
    /** Only the scoring periods changed since Complete: `'changed'`/`'removed'` shows the "Mark complete again" banner; null/absent = nothing. */
    testsChanged?: TestsChangedState | null;
}
