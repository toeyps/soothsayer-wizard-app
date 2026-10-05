# Wizard — Design System

**Owner:** `ui-design-lead` (Fable). Other agents read this file and follow it; they propose changes to the lead instead of editing it.
**Status:** v1, written 2026-10-04 from the design session that produced the current mockups (see `APP_MAP.md`). Real token values live in `src/App.css` `:root` — when this file and `App.css` disagree, `App.css` is what ships; fix whichever is wrong and note it here.

---

## 1. Who the app is for, and the feeling we want

- **Users:** reliability / maintenance engineers in Thai power and process plants. They know their machines and tags; they are not data scientists. They work for long sessions on large desktop screens, often comparing many sensors at once.
- **Job of the app:** sensor CSV → explore → group failure modes → train models → set health-score points → export model files.
- **Feeling:** a precise instrument, calm and dark, with one moment of "wow" per screen (the welcome machine, the glowing chart). Never playful, never cluttered. Data first; chrome recedes.
- **The product promise the visuals must tell:** *see the failure before it happens* — an amber "WATCH" signal appearing before a red alarm is the recurring visual story (welcome callouts, health score, alarm bars).

## 2. Two layers of the visual language

| Layer | Where | Status |
|---|---|---|
| **Base (shipped)** | All windows today. Flat dark surfaces, thin hairlines, small radii. | In `src/App.css` |
| **Studio (new direction)** | Welcome screen (approved by the user 2026-10-04: "สวยมากๆ"), Dashboard v2 (in review). | Mockups only; welcome is being implemented |

Studio is the Base layer plus: ambient glow behind content, faint grid, glass cards, a brand mark, a gradient primary button, glowing data lines. New screens should be designed in Studio unless they are dense forms/tables where glow would hurt legibility (then use Base surfaces inside a Studio window).

## 3. Tokens

### 3.1 Colour (dark only — there is no light theme)

| Token (App.css) | Value | Use |
|---|---|---|
| `--bg-primary` | `#0a0a0b` | window background (Studio mockups use `#07080a`) |
| `--card-bg` / `--bg-secondary` | `#101012` | cards, panels |
| `--input-bg` / `--surface-hi` | `#16161a` | inputs, raised controls |
| `--pop` | `#17171c` | popovers, menus (must read "above" cards) |
| `--text-primary` | `#ededef` | main text |
| `--text-secondary` | `#8c8c94` | secondary text, labels |
| `--text-faint` | `#5b5b63` | meta, axis labels, hints |
| `--border` / `--border-strong` | white 7% / 12% | hairlines / control outlines |
| `--accent-color` / `--accent-hi` / `--accent-muted` | `oklch(.68 .17 245)` / `oklch(.74 .17 245)` / 18% | primary action, selection, focus |
| `--ok` / `--ok-m` | `oklch(.72 .15 150)` / `#10b981` 14% | complete, valid, within limits |
| `--warn` / `--warn-muted` | `oklch(.78 .14 75)` | needs input, near limit, "WATCH", score 80 |
| `--danger` / `--danger-muted` | `oklch(.68 .2 25)` | invalid, outside limits, score 0, destructive |
| `--ki` / `--kr` / `--kc` (+ `-m`) | blue / amber / teal | model kinds Individual / Relation model / Clustering — identity only |
| `--perf` / `--cond` | green / violet | model **category** (Performance / Condition) — a different axis from kind; never reuse kind colours for it |

**Studio additions** (mockup values, to be added to `App.css` when a Studio screen ships):
- Ambient glow: `radial-gradient(900px 520px at 34% 22%, oklch(.45 .13 245 / .22), transparent 70%)` + a second violet one bottom-right at 12%.
- Grid: 44px lines at white 2.5%, masked by a radial fade.
- Glass card: `rgba(16,17,22,.72)` + `backdrop-filter: blur(14px)` + border white 11% + radius 16px + shadow `0 20px 50px rgba(0,0,0,.35)`.
- Brand mark: rounded square, radial gradient `oklch(.8 .13 235)` → `oklch(.45 .14 260)`, waveform glyph.
- Primary button (Studio): vertical gradient `oklch(.76 .14 235)` → `oklch(.64 .15 245)`, dark text `#04101e`, soft blue shadow.
- Sensor line palette (charts, in order): `oklch(.72 .15 245)`, `oklch(.74 .16 160)`, `oklch(.7 .19 20)`, `oklch(.8 .15 75)`, `oklch(.72 .15 300)`, `oklch(.78 .12 200)`, then `120`, `340`, `40`, `180`, `100` hues.

