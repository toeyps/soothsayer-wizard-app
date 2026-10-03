import type { WorkbenchPageProps } from './workbenchTypes';

/*
 * Page 2 of the Workbench — "Health score" body.
 *
 * PLACEHOLDER (health score phase 3b-1, 2026-10-04). The route, the page
 * switch, the step bar and the shared state (`useHealthPreview` etc.) already
 * exist in `BuildModelWindow`; phase 3b-2 replaces this component's body with
 * the real page: the set-point chart, the "Health set points" ladder card, the
 * Checks card and the full-width Health score chart (mockup `healthPage`).
 *
 * What 3b-2 receives (see `WorkbenchPageProps` + the container's call site):
 *   - `model`     the draft-merged active model (`model.healthSetPoints` = the
 *                 PERSISTED set points; the draft being edited is state 3b-2
 *                 adds to the container)
 *   - `preview`   `useHealthPreview` result; today it is called WITHOUT
 *                 set points. 3b-2 passes its draft set points to that same call
 *                 (marked `// 3b-2:` in `BuildModelWindow`) so `preview.data`
 *                 carries `validation`, `valid`, `series.score`, `score_summary`
 *   - `stale`     charts get `stale` for the "Out of date" overlay
 * and it should reuse `ChartCard`, `healthCharts.buildTimeSeriesOption` /
 * `ellipseSeries` and `chartTheme` rather than redraw the axes.
 *
 * The footer of this page (← Model fit · status · Mark complete) is rendered by
 * the container (`renderHealthFooter`), because Mark complete shares the
 * container's persist/complete flow.
 */
export default function HealthScorePage(_props: WorkbenchPageProps) {
    return (
        <div className="wb2-board" data-testid="health-page">
            <div className="wb2-lockpane">
                <div>
                    <b>Health score — coming next</b>
                    The set points, checks and the score over time will appear here.
                </div>
            </div>
        </div>
    );
}
