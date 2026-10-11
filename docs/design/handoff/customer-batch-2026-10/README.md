# SPEC FINAL — Customer requirement batch, 2026-10 (items 3, 4, 5, 6, 8+9, plus the Pair Plot cluster legend)

**Approved:** the user approved the whole batch on 2026-10-09 ("design ok แล้วส่งให้ dev จัดการได้เลย") after reviewing it in the merged mockup. Every open question below kept its default.

## Mockup

https://claude.ai/artifact/Er2fQQFpJB6ETtnbQnv119 (Version 4 or later). It is the real app frontend built against a mock backend, and the ONLY reference. Ignore the older link K1wTJLmv1ZV8teegUV6u4Q, which still shows a superseded calculator.

**Before you try it:**
- Press **Reset** in the top badge.
- The red "couldn't be restored" toast on opening GEG-4 is seeded on purpose, to show the repair state.
- Mock-only badge tools (not part of the design):
  - **Installed fonts** — Segoe UI / Consolas.
  - **Data change** — simulates STALE_SESSION.

## Files in this folder

- **`mockup-frontend.diff`** — the mockup's `src/` against repo commit `b044d01`. Use it as a REFERENCE, not a patch.
  - The mockup was copied before `b044d01`, so the diff wrongly shows dev's own work as removed: `specialSensorRepair.ts`, `specialSensorDeps.ts`, `specialSensorEdit.ts`, and parts of `useFormulaValidation.ts`. KEEP dev's versions of those.
  - The mockup's `merge*.css` files are scratch CSS. Fold them into `App.css` tokens/classes.
  - The mockup uses a module-level sensor-meta registry fed from `useSensorMetaMap`. A real build passes the metadata as props or context instead.
- **`mock-backend-reference.js`** — the JS stand-ins for Rust commands. It includes `preview_formula`, the train queue timings and `failureGroupCount`.
- **`mock-seed-reference.js`** — the seeded projects and states, useful for test fixtures.

## Design rules

`docs/design/DESIGN_SYSTEM.md` §4 (SensorLabel / SensorPicker / ColourPicker), §4.1 (flow patterns: FG step, Formula editor + Quick build, Train queue), §3.2 (installed fonts) and §5 (banned words). The UI says "Relation model" and never names the algorithm.

## Reviews

`ui-design-reviewer` reviewed items 3+4 and items 5/6/8+9 as part-mockups on 2026-10-08. All must-fixes were applied in the merge (handover entries of 2026-10-08).

The final review of the merged app was started and stopped by a usage limit. The Pair Plot legend and the formula-editor round 2 (Quick build) had no separate review; the user approved them directly. → **Run `code-reviewer` after each implementation phase.**

## Suggested phases (each phase is independently shippable)

| Phase | Item | Route |
|---|---|---|
| 1 | Items 3+4: shared SensorLabel / SensorPicker / ColourPicker + rollout | UI only → `fe-ui-agent` |
| 2 | Pair Plot cluster legend + rename | UI only → `fe-ui-agent` |
| 3 | Item 5: Failure groups as Import step 3 | `fe-logic-agent` (metadata) → `fe-ui-agent` |
| 4 | Items 8+9: Train sensor / Train all queue | `fe-logic-agent` (`useTrainQueue`) → `fe-ui-agent` |
| 5 | Item 6: Formula editor + Quick build | `rust-agent` (`preview_formula`, aggregate decimals) ∥ `fe-logic-agent` (tokenizer/check) → `fe-ui-agent` |

`qa-agent` closes every phase, and the main session runs its own verification (`tsc`, `vitest`, `cargo test`). Update `docs/testing/MANUAL_TEST_PLAN.md` in the same pass and regenerate the HTML. Performance: nothing may make the app slower. Previews stay bounded and debounced.

---

## 1. Items 3+4 — sensor label, sensor picker and colour picker everywhere

### New shared components (`src/components/sensor/`)

**`SensorLabel`**
- Description first, then the tag. Two variants: **Stacked** (lists) and **Inline** (rows, tooltips, chips).
- Options: `size="lg"` (Workbench detail header) and `muted` (chart subtitle).
- No-description fallback = the tag alone. Never write "no description", and never show the tag twice.
- The tag line uses `--text-secondary`; `--text-faint` is only for placeholders and separators.
- Narrow rule:
  - Below ~150 px of label width, hide the tag. It stays in `title` and in the picker rows.
  - In condition rows narrower than ~480 px, the component chip moves under the trigger.

