# SPEC FINAL — Train/Test model validation (retrospective health scoring)

**Approved mockup:** https://claude.ai/artifact/K1wTJLmv1ZV8teegUV6u4Q, Version 4. It is the current app's real frontend built against a mock backend.

**Status:** the user approved hand-off to dev on 2026-10-07.

**Design rounds:** ui-design-agent did rounds 1–4 and ui-design-reviewer reviewed round 2. All of the reviewer's items were applied in V3, and the overlap rule changed in V4.

**Design rules:** `docs/design/DESIGN_SYSTEM.md` §4, "Train / Test periods".

## What is in this folder

- `mockup-frontend.diff` — the mockup's changes to `src/`, as a diff against the repo at the time the mockup was copied. Use it as a REFERENCE, not as a patch to apply blindly. Two parts are mockup shortcuts:
  - `setActiveTimeScopes` is a module-level setter. Pass the scopes through `TimeSeriesSpec.scopes` instead.
  - The mock Rust replacement is not real code.
  - No tests were written for any of it.
- `mock-backend-reference.js` — the JS stand-in for the Rust commands. Its `healthPreview()` shows the intended maths for `test_validation`: per-test metrics, the 1-hour sustained-drop rule, lead time and train-overlap days. Port the logic to Rust: `health_preview.rs` / `health_score.rs`.

## Concept

This is anomaly detection. A model trains ONLY on periods when the machine was healthy, so it learns what "normal" looks like. Test periods are the time ranges where the score is checked:
- **Normal** — the score should stay high. This measures false alarms.
- **Known problem** — the score should drop. This proves detection. An optional event time gives the lead time: "dropped below 80 N days before the event".

The product is offline and historical only. Do not add live monitoring.

## Rules (all confirmed by the user)

1. **Train periods are REQUIRED to train.** The old default of "no period = whole dataset" is gone. With no train period, the Running-condition Apply is blocked with the hint "Add a train period", and Train is blocked by `getBuildBlockReason`. The copy tells users to pick healthy periods only.
2. **At least one test period is required before Mark complete.** Train can run without one. There is no "Not tested" state; the export always has `tested = true`.
3. **Test periods MAY overlap train periods** (e.g. train Jan–Mar, test Jan–Dec). Test results use the WHOLE test period, overlap included. The test row, its table row and its result tile carry a neutral grey note: "T1 includes N d of train running time — results include rows the model was trained on". The note never blocks anything.
4. **A train period overlapping a Dashboard highlight** shows an amber warning only, with a "Remove the overlap" action that splits the train period.
5. **Each test period has:**
   - start and end;
   - a label, Normal or Known problem;
   - for Known problem, an optional event time. The event time must be valid and inside its test period, otherwise it is red and blocks Apply.
6. **"From Highlights"** copies a Dashboard time highlight into a test period. The label is NOT stored on the highlight.
7. **Workspace default plus per-model Custom override**, using the same Workspace/Custom switch as the running condition:
   - Workspace data: `FailureGroupStateSlice.runningConditionTestPeriods`.
   - Custom data: `FailureModel.customTestPeriods`, copied once from the workspace when the model switches to Custom.
   - For a Custom model, the block reason points to Model settings.
8. **Changing ONLY test periods:** re-score with no re-train. The model stays trained, but a Complete model goes back to Incomplete and needs Mark complete again (`testsChangedAt`). Show:
   - a banner on the Health score page;
   - a notice under the Step-1 card: "Test periods changed — N complete model(s) need Mark complete again".
   - If every test period was removed, the banner reads "Test periods removed…".
9. **Changing train periods:** Incomplete plus re-train, as today.
10. **Test results are information only and never block.** They are green or amber, never red:
    - Normal: green when less than 5% of running time is below 80; amber at 5% or more.
    - Known problem, detected before the event: green with the lead time.
    - Known problem, detected only after the event: amber, "Detected only N days after the event".
    - Known problem, never detected: amber, "Not detected".
11. **"Detected / first drop below 80"** means the score stayed below 80 for **1 h of running time** (a constant). "Lowest" uses the same rule.
12. **Minimum training data** (as shipped 2026-10-07 — the user did not want a hard block): no hard minimum; an amber warning below `RECOMMENDED_TRAIN_DAYS` = 30 days of train running time. Train is blocked only by technical errors from Rust (e.g. `NO_DATA`).
13. **Mark complete** exports the model trained on the train periods only; never refit on test data. `*_INFO_*.json` gets a new `validation` block containing the periods, labels, event time, per-period metrics, `tested` and the date. Existing keys are untouched.
14. **The UI says "Relation model".** Never name the algorithm.

## Metrics

**Model fit page, "Train vs test" card:**
- Relation model: R², RMSE, residual mean and SD, and test/train RMSE ratio, for Train and each Normal test. For a Known-problem test, show only the residual shift and "× train RMSE".
- Individual: % of rows within ±3σ and the mean shift in σ, per test.
- Clustering: % of rows inside the 3× SD ring, per test.

**Health score page, "Test results" tiles**, per test period:
- Normal: % of running time below 80, and the lowest score held for 1 h.
- Known problem: first sustained drop below 80, lowest score, lead time compared with the event.
- The "Tested · N" pill appears in the footer only.

## Screens and UI

- **Step-1 card:**
  - "Train" chips, plus "Test" chips (Known problem hatched, event time shown).
  - Coverage strip: train on the top half, test on the bottom half. Caption like "117 d train · 59 d test".
- **Running condition modal:**
  - "Which time" contains Train periods (required, healthy-only callout) and Test periods (new `TestPeriodsEditor`), plus "From Highlights".
  - The preview column ("Data used for training", sticky) shows the test summary and the minimum-data note.
- **Every Workbench time chart (the time scopes):**
  - Train is a blue fill. Test is a magenta fill with a dashed outline; Known problem is hatched. The event is a red dashed line labelled EVENT.
  - Train labels sit in a strip above the plot; test labels sit inside it. Reference-line labels move to the left end.
  - Time outside every period is a gap (unscored).
- **Colour tokens:** train = accent blue; test = magenta `oklch(.74 .16 340)`, defined as `--train` / `--test`.

## Wire contract (mockup naming — confirm in the IPC types first)

**`compute_health_preview` request:** add `test_periods: [{ start, end, label: 'normal'|'problem', event_time }]`.

**Response:** add `test_validation`, as `ValidationResult` / `TestPeriodResult` in the diff's `types/health.ts`.
- `train`: summary.
- `train_ranges`.
- `tests[]`, each with:
  - `rows`, `days`, `train_rows`, `train_days`;
  - the kind's metrics;
  - `scored`, `pct_below_80`;
  - `first_below_80`, `lowest`, `lowest_at`, `lead_days`.

It is named `test_validation` because `validation` is already the issue list. Train fit and stats stay train-rows only. Test rows are scored with the train-only model.

**Decided during implementation:** no hard minimum, amber below 30 days (`RECOMMENDED_TRAIN_DAYS`). See DESIGN_SYSTEM §4 for the other shipped details: the amber "No train period" chip, the amber `.vt-fail` notice and test-result numbering.
