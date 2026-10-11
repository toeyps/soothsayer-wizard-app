# SPEC FINAL — Welcome screen: honest copy + machine art C6 with orbit drag

Approved by the user on 2026-10-08. They accepted every recommendation and asked to hand this to dev.

**Mockups:**
- Copy: https://claude.ai/artifact/Pg1W26JL2JimUachjDkJFU — option C chosen. Source: `welcome-copy-reference.html`.
- Machine art: https://claude.ai/artifact/6m3acYz8QznHyuJncnPL78, Version 2 (C6 + orbit). Source: `machine-art-c6-orbit-reference.html`. Port the C6 path from it. Ignore the mockup-only parts: benchmark, ×4 simulation, zoom toggle, machine chips.

**Reviews:** `ui-design-reviewer` approved the copy and C6 on 2026-10-08, with the fixes below. The orbit drag was built afterwards and was not separately reviewed.

**Route:** UI only — no new data and no new command. `fe-ui-agent` builds it, then `qa-agent` checks it.

**Design rules:** `docs/design/DESIGN_SYSTEM.md` — §1 product promise (offline analysis, no prediction), §5 banned words, §6 lesson 10.

## 1. Copy (exact strings)

| Where | New text |
|---|---|
| Kicker (`HomeStep.tsx`) | `OFFLINE SENSOR DATA → MACHINE BEHAVIOUR` |
| Headline | `Abnormal behaviour, ` + gradient span `found in your history.` |
| Subtitle | `Import the CSVs you already have, explore every tag, group failure modes and score each period against learned normal — all on this computer.` |
| Product line under the logo | `Machine health studio` (same style as today, `--text-faint`; the amber colour in the mockup only marked it as changed) |
| Machine-art callout label | `● ABNORMAL` instead of `● WATCH` (same amber, same card, same drift rule: threshold `isWatch` > 12 %; the helper may be renamed) |
| About dialog (`src/App.tsx:82`) | e.g. "A desktop tool for exploring CSV sensor data and finding abnormal machine behaviour." |
| Installer text (`src-tauri/tauri.conf.json` `shortDescription` / `longDescription`) | Remove "predictive modeling"; describe exploring sensor data and finding abnormal behaviour against learned normal |

- **Headline size:** use `font-size: clamp(36px, 3.4vw, 44px)` so the headline stays two lines below a ~1,220 px window.
- **README.md:** optionally update lines 4 and 29 too (developer-facing).

