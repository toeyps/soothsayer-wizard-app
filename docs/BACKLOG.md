# Backlog

Confirmed issues / follow-ups that aren't being worked on yet. Picked up one
at a time, in whatever order matches the actual workflow being built out —
not necessarily top to bottom. Each entry has enough context to resume cold,
without needing the conversation that found it.

---

## ⏸️ WHERE THINGS STAND — 2026-09-03 (read this first on a fresh machine)

Written specifically so this can be picked up on the other machine without
the chat history. Items 11-19 below are all new as of this date.

### ✅ Resolved 2026-09-07 — and it found a real bug

The CSP question below is **answered**: removing `'unsafe-eval'` broke the
Scatter and Pair Plot charts (regl compiles its draw commands at runtime), so
0.4.0 shipped broken and **0.4.1 reverts it**. 0.4.1 was built, installed and
tested on 2026-09-07: line chart, scatter, pair plot, PNG export, a
from-scratch CSV import, workspace persistence across a restart, concurrent
chart+table loading against the release build, closing the app, and the
sensor-colour fix — **all passed**.

**Still untested, deliberately deferred:** training a **Relationship model**,
which is the only path that exercises the bundled Python sidecar. In dev the
sidecar resolves out of `src-tauri/bin/`; in an installed build it sits beside
the exe, so this is genuinely installer-only and cannot be substituted. The
user has not reached the model-building stage of their workflow yet. Nothing
else is known to be at risk.

The historical account below is kept because the trap it describes is worth
knowing about; the conclusion in it about `'unsafe-eval'` being removable is
**wrong** — see `CLAUDE.md`'s CSP section.

<details>
<summary>Original entry (superseded)</summary>

**v0.4.0 is built but its CSP change is unverified, and nothing has been
pushed.**

