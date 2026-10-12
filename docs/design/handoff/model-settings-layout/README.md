# SPEC FINAL — Build Model "Model settings": one tidy form for all three kinds

**Status:** the user asked for the redesign on 2026-10-12 ("ไม่สวยเอามากๆ แปลกตามาก ดูไม่เท่ากันเลย") and, after seeing it in the mockup, told the design side to send the work to dev.

**Rule:** the mockup is the real app code (at `d917dae`) plus only the changes below. No behaviour, copy, data, Rust or IPC change. If the real code has moved, the real code wins.

**No hint about "Incomplete" anywhere in this section.** The user decided with dev (commit `d917dae`) to remove it completely. Do not bring it back in any form: no note, no dots.

**Mockup:** https://claude.ai/artifact/Tj2dEf48eZNHVGpfujxbdo ("Wizard Current"), or `C:\00_DATA\wizard-mockups\workbench-v2\open-mockup.bat`. Path: GEG-4 Bearing study → Failure Groups → Build Model → a sensor → open "Model settings".

| Kind | Sensor to open |
|---|---|
| Individual, Relation model | BEARING DE TEMPERATURE |
| Clustering | GENERATOR ACTIVE POWER |
| Custom running condition | DAMPER FOR BOILER BYPASS |

**Files here:**
- `model-settings-BuildModelWindow.diff` — the hunks in `renderModelSettingsFields`.
- `model-settings.css` — the CSS block to fold into `App.css`.

**Route:** UI only → `fe-ui-agent`.

## Why

Today the fields are laid out with flex-wrap (Clustering alone uses a 4-track grid) and the controls have five different heights: name input 36 px, pill 28, segmented control 33, picker 30, stepper 28. Labels do not share a baseline, and the widths are arbitrary.

## Intentional differences (the whole scope)

1. **One grid for all three kinds:** three equal columns.
   - **Row 1 is always:** Model name · the kind's own setting · Training data (Workspace | Custom).
     - Individual: Boundary.
     - Relation model: Stiffness.
     - Clustering: Clusters.
   - **Row 2** holds the sensors: X · Y · Criteria for Clustering; the predictors on a full row for the Relation model.
   - Cluster ranges and the Custom running-condition panel each take a full row.
   - **Narrow pane:** two columns at ≤ 780 px (the name on its own row); one column below 480 px.
2. **Every control is 30 px high**, with the same radius and field colour: name input, pickers, read-outs, segmented controls, stepper.
   - Labels sit on one 16 px line.
   - Help text is 10.5 px, under the control.
3. **Boundary** is a read-out box ("1σ + 3σ · automatic", with a lock icon) instead of a pill. It matches the X read-out.
4. **Stiffness** is a single-row segmented control. The stepper and the Workspace | Custom switch keep their natural width; they do not stretch.
5. **Clustering:** the Clusters stepper sits in row 1, before the sensors. The mockup places it with CSS only. In the real code, **move the JSX** so the DOM and tab order match what is seen.

Nothing else changes: the same fields per kind, the same pickers (`SensorPickerSingle` / `SensorPickerMulti`), the same validation and block reasons, the same Custom panel.

## Not verified by the design side — check in the real app

- Many predictors, and very long sensor descriptions. The chips wrap by construction.
- The empty and required states: no predictor, no Y, a duplicate name, the one-cluster ranges box.
- The Custom panel overflows the pane by 22 px at a 1000 px window. This is the same in the real app before this change; it is not caused by it.

## Tests and manual plan

- **Tests:** `BuildModelWindow.test.tsx` (add assertions for the Boundary read-out and the field order), `CssClassCoverage`.
- **Manual plan:** the BMW items that describe Model settings.

## About the "Mock" tool bar

The mockup's tool bar is hidden by default (Alt+Shift+M shows it). It belongs to the mock harness and must never be built into the app.