**Rules:** semantic colours (ok/warn/danger) only for state, never decoration. Accent blue only for action/selection. Kind colours only for I/R/C identity.

### 3.2 Typography
- **Inter** for UI text; **JetBrains Mono** (`--mono`) for tags, numbers, units, dates, code-like values.
- Scale used in the app: 10.5 (meta, uppercase labels with +0.06–0.14em tracking) · 11.5–12 (secondary) · 12.5–13 (body) · 14–15 (panel titles, 600) · 20–28 (page titles, 650–700, tracking −0.02 to −0.025em) · 46 (welcome hero only, 700, −0.035em).
- Big numeric readouts: mono 18–24, weight 600, tracking −0.03em, coloured by the series.

### 3.3 Space, radius, elevation
- Spacing steps: 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 px. Panels pad 12–16; window gutters 12.
- Radius: 5–7 (chips, small buttons) · 8–10 (inputs, buttons) · 11–14 (cards, rows) · 16 (Studio cards, modals).
- Elevation: base cards have no shadow; Studio cards, popovers and modals do. Modals sit on a 55% black scrim with 3px blur.

### 3.4 Motion
- Hover/selection transitions 150 ms. Chart redraws are instant (no tweening data).
- One ambient animation per screen at most (welcome machine). Always honour `prefers-reduced-motion` (render a still frame).

## 4. Patterns (reuse these, don't invent parallels)

- **Sensor label:** "DESCRIPTION (tag)" or description with the tag in mono underneath; fall back to the bare tag. Unit as a small mono chip.
- **Per-sensor actions live on the sensor row in the right panel** (user, 2026-10-04: the side placement is easier than the instrument cards): 🔔 alarm setpoints (popover with LL/L/H/HH ticks; active levels show as small chips under the name) and 📁 add-to-failure-group (opens the assignment sheet), visible on hover and always on selected rows; FG chips under the name. Instrument cards keep only view controls (colour, show/hide, pin Y, remove) — never duplicate an action in two places.
- **Sensor picking:** `SensorPickerModal` (search + collapsible component groups) for form fields; the Dashboard right panel for exploring. Never a full-width bare autocomplete.
- **Component groups:** coloured two-letter badge + name + "selected / total".
- **Model kinds:** I / R / C badges (18 px rounded square, kind colour on 16–30% tint). UI says **"Relation model"** — the algorithm name is confidential.
- **Status:** a pill (Complete / Trained / Incomplete / Set points needed / Fix set point) + a corner dot on kind badges (amber = needs input or re-train, red = fix, green = complete). One rule feeds all of them (`modelSetPointFlag`).
- **Failure-group assignment:** the matrix sheet (rows = groups, columns = I/R/C toggle cells, search, All/Assigned, ‹ › to step sensors, create group inline). Removing a model's last group deletes that model — say so in a toast.
- **Confirmations:** inline in the row (rename, delete) rather than OS dialogs, except irreversible bulk deletes.
- **Blocked actions:** keep the button visible but disabled, with the reason as text next to it (footer) and a tooltip. Exactly one blocked primary action per page (e.g. Mark complete).
- **Validation:** required-empty = dashed amber field + "Required"; invalid = red field; a "Checks" list explains every issue with its fix. Equal values count as invalid when a strict order is required.
- **Charts:** the chart the user is already reading is where they set values (lines on the chart, draggable later). Result charts go **below** the inputs that drive them (users read top-to-bottom as cause → effect). Score/health colours: ≥80 green, below 80 amber→red.
- **Multi-sensor line charts (colour + layout rules, 2026-10-04):**
  - Palette = the shipped `LINE_CHART_COLORS` hues, ordered for maximum difference first: `#3b82f6` blue, `#10b981` emerald, `#f43f5e` rose, `#8b5cf6` violet, `#06b6d4` cyan, `#84cc16` lime, `#d946ef` fuchsia, `#f97316` orange, then amber/teal/indigo/pink. Amber/red are kept late because they mean alarms. A sensor keeps its colour slot for the window's lifetime; the colour picker marks colours already on the chart.
  - **Overlay** (default): one grid, one Y-axis per sensor alternating left/right, axis line + ticks + a unit chip in the sensor's colour; lines 1.3 px, no glow. **Focus**: hovering a legend chip, an instrument card or an axis brightens that sensor (2.1 px, glow, soft fill) and dims the rest to ~16%.
  - **Split**: one lane per visible sensor sharing the time axis; lane = colour stripe + name/unit chip + own min/max; best for 4+ sensors. Hover crosshair runs through all lanes with a value badge per lane.
  - No legend row above the chart (removed 2026-10-04): show/hide lives on the instrument cards below (eye) with "Show all on chart" on that tab; hovering a card focuses its line.
  - Highlights by time: *Band* (tinted window) or *Recolour line* (segments inside the window take the highlight colour). By value (Scatter only): points coloured by one sensor's value bands, grey outside.
  - Alarm setpoints: four levels LL/L/H/HH, user ticks which to draw; L/H amber long-dash, LL/HH red short-dash, label at the right end.
  - Tag point: pinned markers in their own colours with a value box per sensor and Δ vs the first tag.
