# SPEC FINAL — Dashboard "Tagged points" tab: layout polish

**Status:** the user asked for the redesign on 2026-10-12 ("ไม่สวยเท่าไหร่ design ใหม่สิ") and, after seeing it in the mockup, told the design side to send the work to dev.

**Rule:** the mockup is the real app code (at `d917dae`) plus only the changes below. Behaviour does not change. If the real code has moved, the real code wins and only the listed differences are applied on top.

**Mockup:** https://claude.ai/artifact/Tj2dEf48eZNHVGpfujxbdo ("Wizard Current"), or `C:\00_DATA\wizard-mockups\workbench-v2\open-mockup.bat`. Path: GEG-4 Bearing study → Line chart → click the chart to tag points → the Tagged points tab.

**Files here:**
- `tagged-points.diff` — the two components.
- `tagged-points.css` — the CSS block to fold into the existing rules in `App.css`.

**Route:** UI only → `fe-ui-agent`. No data, Rust or IPC change.

## What the real code does today (unchanged)

- `TagCompareTable.tsx` is rendered by the chart into the tab through a portal. The column heads are `TaggedPointList.tsx`.
- Remove one point: the × on its column head, or click the tagged spot again on the chart.
- Clear all: only the trash button in the chart's toolbox.
- At most 8 points (`MAX_TAGGED_POINTS`). A 9th click is ignored.
- A missing value shows "—".
- Scatter uses the same table.
- Columns stay in tagging order.

## Intentional differences (the whole scope)

1. **Full width.** The head band and the row lines cross the whole tab. A trailing empty column takes the spare width, so the values stay next to the names. The table no longer floats in the top-left corner.
2. **Columns.** Value columns are 124–152 px (were 168–210 px). The name column can grow to 400 px.
3. **Rows** are 30 px high (were 22 px), with a hover tint across the row.
4. **Point head** is 44 px:
   - the date over the time, on two lines, in the app's date format;
   - a 2 px rule in the tag's colour above it;
   - the × is dimmed until hover or focus.
5. **Unit once per row**, at the right end of the name cell. Cells hold the number only.
   - `tagCell` drops its unit argument, so the two `tagCell(…, info.unit)` calls in `LineChart.tsx` and `ScatterChart.tsx` change too.
6. **Missing value:** "—" is dimmed, with the tooltip "no value at this point".
7. **Count footer:** "3 of 8 points". At 8 it adds "the chart holds 8 at most — remove one to tag another".
8. **Narrow name cell:** the tag hides sooner, so the description keeps the room.
9. **Empty state:** the same sentence as today, centred in the tab.

## Left out on purpose — do not add

- Change between points (Δ): the user had it removed on 2026-08-17.
- T1 / T2 numbers on the points: the user removed numbers on 2026-10-12 ("leave only the colour").
- A hover link between a column and its chart marker: not cheap with the current chart code.
- A "Clear all" button inside the tab: it stays in the chart toolbox.

## Not verified by the design side — check in the real app

- Scatter tags: only Scatter's empty state was seen.
- A real "—" cell: the mock data has no gaps.
- The sticky head and name column with 8 points and 12 sensors were checked in the mockup at 1280 px and 1000 px. Check them again in the real window.

## Tests and manual plan

- **Tests:** `TagCompareTable.test.tsx`, `TaggedPointList.test.tsx`, `LineChart.test.tsx`, `ScatterChart.test.tsx` (cells no longer contain the unit), `CssClassCoverage`.
- **Manual plan:** LINE-16, LINE-17, SCAT-13. Use new ids where the meaning changed.

## About the "Mock" tool bar

The mockup's tool bar is hidden by default (Alt+Shift+M shows it). It belongs to the mock harness and must never be built into the app.