**`SensorPicker`**
- **single** = an anchored popover on `AnchoredPopover.tsx`, `min(420px, 92vw)`.
  - It flips upward near the bottom of the window.
  - Search matches description, tag, unit and component.
  - Keyboard: Space/↓ opens into the search, ↑↓ move, Enter picks, Esc closes and returns focus to the trigger.
  - The search uses `role="combobox"` with `aria-activedescendant`, and every row has an id.
- **multi** = a 520 px modal with OK/Cancel and pending state.
- A **scope line is required** whenever the list is not "all sensors". Examples:
  - "Sensors on the chart · N"
  - "All sensors except the target · N"
  - "Predictors of this model · N"
  - special-sensor sources: "except this sensor and the sensors built on it"
- In rows narrower than ~320 px, drop the unit chip. The unit stays searchable and in `title`.
- A chosen "None" renders in `--text-secondary`, non-italic.
- `SensorAutocomplete` is retired. `SensorPickerModal` becomes an adapter or is replaced.

**`ColourPicker`**
- 12-colour palette, a "current" ring drawn with `box-shadow: 0 0 0 2px var(--text)` (`outline` stays free for `:focus-visible`), dots on colours already in use, and a Custom colour section (today's `ColorPlatePicker`, HSV + hex). An invalid hex shows "Use 6 hex digits, like #3b82f6."
- The 16 px swatch sits inside a 24 px hit area.
- Tab past the last control closes the popover.

**Number formatter:** one en-US formatter with thousands separators that keeps 3 decimals. Use it in tooltips, the tag box, Highlights chips and Step-1 chips. Never inside `<input>` values or CSV exports.

As shipped (ce23c64), this replaces the line above:
- Values the user **typed** keep every typed decimal (`fmtNumText` / `fmtNumExact`).
- **Computed** values use `fmtNum`, which never shows a non-zero value as 0:
  - below 0.001: 3 significant digits;
  - from 1e9: whole numbers with separators;
  - from 1e15: scientific notation.

### Where they apply (see the diff for each file)

- **Dashboard › Sensor tab / Failure Groups tab / assignment sheet header:** Stacked. FG rows match the Sensor-tab row metrics exactly. The sheet header gets meta, not strings.
- **Selected Sensor tab:**
  - A swatch replaces the pipette and opens ColourPicker.
  - The row text is neutral. The series colour lives only on the swatch and on tooltip/tag-box values.
- **Filter tab:**
  - Add condition → single picker with the unit suffix in the value boxes.
  - **A filter whose sensor is no longer on the chart is kept and still applies** (verified: `Dashboard.tsx` `wireValueFilters` sends every filter).
  - That row shows a ⚠ / solid amber border, and a note directly under it: "<DESC> · <TAG> is not on the chart. The filter still applies." with the actions **Show on chart** / **Remove**.
  - Never use the dashed `.req` style for this; it means "required and empty".
- **Highlights:**
  - Time swatches use ColourPicker.
  - In By value, "Colour by…" is a picker, and it is a real disabled state on Line and Pair Plot.
  - Range chips show the unit and thousands separators.
- **Line chart:**
  - Tooltip rows = Inline label + value + unit.
  - Tag-point box (ECharts rich text): a description segment ≥ 200 px measured in Consolas, then the tag segment, then a fixed-width right-aligned value column. The box is capped at ~320 px; the tooltip carries the full name.
- **Scatter:**
  - Compact X/Y pickers; Y opens right-aligned.
  - Inline axis titles. The Y title uses `writing-mode: vertical-rl` with `max-height` = plot height, so it can ellipsize. Verify this in the real WebView2.
- **Pair Plot:** the axis hover card is the Stacked label + a component chip.
- **Build Model:**
  - List rows: Stacked. Detail header: `lg` + component chip.
  - Relation model: predictors as chips + a dashed "Add…" that opens the multi modal ("All sensors except the target · N").
  - Clustering: X readout; Y and Criteria use the single picker (Y is dashed amber when empty, Criteria allows None).
  - Running condition rows: single picker + component chip.
  - Step-1 chips: Inline label + mono condition.
  - Drop the "· Relation model" / "· Clustering" field-label suffixes.
  - Model fit › X selector: compact picker. With one predictor it is **disabled, still shows its value, and gives the reason in a tooltip**.
- **Special Sensors window:**
  - Explorer rows: Stacked.
  - Manage rows: description first, unit chip, tag on line 2, neutral grey lock pill.
  - The "— no description —" placeholder is removed.
- Excluded sensors (e.g. the target in the predictor modal) stay hidden. The scope line explains why.

### Tests to update

`FailureGroupsPanel`, `BuildModelWindow` (it mocks `SensorPickerModal`), the picker tests (formerly in `PredictiveModelBuild.test`), `HighlightsPanel`, `FilterPanel`, `ScatterChart`, `PairPlotChart` and `SpecialSensorEditor`. Manual-plan items for Scatter X/Y, cluster colour, highlight colours, Filter and predictor picking need **new ids**.

---

## 2. Pair Plot cluster legend (+ rename)

**What changes**
- The floating card ("N clusters · M rows", View Table, ↺, a trash per row) is replaced by a **chip row in the existing 36 px strip above the matrix**, left of the toolbox. It never covers data.
- Chip = ColourPicker swatch + name + ×.
- "Clear" (text action) shows only at 2+ clusters.
- On overflow the row scrolls sideways with a right fade; Clear and the toolbox stay visible.
- The enlarged-view footer shows the same chips.

**Rename in place**
- Click the name, or focus it and press Enter/F2. The name becomes an inline field with the text selected.
- Enter or blur saves; Esc cancels; empty or whitespace-only reverts.
- Names are trimmed and capped at 40 characters. Above 160 px they ellipsize, with the full name in `title`.
- Focus returns to the name afterwards.
- Duplicate names are allowed.
- Names are not persisted, because clusters are not persisted today.

**Behaviour fixes**
- Toolbox ↺ = reset view ONLY (today it also deletes every cluster).
- New clusters take the smallest free "Cluster N" number, counting only names still of that form, plus the first unused colour.
- The default cluster colours become the matching PALETTE swatches.

**Removed**
- Row counts, View Table, the cluster table modal and **CSV export of brushed rows** (the user doesn't use them).
- Dead code: `TABLE_PAGE`, `HEAD_W`, `tableOpen`/`tableFilter`, `allClusterRows`, `rowToCluster`, `tableRows`, `openTable`, `toggleClusterFilter`, `handleExportCsv`, the table modal, and the imports `Table2`/`Download`/`Trash2`/`save`/`writeUserTextFile`/`fmt`.
- CSS: `.pair-regl-cluster-panel*`, `.pair-regl-modal*` and `.pair-regl-filter-chip*`.
- **Cascade:** `writeUserTextFile` (`workspaceManager.ts`) loses its last caller. Remove the TS helper. Keep the Rust `write_user_file` command unless the user decides otherwise, and update CLAUDE.md's mention.

**Copy:** `Dashboard.tsx` help text → "…pick a cluster colour or remove a cluster from the chips above the matrix."

**Tests and manual plan**
- `PairPlotChart.test`:
  - Remove the View Table and CSV blocks.
  - Rewrite the cluster tests as "Reset keeps clusters; Clear removes them".
  - Add tests for: name/colour reuse, Clear hidden at 1, footer chips, rename (Enter/Esc/empty/40 chars/F2/numbering).
- `VisualRefreshFinalSweep`: drop `.pair-regl-modal-backdrop`.
- Manual plan:
  - PAIR-4: rewrite.
  - PAIR-5: new id.
  - Delete PAIR-6 and PAIR-7.
  - Add "↺ keeps clusters" and the rename items.

---

## 3. Item 5 — Failure groups as Import step 3

**SetupRail**
- 4 steps: Data → Tag names → **Failure groups** → Dashboard.
- Tab order: the step's own controls come first and the rail after, **on every step** (a SetupRail-wide change).
- The step-2 value may wrap to two lines.

**Step 3 screen ("Which failures should Wizard look for?")**
- Quick-add field: Enter adds a group and keeps focus. A duplicate name turns red.
- Group cards: name, description, recommendation.
- ✕ removes a group, with an Undo toast (7 s, live region).
- "+ Add group" is secondary; **"Open Dashboard ›" is the only primary**; "Skip for now" is a text link.
- Footer status is `--text-secondary`, not green.

**After Open Dashboard / Skip**
- The rail shows step 4 "Opening the Dashboard…".
- On Skip, step 3 gets a dashed "Skipped · 0 groups" marker, never a ✓.

**Dashboard landing**
- Opens on the Failure Groups tab with a blue callout and the summary "N groups · M sensors assigned · x of y models complete".
- "Assign sensors →" on every empty group. With no groups, the "No failure groups yet" callout.
- **"Build Model →" stays in the FG-tab footer.** The Dashboard header has no Build Model button, so this is the only entry point. At 0 models it is disabled with the tooltip "No models yet — assign sensors to a failure group first".

**Assign mode**
- "Assign sensors →" switches to the Sensor tab with a bar "Assigning to FG-n · name · Done".
- The folder button on a row opens the existing assignment sheet with that group pinned first and tagged "Assigning".
- Component counts read "assigned / total".
- Esc/✕ return focus to the folder button. Done goes back to the FG tab.
- Removing a model's last group shows a toast with Undo.
- Copy never uses the 📁 emoji; it names the lucide icon's button ("the Failure groups button on a sensor row").
- Before writing the sheet footer copy, check what Enter does in the shipped `FailureGroupAssignSheet`, and say exactly that.

**Recent-project chip** (on the shipped 0.9.0 `RecentProjectCard`)
- "n failure groups" with the group colours, or a neutral dashed "No failure groups" (never amber).
- Projects saved before this change show no chip.

**Data:** optional `WorkspaceMetadata.failureGroupCount` + `failureGroupNos`, written in `workspaceManager.saveWorkspace`. Frontend only, no Rust.

**Files:** `SetupRail.tsx`, `DataUploadPage.tsx` (step `0|1|2|3`), new `FailureGroupsStep.tsx`, `RecentProjectCard.tsx`, `FailureGroupsPanel.tsx`, `SensorSelection.tsx`, `FailureGroupAssignSheet.tsx` (a "highlight group" prop), `workspaceManager.ts` and `types.ts`.

---

## 4. Items 8+9 — Train sensor / Train all with a queue

**Buttons**
- **Train sensor** (the one primary) sits in the detail header: "▶ Train sensor · n of m", with a ▾ menu (Re-train all / Train only…) and a reason line under it.
- The per-model Train button in the footer is removed. The footer reason line says "Not trained / Settings changed · Train sensor ↑", and focuses the header button.
- **Train all** is secondary, above the list, with a count line ("9 ready · 0 up to date · 1 can't train").

**Train all preflight**
- Grouped by failure group, with "Fix →" on models that can't train.
- Rewrite the can't-train reason for this modal: the shipped "Fill in the required fields above first" reads wrong here.
- "Skipped — up to date" is grey; amber only for "Skipped — <missing setting>".

**Run strip**
- Shows "Training i of n", the current model, time left, a segment bar (each segment gets a `title`), Details and Cancel.
- List badges: dashed ring = queued, spinner = current.
- When finished:
  - Partial failure = amber; red only when nothing trained.
  - "Done · 6 trained · 1 failed · 2 skipped".

**Queued or running model**
- Settings are locked: "Locked while this model is in the run · Remove from run". Save is disabled.
- "Remove from run" leaves the model's status unchanged. It is also offered on the running-details modal rows.

**Close during a run**
- An in-window alertdialog. "Keep training" is the default; the other choice is "Stop after this model and close".
- It also covers the native close (`onCloseRequested`).
- It survives queue progress, and its numbers update live. If the run finishes while it is open, it becomes "Run finished — close?" with one Close.

**STALE_SESSION**
- The run stops. The strip, the sidebar line and the Train-sensor reason are all `--danger`, with the shipped wording ("The data in this window is out of date. Close it and open Build Model again from the Dashboard").
- Both Train buttons are disabled.

**0 ready / no running condition**
- The Step-1 card shows an amber NOT SET with its own primary "Set running condition…".
- Both Train buttons are disabled, with the reason as text.

**After a run**
- A "Set points needed" list filter chip.
- Health score page banner: "N trained in this run need set points (M in total)", with "Next needing set points ›".
- "Next: Health score →", when disabled, gets its reason in the footer ("Train first, then set the health set points").
- Mark complete keeps the shipped button style.

**Files:** `BuildModelWindow.tsx` (footer, header button, close handler, queue strip; `executeTrain` returns its error so the queue can read it), new `workbench/TrainQueueParts.tsx`, new `useTrainQueue` hook, `WorkbenchShellParts.tsx` (Re-train button), `ModelFitPage.tsx` and `HealthScorePage.tsx`. No data-model or Rust change, beyond reacting to `STALE_SESSION`.

---

## 5. Item 6 — Formula editor + Quick build (replaces SensorTooling's builder)

**Path:** Dashboard › Sensor tab › + Add Special Sensor, and Manage › ✎ (opens the same editor, titled "Edit sensor", with Cancel edit / Save changes).

### Quick build — the primary way to start (the old `ButtonBuilder` concept, kept on user request)

- **Left list:** clicking a row PICKS it ("Picked" pill, group counter). A hover `$` button inserts `$TAG` at the editor caret instead.
- The Quick build card sits **above** the formula field and shows the option set for the pick count:
  - **0 picked:** a hint ("…one sensor offers a number or a transform, two or more a chain and combinations. Or type straight into the formula below.").
  - **1 picked:**
    - *Combine with a number* `+ − × ÷ ^` → a value field. The formula stays dim with "Enter the number" until a number is typed.
    - *Transform* `abs √ log₁₀ exp ceil floor round`. `round` reveals a decimals field and writes `round(0.01, $A)` (engine form).
    - Nothing chosen = "As-is".
  - **2+ picked:**
    - *Chain* — chips with a sign button between each, `+` by default, with a menu `+ − × ÷ ^`.
    - *Combine all* — Sum · Average · Median · Spread · |A − B| (|A − B| needs exactly 2). Choosing one dims and disables the chain signs.
    - *Compare one against the rest* — Efficiency %, with an "input = …" radio. It stays dim until the input is chosen. Writes `($out / $in) * 100`.
    - *Then wrap* — `abs √ log₁₀ exp ceil floor round`, hidden for blocks.
- The footer always shows the generated text before anything is committed, with **Use this formula** (editor empty) or **Insert at cursor** / **Replace formula**. Insert brackets the piece when it has a top-level operator.
- **Average / Median are aggregate blocks** (user decision 2026-10-08: they skip missing values, while an expanded sum does not). They show "Average of N sensors · missing values skipped", with **Use this block / Replace with this block**. A block stands alone. A rounded aggregate stores the operation's own decimals (**needs `SensorOperationConfig.multiOp.decimals` in Rust**), never a `round()` wrap.
- **Sum / Spread / |A−B| / Efficiency %** expand to editable text. Sum = `A + B + C` (a row is missing if any source is missing). Spread = `max(…) - min(…)`, and min/max take any number of arguments.
- Picks clear on Add, on Edit and via "Clear picks". The option sets reset when the count changes bucket (0 / 1 / 2+).
- The old Templates menu is merged into Quick build. "Add as-is to the chart" is not offered here; the Dashboard does that.

### The formula field — precise, free editing

- One textarea over a mirror in the same mono font. The structure is painted behind the text:
  - sensor chips;
  - depth-coloured brackets with pair highlighting;
  - error range = red wavy underline + tint.
- Storage is unchanged: `kind: 'formula'` text with `$Tag` / `${…}`. **Names with spaces or Thai always serialise as `${…}`.** Inside the text a sensor shows as its tag; the description is on hover, in suggestions and in the Sensors row.
- Selecting text and pressing `(` (or "( ) Wrap") wraps the selection and keeps the inside selected. **Unwrap** removes the pair at the caret. Both are native insertions, so Ctrl+Z / Ctrl+Shift+Z work.
- Operator change: select it and type over it. Palette pills insert with spacing; function pills wrap the selection.
- The thin secondary palette is one row: `( ) Wrap · Unwrap | + − × ÷ ^ | abs √ ln log₁₀ exp round min max ceil floor · All functions ▾`.
- **Autocomplete** opens on `$` or after 2+ letters, and Ctrl+Space works any time. It lists sensors (description + tag + unit), then functions with a one-line meaning. ↑↓, Enter/Tab, Esc. While a word is being typed, no red flash for that token.
- **Sensors row** under the field: every referenced sensor as an Inline label. Click one to select its first occurrence.
- **Check line:** `✕ message` plus a fix button when one exists — `Add )`, `Insert ×`, `Use round(0.01, …)`, `Use sqrt`, `Add ( )`, `Remove it`, `Replace…`. Clicking the message selects the error range. While invalid, Add/Save stay disabled and the footer repeats the message.
- **Functions:** text mode and recipe loading accept EVERY engine function (`FORMULA_FUNCTION_LIST`: abs, sqrt, pow, exp, ln, log (base 10), log10, round, min, max, ceil, floor, sin, cos, tan, pi(), e(), plus sign, int and hyperbolics). The error lists the engine's own list, supplied by Rust — never retyped in TS. `round(m, x)` is valid.
- **Unknown sensor:** a red dashed token and a red chip with **Replace…** (anchored single picker), which replaces every occurrence.
- **Preview:** min / max / mean / rows plus an amber missing-row count. It comes from Rust `preview_formula`, debounced ~220 ms, ~600 points, bounded.
- **"Round the result":** set in ONE place. The stored form is shown.
- **Narrow window (~900 px):** the left list is 230 px, the palette wraps, the fields go 2-column.

### States

- **Locked** (a model uses it and its data is fine):
  - read-only dashed field;
  - a neutral grey lock pill + one lock sentence, shown once;
  - Quick build and the palette are hidden; Name is read-only;
  - description / unit / component stay editable.
- **Repair** (dev's shipped behaviour, b044d01 — an unrestored sensor):
  - an amber "No data — fix formula" pill, and an amber note with Rust's reason;
  - the formula is UNLOCKED even though a model uses it;
  - the name is locked, and Delete stays disabled while a model uses it;
  - the error is placed in the text with its fix button;
  - footer: "Saving restores the data; N model(s) go back to Incomplete (set points kept)";
  - toast after save: "Restored <TAG>. N model(s) set back to Incomplete — train again." Use the real `demoteModelsTrainedOnSensors` count.
- **Manage:**
  - a special sensor used by another special sensor has Delete disabled: "Used by <name> — remove it there first";
  - Delete + Undo (8 s), as shipped;
  - legacy Sum recipes (`kind: 'operation'` sum) open as expanded `A + B + C`, with a note.

### Rust contract (new) — `preview_formula`

- Bounded and downsampled. Request: `{ formula | aggregate, max_points, expectedGeneration }`.
- Response: `{ ok, issues: [{ code, message, range?: [start, end] }], stats: { min, max, mean, rows, missing }, timestamps, values, functions: string[], limits: { max_len, max_depth } }`.
- Stable codes: `unknown_function`, `unknown_sensor`, `bad_arg_count`, `too_long` (4096), `too_deep` (64), `unclosed_bracket`, `unmatched_close`, `empty_brackets`, `op_no_left`, `op_no_right`, `missing_operator`, `stray_comma`, `fn_no_bracket`, `constant_only`, `div_zero`, `bad_number`, `bad_char`, `agg_too_few`, `round_excel` (Excel-style `round(x, n)`). The codes must match what the save path refuses.
- The front-end check mirrors Rust's rules only as a cheap first pass. Rust has the last word.
- Remember `#[tauri::command(rename_all = "snake_case")]`.

**As shipped by dev (2026-10-09, commit 9476aa2) — this overrides the bullets above where they differ:**
- Request keys are **camelCase**: `maxPoints`, `expectedGeneration`, `replace` and `requestId`. This matches `bindToGeneration`.
- `div_zero` and `agg_too_few` are reported only when creating a sensor.
- **Rounding form:** the engine's legacy converter emits `round(X * 100) / 100`, a literal power of ten. Quick build "round" and the fix buttons use this same form, **not** `round(0.01, X)`. Read every `round(0.01, …)` in this spec as that form.
- The user decided (directly with dev) to **auto-convert legacy Excel-style `round($A, 2)` on load**. The "Not in this batch" item below is therefore resolved.

### Files

New `SpecialSensorFormulaEditor.tsx` (with `QuickBuild`); `AddSensorWindow.tsx` (`quickSel`); `SensorExplorer.tsx` (pick + `$` insert); `ManageSpecialSensors.tsx`; `useFormulaEditor.ts` / `useFormulaValidation.ts` (front-end check + tokenizer); `specialSensorDescribe.ts`. `SensorTooling.tsx`'s builder and `SpecialSensorEditor.tsx` are replaced. Keep dev's repair/edit utilities (`specialSensorRepair.ts`, `specialSensorEdit.ts`, `specialSensorDeps.ts`) as they are in `b044d01`.

---

## Not in this batch / still open

- ~~Auto-converting legacy formulas on load~~ — **decided 2026-10-09: yes**, the user asked dev directly. Shipped in 9476aa2 as `round(X * 100) / 100`.
- **Fonts:** bundle Inter / JetBrains Mono, or accept Segoe UI / Consolas. Open, not part of this batch.
