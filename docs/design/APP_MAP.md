# Wizard — App Map (screens, flows, latest designs)

**Owner:** `ui-design-lead` (Fable). Update the "Latest design" and "State" columns whenever a design round finishes. Detailed decisions live in `docs/PROJECT_HANDOVER.md` (search the SPEC FINAL entries).

## Main flow

```
Welcome (Get started) ──New project──▶ Step 1 Name project ──▶ Step 2 Add sensor data + tag names ──Open Dashboard──▶ Dashboard
        └──Recent project──────────────────────────────────────────────────────────────────────────────────────▶ Dashboard
Dashboard ──Build Model──▶ Build Model window (Workbench)
   Workbench: Running condition (Step 1) → per sensor: model kind tabs I/R/C
              → page 1 "Model fit" (settings, Train, analysis charts)
              → page 2 "Health score" (set points, checks, score chart, Mark complete → writes model files)
Dashboard ──Add special sensor──▶ formula builder (computed sensor)
```

Windows: `main` (welcome → setup → dashboard), `build-model`, `add-sensor`.

## Screens

| Screen | What the user does there | Latest design | State |
|---|---|---|---|
| Welcome (Get started) | Start a project, reopen/rename/delete recent ones | https://claude.ai/artifact/JVy9LrSHbuy6EB7Let261s (machine art: 6 machine types) | Approved; being implemented |
| Step 1 — Name project | Name + description, duplicate-name warning | https://claude.ai/artifact/HhJYLJHx4uimVs1hG8CW7p | In the welcome SPEC FINAL |
| Step 2 — Add sensor data | Add CSVs (merge by timestamp), see summary/coverage/warnings, add tag-name file | same as Step 1 | In the welcome SPEC FINAL |
| Dashboard | Explore sensors (line/scatter/pair, Overlay/Split), time range, filters, highlights, tag points, instrument cards, failure groups (FG overview tab), special sensors | inside the full-loop prototype below (`dashboard.html`) — the standalone Dashboard artifact was deleted 2026-10-04 at the user's request | In review with the user |
| Failure group assignment sheet | Put a sensor's I/R/C models into groups | https://claude.ai/artifact/KdzE1gT85kLhcTwgXWveGH (also inside Dashboard v2) | Shipped design |
| Build Model — Running condition | Step 1 card (set / not set / invalid) + editor (periods + conditions + live preview) | https://claude.ai/artifact/WKZxQbvJZLQiMLvMDEFoqq · editor https://claude.ai/artifact/1pp59aydphzaDu2R1SvKGh | Shipped; its "Open full view" and 3-step bar are superseded by the Workbench below |
| Build Model — Model fit | Settings, Train, charts (I: value + distribution; R: fit, target vs predicted, residual; C: clusters) | https://claude.ai/artifact/EqqcM7miNdBmNMZAiQxtSA | Shipped (Health score phases 1–4) |
| Build Model — Health score | Set points (I: L/H, R: 80/0 per side, C: N× SD), checks, score chart, Mark complete | same as Model fit | Shipped |

## Full-loop prototype
- https://claude.ai/artifact/NyTzUanJNZdqs5FCfpnuh3 — welcome → setup → Dashboard (with the FG overview tab) → Build Model → "All models complete" end state, linked pages, state kept across pages (2026-10-04). Use this to judge the whole journey; the per-screen links above stay the detailed references.

## Static exports
- 19 PNG/HTML screens (2026-10-04): scratchpad zip `Wizard-UI-designs-2026-10.zip` (sent to the user). Figma file (empty pages, MCP quota hit): https://www.figma.com/design/mBImT8ZsWafulY1ZCOwCkl

## Open design questions (owner: lead)
- Dashboard v2: tab rename "Selected sensors" → "On the chart"? keep the time navigator (≈60 px)?
- Welcome/setup: "Sensor mapping" → "Tag names", "Continue" → "Open Dashboard", keep two setup steps — defaults applied, user not yet asked.
