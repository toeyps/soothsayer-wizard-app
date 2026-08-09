# Backlog

Confirmed issues / follow-ups that aren't being worked on yet. Picked up one
at a time, in whatever order matches the actual workflow being built out —
not necessarily top to bottom. Each entry has enough context to resume cold,
without needing the conversation that found it.

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
