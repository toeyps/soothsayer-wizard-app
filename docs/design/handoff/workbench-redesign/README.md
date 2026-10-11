# SPEC FINAL — Build Model Workbench redesign (Model fit, Health score, running-condition modal, scoring periods)

**Approved:** the user approved the whole set on 2026-10-10 ("ตามที่แนะนำ ส่งให้ dev ได้เลย") after reviewing mockup Version 11. Every open question kept its recommended default.

**Why:** the user said the two Workbench pages were "ใช้ยากเกินไปมากๆ … ดูรก แต่ concept ถูกต้อง" — far too hard to use and cluttered, but right in concept. The redesign keeps every concept and rule, with one exception: scoring periods (§2). It removes the clutter.

## Mockup

https://claude.ai/artifact/A1gQZ1tEZbRGioeByJ6ZUi (Version 11). It is the real frontend against a mock backend. Press **Reset** on the "Mock" badge first.

The badge tools are mock-only and are not part of the design: Installed fonts, Data change, Preview error, Fit lost.

**Click paths** — start at GEG-4 Bearing study → Failure Groups → Build Model →.

| What to see | Where |
|---|---|
| Individual + Relation model pages | BEARING DE TEMPERATURE |
| Clustering pages | GENERATOR ACTIVE POWER |
| Not trained; queued / training / failed | BOILER DRUM LEVEL (▶ Train sensor, then the R tab) |
| Invalid Custom running condition | DAMPER FOR BOILER BYPASS |
| Gate not set; empty modal | the project "GEG-4 Lube oil review" |
| Save error on the first try | COOLING WATER OUTLET TEMP → Health score → Mark complete |
| Files out of date | BEARING VIBRATION X → change H |
| Running-condition modal | the running-condition line → Edit |
| Train all | ▶ Train all above the list |

## Files in this folder

- **`mockup-frontend.diff`** — this redesign only: the mockup before it (`cur3`) against the mockup after it (`cur4`), under `src/`. It is a REFERENCE, not a patch.
  - The mockup predates dev's commits after `b044d01`: the phase-1 `src/components/sensor/` components, the `axisValueFormatter` change in 46dee3b, the cluster-range work in f507258 / 3231fed, and the removal of the step bar. Keep the real code's versions of all of those.
- **`mock-backend-reference.js`**, **`mock-seed-reference.js`** — the mock commands and the seeded states. Useful as test fixtures.

## Design rules

`docs/design/DESIGN_SYSTEM.md` §4:
- "Build Model Workbench pages"
- "Time scopes on charts"
- "Scoring periods — just score it"
- "Running-condition modal (redesign)"
- "Train sensor / Train all"
- the label, picker and number rules

The UI says "Relation model" and never names the algorithm.

## Reviews

`ui-design-reviewer` reviewed Version 9 on 2026-10-09 and found 10 must-fixes and 18 should-fixes. All were applied in Versions 10 and 11. In Version 11 a few fixes are in the mockup code but were not viewed on screen: the typed-form residual labels, the save-error footer, the "Failed last run" text, reduced motion, and "< 0.1%". Check those during implementation. Run `code-reviewer` after each phase.

## Suggested phases

| Phase | What | Route |
|---|---|---|
| A | Scoring periods: remove labels, event time and verdicts (§2) | `rust-agent` ∥ `fe-logic-agent` → `fe-ui-agent` |
| B | Workbench shell + Model fit / Health score pages for all three kinds (§1, §3, §4) | `fe-ui-agent` |
| C | Running-condition modal + the Custom panel + impact lines (§5) | `fe-logic-agent` (impact helper, per-period counts) ∥ `rust-agent` (the count) → `fe-ui-agent` |
| D | Train menu copy, Train-all vocabulary, page states (§6, §7) | `fe-ui-agent` |

`qa-agent` closes every phase. Update `docs/testing/MANUAL_TEST_PLAN.md` in the same pass: new ids where the meaning changed, and delete items for removed features.

---

## 1. The page spine (both pages, every kind)

