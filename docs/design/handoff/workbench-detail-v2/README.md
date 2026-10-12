# SPEC FINAL — Workbench detail pages v2 (Model fit + Health score, all three kinds)

**Status:** the user approved the design direction on 2026-10-12 ("ok ครับผม"). This SPEC is written and is **waiting for the user's go-ahead before dev starts**.

**Why:** after testing the shipped Workbench redesign in the real app, the user said the detail pane and the Health score page were still "ใช้ยาก แล้วก็ไม่สวย". The Welcome page, the Dashboard, the Build Model left list, the running-condition line and its modal are fine and are NOT touched.


> ## ⚠️ UPDATE 2026-10-12 (afternoon) — read this first; it overrides the text below where they differ
>
> **User decision.** The real app stays the base for everything. For the Build Model detail pages, the redesign in this SPEC **replaces** what is there now. The user said: "ส่วน FG build model เราออกแบบใหม่กันแล้วก็เปลี่ยนใหม่ได้เลย … ส่งงานให้ dev ได้เลย".
>
> **The mockup was rebased on the real tree at `d917dae`.** `mockup-vs-real.diff` in this folder was regenerated against it. It now also contains three other approved changes, each with its own SPEC folder:
> - `dashboard-tagged-points` — `TagCompareTable.tsx`, `TaggedPointList.tsx`;
> - `model-settings-layout` — hunks in `BuildModelWindow.tsx`;
> - `welcome-machine-rotation` — `machineShapes.ts`, `machineDots.ts`.
>
> **This redesign changes things the user asked dev for earlier the same day. The user knows, and chose the redesign:**
> 1. **Page switching.** Today: no header switch; the footer's "Next: Health score →" / "← Model fit". **v2:** the "① Model fit / ② Health score" tab row under the kind tabs, plus the header state button. No footer bar.
> 2. **Charts.** Today: two time-chart cards of the same width with aligned axes. **v2:** one full-width card with both charts stacked on one time axis. Keep the real `useSharedZoom`; it is already wired into the mockup.
> 3. **Set points.** Today: a Health set points card (table + Checks) in the right column. **v2:** the full-width score ruler above the charts, with the Checks under it. There is no right-column card.
> 4. **Share of scored hours.** Today: a card in the right column. **v2:** a tile in the top strip.
>
> **Removed from v2 since this SPEC was first written — do NOT build:**
> - **Scoring-period tiles (S1, S2 …)**, and any "no scoring period" tile, on the Health score page. The user removed the Scoring results card in the real app ("ไม่ได้ใช้"). The Health score strip is now: Lowest score · Below 80 · Share of scored hours.
> - **Any "sets the model to Incomplete" hint** in Model settings (the user's decision; real commit `d917dae`).
>
> **Not reviewed.** The rebase onto `d917dae` had two conflicts (`HealthScorePage.tsx`, `BuildModelWindow.tsx`). They were resolved by the design agent and have not been reviewed. Run `code-reviewer` after implementing.
>
> **If any of points 1–4 looks wrong once it is in the real app,** the user may want that piece back the way it is today. Build them as separable commits where practical.

## The one rule of this hand-off

**The mockup is the real app code plus ONLY the changes listed here.** It was rebased on the real working tree at `d917dae` (2026-10-12 afternoon). Everything not listed under "Intentional differences" must stay exactly as it is in the real app: copy, tooltips, chart behaviour, date format, colour picker, states.

If the real code has moved since then, the real code wins. Apply only the listed differences on top of it.

## Mockup

- Online: https://claude.ai/artifact/Tj2dEf48eZNHVGpfujxbdo (Version 5).
- Local, full screen: `C:\00_DATA\wizard-mockups\workbench-v2\open-mockup.bat`.
- Press **Reset** on the "Mock" badge first. The badge tools are mock-only: Installed fonts, Data change, Preview error, Fit lost, Train error, Slow run.

**Click paths** — start at GEG-4 Bearing study → Failure Groups → Build Model →.

| What to see | Where |
|---|---|
| Individual, Relation model | BEARING DE TEMPERATURE |
| Clustering | GENERATOR ACTIVE POWER |
| Not trained | BOILER DRUM LEVEL |
| Invalid Custom running condition | DAMPER FOR BOILER BYPASS |
| No data in the loaded file | STEAM PRESSURE HRSG4 |
| Gate not set | the project "GEG-4 Lube oil review" → BOILER DRUM LEVEL |
| Save error, then saved | COOLING WATER OUTLET TEMP → ② → Mark complete |
| Complete; files out of date | BEARING VIBRATION X (then change H) |
| Training failed | BOILER DRUM LEVEL → badge "Train error" → Train sensor |
| Preview error | badge "Preview error", then edit a set point |

## Files in this folder

- **`mockup-vs-real.diff`** — the complete difference between the real `src` and the mockup (9 files, tests excluded). Use it as a REFERENCE for the exact markup and CSS. Do not apply it blindly:
  - it contains mock shortcuts — the period tiles are rendered twice and one is hidden by CSS;
  - a hidden `.wb3-ruler-vl` label is still in the markup;
  - the `wb3` CSS block should be folded into `App.css` properly.
- **`mock-backend-reference.js`**, **`mock-seed-reference.js`** — the mock commands and seeds, useful as test fixtures.

```
 src/App.css                                              | 196 ++++-
 src/components/windows/BuildModelWindow.tsx              | 169 ++--
 src/components/windows/workbench/HealthScorePage.tsx     | 369 +++--
 src/components/windows/workbench/Kpi.tsx                 |  34 + (new)
 src/components/windows/workbench/ModelFitPage.tsx        |  70 +-
 src/components/windows/workbench/ScoreRuler.tsx          | 335 + (new)
 src/components/windows/workbench/SetPointsCard.tsx       | 275 +- (table removed, NumField kept)
 src/components/windows/workbench/WorkbenchShellParts.tsx |  38 - (PageSwitch removed)
 src/components/windows/workbench/healthChecks.ts         |  10 +-
```

## Design rules and reviews

- `docs/design/DESIGN_SYSTEM.md` §4 "Workbench detail pages v2 (USER APPROVED 2026-10-12)". It marks which older rules are superseded: "status words only in the footer", "primary button in the footer", "no text on kind tabs", "no numbers on the page switch".
- `ui-design-reviewer` reviewed Version 4: 7 must-fixes and 12 should-fixes, all applied in Version 5. Exceptions are under "Notes for dev". Version 5 itself has not been re-reviewed.
- Run `code-reviewer` after the implementation.

## Route

UI only. No data-model, Rust contract or IPC change — except the optional copy change in §4. → `fe-ui-agent` → `code-reviewer` → `qa-agent`. One phase is enough; split it per page if preferred.

---

## Intentional differences from the real app (the whole scope)

### 1. Detail header — arranged by function

- **Left = identity:** label, unit, tag, component chip, FG chips, then the **Performance / Condition switch**, small, in the same meta row.
  - The switch must stay, and its value must keep being saved as today.
- **Right = actions only:**
  - `▶ Train sensor ▾` — a ghost when training is not the next step, filled when it is. The menu is unchanged.
  - ONE filled, state-following button: Save changes (while a draft exists) → Train → Next: Health score → Mark complete / Mark complete again.
  - A Complete, up-to-date model has no filled button (Mark incomplete is a text button).
  - The existing one-filled-button precedence stays.
- **A short reason line under the state button** when it is disabled, in the same slot and style as Train sensor's reason line. Example: "1 set point not valid".
- **"Next: Health score →" is rendered only when it is the primary action or can be pressed.** No disabled copy of it.
- The header page switch (Model fit | Health score) is removed.

### 2. Kind tabs — status in words

- The dot stays. Beside it are the status words: "Trained" (neutral grey), "Set points needed", "Fix set point", "Not trained yet", "Re-train needed", "Training failed", "Complete", and the gate badges ("Needs condition", "Fix periods" …).
- Amber or red only for words that ask for action.
- The visible words include the suffixes, uncut: "· files out of date", "· no data in the loaded file", "Fit no longer in memory".
- The tooltip keeps the full sentence.

### 3. Page tabs — a second row under the kind tabs

- `① Model fit — settings · train · check the fit` / `② Health score — set points · score · mark complete`.
- The numbers are an order, not progress: no ticks, and the user can always go back.
- A `<nav>` with plain buttons and `aria-current="page"`.
- A closed ② uses `aria-disabled` (it stays focusable). It shows its reason in place of the caption — "Train the model first", "Re-train first", "Fix the settings first" — visible at every width and not dimmed.
- The footer's "← Model fit" button is removed.

### 4. Notice line — replaces the footer bar

- No footer bar and no status pill.
- One line appears ONLY for: warn, bad, saving, unsaved draft, queued / training, and the "Files saved <date> · <folder>" confirmation.
- Tone:
  - a rejected set point is **red** (`--danger` text and icon);
  - warnings are amber;
  - it has `role="status"`.
- On ② with a Model-settings draft: "Unsaved changes in Model settings".
- **No train date anywhere on the page, and no "scored on N periods"** (user decision). The tab tooltip is unchanged.
- After Save changes, focus goes to the notice line when it shows; otherwise to the active page tab.

### 5. Model fit page

- **A KPI tile strip above the charts** replaces Individual's Statistics table and the Relation model's stat row:
  - Individual: `Mean · SD (±1SD range) · Outside ±3SD (% · ≈ rows · ±3SD range)`
  - Relation model: `R² · RMSE (±2RMSE) · Residual SD`
  - Clustering: `Clusters (split by …) · In a cluster % · Inside 3× SD %`
- **No "Training rows" tile and no "Trained" tile** (user decision). Rows / Predictors / 2RMSE as separate items are gone; 2RMSE and the residual mean are sub-captions.
- **Tiles never judge.** Values are neutral. No amber thresholds and no "fair / weak fit" sentences.
- Three equal tiles, each capped at about 420 px.
- A non-zero share never reads "0.0%"; use the existing `shareText` ("< 0.1%").
- Individual: the charts are full width and taller. The sub-caption reads as a sentence: "green = within ±1SD (score 100) · amber dashes = ±3SD (score 80)".

### 6. Health score page

- **KPI strip** — one row; it scrolls sideways if it overflows:
  - `Lowest score` (coloured by its band, with the date);
  - `Below 80` (% of scored hours);
  - `Share of scored hours` (a stacked bar + key);
  - one tile per scoring period: a two-line label "S1 · start" / "→ end", then "% below 80 · lowest N · includes N d of train time".
  - Colour appears ONLY on a score number itself: the Lowest score value, and the "lowest 34" in a period tile.
  - This strip replaces the "Scoring results" card, and the score chart's subtitle and share column.
  - On a narrow pane, the period tiles move under the ruler so the ruler stays above the fold. Build it as one component placed by container width, not rendered twice.
- **Score ruler** (`ScoreRuler.tsx`) replaces the set-point table. One horizontal band maps value → score:
  - **Individual:** `0 · 80 · 100 · 100 · 80 · 0` on `L · −3SD · −1SD · +1SD · +3SD · H`. Inputs: L and H.
  - **Relation model:** `0 low · 80 low · −2RMSE · no residual · +2RMSE · 80 high · 0 high`. Four inputs.
    - One name per point everywhere (ruler, markers, Checks): "0 low / 80 low / 80 high / 0 high", in ruler order.
    - On a narrow pane, the four inputs sit on their own labelled row under the band.
  - **Clustering:** one-sided, `centre · 1× · 3× · N×`. N stepper + 4×–7× presets.
  - Program values are text. The user's inputs are large (the `NumField` "big" variant).
  - The band is capped at about 1,100 px.
  - The Checks sit under the ruler in the same card.
  - The master-data footnote and its "Use master H …" link are unchanged.
- **Wrong values must warn** (the user's concept rule). The validation RULES are unchanged — the same Rust issues and codes. For every rejected or empty value, show ALL of:
  - the tick and input in red; an empty one is dashed amber;
  - a red marker on the band where the typed value really sits, labelled as typed ("L = 62"):
    - the other valid user points are anchors, so the marker never sits on the wrong side of another point;
    - a value beyond the last user tick sits at that end with an arrow ("L = 90 →");
    - colliding labels stack on rows;
  - the Checks sentence with the typed value as typed;
  - the kind-tab words ("Fix set point" / "Set points needed");
  - the red or amber notice line;
  - Mark complete disabled, with the reason under the button.
  - Ruler inputs keep a visible focus outline in every state. Each input has `aria-describedby` pointing at the Checks.
- **Preview failed:**
  - the ruler draws the user ticks as "not checked" — grey, dashed, no score colour;
  - every tile says "not available until the score loads".
- **Lock text:**
  - when the verdict is bad: "Fix the set point on the ruler above — the score appears here";
  - when points are empty: "Set every point on the ruler above — the score appears here".
- **One stacked chart card** replaces the two cards: the set-point chart on top, the score chart below, on ONE time axis with one crosshair. Heights: 560 px; 700 px for Clustering.
  - Clustering: the scatter sits above the score chart. They share no axis; the existing cross-highlight stays.
  - The hover read-out is in the card header.
- `healthChecks.ts`: the Relation model hint says the residual chart is "below", not "on the left".

### 7. Polish (CSS only)

- Cards are lifted off the window: card background + shadow, radius 14.
- Tile numbers are mono 24.
- Tile sub-lines, program tick names and the ruler note use `--text-secondary`, not `--text-faint`.
- Kind-tab padding is slightly larger, scoped to the Workbench tabs.

## Where each existing state lives (no behaviour change)

- **Chart-less states** — not trained, queued, training, failed, lost fit, load failed, no data in file, blocked by the gate or by an invalid Custom running condition: the same board in the page body, with its existing text links. No KPI strip is shown, because there is no preview.
- **Stale:** the existing banner + the tab words "Re-train needed" + the "Out of date" overlay.
- **Saving / slow save / save error / files out of date / unsaved draft:** the notice line + the header button, as described above.
- **Complete:** the tab words "Complete"; "Mark incomplete" as text; no filled button.

## Notes for dev

1. **Relation point names in the Checks sentences (optional Rust copy change).** To say "The 80 low point …" instead of "The lower 80-point …", and to list issues in ruler order, `health_score.rs` message texts and their tests change. If you would rather not touch Rust, rename only the ruler, the markers and the collapsed Checks line, and keep Rust's sentences. Tell the design side which you did.
2. **Item 10 focus fallback** and **the sideways scroll of the tile strip** were coded but not seen on screen. Check them.
3. **Dead code after this change:** `PageSwitch`, `TestResultsCard`, and the old set-point table in `SetPointsCard.tsx` (keep `NumField`).
4. **Tests to update:**
   - `BuildModelWindow.test.tsx`, `HealthScorePage.test.tsx`, `ValidationCards.test.tsx`, `healthChecks.test.ts`;
   - the Workbench integration tests: `WorkbenchPhaseBStates`, `WorkbenchTrainCopyAndWording`, `WorkbenchDataGuards`, `HealthScoreHourlyFiveMinute`, `ScoringPeriodsLegacyWorkspace`.
   - Test ids that change or disappear: the footer pill, `footer-back-to-fit`, `stats-card`, `stat-rows`, `stat-2rmse`, `stat-predictors`, `score-summary`, `test-results`.
   - New tests: the ruler marker position and row logic; the notice tone; tab words with suffixes.
5. **`MANUAL_TEST_PLAN.md`:** items for the footer, page switch, statistics and scoring results need new ids. Delete the items for removed things.
6. **Performance:** nothing new is fetched. Every tile number already comes from `HealthPreview` and the existing stats.

## Not in this spec

- A hover marker on the ruler showing the score of the hovered hour — later.
- Any change to the left list, the running-condition line or modal, the Train menu, the queue, the Dashboard or the Welcome page.

## About the "Mock" tool bar in the mockup — it is NOT part of the design

The mockup has a small tool bar: Installed fonts, Data change, Preview error, Fit lost, Train error, Slow run, Reset.

- It belongs to the mock harness (`mock/runtime.js`). It is not in the app's `src`, it is not in `mockup-vs-real.diff`, and it must never be built into the app.
- It is hidden by default. Press **Alt+Shift+M** in the mockup to show or hide it.
- Dev needs it only to reach some states (preview error, lost fit, train error, data change) and to Reset the example data.