- Installer: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Wizard_0.4.0_x64-setup.exe`
  (60.3 MB, built 2026-09-03 15:24 from `c266167`). **This file lives on the
  other machine only — it is not in git.** Rebuild with `npm run installer:win`
  if it is not there.
- **17 commits + 2 tags (`v0.3.0`, `v0.4.0`) are unpushed.** Tags need their
  own push (`git push personal v0.3.0 v0.4.0`), a plain `git push` will not
  carry them. Push target is `personal` only — never `origin`.
- **What still needs testing, and why only an installer will do:** 0.4.0
  removed `'unsafe-eval'` from the production `csp` in `tauri.conf.json`.
  Dev mode uses a separate `devCsp` that still allows it, so `tauri dev`
  proves nothing here. Install the .exe and open: **line chart, scatter,
  pair plot, and PNG export**. A chart rendering blank (rather than
  erroring) is the failure mode to watch for.
- If it fails: try `'wasm-unsafe-eval'` in place of `'unsafe-eval'` (narrower
  but still permissive), or revert that one string. Everything else in 0.4.0
  is independent of it.
- Note that `errorReporter` only hooks `error` and `unhandledrejection`, not
  `securitypolicyviolation`, so a CSP block swallowed inside a library will
  not produce a toast or reach
  `%LOCALAPPDATA%\com.prompt-solution.tauri-app\logs\frontend-errors.log`.
  Judge by whether the charts actually draw. (Adding that listener was
  offered and not taken up — it is a ~10-line change if wanted later.)
- The installed binary is `tauri-app.exe`, not `Wizard.exe` — see item 17.

</details>

### ✅ Manual testing already done (2026-09-03, in `tauri dev`)

Everything except the installer pass above: closing the app (both the custom
titlebar X and the OS close, immediately after an edit and after idling),
workspace persistence across close/reopen, concurrent chart+table fetches
after the `Mutex` → `RwLock` change, the Sensor panel's failure-group chips
and search, and the removed "N Rows" badge. One bug came out of it — the
chart colour flicker — which is fixed in `3eac8a4` and **is** included in the
0.4.0 build, but has not been re-tested since the fix.

### 📋 Reported but never analysed — tracked only in Notion

These predate the 2026-09-03 code review and nothing has been looked at yet.
Listed here so they are visible from this file too:

- **"FG page back to dashboard → ACTUAL: back to start program"** — sounds
  like a navigation bug, probably the highest-value one in this group.
- **"distance of lineplot 10 min and 10 hr distance is same"** — the time
  axis may not be scaling to the real interval.
- **"auto selected period time from data (start date and end date), not auto
  start date from date now"**
- **"selected between raw data and sampling data"** — feature request;
  overlaps with item 10 below.
- **"if 1 model in more than one failure group must be train model more than
  1 time"** — status "In progress" in Notion, but no code work has happened.

### ✅ First real tester pass (2026-09-07, ธนัชชา นกดารา) — 156/184 pass, 4 fail, all 4 now closed

184-item run against installed 0.4.1 (or a same-day rebuild carrying the
Manage/Edit special-sensor work — the tester's `ver` field just says "0.4.1"
and no new tag was cut for that work, so which exact commit was in the
installer isn't certain). Full result file: ask the project owner for
`wizard-test-ธนัชชา-นกดารา-2026-09-07 (2).json`. Of the 4 fails:

- **FIL-3 / FIL-1 / FIL-2 (test-plan bug, not app bug)** — reported "must
  click Apply before it returns a value." Traced to `FilterPanel.tsx`: it
  deliberately holds edits in local `draft` state and only commits via
  `onFiltersChange` when **Apply Filter** is clicked (avoids firing a query
  on every keystroke). The test steps just didn't say to click Apply.
  **Fixed** — `MANUAL_TEST_PLAN.md`/`manual-test-plan.html` regenerated with
  an explicit "must click Apply Filter" step on FIL-1/2/3 and a section-level
  note.
- **EDT-11 (test-plan wording, not app bug)** — reported "not have combine
  function." The step asked to make sensor C reference both A and B; for a
  *formula*-kind recipe that's just typing `${A} + ${B}` into the existing
  formula textarea — there is no separate "combine" UI, and the step didn't
  say so explicitly, which likely read as "the feature to do this is
  missing." **Fixed** — step reworded to say "type directly into the Formula
  field, no separate combine button."
- **SPC-6 ✅ fixed 2026-09-08** — the user reported a follow-up detail after
  the first analysis ("no warning appears, but I think I see text flash and
  then disappear") that pinpointed it. Root cause: `SensorTooling.tsx` called
  `engine.build()` directly on every render (`const buildResult =
  engine.build();`) instead of memoizing the result. `engine.build` itself is
  a properly-deps'd `useCallback`, but *calling* it always returns a fresh
  object literal — so two `useEffect`s keyed on `buildResult`
  (`onConfigChange`/`onFormulaSubmit`) re-fired on **any** re-render of this
  component, including ones with nothing to do with the calculation (e.g. the
  parent, `AddSensorWindow`, re-rendering because it just set
  `nameMissing(true)`). `handleConfigChange` unconditionally clears
  `nameMissing` on every call, so the warning got shown for one render and
  wiped by the very next effect flush — reading as "flashes and disappears."
  Fix: `const buildResult = useMemo(() => engine.build(), [engine.build]);`.
  Verified the fix actually catches the regression, not just passes
  incidentally: 2 new tests in `SensorTooling.test.tsx` fail against the
  pre-fix code (confirmed by reverting locally and re-running) and pass
  against the fix.
- **EDT-15 ✅ closed 2026-09-08 — confirmed working on retest, root cause
  unconfirmed**: originally "editing a special sensor's formula updates the
  Line chart but not the Scatter chart." Traced `Dashboard.tsx`'s
  `update-special-sensor` listener, `useScatterSample`'s revision-keyed
  cache (separately unit-tested and passing), `scatterFeed`, and
  `ScatterChart.tsx`'s data-effect end to end without finding a broken link
  — see the reasoning this entry used to carry, kept below for the record.
  User re-tested and reported it now works. This came right after the same
  dev-server session was confirmed stale for the unrelated close-button
  report just above, so the leading theory is the same cause (a stray HMR
  state, not a real defect) rather than the auto-fit-masks-a-pure-scale
  theory below — but that was never independently confirmed, since the
  retest wasn't done with the specific additive-edit repro this entry had
  asked for. No code changed for this item.

  <details><summary>Original investigation notes</summary>

  One real possibility that was being ruled out: **Scatter's axes auto-fit
  to the data extent on every redraw**, so a pure multiplicative formula
  edit (e.g. `* 2` → `* 5`, no offset) can leave the point *shape* looking
  identical even though it redrew correctly — the numeric axis tick labels
  (a separate SVG overlay) should still change, though, so that alone may
  not fully explain "no change at all."
  </details>

### 👀 Close button unresponsive on the Import page (2026-09-08) — confirmed dev-server artifact, not an app bug

User report: the window's X button did nothing while on the "Get started"
(Import) page, but worked normally once inside a workspace's Dashboard.
Traced every close-related path in the source — `TitleBar.tsx`'s close
button (unconditional `appWindow.close()`, same DOM element mounted once at
the `App.tsx` level for both pages, never remounted on navigation), the
titlebar's CSS (`z-index: 9999`, nothing else in the app goes higher), the
`core:window:allow-close`/`allow-destroy` capability grant (unconditional on
the `main` window), and the one place in the whole codebase that intercepts
a close request at all (`Dashboard.tsx`'s `onCloseRequested` handler, which
only exists while Dashboard is mounted — i.e. never on the Import page,
and even then only *delays* a close pending an autosave flush, never blocks
one outright). None of it explains the reported direction of the symptom.

User then restarted the Vite dev server (`npm run tauri dev` fresh, rather
than reusing one left running) and the problem was gone. Confirms this was
a stale dev-server/HMR artifact, not a defect in the app itself — no code
change needed. Left here only so a repeat report isn't re-investigated from
scratch.

### 🐛 Fixed 2026-09-08 — a special sensor's Component field could silently get wiped before creation, landing it in "Uncategorized"

User report: picked a Component for a new special sensor, created it, then
found it filed under "Uncategorized" instead. Traced to
`SensorTooling.tsx`'s selection-change effect: it reset `description`,
`unit`, and `component` alongside the picked operation on **every** change
to `selectedSensors` (adding/removing a raw input sensor while configuring
the calculation). Only the operation reset was actually justified — a
"starting value" or operator config computed for one set of input sensors
genuinely doesn't carry over to a different set — but Description/Unit/
Component describe the sensor being *created*, not which raw sensors feed
it, so nothing about adjusting the input selection makes them wrong. A user
who filled in Component, then tweaked which sensors were selected before
clicking Add, had it silently blanked with no visible cue, and
`AddSensorWindow.computeCurrentRound` defaults an empty component to
`'Uncategorized'` server-side.

Fix: split the effect so `engine.setOperationId(null)`/`setWrapFunc(null)`
still reset on every selection change, but Description/Unit/Component only
reset when the selection drops to **empty** — the same moment
`AddSensorWindow` itself clears `selectedSensors` right after a successful
Add to start the next round with a blank picker. Verified against a real
regression: reverted the fix locally, watched the new test fail exactly as
expected, restored it, watched it pass. Tests +2 in `SensorTooling.test.tsx`
→ 947/947, `tsc`/`eslint` clean.

### 🗂️ Everything else outstanding

Items **11-19** below, added 2026-09-03. Items 9 and 10 remain deferred by
explicit request. Items 1, 3, 5, 6, 7 are resolved; 2 is moot; 4 was never
confirmed; 8 is now fully done (its status block is updated).

---


## 1. FG → Dashboard sync is one-way only

**Resolved (2026-08-06) — moot, not fixed.** `FailureGroupCreation.tsx` was
deleted and its functionality folded into `Dashboard.tsx` (a new "Failure
Groups" tab in the Sensor panel + a read-only summary modal, both backed by
`fgGroups`/`fgRows` React state already living in Dashboard). There is only
one window now, so there is nothing to sync between — the two-window race
this item described can't happen anymore. Left below for historical
context; not something that needed a code fix in the end.

**Found:** 2026-08-03, while testing the Dashboard-side failure-group
assignment feature against `FailureGroupCreation.tsx`.

**Problem:** `Dashboard.tsx` emits `failure-group-updated` after every
assign/rename/delete it makes, and `FailureGroupCreation.tsx` listens for
it — but nothing goes the other way. `FailureGroupCreation.tsx` never emits
that event after its own autosave, so if the FG window deletes/renames/moves
a sensor, Dashboard's in-memory `fgGroups`/`fgRows` (read once at mount)
never refreshes. Confirmed via `grep -n "failure-group-updated"` across both
files — only one `emit`, one `listen`, both on the same side.

**Proposed fix:**
- `FailureGroupCreation.tsx`: after its debounced autosave effect writes
  `failureGroupState` to disk, also `emit('failure-group-updated')` —
  mirrors what `Dashboard.tsx` already does.
- `Dashboard.tsx`: add a `listen('failure-group-updated', ...)` effect that
  `loadWorkspaceData(initialState.id)` and `setFgGroups`/`setFgRows` from the
  result — mirrors the listener that already exists in
  `FailureGroupCreation.tsx`.

**Residual risk (not fixed by the above, lower priority):** both windows
write the whole `failureGroupState` object wholesale, not merged per
group/row. If both windows write within the same ~250ms window (FG's
autosave debounce), whichever write lands last wins outright, even if it's
based on slightly stale in-memory state. Real-world odds are low (needs the
user actively editing both windows within the same quarter-second), so this
is parked, not scheduled — revisit only if it's actually hit in practice.

---

## 2. FailureGroupCreation.tsx's "ASSIGNED GROUP" panel is single-select

**Resolved (2026-08-06) — moot, not fixed.** `FailureGroupCreation.tsx`
(the file this item is about) was deleted; its replacement,
`FailureGroupsPanel.tsx` (new Failure Groups tab in the Dashboard's Sensor
panel), was built directly on the multi-group row model from the start —
adding a sensor to a group creates a new `FailureSensorRow` for that
(tag, group) pair rather than overwriting one row's `groupNo`, so the
single-select "move" behavior this item describes was never reproduced.
Left below for historical context.

**Found:** 2026-08-03, right after building multi-group support into the
Dashboard's Sensor tab.

**Problem:** The Configure panel's "ASSIGNED GROUP" chips
(`FailureGroupCreation.tsx`, `fg-group-chip-grid` section) call
`updateRow(selectedRow.id, 'groupNo', g.no)` — this **moves** the currently
selected row to a different group by overwriting its single `groupNo`
field. It's built on the original one-row-per-sensor data model, so from
inside this window a sensor can still only ever belong to one group at a
time — inconsistent with the Dashboard side, where a sensor can now hold
multiple `FailureSensorRow` entries (one per group).

**Proposed fix:** Change the chip click behavior from "move" to "toggle":
- Click an inactive group chip → create a **new** row for that (tag, group)
  pair instead of overwriting the current one.
- Click an already-active chip (that isn't the row currently focused) →
  delete that row.

**Open question — needs the user's call before implementing:** the
Configure panel's other fields (Concept Sensor, Model Type, Model Notes,
Additional Notes, Status) are currently scoped to the one selected `row`. If
a sensor has rows in multiple groups, should each row keep independent
values for these fields (current behavior, no change needed — the panel
would just be showing/editing whichever row's chip you clicked), or should
they be shared/synced across every group a sensor belongs to? Leaning
toward "independent per row" since notes/model type plausibly differ by
failure context, but not decided yet.

---

## 3. "Ready / Pending" status toggle on sensor chips isn't self-explanatory

**Resolved** (exact date unclear — a side effect of the wider Build Model
redesign, not a dedicated fix pass; re-verified 2026-09-01 against current
code). `FailureGroupCreation.tsx` itself is long gone; its successor,
`BuildModelWindow.tsx`, renders the control as a pill that shows its own
state as text directly on the button — `model-status-pill--complete` /
`--incomplete` with the label `{model.status ? 'Complete' : 'Incomplete'}`
(`BuildModelWindow.tsx:640-643`) — not a bare unlabeled switch. The
original complaint (no indication of what flipping it means) no longer
applies.

**Found:** 2026-08-03, walking through `FailureGroupCreation.tsx`'s sensor
chip UI.

**What it is today:** each sensor chip has a toggle switch bound to
`row.status: boolean` (`FailureGroupCreation.tsx`, the `fg-status-switch`
markup, ~line 942). It's a manual, user-set checkbox meaning "I've finished
configuring this sensor" (Ready) vs "still in progress" (Pending) — nothing
validates it against whether Concept Sensor / Model Type / Notes are
actually filled in. It drives: the chip's dimmed/disabled styling when
Pending, the "MODELS READY" / "PENDING" counters in the top stats bar, and
the "COMPLETION %" bar.

**Problem:** the toggle itself gives no indication of what flipping it
means or what it affects — a first-time user has no way to tell it's a
self-reported "I'm done with this one" marker rather than some kind of
validation or enable/disable switch.

**Next step:** not a fix yet — needs a redesign session to figure out
better affordance (label, tooltip, icon, or a different control entirely)
before touching the implementation.

---

## 4. Raw mode feels slower than Aggregated mode, despite both rendering the same 4,000 points

**Status re-checked 2026-09-01: main hypothesis still NOT confirmed or
fixed** — nothing in the current code addresses the canvas-repaint-cost
theory below. **The small side-finding IS moot now** (not because it was
fixed, but because its target no longer exists): the whole "Data Insight"
tab and its `useTablePage` query were removed entirely on 2026-08-16 (unit
economics didn't justify keeping a tab nobody used — see
`PROJECT_HANDOVER.md`), so there's no `activeDataTab === 'insight'` gate
to add anymore. The main perf question this item is actually about
remains open.

**Found:** 2026-08-05, user reported the Line Chart feels noticeably less
responsive in Raw sampling than in Aggregated (e.g. hourly avg) — more
pronounced with more sensors selected (8 in the reported case) — even though
`get_chart_data`'s `decimate()` caps both at the exact same `max_points`
(4,000).

**Ruled out (confirmed, not the cause):**
- Frontend ECharts config is identical either way — `isLargeData` in
  `LineChart.tsx:97` is computed from `xData.length`, which is 4,000 in both
  modes, so animation/smoothing/LTTB toggle the same regardless of sampling.
- Backend compute cost actually runs the OTHER direction from the reported
  symptom: Aggregated does strictly more backend work than Raw —
  `aggregate_hourly()` (`chart_query.rs:395`) is single-threaded (no rayon),
  folding the full filtered population into an hourly `BTreeMap` BEFORE the
  parallel `decimate()` even runs, and that same fold re-runs a second time
  for `get_table_page` (`Dashboard.tsx:752` calls `useTablePage`
  unconditionally, not gated on the Data Insight tab being active — confirmed
  via read, not gated). Raw skips the fold and decimates the full population
  directly in parallel via `rayon::into_par_iter()`. So Raw should be cheaper
  server-side, which is the opposite of what's felt — this backend-cost
  angle does not explain the symptom and was a dead end.

**Leading hypothesis (reasoned from code + the user's own earlier
screenshots, NOT profiled — this app can't be opened in the Browser pane to
measure):** the cost that actually dominates *felt* speed is frontend canvas
repaint during interaction (hover, dataZoom drag, resize), which recurs
continuously — unlike the one-shot backend fetch, which only runs once per
filter/sampling change. Raw's `decimate()` picks bucket min AND max from
noisy raw sensor data, producing a dense zigzag line (visible in earlier
screenshots as a thick fuzzy band); Aggregated averages away the noise
*before* decimating, producing a comparatively smooth line at the same point
count. Canvas rasterization cost scales with path complexity / overdraw
area, not just vertex count, so the zigzag likely costs more to repaint per
frame — and with multiple overlapping series (8 sensors), the effect
compounds, matching the "more sensors → more noticeable" observation.
Corroborating (not conclusive) evidence: `LineChart.tsx:139-144` already has
a prior comment from the original authors about redraw cost recurring "per
mousemove... the whole time the user hovers the chart" — i.e. this general
class of cost was already a known concern in this file before this
investigation.

**How to actually confirm before touching anything:** open WebView2 DevTools
in a dev build and compare the Performance tab's Rendering/Painting time
during hover + dataZoom drag, Raw vs Aggregated, same sensor set. If painting
time doesn't differ, the hypothesis is wrong and this needs a fresh look.

**Possible fixes, if confirmed (not decided, needs the user's call):**
- Thinner/simplified stroke rendering specifically for Raw mode's dense
  zigzag (current `lineStyle.width` is already `0.8` under `isLargeData`, so
  there may be limited room left).
- Lower `max_points` automatically as selected-sensor count grows, so total
  on-screen ink stays roughly constant regardless of series count.

**Also found in passing, independent of the above (small, real, cheap to
fix separately):** `get_table_page` fires on every filter/sampling change
even when the Data Insight tab isn't the active one — pure wasted backend
work today, unrelated to the render-cost hypothesis above. Gate
`useTablePage`'s query on `activeDataTab === 'insight'` in `Dashboard.tsx`
whenever this gets picked up.

---

## 5. Pair Plot floods uncaught "(regl) context lost" errors with enough sensors selected

**Resolved — but via a different mechanism than either tier proposed
below.** Corrected 2026-09-01: an earlier re-check of this file only
looked for tier 1's exact proposed fix (a `webglcontextlost` listener,
still genuinely absent) and wrongly called the item still-open on that
basis — the user pointed out sensor count was capped instead, which
*is* the real fix. `MAX_PAIR_PLOT_SENSORS = 4` (`ChartTypes.ts:12`) is
enforced as a hard cap in multiple places — `SensorSelection`'s
`maxSelectable` prop, and `Dashboard.tsx`/`PairPlotChart.tsx` both
blocking Pair Plot mode outright above it — bounding total WebGL
contexts at `n(n+1)/2 = 10` for `n=4`, down from the uncapped 36 at
`n=8` from the original report. `PairPlotCell.tsx:185`'s own comment
references `MAX_PAIR_PLOT_SENSORS` specifically in the context-count
discussion, confirming the cap was added *because of* this item, not
coincidentally. This satisfies (and goes further than) tier 2's own
"~5 sensors (15 contexts)" proposal below. Tier 1's reactive listener
(catching a context loss if the cap still isn't enough headroom on a
weak GPU) was never added — left as a possible defense-in-depth
follow-up, not required for this item to count as done.

**Found:** 2026-08-06, user hit a runtime error overlay showing `UNCAUGHT
×65254` / `(regl) context lost`, stack trace bottoming out in
`regl-scatterplot`'s internal `handleRAF` loop, while using Pair Plot.
Confirmed unrelated to the same-day scatter-axes-persistence fix — neither
`PairPlotChart.tsx` nor `PairPlotCell.tsx` was touched by that change.

**Root cause (two parts):**
1. **Too many concurrent WebGL contexts.** `PairPlotCell.tsx` creates one
   `regl-scatterplot` instance (= one WebGL context) per cell — every
   upper-triangle scatter cell plus one timeseries cell per row. Only the
   diagonal is plain SVG (`PairPlotChart.tsx:55-56` comment says so
   explicitly). Total contexts = `n(n+1)/2` for `n` selected sensors: 4→10,
   5→15, 6→21, 8→36. Browsers (Chromium/WebView2 included) evict old WebGL
   contexts once a page exceeds an implementation-defined budget — commonly
   cited in the 8–16 range, lower on weak/integrated GPUs. Opening the
   magnifier (`expanded` dialog) adds one more context on top of the
   still-mounted matrix behind it, pushing the count higher still.
2. **No context-loss handling in `PairPlotCell.tsx`.** `ScatterChart.tsx`
   already has a `webglcontextlost`/`webglcontextrestored` listener
   (`ScatterChart.tsx:290-293`) that calls `preventDefault()` and shows a
   Retry overlay. `PairPlotCell.tsx`'s instance-creation effect
   (`PairPlotCell.tsx:190-290`) has no such listener at all. When a cell's
   context gets evicted, nothing intercepts it — `regl-scatterplot`'s
   internal render loop keeps trying to render the dead context every
   animation frame and keeps throwing, uncaught, forever. That's the flood.

**Proposed fix (two tiers, not started):**
1. **Do first, low risk:** add the same `webglcontextlost`/
   `webglcontextrestored` guard to `PairPlotCell.tsx` that `ScatterChart.tsx`
   already has, reusing the existing `initError` overlay pattern in the same
   file for the lost-context state. Stops the crash/flood outright; doesn't
   reduce how many contexts get created.
2. **Optional follow-up:** a soft warning (not a hard block) when the
   selected sensor count would push Pair Plot's context count past a rough
   safety margin — discussed as ~5 sensors (15 contexts) as a reasonable
   cutoff, leaving headroom under the commonly-cited ~8 floor for weak GPUs.
   Not a guarantee (the real per-device limit is opaque), just a heuristic
   nudge alongside tier 1's guard.

**Library-swap question (asked and answered, not pursued for now):** user
asked whether switching the pair-plot library would fix this. Answer: only
if the replacement changes the *architecture*, not just the library name —
swapping to another per-cell WebGL library (e.g. deck.gl or Plotly scattergl
instantiated once per cell) hits the exact same context-count ceiling. Two
approaches that would actually fix the root cause: (a) one shared WebGL
context for the whole matrix with each cell drawn into a scissored viewport
(biggest rewrite — bypasses regl-scatterplot's high-level per-instance API
entirely), or (b) drop Pair Plot to Canvas 2D rendering (e.g. reuse ECharts,
already a dependency and already proven on the Line chart's point volumes)
to sidestep the WebGL context limit altogether. Both are bigger lifts than
tier 1/2 above and were explicitly deferred — **user said to fix this
later, parking as backlog for now.**

---

## 6. Moving Average / Rate of Change need real backend implementation

**Resolved by decision, 2026-09-01 — not by implementing them.** Corrected
after the user clarified: these were never wired to anything real to
begin with (see "Context" below — the old dropdown entries silently did
nothing when picked), so there's no live feature depending on them.
Decision is to leave them removed rather than build real backend support
— confirmed via re-grep, `moving_avg`/`rate_of_change` are correctly
absent everywhere (Rust and TypeScript both), matching the 2026-08-09
removal described below. The open questions about the exact formula
(below) are moot now — nothing to check with a stakeholder for a feature
that isn't being built. Revisit only if a real user need for either comes
up later; this item itself needs no further action.

**Found:** 2026-08-09, while redesigning the Add Special Sensor window
(`AddSensorWindow.tsx`/`SensorTooling.tsx`) to fix a whitelist bug where
several operations silently did nothing when selected.

**Status: genuinely needed, blocked on the user checking with their own
stakeholder for the exact formula — do not implement with a guessed
default.**

**Context:** the old operation registry (`src/config/operations.ts`) listed
`moving_avg` and `rate_of_change` under "multi" operations, but neither was
ever implemented in the Rust backend (`operation_registry.rs`'s
`build_multi_ops()` only has sum/mean/median/product) — selecting either in
the old Simple Calc dropdown built a config `buildLegacyConfig()` silently
rejected, so `calculate_new_sensor` was never even called and the sensor
was added with no calculation applied at all, no error shown. Both were
removed from the registry and the redesigned Add Special Sensor UI as part
of the 2026-08-09 redesign, pending real implementation.

**Why they don't fit the existing operation model:** every other operation
in the registry (add/subtract/abs/sqrt/sum/mean/etc.) computes a result from
value(s) at a single row — `execute_single_op`/`execute_multi_op` in
`operation_registry.rs` operate one row at a time with no memory of
neighboring rows. Moving Average and Rate of Change both need a *window of
rows over time* for one sensor's own history — architecturally closer to
`chart_query.rs`'s hourly aggregation than to the row-wise operation
registry. They also conceptually only need **one sensor** (their own past
values), not a second sensor to combine with — in the redesigned UI they
belong under the single-sensor operations (a new "Time-based" group next to
"Combine with a number" / "Transform"), not the multi-sensor group they
were filed under previously.

**Open questions — asked the user, they need to check with their own
stakeholder before answering:**
1. **Rate of Change formula:** plain successive difference
   (`value[i] − value[i-1]`, no time unit) or a true per-time rate
   (`(value[i] − value[i-1]) / elapsed_time`, e.g. °C/min)? If the latter,
   which time unit (per second / per minute / per hour)?
2. **Moving Average window:** sized by sample count (e.g. "trailing 10
   rows", matches the old registry's `window_size` default of 10) or by
   real elapsed time (e.g. "trailing 10 minutes", robust to irregular
   sampling but adds complexity)?

**Proposed next step once answered:** implement as new single-sensor
operations. Needs a new Rust code path (not a fit for
`execute_single_op`'s per-value signature) that reads the full column for
the selected sensor plus `ts_parsed` if a time-based window/rate is chosen,
computes the rolling result, and returns a new column the same way
`calculate_new_sensor` does today. Update `src/types/commands.ts` first
(contract-first, per `CLAUDE.md`) if the shape doesn't fit the existing
`calculate_new_sensor` command's `SensorOperationConfig`.

---

## 7. Sensors created via "Add Special Sensor" don't survive closing and reopening the app

**Resolved (2026-09-01)**, via the "recipe replay" approach discussed
below (option 2) — commits `f9eba47`, `787d97e`, `c34d6ed`. Two separate
bugs turned out to be stacked on top of each other, found across two
rounds of real-app testing with the user:

1. **The actual data loss** (this item's original root cause, confirmed
   below): fixed by persisting a `SpecialSensorRecipe` per calculated
   sensor (formula string, or source sensors + `SensorOperationConfig`) in
   `WorkspaceState.specialSensorRecipes`, then replaying each one — in
   creation order, since a later sensor can reference an earlier one — via
   `DataUploadPage.tsx`'s `replaySpecialSensorRecipes()`, called right
   after `load_csv` on every workspace reopen, before Dashboard ever
   queries chart data. A recipe that fails to replay (source sensor
   renamed/removed since) is skipped, not fatal, and surfaces as one
   combined toast via the existing `reportError()`/`<ErrorToasts />`
   mechanism (confirmed with the user via `AskUserQuestion` before
   implementing — silent log vs. visible toast).
2. **A second, unrelated bug this uncovered once #1 was fixed**: even
   with the Rust-side data restored, the special sensor was still
   completely absent from the Sensor tab's tree/search — `sensorHeaders`
   (the list `SensorSelection` reads) was only ever seeded from the raw
   CSV headers on mount, never merged with `extraSensorMetadata`. Fixed
   by deriving a new `allSensorTags` memo (`sensorHeaders` ∪
   `selectedSensors` ∪ `extraSensorMetadata` tags) that every consumer
   (`SensorSelection`, the tab's sensor count, `AddSensorWindow`'s own
   picker, Build Model's sensor dropdowns) now reads instead of
   `sensorHeaders` directly — structural fix rather than chasing one
   more imperative-sync gap, since a live repro (building a special
   sensor from an already-special one, same session, no restart
   involved) couldn't be pinned to an exact line from static reading
   alone in an environment that can't run the actual Tauri app
   interactively.

Both confirmed fixed by the user testing the real app after each round.

> **📋 2026-08-06 — superseded by [`docs/PERSISTENCE_PLAN.md`](PERSISTENCE_PLAN.md).**
> That doc has a full project-wide audit (this turned out to be the ONLY
> place where actual *data* is lost, but there are 6 more places where
> *config* is lost), three additional approaches beyond the two recorded
> below (Arrow/Parquet snapshot, sidecar column file, DuckDB), a
> recommendation with reasoning, and a phased implementation plan. Read
> that first — the two options below are still accurate but incomplete.
>
> One thing below is now **out of date**: it says master data would need
> writing back to the mapping CSV. `extraSensorMetadata` was added to
> `WorkspaceState` after this entry was written, so master data already
> persists correctly — only the raw values need solving.

**Status: confirmed real, root cause identified, fix approach not decided
yet — user wants to think about it, revisit last.**

**Found:** 2026-08-09, while redesigning the Add Special Sensor window.
User reported that after creating a calculated sensor, closing the app, and
reopening the same workspace, the sensor still *appears* selected (its name
survives in `WorkspaceState.selectedSensors` and now
`extraSensorMetadata`), and its entry stays visible in the Selected Sensor
panel on the chart — but it's gone from the Sensor tab's full tree, and the
underlying data is actually gone too, not just the list entry.

**Root cause (confirmed by reading the code, not guessed):**
`calculate_new_sensor` / `evaluate_formula` (`lib.rs`) push the new column
straight into the in-RAM `ColumnarData` held in Tauri's managed state —
nothing is written to disk. On every workspace resume, `load_csv`
(`lib.rs:215-230`) does `*state_lock = Some(SessionData { data:
merge_result.data, paths })` — a full replacement built by re-parsing the
original CSV files from `WorkspaceState.dataFilePaths`. Any column that
didn't come from those files (i.e. every calculated sensor) is gone the
moment `load_csv` runs again. The frontend's memory of the sensor's
name/metadata survives (it's in the workspace JSON), which is what makes it
*look* like it's "still there" until you actually query its data.

**Two approaches discussed with the user:**

1. **Write real data back to the source files on disk.** For the mapping
   CSV (master data: tag/description/unit/component) this is low-risk and
   was tentatively agreed to *in principle* — it's a small file, and the
   resume flow (`DataUploadPage.tsx`'s `handleLoadWorkspace`, per the
   `2026-08-09` investigation elsewhere in this session) already re-parses
   the mapping CSV fresh on every load via `load_mapping_csv` +
   `apply_sensor_mapping` + `buildSensorMetadataFromMapping` — appending a
   row there would need no other plumbing to be picked up automatically.
   For the **raw time-series CSV**, writing back was explicitly **not**
   recommended: files can be up to the app's 2 GB/file cap, a crash or
   power loss mid-rewrite risks corrupting the user's original (often
   irreplaceable) sensor export, it's unclear which file a derived column
   should be written into when a workspace merges multiple CSVs by
   timestamp, and it cuts against this app's existing design rule that
   user-selected source files are never mutated (`CLAUDE.md`: writes only
   ever go through `write_user_file`, to `$APPDATA`-scoped or
   explicitly-user-chosen export paths — never back onto an input file).

2. **Persist the calculation "recipe" (formula/config), replay it after
   every `load_csv`.** Store, per created sensor, enough to recreate it —
   either the formula string (`evaluate_formula` path) or the
   `SensorOperationConfig` + source sensors (`calculate_new_sensor` path) —
   and after every workspace resume, once the raw CSV is loaded, replay
   these in the order they were created (matters if one calculated sensor
   was built from another) before the Dashboard's charts try to query them.
   Never touches any file the user didn't explicitly choose to export to;
   from the user's point of view the result is indistinguishable from "the
   CSV just had the data already."

**Where the conversation landed:** user leaned toward liking the mapping-CSV
write-back for master data + recipe-replay for the raw values (asked
"เห็นด้วยไหม" and got a real answer), but then decided to defer the whole
thing — **"เดี๋ยวค่อยทำดีกว่า เอาไว้ทีหลังสุดเลย ผมยังหาแนวทางไม่ได้"**
(wants to think about the approach more, pick this up last). Nothing
implemented yet. When resumed: confirm which of the two pieces (master-data
write-back, raw-value recipe-replay) to build, or both, before touching
code — this is the kind of decision that's expensive to reverse once
workspace files in the wild start depending on whichever shape gets picked.

---

## 8. Autosave debounce has no flush-before-close — a change made in the last 250ms before quitting can be lost

**Resolved.** Implemented 2026-09-01 per the "Proposed fix" below, and the
real-app close testing it was waiting on was done on 2026-09-03 (closing
immediately after an edit, closing after idling, via both the custom titlebar
X and the OS close) — all passed. Note the follow-up bug this caused and its
fix: the first attempt made the window impossible to close at all, because
Tauri needs the `core:window:allow-destroy` permission once anything
registers an `onCloseRequested` handler (commit `f7889aa`). `Dashboard.tsx` now
tracks the currently-scheduled autosave as a promise
(`pendingSaveRef`), and a new `onCloseRequested` handler on the main
window checks it: if something is still pending, `preventDefault()`s the
close, awaits the flush, then calls `.close()` itself; if nothing is
pending, the handler does nothing and the close proceeds exactly as
before (no added delay on the common case). Unit tests cover both paths
(`Dashboard.test.tsx`'s "close-flush" describe block) with a mocked
`getCurrentWindow()`, but — same caveat the original "why not fixed in
the same pass" section below already called out — this specific class of
bug (get it wrong and the window becomes impossible to close at all) is
exactly the kind unit tests can't fully substitute for a real close.
**Needs an actual close via both the custom titlebar button and the
native OS close control, inside and outside the 250ms window, before
this is confidently done.**

**2026-09-01, same day — hit exactly the predicted failure mode on the
first real-app test: the window became impossible to close at all**,
confirming the risk called out above wasn't hypothetical. Error toast:
`window.destroy not allowed. Permissions associated with this command:
core:window:allow-destroy`, repeated (×4, ×2) — happened on every close
attempt, regardless of whether anything was actually pending.

**Root cause:** `Window.close()` (the JS API) invokes `plugin:window|close`,
which re-emits `closeRequested` rather than closing directly — that's
what makes "prevent, flush, call `.close()` again" the correct pattern in
the first place (confirmed against Tauri's own `onCloseRequested` docs).
Once nothing is pending on the second pass, the Rust core finalizes the
close by destroying the window — and *that* internal step requires the
`core:window:allow-destroy` permission, which had never been needed
before because no window in this app had ever registered an
`onCloseRequested` listener at all (every close used to go through
Tauri's un-intercepted default path, which apparently doesn't hit the
same permission check). `src-tauri/capabilities/default.json` (covering
`main`/`save-as`/`build-model`) had `core:window:allow-close` but not
`core:window:allow-destroy` — added the missing permission; `cargo check`
confirms the capabilities file is still valid.

**Still not confidently done** — this class of bug is exactly what
needed a real close to surface at all (unit tests, which mock
`getCurrentWindow()` entirely, had no way to catch a missing OS-level
permission). Needs another real close-app round before this is
considered finished.

**Found:** performance audit requested by the user across the whole app
(2026-08-15). `Dashboard.tsx`'s autosave effect used to call
`saveWorkspaceData(buildWorkspaceState())` on every single tracked state
change with no debounce at all — a real disk-I/O cost (every keystroke in a
Filter value box, every drag-tick while resizing a panel, etc. each
triggered an immediate `JSON.stringify` + `writeTextFile`). Fixed by adding
a 250ms debounce (`AUTOSAVE_DEBOUNCE_MS`), matching the same pattern already
used by `useChartData`/`useScatterSample`/`useTablePage` for backend
queries — see the `useEffect` around `AUTOSAVE_DEBOUNCE_MS` in
`Dashboard.tsx`.

**Residual risk introduced by that fix (not present before):** with the
debounce in place, there's now up to a 250ms window after any edit where
the change exists only in React state, not yet on disk. If the user closes
the app within that window, the change is lost — the workspace still
resumes correctly, just one edit behind. Checked the whole codebase for an
existing "flush pending work before the window actually closes" mechanism
(Tauri v2's `getCurrentWindow().onCloseRequested(...)`, which lets you
`preventDefault()`, await async work, then close manually) — **there isn't
one anywhere**, not just for autosave. `PredictiveModelBuild.tsx` even has
an explicit comment confirming this: "No `onCloseRequested` handler — let
close proceed unconditionally."

**Why not fixed in the same pass:** adding a close-intercept touches window
lifecycle behavior that's hard to verify without interactively closing the
real app (get it wrong — e.g. a handler that `preventDefault()`s but never
actually calls `.close()` after the flush — and the window becomes
impossible to close normally, which is a much worse regression than losing
up to 250ms of the last edit). Scoped down to just the debounce, which was
the actual ask.

**User's call:** explicitly deferred — **"เขียนทิ้งไว้ใน backlog แต่ยังไม่
ต้องทำตรงนี้ เดี๋ยวผมมาแก้ปัญหาทีหลัง"** (note it in the backlog, don't fix
it now, will come back to it later).

**Proposed fix, when picked up:** add `onCloseRequested` to the **main**
window only (where `Dashboard.tsx` lives — sub-windows like Predictive
Model / Add Sensor don't own workspace state). Track whether a debounced
save is currently pending (e.g. a ref flipped by the same effect that sets
the timer); if one is pending when close is requested, `preventDefault()`,
await the flush (`saveWorkspaceData` on the latest state), then call
`getCurrentWindow().close()` to let it actually close. Test manually via a
real close (custom titlebar button in `TitleBar.tsx` + the native OS close
control) after an edit, both inside and outside the 250ms window, before
considering this done — this is exactly the kind of change unit tests
can't fully cover.

---

## 9. `echarts` bundle chunk exceeds Vite's 500kB warning threshold

**Found:** 2026-09-01, during a full dead-code/unused-export audit
(`knip` + `tsc --noEmit` + `cargo clippy`) requested by the user. `npm run
build` reports `assets/echarts-*.js` at **1.14MB (381KB gzip)** — Vite's
default chunk-size-warning threshold is 500kB.

**Status: not a pressing problem today, explicitly deferred by the
user — "เขียนทิ้งไว้ใน backlog กับ notion ด้วย แต่ยังไม่ทำนะ".**

**Context that matters before touching this:** the app already does the
one optimization that matters most — `App.tsx:9` lazy-loads `Dashboard`
specifically so `echarts` + `regl-scatterplot` (the two heaviest deps)
stay out of the initial bundle the upload screen has to parse:

> "Dashboard pulls in echarts + regl-scatterplot (the app's two heaviest
> dependencies) — deferring it until a workspace is actually open keeps
> those out of the initial bundle the upload screen has to parse."

Since this is a Tauri desktop app (assets ship inside the installer, not
fetched over the network on every launch), the usual "large chunk = slow
page load" framing mostly doesn't apply here. What actually remains:
- A brief parse/execute delay the *first* time a workspace is opened in a
  session (the lazy chunk has to be parsed before Dashboard finishes
  mounting) — not on every subsequent workspace open in the same session.
- Installer size, and update-package size if an auto-updater is ever
  added.
- RAM once parsed — but echarts needs that memory regardless of how many
  pieces it's split into, since it's genuinely in use once a chart shows.

**If picked up:** split `echarts` further by chart type actually used
(Line/Scatter/Pair Plot each pull in different pieces today) rather than
one monolithic chunk — bigger lift, touches `components/charts/*` import
boundaries, and trades bundle size for more moving parts to maintain. Only
worth it if a user actually reports the first-workspace-open delay as
noticeable — not before.

---

## 10. Line chart plots a downsampled preview even at full raw-data resolution — no way to actually see every row without narrowing the time range

**Status: deferred by the user — "เก็บเป็น backlog ไว้เดี๋ยวผมทำทีหลัง"
(2026-09-01). Design agreed in conversation, not started.**

**Found:** 2026-09-01, user asked how to plot the Line chart without any
resampling at all. Investigated the actual mechanism and options with
them before they picked a direction.

**Current behavior (confirmed by reading the code):** `get_chart_data`'s
`decimate()` (`chart_query.rs`) always caps the Line chart at
`LINE_MAX_POINTS` (4,000) regardless of how much of the filtered
population it represents — for the reported case, 4,000 points standing
in for 159,264 rows. The chart's own interactive zoom
(`LineChart.tsx:677`'s `dataZoom`, both the `inside` scroll/pinch gesture
and the bottom `slider`) is **purely a client-side ECharts feature** —
confirmed via grep, there's no listener anywhere that turns a zoom
gesture into a new backend query. Zooming in today just stretches the
same already-decimated 4,000 points; it never reveals more real detail,
which the user hadn't realized until this was pointed out.

**Options discussed (five), with the user's own words on the risk that
matters most:**
1. Remove the cap entirely — real crash/freeze risk on large files (app
   supports CSVs up to 2GB, this dataset's 159k rows is nowhere near the
   worst case), rejected implicitly by not being the direction chosen.
2. Switch the Line chart to ECharts' `large`/WebGL rendering mode —
   raises the practical ceiling a lot, but ECharts may still sample
   internally at very large row counts, so it doesn't guarantee "zero
   resampling, ever." Not chosen, but not ruled out as a *complementary*
   future improvement on top of #3.
3. **Chosen direction — level-of-detail: re-fetch a decimated view scoped
   to the current zoom window instead of stretching a fixed one.** Same
   4,000-point cap applies, but now against a narrower time range, so
   resolution increases as the user zooms in — and once the zoomed
   window's actual row count drops to ≤ 4,000, `decimate()` becomes a
   no-op and the chart is showing 100% raw, unmodified data. This is the
   same technique tools like Grafana use. Confirmed with the user this
   correctly describes what they were picturing.
4. Just raise the cap moderately (e.g. 4,000 → 20-50k) — simplest,
   lowest-risk, but not discussed further once #3 was chosen as the real
   fix; still worth doing as a cheap complement regardless.
5. Rewrite the Line chart onto the same WebGL point-renderer
   (`regl-scatterplot`) already used for Scatter/Pair Plot — explicitly
   the biggest lift (axis formatting, tooltips, alarm mark-lines,
   per-sensor colors are all ECharts-specific today) and not pursued.

**The redesign problem that came up once #3 was picked:** the app has
**three separate ways to change the visible time range**, and only two of
them are safe to wire straight into a backend refetch:
1. The "Time Range" text inputs (top of Dashboard) — discrete, already
   drives `filters.timestampStart/End` → `useChartData` refetches. Fine
   as-is.
2. The relative-range quick-select buttons (Y/M/W/D/H + amount) — also
   discrete, same `filters` pipeline. Fine as-is.
3. **The chart's own interactive zoom (drag the slider, scroll/pinch
   inside the plot)** — continuous, fires on every intermediate step of a
   drag gesture (comparable to `mousemove` frequency). User specifically
   flagged this as "the biggest problem" — correctly: wiring every
   intermediate `dataZoom` event straight to a Rust `invoke` would hammer
   the backend during a single drag.

**Proposed fix, when picked up:**
- Route path 3 through the *same* `filters.timestampStart/End` state
  paths 1 and 2 already write to — no new/parallel state, no new fetch
  code path, it just becomes a third writer into the existing pipeline
  `useChartData` already reacts to.
- **Debounce only path 3's write into `filters`** (~300-500ms after the
  zoom gesture settles) — same debounce shape already used elsewhere in
  this app (`AUTOSAVE_DEBOUNCE_MS`, the existing filter-driven
  `useChartData`/`useScatterSample`/`useTablePage` debounces), just a new
  trigger source. During the drag itself, ECharts keeps handling the
  live visual pan/zoom entirely client-side against whatever's already
  loaded — exactly today's behavior, no backend calls — so nothing about
  drag responsiveness changes. Only once the user stops does one fetch
  land, at the new (narrower, more detailed) range.
- Sync the "Time Range" text inputs to reflect the zoomed range too once
  it commits, so all three controls stay showing the same state instead
  of the inputs silently going stale while the chart itself has zoomed.
- Natural correctness check once built: zoom in far enough that the
  visible window's row count drops below `LINE_MAX_POINTS` and confirm
  the chart is now reading genuinely raw (non-decimated) data — same
  "escape hatch" reasoning discussed with the user, not something to
  special-case in code, it just falls out of reusing `decimate()`
  unchanged.
- Worth deciding alongside this (not blocking it): whether Scatter/Pair
  Plot's own sampling (`useScatterSample`, a different reservoir-sampling
  mechanism, not `decimate()`) should get the same zoom-to-refetch
  treatment, or whether this item is Line-chart-only for now.

---

## 11. Seven real `react-hooks/exhaustive-deps` findings, newly visible

**Status: found 2026-09-03 the moment ESLint was installed for the first
time. Not touched — each one needs its own judgement call, and adding a
dependency can turn a one-shot effect into a loop.**

ESLint had never been installed in this project, yet eleven
`// eslint-disable-next-line react-hooks/exhaustive-deps` comments were
scattered through the code — suppressions for a linter that never ran. With
`eslint.config.js` in place (`npm run lint`), 51 warnings remain, of which
these seven are the ones worth reasoning about:

| Where | Finding |
|---|---|
| `ScatterChart.tsx:427` | missing dep `resetDraw` |
| `ScatterChart.tsx:749` | unnecessary dep `visibleBounds` on a `useMemo` |
| `FilterPanel.tsx:170` | missing dep `draft` |
| `PredictiveModelBuild.tsx:759` | missing dep `dashboardFilterPayload` |
| `PredictiveModelBuild.tsx:784` | missing dep `dashboardFilterPayload` |
| `SensorTooling.tsx:84` | missing dep `engine` |
| `LineChart.test.tsx:36` | missing dep `props` (test harness, low value) |

The other 44 warnings are recorded debt, deliberately left as warnings so
`npm run lint` exits 0 and CI can gate on errors: 39 `no-explicit-any` and
5 `no-useless-assignment` (defensive initialisers that every branch
overwrites — removing them is churn, not a fix).

**How to approach:** one at a time, and for each decide whether the omission
was deliberate. Three similar-looking cases were already resolved this way on
2026-09-03: `useChartData` / `useScatterSample` / `useTablePage` all warn
about reading `fetchIdRef.current` in cleanup, which is a false positive —
that advice is written for refs holding DOM nodes, while these hold a
monotonic race-guard counter whose live value the cleanup must see. They now
carry documented suppressions. Expect some of the seven to be the same kind
of intentional omission; the ones that are not are exactly the stale-closure
bugs this project has hit repeatedly.

---

## 12. `PredictiveModelBuild.tsx` and `Dashboard.tsx` are too large to reason about

**Status: identified 2026-09-03 during the project-wide review. Not started —
this is the largest item in the backlog and should be split into several
passes, never done in one go.**

| File | Lines | `useState` | `useEffect` |
|---|---|---|---|
| `src/components/windows/PredictiveModelBuild.tsx` | 3,573 | **42** | 16 |
| `src/components/dashboard/Dashboard.tsx` | 2,222 | **34** | 18 |
| `src/components/upload/DataUploadPage.tsx` | 1,514 | 13 | 6 |

Forty-two independent state variables and sixteen effects in one component
means the number of interactions a reader has to hold in their head grows
quadratically. This is the structural reason behind the recurring "fixed one
thing, broke another" pattern in this project's history — the bugs are
symptoms, this is the cause.

**Approach:** collapse state that always changes together into `useReducer`,
or lift cohesive groups into custom hooks (`useFailureGroupState()`,
`useChartFilters()`, …). Do it one cluster at a time with the test suite
green in between; there are 862 frontend tests to lean on. Do not attempt a
single sweeping refactor.

---

## 13. `App.css` is 9,048 lines with duplicate rules that silently cancel out

**Status: identified 2026-09-03. Not started.**

One stylesheet, 9,048 lines, 25 `!important` declarations, and selectors
defined several times over. The worst example: `.fg-sensor-dropdown-item` is
declared **four times** (lines ~2565, ~3389, ~3983, ~5015), plus its
`:hover` / `.selected` / `-tag` / `-desc` variants — 18 blocks in total. The
copies at 2565 and 3389 are byte-identical; the one at 3983 differs only in
`padding` (`0.35rem 0.6rem` vs `0.55rem`).

Because they have equal specificity, **only the last one wins** and the first
three are dead code that still looks live. Editing the wrong copy and seeing
nothing change is an easy hour to lose — and the 25 `!important`s look like
scar tissue from exactly that.

**Approach:** find duplicate selectors first (they are the trap), keep the
last-wins copy, delete the rest. Splitting the file by feature can follow,
but de-duplication is the part that removes the hazard.

---

## 14. `docs/PROJECT_HANDOVER.md` has outgrown being readable in one pass

**Status: identified 2026-09-03. Not started. Gets worse with every task, since
every finished task appends to it.**

Currently ~850 KB / ~1,500 lines / roughly 280,000 tokens — larger than most
model context windows, so it can no longer be read whole. That directly
breaks the release process defined in `CLAUDE.md`, which says the handover's
dated entries are the primary source for the changelog and instructs the
reader to "read every entry dated after the previous shipped version's date".
Today that only works via `grep` and range reads.

**Approach:** split the chronological log by month into `docs/handover/YYYY-MM.md`
and leave `PROJECT_HANDOVER.md` as the §1-§9 reference sections plus an index
of the monthly files. Update `CLAUDE.md`'s release checklist to point at the
monthly files. One-time job; makes the existing rule workable again.

---

## 15. Two stale claims left in `CLAUDE.md`

**Status: identified 2026-09-03. Not started — small, ~15 minutes.**

Eight other stale spots were corrected on 2026-09-03 (the deleted
`TauriCommands` contract, and the PDF-export paragraph that was also the
standing justification for `'unsafe-eval'`). These two remain:

- **`CLAUDE.md:46`** lists the sub-windows as `predictive-model`, `save-as`,
  `add-sensor`. Predictive Model was folded into the Build Model window
  (0.4.0), and the window labels the capabilities actually cover are `main`,
  `save-as`, `build-model`.
- **`CLAUDE.md:155`** — "Repo state snapshot (2026-07-14)" still says
  `main @ v0.2.1 is canonical`. 0.3.0 shipped on 2026-08-20 and 0.4.0 is
  built. The section flags itself as needing verification, which helps, but
  the content is wrong.

These matter more than normal documentation drift: `CLAUDE.md` and
`.claude/agents/*.md` are loaded as instructions, so a wrong statement here
actively misdirects work.

---

## 16. `.msi` references left in the release workflow and the build script

**Status: identified 2026-09-03. Not started — cosmetic, but actively
misleading.**

`src-tauri/tauri.windows.conf.json` sets `"targets": ["nsis"]` on purpose, so
Windows builds produce only the NSIS `.exe`. Two places still expect an MSI:

- `.github/workflows/release.yml` — header comment (lines 10-11), the copy
  step at line 226, and `release-assets/*.msi` at line 263.
- `scripts/build-installer-windows.ps1` — header comment (line 23), the
  "Building Tauri app + NSIS/MSI installers" banner (line 193), and the MSI
  lookup at lines 203-232.

Neither breaks: both guard with `Test-Path` / `|| true`, so the globs simply
match nothing. But the banner tells whoever runs it that an MSI is coming,
and the workflow advertises an asset that will never exist.

---

## 17. The installed executable is named `tauri-app.exe`, not `Wizard.exe`

**Status: identified 2026-09-03 while reading the 0.4.0 build output. Not
started — see the upgrade caveat before doing it.**

`productName` is `"Wizard"`, but the binary keeps the Cargo crate name
because `tauri.conf.json` does not set `mainBinaryName`. The build log says
it plainly: `Built application at: …\release\tauri-app.exe`. Users see
`tauri-app.exe` in Task Manager, in the install directory, and in any
firewall prompt.

**Fix:** add `"mainBinaryName": "Wizard"` to `tauri.conf.json` — safer than
renaming the Cargo crate, which also changes the lib/binary target names.

**Caveat, and the reason this is not a five-minute job:** an existing
installation upgraded in place may leave the old `tauri-app.exe` behind, and
shortcuts created by the previous installer point at the old name. Do this
alongside a version bump and actually test an upgrade over an installed
0.4.0, not just a clean install.

**Do not** change `"identifier": "com.prompt-solution.tauri-app"` while doing
this. It determines the `$APPDATA` path where every workspace lives; changing
it orphans all existing user data.

---

## 18. Two disagreeing default-colour systems for sensors

**Status: found 2026-09-03 while fixing the chart colour flicker. Only the
flicker was fixed; the duplication is untouched.**

There are two different ways a sensor's default line colour gets decided:

- `Dashboard.tsx`'s `resolvedSensorColors` — palette **slot** per sensor,
  remembered so it never moves (this is the 2026-09-03 fix).
- `LineChart.tsx:117`'s `defaultSensorColor(sensor)` — a **hash of the tag**,
  used as the fallback at lines 446 and 700 whenever the map has no entry.

Their comments give directly contradicting rationales: the LineChart one says
it exists *because* index-based assignment "silently disagreed" with the
swatch picker, while the Dashboard one says it uses position *rather than*
hashing because "hashing let unrelated sensors collide". Both survive, so the
codebase argues with itself, and the two produce different colours for the
same sensor.

The flicker this caused is fixed, because the map now also covers sensors
that were just deselected, so the fallback is no longer hit during the window
where a stale line is still on screen. But the fallback remains reachable,
and whoever touches sensor colouring next will meet both systems.

**Approach:** pick one source of truth (the remembered slot is the better
behaviour — stable, and distinct across simultaneously-selected sensors),
make the other delegate to it, and reconcile the two comments so the history
reads as one decision instead of two contradictory ones.

---

## 19. Custom NSIS installer UI — design approved, never implemented

**Status: design signed off 2026-09-02, implementation not started. The
0.4.0 installer is still stock NSIS.**

The user asked to redesign the Windows installer, which "looks old". Five
pages were mocked up and approved after two rounds of feedback:
[design canvas](https://claude.ai/code/artifact/f05ff513-e59a-49fd-a656-bfcc6680696f)
— Welcome, License, Choose Install Location, Installing, Finish, in the app's
navy/gold brand.

**What was decided:**

- Full-page custom backgrounds via a real `nsDialogs` page, not just the two
  small bitmap slots MUI2 offers.
- Buttons custom-drawn (owner-draw) rather than native Windows buttons.
- `SetCtlColors` / `CreateFont` / `PBM_SETBARCOLOR` for surfaces, text and
  the progress bar fill.
- Controls that cannot be safely restyled are left plainly native: the
  License radio dots, the Finish checkbox, and the progress bar's track.
- A navy title bar needs `DwmSetWindowAttribute` / `DWMWA_CAPTION_COLOR`,
  which is **Windows 11 only** — Windows 10 falls back to the default light
  bar.
- **Explicitly rejected:** a fully borderless custom-chrome window. Much
  bigger and riskier (custom drag, resize hit-testing, DPI, taskbar and
  accessibility behaviour) and the user chose to skip it.

**What is left:** writing the actual `.nsi` template and wiring it into
`bundle.windows.nsis` in `tauri.conf.json` (which currently sets only
`installerIcon`, `installMode`, `languages`, `displayLanguageSelector` — no
`headerImage`, no `sidebarImage`, no custom template). If the full custom
template turns out to be more than it is worth, `headerImage` (150×57 BMP)
and `sidebarImage` (164×314 BMP) alone would already remove most of the
"looks old" complaint for a fraction of the effort.

---

## 20. Housekeeping picked up during the review, not worth its own entry

**Status: identified 2026-09-03. Not started, all small.**

- **`npx update-browserslist-db@latest`** — `caniuse-lite` is ~10 months old
  and warns on every build. Harmless here (the only target is WebView2) but
  noisy.
- **`npm audit`: 7 vulnerabilities, all devDependencies** — `@babel/core`,
  `browserslist`, `esbuild`, `nanoid`, `postcss`. None ship in the app. The
  one that did (`echarts`) was fixed in 0.4.0. `esbuild` needs a Vite major
  bump, so it is not a quick `npm audit fix`.
- **39 `any` and `noUncheckedIndexedAccess`** — turning the flag on was
  measured on 2026-09-03: **247 type errors**. Worth doing eventually, its
  own dedicated pass, definitely not a side quest.