Top to bottom:
1. Window title "Build Model". **The 5-step bar is gone** — dev already removed it. No text may say "Step 1".
2. **Running condition as ONE line** when set: `✓ · Train n periods + span · Scoring n periods · When running: n condition · rows · % · mini strip · Details ▾ · Edit`.
   - Details unfolds the old grid.
   - When unset or invalid it is a card with its own primary "Set running condition →", marked "!" (no step number).
3. **Sensor header:** description, unit, tag, component chip and FG chips (wrapping inline in one row). Then ONE control group:
   - the **Performance / Condition switch** — the user said it MUST stay and its value MUST be saved (`FailureModel.category`, as today);
   - the page switch Model fit | Health score — plain segmented, no ticks, no numbers;
   - **Train sensor** with one short line under it.

   Below ~1000 px all three wrap onto one row under the name.
4. **Kind tabs** (Individual / Relation model / Clustering). **No text pills** — not "Trained", not "edited". One state dot using the list colours, with the words in a tooltip. A failed model gets the red dot, in the list too.
5. Model settings line (collapsed summary). It **opens by itself** when the thing to fix is inside it.
6. Page content.
7. **Footer:** one status pill + ONE sentence, and at most one filled button.

**Rules**
- **Status is said in words exactly once — in the footer.** Dots everywhere else. No status pill on the set-point card (a dot with a tooltip). No "Files saved to …" banner; it is the footer sentence.
- **At most ONE filled button on screen**, and it follows the state:
  - Train sensor when something needs training;
  - Save changes only while there is a draft;
  - Next: Health score when the model is trained (a ghost whenever training must come first, including when a sibling model of the same sensor needs training);
  - Mark complete on Health score;
  - Mark complete again only when the files are out of date;
  - a Complete model has none (Mark incomplete is a text button).
- **Chart-less states use one board shape**: a title, one sentence and an optional mono line. Their actions are text links to the one place for them: "Train sensor ↑", "Model settings", "Running condition ↑". The hint is said once on the board; the line under Train sensor stays short ("Can't train · see below", or "Relation model can't train · see its tab" when the blocked model is on another tab).
- **"Loading the … model…"** (no time estimate) while a trained model's preview loads. **"Training the … · about 15 s"** only for a model in the run.
- **One date format in the Workbench:** `9 Feb 2026 23:50`, mono. Applies to chart subtitles, tiles, and the footer "Trained …" / "Files saved …".
- Switching page or kind tab resets the scroll to the top.
- Spinners honour `prefers-reduced-motion`.

## 2. Scoring periods — "just score it" (USER DECISION 2026-10-09; changes shipped behaviour)

"Test periods" are renamed **Scoring periods** everywhere, numbered `S1, S2 …` by list position. A scoring period is **only start → end**: the trained model gives a health score for that time, and the user reads the chart.

**Remove from the app**
- the Normal / Known problem label control;
- the event time ("when was it found") and the lead time;
- the green/amber detection verdicts and their tile texts;
- the Known-problem hatch and the EVENT line on charts;
- the "n normal · n with a problem" counts;
- **"From Highlights" for scoring periods** — the button, the menu and the "From highlight …" caption.

**Keep**
- at least one scoring period before Mark complete;
- scoring periods may overlap train periods, with one quiet note on the row;
- the fit uses train rows only;
- results never block anything;
- the train-period highlight-overlap warning ("Remove the overlap") — it is a different thing and stays.

**Scoring results card (Health score):** neutral tiles only — `% of running time below 80` and the lowest score held for 1 h, with its date. "For reading only — never blocks Mark complete." Until the set points are valid, the card is one quiet line: "Scored once the set points are valid".

**Data and Rust**
- `TestPeriod.label`, `eventTime` and `fromHighlight`: keep them readable so old workspaces load. Stop writing them and ignore them on load. No migration is needed.
- Request `test_periods`: send only `start` / `end`.
- `test_validation`:
  - drop the verdict logic, `lead_days`, the Normal 5 % rule and the before/after-event branches;
  - keep `rows`, `days`, `train_rows`, `train_days`, `scored`, `pct_below_80`, `lowest`, `lowest_at`.
- `*_INFO_*.json` `validation` block: write periods without `label` / `event_time`.
- Remove the leftover label builders ("T1 Known problem" / "T1 Normal").

