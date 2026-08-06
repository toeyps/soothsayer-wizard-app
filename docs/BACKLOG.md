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
