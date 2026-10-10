import type { FailureModel, HealthSetPoints } from '../../../types';
import type { HealthIssue } from '../../../types/health';
import type { UseHealthPreviewResult } from '../../../hooks/useHealthPreview';
import type { TestsChangedState } from '../../../utils/trainTestValidation';

/*
 * Contract of the Build Model Workbench's two per-model pages (health score
 * phase 3b-1/3b-2, 2026-10-04).
 *
 * `BuildModelWindow` is the STATE CONTAINER: it owns the selected sensor / kind
 * tab, the drafts, the train flow, ONE `useHealthPreview` call for the active
 * model, and the page switch. The pages below are presentational: they receive
 * the pieces they need as props and report user intent through callbacks.
 *
 *   page 'model'   -> `ModelFitPage`     (3b-1)
 *   page 'health'  -> `HealthScorePage`  (3b-2 replaces the 3b-1 placeholder)
 */

export type WorkbenchPage = 'model' | 'health';

/** Props every page of the Workbench receives. */
export interface WorkbenchPageProps {
    /** The ACTIVE model, merged with any unsaved draft — exactly what Train
     *  would train (`effectiveModelFor`). Never the bare persisted record. */
    model: FailureModel;
    /** The model was trained, but its inputs changed since (`isModelStale`):
     *  every chart is "Out of date" and the page's actions are limited to Re-train. */
    stale: boolean;
    /** `useHealthPreview` for this model (data / loading / error / `notFitted`).
     *  `preview.data` is only ever this model's data; it is kept while stale. */
    preview: UseHealthPreviewResult;
    /** Unit text of the model's target sensor ("°C", "bar"; '' when unknown). */
    unit: string;
    /** The S-number (1-based position in the user's full scoring-period list) of
     *  each scoring period that was SENT — `testPeriodsWirePlan(...).numbers`.
     *  Results carry their wire `index`; this maps it back so an invalid
     *  (unsent) S1 does not make the valid S2 read "S1". Absent = the wire index
     *  is shown. */
    testNumbers?: readonly number[] | null;
    /** A Relation-model preview that scores scoring periods has been loading for
     *  a while: show "Scoring these periods … up to ~15 s". */
    slowScoring?: boolean;
}

// ---------------------------------------------------------------------------
// Health score page (3b-2)
// ---------------------------------------------------------------------------

/** What the page tells about the model's saved files ("Mark complete" writes them). */
export type SaveInfo =
    | { phase: 'idle' }
    /** `slow`: Relationship re-runs the sidecar and scores the scoring periods (15 s or more, longer the first time). */
    | { phase: 'running'; slow: boolean }
    /** `files` is `null` when only the persisted record is known (the model was
     *  completed in an earlier session): the folder and time, not the file list. */
    | { phase: 'ok'; outputDir: string; files: { file_name: string; path: string }[] | null; at: string }
    | { phase: 'error'; message: string };

export interface HealthScorePageProps extends WorkbenchPageProps {
    /** The draft set points being edited (always this model's own kind). */
    setPoints: HealthSetPoints;
    /** Every edit; `commit` = persist right away (stepper, quick buttons, reset to master). */
    onSetPointsChange: (next: HealthSetPoints, commit?: boolean) => void;
    /** The user is done typing in an input (blur / Enter): persist the draft. */
    onSetPointsCommit: () => void;
    /** Issues Rust returned when the last Mark complete was refused (shown in
     *  Checks until the set points change); `null` = show the live preview's. */
    attemptIssues: HealthIssue[] | null;
    /** Only a FAILED save (and a save that is taking long) shows on the page; a save in
     *  progress and a successful one are the footer sentence. */
    save: SaveInfo;
    /** "Train sensor ↑" (the Relation-model fit is no longer in memory): move the
     *  focus to the header's Train sensor button — the ONE place to train. The page
     *  has no Re-train button of its own. Must be stable (the page is memoised). */
    onGoTrainSensor: () => void;
    /** The error banner's Retry: ask `compute_health_preview` again. */
    onRetryPreview?: () => void;
    /** The `test_scoring_failed` notice's "Try again": same, but also tells Rust to
     *  retry the scoring-period prediction it remembered as failed. Falls back to
     *  `onRetryPreview` when absent. */
    onRetryTestScoring?: () => void;
    /** Only the model's scoring periods changed since it was Complete —
     *  `'changed'` / `'removed'` shows the "Mark complete again" banner
     *  (`testsChangedState`); null/absent = nothing to say. */
    testsChanged?: TestsChangedState | null;
}