This reverses rules 5, 6, 10 and 11 and the Known-problem metrics of `handoff/train-test-validation/README.md`. The rest of that spec stands.

## 3. Charts

- **Time scopes:** train and scoring ranges are named in a thin strip ABOVE the plot (`TRAIN P1 P2`, `S1 S2`). No pills inside the plot.
- Reference-line labels sit at the right edge, outside the plot. No legend rows where the lines are labelled (Target vs predicted: "Actual" / "Predicted" at the line ends).
- Only the 100 band is filled; ±3SD is a dashed line.
- **The user's set points are the strongest lines** and carry their value **as typed**: `H 4.6`, `L 2.2`, `80 · +5`. Never pad or round a typed value (`fmtNumText`). Computed values use `fmtNum`.
- Axes use round ticks on both axes, with no raw extremes (Distribution x/y). Score axes print whole numbers (dev's `axisValueFormatter`).
- **Clustering:**
  - rings are labelled once per level, at the edge of the ring that reaches furthest right (`1× · 100`, `3× · 80`, `N× · 0`);
  - the user's N ring is solid red;
  - cluster point colours never use green, amber or red (those mean 100 / 80 / 0);
  - the axes include every ring; no stray x = 0 line;
  - axis titles are description + unit (the tag goes in the subtitle);
  - ranges print as typed.
- Clustering Model fit has no time chart (decided). The strip appears on the score chart.

## 4. Set points (Health score)

A small table: `Score · Band · Lower · Upper`. Automatic values are TEXT ("within ±1SD · automatic"), never fake inputs. The only inputs are the user's.
- **Individual:** L / H. The master-data footnote sits inside the card, with a "Use master H 4.5" link only when a side differs.
- **Relation model:** the four residual points (80 and 0 per side). They start empty; placeholders "−" / "+"; a short sign footnote. The 100 row is "within ±2RMSE · automatic".
- **Clustering:** N (stepper + 4×–7× presets). The 1× and 3× rows are text.
- The Checks live in the same card.
- **Validation messages echo typed values as typed** ("-2", not "-2.000") — a Rust change.
- **Footer empty count:** count `required` issues, not merged check lines (today 4 empty points show as "1 set point still empty").
- **Preview failed:**
  - a red card: "Couldn't load the health score. <reason> · the score and Checks are not available until it loads" + Retry;
  - tiles: "Not available until the health score loads";
  - **Mark complete / Mark complete again are disabled**, with the reason in the footer.
- **Saving:** the footer only. No "Saving results…" card, unless saving is slow.
- **Save error:** a red card with the file path. Footer: "Not saved · fix it, then Mark complete again".
- **Files out of date:** footer "Complete · Files out of date — set points changed after saving · Mark complete again to update them".
- **Footer when valid:** "Set points valid — check the score chart, then Mark complete".
- **NOT_FITTED:** no in-pane Re-train button. It points to "Train sensor ↑", and it counts as "needs training" in the train state. Ideally this holds for every Relation model whose fit was dropped, not only the active one.
- **"Trained in the run" bar** — one line: "Trained in the run 22:41 · 7 need set points · this is 3 of 7 · Next needing set points ›".

## 5. Running-condition modal (rebuilt) + the Custom panel

- Width 980 px. **No right-hand preview column.**
- **Timeline hero at the top:** a month axis, a Train lane (`P1 P2`, train blue) and a Score lane (`S1 S2`, scoring magenta, dashed). Invalid = red. Dragging on the timeline is a later step, not in this spec.
- **One caption under it:** `117 d train (about 100 d running time) · 59 d scoring · 14,391 of 25,880 rows (56 %) used for training · ≥ 30 d recommended`. With no train period: "no train period · no scoring time · add a train period to count the rows".
- **Sections** have one eyebrow line each (name + one sentence): Train periods · Scoring periods · When the plant is running. **No callout boxes.**
- **Period rows are one quiet line:** `P1  date → date  81 d · 69 d running  🗑`.
  - The per-period "d running" needs a **per-period running-row count** (a Rust count per period; approved).
  - The overlap note is one small grey line under the row.
- The highlight-overlap warning is one amber line under the train rows, with "Remove the overlap" inline.
- **Invalid period:** a thin red left edge and red date fields on the row, with one reason line ("P2 ends before it starts — pick an end after 11 May 2026"). **Apply is disabled**, with the red footer line "Fix P2 before applying". Reasons say `P1`, never "Period 1".
- **Empty:** "No train period yet — add at least one". Apply is disabled ("Add a train period").
- **No scoring period:** a quiet grey note, "No scoring period yet — you can train and apply now; Mark complete needs at least one." It does not block Apply.
- **Running mode** is one radio row: `Only when running · keep rows that meet a condition | Use all rows · idle and shutdown time included`.
- **Condition row** is ONE line: `[sensor] [> < ↔ =] [value unit] [✕]`. No component chip. The sensor trigger is capped at ~360 px, so the value input never clips.
- **Keyboard:** focus the first field on open; trap Tab; Esc = Cancel (existing dirty-draft behaviour).

**Change warnings (the user asked for these)**
- **Before Apply** — an impact line next to Apply replaces "Changes not applied yet". It is amber (grey when nothing is affected). Apply stays enabled.
  - Train periods or the condition changed → "Applying sets N models back to Incomplete — they need training again". N = Workspace-mode models that are trained and fresh and whose train fingerprint changes.
  - Only scoring periods changed → "N complete models will need Mark complete again (re-score, no training)".
  - Both changed → the train line, plus a quiet line "The new scoring periods are scored when they are trained again".
  - Nothing affected → "No trained or complete model is affected by this change".
  - Custom-mode models are never counted.
- **After Apply** — a notice under the running-condition line:
  - "Running condition changed — N models need training again. Use Train all, or Train sensor on each one; the amber dots in the list show which." This notice is session-only; the dots persist.
  - or "Scoring periods changed — N complete models need Mark complete again. They were re-scored with the same trained model, not re-trained." This is the existing `testsChangedAt` notice, reworded.

**Custom running condition (Model settings):** reuses `RunningConditionPanel` — the same timeline, rows and states — ending with "Only this model · the workspace default is untouched · saved with Save changes".
- Summary line: `Custom · 1 condition · 1 train · 0 scoring`.
- Reasons read "Own running condition: P1 ends before it starts. Fix it in Model settings"; once the section is open, "Fix P1's end above".

## 6. Train sensor / Train all copy

- **Train sensor ▾ menu (USER DECISION 2026-10-09):**
  - before any training: `Train all N models` / `Individual only` / `Relation model only`;
  - once trained (`lastTrainedAt`): `Re-train all N models` / `Re-train Individual only`;
  - `Re-train all` appears only when EVERY model of the sensor was trained before.
  - A small state line stays under each item: "Not trained yet · ≈ 1 s", "Up to date · trains anyway", "Settings changed since it was trained · ≈ 15 s", "Failed last run · ≈ 15 s", "Fit no longer in memory · ≈ 15 s", or the can't-train reason.
- **Main button:** filled `▶ Train sensor · n of m`; a ghost `▶ Train sensor` when nothing needs it.
- **Line under the button** — short: "Trains the Relation model · Individual up to date, skipped".
- **Can't-train reasons name the missing setting** ("Add at least 1 predictor", "+N more"). Never "Fill in the required fields above first" outside the form.
- **Train all preflight:**
  - Rows say "Ready", amber "Skipped" + Fix → with the long reason on a second line under the row, or grey "Skipped — up to date".
  - Zero counts are hidden.
  - Footer: "Trains 3 models; the 2 that can't train stay as they are".
- **Stale banner:** "Settings or running condition changed — this model is Incomplete again. Train it again with Train sensor ↑ to update the charts. Your set points are kept." It has no button of its own.
- **Close-during-run dialog:** focus "Keep training" on open; Esc = Keep training; trap Tab.
- **List legend:** "Needs input / re-train".

Everything else about the queue follows `handoff/customer-batch-2026-10/README.md` §4.

## 7. Page states (all reachable in the mockup)

Not trained · loading · stale · blocked by the gate · blocked by an invalid Custom running condition · queued · training · failed · set points needed · set point not valid · preview error · saving · save error · complete · files out of date · NOT_FITTED.

## Files (consolidated from the design runs)

- **`src/components/windows/BuildModelWindow.tsx`** — the spine; menu copy; `trainStateOf` reasons; boards; footer sentences, the empty-point count and the Next ghost rule; modal footer (impact line, `invalid-train`, focus trap); notices after Apply; the Custom panel via `RunningConditionPanel`; summary line; dots; no "edited" pill; scroll reset; remove the "can't be built yet" banner.
- **`workbench/ModelFitPage.tsx`, `HealthScorePage.tsx`, `SetPointsCard.tsx`, `ChecksCard.tsx` (merged into the card), `ValidationCards.tsx`, `healthCharts.ts`, `healthPageCharts.ts`, `chartTheme.ts`, `ChartCard.tsx`, `WorkbenchShellParts.tsx`** (`StaleBanner` loses its button; test id `stale-go-train`)**, `TrainQueueParts.tsx`**.
- **`RunningConditionPanel.tsx`** (rebuilt), **`RunningConditionCard.tsx`**, **`TimePeriodsEditor.tsx`**, **`TestPeriodsEditor.tsx`**.
- **`src/utils/timePeriods.ts`** ("P{n}" reasons), **`runningCondition.ts`** (gate copy), **`trainTestValidation.ts`** (scoring wording).
- **`src/App.css`**. The mockup classes (`.wbx-*`, `.rc-impact`, `.hsx-*`, `.rcm-*`, `.tq-*`, `.vt-quiet`) are reference names.
- **Rust:**
  - `health_preview.rs` — drop the verdicts, `lead_days` and `event_time`;
  - validation messages echo typed values;
  - a per-period running-row count for the modal rows — bounded, generation-pinned, `#[tauri::command(rename_all = "snake_case")]`, or follow the camelCase convention of the newer commands.
- **Tests:** everything that pins `label: 'normal' | 'problem'`, verdict tiles, the EVENT line and hatch, the `rc-preview` aside, "Step 1", "Period N", "edited", the `hs-verdict` pill text, `stale-retrain`, "Fill in the required fields above first" in queue or header context, "Saving results…", `test-from-hl`.

## Not in this spec

- Drawing or dragging periods on the timeline (later).
- Persisting the after-Apply train notice across restarts (session-only by decision).

---

## As shipped by dev — phases A + B (2026-10-10, commits 84d2aba … 0ce26a9; code-reviewed, not yet tested in the real app)

Where this section differs from the sections above, this section wins. The design side accepted every point.

1. **Target vs predicted (§3):** the names are not at the line ends, because ECharts does not re-place end labels on zoom or pan. A fixed Actual / Predicted colour key sits under the chart.
2. **Lost fit / NOT_FITTED (§4):**
   - The boards have a "Load it again" text link: a silent re-fit, nothing written, a Complete model stays Complete.
   - A not-Complete model also gets "or re-train it with Train sensor ↑".
   - Reason: Train sensor never trains an up-to-date Complete model, and the fit cache holds 8.
3. **One filled button (§1) — strict precedence:**
   - first, the running-condition card button;
   - Model fit: Save changes (draft) > Train sensor > Next;
   - Health score: Train sensor if this model must train again > Mark complete / Mark complete again;
   - a Complete model has none.
   - "Save changes" is rendered only while a draft exists.
4. **Typed values:** the shortest exact form ("4.60" → "H 4.6"), never padded or rounded. Rust messages follow the same rule.
5. **Charts:**
   - the strip prints "TRAIN" once, then P1, P2…; names that would collide are thinned;
   - ±1SD / ±3SD outside labels stack when close;
   - cluster colour slot 7 is `#a5b4fc`;
   - Model fit ring labels read "1× SD" / "3× SD";
   - computed numbers in table columns use fixed 3 decimals.
6. **Scoring results card:**
   - with no 1 h stretch of scored rows, it says there is no lowest score to show;
   - preview failed → "Not available until the health score loads";
   - the slow-save line appears after 4 s for every kind;
   - empty Individual inputs show "L" / "H";
   - the Clustering 0 row shows the chosen N as text.
7. **User decisions on 2026-10-10 (made with dev):**
   - at most 5 clusters; older models with more open unchanged;
   - new Clustering models start with 1 cluster;
   - 2+ clusters need a criteria sensor;
   - N stays unbounded, with the 4×–7× presets;
   - the saved-files / output-folder presentation is deferred.
8. **One-line running condition:** shows "· ⚠ n to fix" in red when a persisted scoring period is invalid.

Rust `count_period_rows` exists for the per-period "d running" rows (§5). Phases C and D are next.

## As shipped by dev — phases C + D and new requests (through 88f15cc, 2026-10-11; not yet tested in the real app)

The design side accepted every point. This section wins over the earlier text where they differ.

**Phase C — running-condition modal**
1. A complete date takes effect at once (timeline, counts, impact line).
   - A half-typed date shows a grey footer line: "Finish the date in P1 to see what this changes".
   - Clearing a set bound never opens it; only ✕ does.
2. "≥ 30 d recommended" turns amber below 30 d, with the full sentence in its tooltip. The caption says "set the condition to count the rows" while the condition is still required.
3. Train-on-train overlap is one grey line with an inline "Merge into one" link. The highlight-overlap line sits directly under the rows.
4. Running mode is a `radiogroup` with arrow keys. Focus returns to the opener on close.
5. The retrain notice and the scoring notice can show together when they concern different models.
6. Save changes for a Custom model is blocked by any invalid own period: "Fix P1 before saving".

**Phase D — Train copy and page states**
7. A sensor with one model has a single menu row ("Train the Individual model" / "Re-train the Relation model") and no all-row.
8. New board "Couldn't load the <kind> model" + "Load it again", for a Complete model whose silent load failed.
9. The stale banner states the reason when Train sensor would not train this model.
10. A fixed ring key "1× SD / 3× SD" sits under the Model fit Clusters chart.
11. "Fill in the required fields above first" appears only directly under the form.

**New user request — guards against "no data to train on"**
12. The rules:
   - A period that is new or changed in the draft and lies entirely outside the data is invalid: red row, "P1 is outside the data (1 Jan 2025 – 31 Dec 2025)", Apply / Save disabled.
   - A period partly outside the data gets an amber note.
   - A SAVED period outside the data only warns, in amber, on its row and on the one-line card ("… — it is not used"). It never blocks.
   - Train is blocked with "No rows to train on" only when no train period overlaps the data or the settled count is zero. The card turns red: "0 rows — nothing to train on".
   - The guards block actions only. Charts, Health score, Mark incomplete and Mark complete again are untouched.

**Wording (user decision)**
13. "Relation model" everywhere in the app: the Dashboard FG column, tooltips, toasts, and new suggested names "X (Relation model)". Saved names are kept.
   - User-readable errors say "Relation model engine".
   - The engine's raw error is replaced by "The Relation model engine could not fit this model. The details are in the error log."

**Open on the design side**
14. The "Relation model" header in the FG assign sheet is ~77 px wide in a 72 px column. ui-design-lead is ruling on it.

Dev's proposal for later (not started): split `BuildModelWindow.tsx` into smaller files.

## As shipped by dev — close-out (HEAD 0128402, 2026-10-11; code-reviewed, QA-closed, awaiting the user's real-app test, not pushed)

1. **FG assign-sheet kind columns:** `repeat(3, minmax(52px, 84px))` — the design ruling, applied.
2. **New chart-less state, "No data for this model in the loaded file".**
   - **When:** on both pages, for a trained or Complete model whose training scope has no row in the loaded data. That means all its train periods lie outside the data, a settled zero count, or the engine answering "no rows".
   - **Board:** one cause sentence + one working link — "Running condition ↑" for a Workspace-mode model, "Model settings" for a Custom one.
   - **Status:** the model keeps its own words (Complete / Trained). Tooltips add "· no data in the loaded file".
   - **Footer:** "Complete · no rows for it in the loaded file — fix the running condition to see its charts".
   - **Actions:** Mark incomplete stays available. Mark complete is disabled, with the reason.
   - It replaces "Couldn't load… Load it again" and "Training failed", which were untrue in this state.
3. **Rule across all boards:** a text link never points at a disabled control; the reason is shown instead.