## 2. Callout card fix (reviewer must-fix)
- Set `LABEL_W` from 188 to 204 in `machineShapes.ts` (**as shipped: 224** — dev measured with the installer's real fallback fonts, because the CSP blocks Google Fonts and the installer falls back to Segoe UI / Consolas; at 204 the label overlapped "Exhaust gas temperature"). Move the sparkline by the same 16 px (`sx = b.x + 114`; width stays 80). Keep the ±70 px leader offsets.
- Add a unit test for every trending sensor: `measureText(name) + 8 + measureText('● ABNORMAL') ≤ LABEL_W − 21`.

## 3. Machine art C6
- **Dot counts:** `HERO_PARTICLES = 6000`, `MINI_PARTICLES = 2400`.
- **Richer geometry on all six machines:**
  - flanges with bolt circles;
  - fins and a fan cowl on the motor;
  - combustor cans and the stack on the gas turbines;
  - skids on every machine — keep the skids and stacks;
  - Reciprocating pump: sheave with spokes, three plungers, valve covers;
  - stiffener rings on the Can pump;
  - IGV ring on the Turbo expander.
  - Machines and sensor anchor spots are unchanged.
- **Dot placement:** edge-weighted — rims, seams, box edges and bolt rings get most of the dots.
- **Point data:** stride 8 per point, `(x y z group edge nx ny nz)`. Rim light comes from the normals.
- **Renderer — one pixel buffer per frame:**
  - Dots add light into an `ImageData` buffer covering the machine's bounding box, clipped to the canvas. No depth sort.
  - Then one `putImageData` + one `drawImage` with `globalCompositeOperation = 'lighter'` per frame.
  - Buffer pixel ratio is capped at 1.25.
  - 260k-pixel budget: above it, step the buffer scale down 1.25 → 1.0 → 0.8 → 0.65. Cache the dot stamps per scale.
- **Constants — port them, don't re-derive:**
  - `DE = 150`, `DS = 46`
  - `TONE = [{r:.62,a:.34},{r:.72,a:.48},{r:.86,a:.62},{r:.98,a:.6,halo}]`
  - 5 depth levels: `sm = 1.22 − lv×.13`, `am = 1 − lv×.15`
  - 2×2 sub-pixel phases
  - `GROUP_ARR = [[110,175,255],[180,150,255],[255,150,80],[235,240,255]]`; tone 3 lifts 12 % toward white
  - Hue-preserving clamp: if `m > 255`, then `s = 255/m × (1 + (m−255)/(m×2.2))`
  - Dust uses tone 1 when `burst > .35`
  - Plunger groups 10–12 with phase offsets 0 / 2.094 / 4.188
  - Timing unchanged: HOLD 4.6 s, TRANS 1.8 s
- **Mini canvas (SetupRail):**
  - same renderer at 2,400 dots;
  - no labels, no background gradient or grid;
  - `sc = W × 0.13`, `cy = H × 0.52`;
  - dot tone alphas × 0.6, on top of the existing `opacity: 0.45`;
  - **no drag**.
- **jsdom:** use `ctx.createImageData`, and skip the dot pass when it is unavailable, so the existing component tests keep running.
- **Orange group colour:** group 2 orange (`255,150,80`, hot section / volute) is an accepted exception to "warn hue only for state". It is pre-existing and user-approved twice. Note it in DESIGN_SYSTEM; do not "fix" it.

## 4. Orbit drag on the hero art — "feels like a 3D model viewer"
- **Pointer and cursor:**
  - Press and drag with pointer events and pointer capture, so mouse, touch and pen all work.
  - Cursor is `grab`, and `grabbing` while dragging.
  - The canvas becomes `pointer-events:auto; touch-action:none`. This is accepted: a swipe that starts on the art tilts the machine instead of scrolling.
- **Turn and tilt:**
  - Left/right turns the machine all the way round, with no limit.
  - Up/down tilts from −10° to +80°, clamped so it never flips. Default tilt is 18°.
  - The view follows the pointer with light smoothing.
- **Release:**
  - The turn keeps its speed and slows to a stop in about 0.5 s.
  - No glide if the pointer was held still for more than 80 ms before release.
- **While held:**
  - The auto-spin and the machine cycle pause.
  - A dissolve that has already started finishes first.
  - Otherwise the clock stops just before the callouts would fade.
- **After release:**
  - The auto-spin and cycle resume 1.5 s after the glide ends.
  - The tilt eases back to the default over about 2 s; the turn angle is kept.
- **Double-click:** resets to the default view by the nearest route.
- **Callouts:** they stay visible while dragging and follow the rotated sensor positions. The leader line ends on the nearest edge of its card.
- **No zoom in the app** (user decision).
- **Reduced motion:**
  - Dragging still works, and the canvas redraws only while the user drags.
  - No glide, no auto-spin, no cycle.
  - The still frame shows the trending sensor already in the **● ABNORMAL** (amber) state. The user approved this, so the still image still tells the product's story.
- **Performance target:** not slower than today. Measured in the mockup on the dev PC:
  - C6 while orbiting averages 1.88 ms per frame at 60 FPS — about the same as today's 11k idle.
  - Office-laptop ×4 simulation, worst 5 % of frames: C6 7.1 ms vs today's 12.2 ms (today's art drops frames there).
  - At pixel ratio 2: 2.45 ms average.

## 5. Small extras (reviewer nice-to-have, accepted)
- "Illustration · simulated readings" uses `--text-secondary` (`#8c8c94`) instead of `#5b5b63`, so the required label is legible.

## 6. Tests and manual plan
- **Update the tests that assert old strings:**
  - `src/__tests__/DataUploadPage.test.tsx:1222` — the "See the failure before it happens." line.
  - `src/__tests__/DataUploadPage.test.tsx:1587–1588` — "Predictive maintenance studio" and "Sensor data → failure models".
  - `src/__tests__/MachineMorphCanvas.test.tsx` — the WATCH label and draw assertions, and stride 4.
- **Add new pure tests:**
  - the new primitives: counts, edge ratio, stride 8;
  - sensor anchors stay inside the ±2 box;
  - the callout fit test;
  - orbit helpers: tilt clamp, hold rule, buffer-scale picker, glide decay, reset to the nearest equivalent yaw.
- **Add component tests:**
  - pointer down/move/up changes the view;
  - double-click resets;
  - the mini variant gets no listeners.
- **Manual test plan** (`docs/testing/MANUAL_TEST_PLAN.md`, then regenerate the HTML):
  - IMP-23 / IMP-24: update the expectation text, keep the ids.
  - Add items: drag on mouse and touch, a 125–150 % Windows display, an office laptop (CPU in Task Manager), and reduced motion.

## Files
- `src/components/upload/HomeStep.tsx`
- `src/components/upload/MachineMorphCanvas.tsx`
- `src/components/upload/machineShapes.ts`
- `src/components/upload/SetupRail.tsx` (mini, if needed)
- `src/App.tsx`
- `src-tauri/tauri.conf.json` — description strings only; owned by rust-agent, or a main-session edit
- tests and `docs/testing/MANUAL_TEST_PLAN.md` as listed above

Estimate: about 1.5 days (C6 about 1 day + orbit about 0.5 day).

## As shipped (dev, 2026-10-08, commit 062e24d, installer 0.9.0 / tag v0.9.0 local)
- `LABEL_W` = 224, not 204 (see §2).
- No visible "Drag to turn" chip; the canvas has `aria-label="Drag to turn the view."`.
- Release velocity is capped at 12 rad/s. The glide is about 95 % done by 0.5 s and stops at about 1 s.
- `code-reviewer`: no must-fix. The should-fix about interrupted drags is fixed.