- **Empty/locked states:** a dashed box the same size as the content it replaces, with one sentence saying what unlocks it.
- **Numbers:** tabular mono; units always shown; thousands separators for counts.

- **Group settings by kind, in one place each (user, 2026-10-04: "setting ของแต่ละประเภทมันควรอยู่ที่เดียวกัน")** — Dashboard map: *chart view* (Overlay/Split, Tag point, Line/Scatter/Pair; Scatter's X, Y and **Colour by + value bands**) = the bar above the chart · *time* (navigator, dates, First/Last N, aggregation, reset) = under the chart · *per-sensor display* (colour, show/hide, pin Y, remove) = instrument cards · *per-sensor data settings* (alarm setpoints, failure groups) = the sensor rows on the right · *filters* and *time highlights* = their tabs under the chart · *navigation* (Build Model) = the header only. Never split one kind of setting across two places.

## 5. Content rules
- English UI copy; replies to the user in Thai.
- Say what the user recognises (Tag names, On the chart) rather than system terms (mapping, selected sensors) — but don't rename shipped labels without the user's OK.
- Buttons say exactly what happens ("Mark complete", "Open Dashboard", "Create sensor"). Errors say what is wrong and how to fix it, no apologies.
- Simulated/illustrative data is labelled as such ("Illustration · simulated readings").

## 6. Lessons from user feedback (do not repeat these mistakes)
1. Show only what exists — no placeholder slots for missing things.
2. Don't leave demo toggles, alternative concepts or extra items in a mockup the user has already decided on ("เดี๋ยวงงตอน implement"). Remove the losers once a choice is made.
3. Don't add items the user didn't list (e.g. extra machines). Ask or offer instead.
4. One place to set a value; one page per job; the whole model flow lives in the Build Model Workbench (no "full view").
5. Keep left/right columns balanced in height; avoid dead space under a short chart.
6. Results below inputs, not above.
7. Hidden tabs hide important charts — if a chart is essential (Relation model fit), show it.
8. Machine graphics must not lock the app to one machine type — the welcome art cycles the user's six machine types.
9. Lead with the user's real data/terms (real tags, units, FG names) in mockups.

## 7. Change log
- 2026-10-04 — v1 written (Base + Studio layers, tokens, patterns, lessons).
