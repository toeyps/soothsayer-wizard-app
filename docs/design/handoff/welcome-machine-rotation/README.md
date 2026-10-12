# SPEC FINAL — Welcome machine art: every machine's rotor train turns

**Status:** the user approved the motion on 2026-10-12 ("ภาพเคลื่อนไหวอะได้แล้ว"). This SPEC is written and is waiting for the user's go-ahead before dev starts.

**Why:** the user wanted every machine picture to show movement — the ROTATING of the machine's own parts, not the view angle changing. Until now only the Reciprocating pump moved (its three plungers).

**Rejected, do not build:** adding more sensor callouts (5–6 per machine, cards + chips). The user tried it and said it looks cluttered. Each machine keeps exactly its 2 callouts.

## The one rule

The mockup is the real app code (at `433f1e6`, with dev's ‹ › machine navigation) plus ONLY the two files below. `MachineMorphCanvas.tsx` is byte-identical to the real file and does not change.

## Mockup

- Online: https://claude.ai/artifact/Tj2dEf48eZNHVGpfujxbdo (Version 9).
- Local: `C:\00_DATA\wizard-mockups\workbench-v2\open-mockup.bat`.
- Look at the Welcome page; use ‹ › to step through the six machines.

## Files in this folder

- `mockup-vs-real.diff` — the complete change, in `machineShapes.ts` and `machineDots.ts`.
- `machineShapes.reference.ts`, `machineDots.reference.ts` — the full mockup files. These two may be ported almost directly; they contain no mock shortcuts.

## Route

UI only: no data model, Rust or IPC change. `fe-ui-agent` → `code-reviewer` (optional; it is a contained change) → `qa-agent`, or the size-Medium path.

---

## What moves

| Machine | What turns | Speed |
|---|---|---|
| Gas turbine generator | One shaft line: inlet hub + 14 first-stage blades in the bellmouth (new), shaft with a 6-bolt load coupling (new), generator NDE shaft | 0.30 rev/s |
| Gas turbine compressor | Two shafts: gas-generator inlet blades (14, new); power-turbine shaft with a 6-bolt coupling (new) | 0.42 and 0.26 rev/s |
| Motor | Shaft with keyway, coupling half and its 6 bolts, 7-blade cooling fan behind the cowl (new) | 0.36 rev/s |
| Reciprocating pump | Plungers unchanged; the sheave (spokes, grooves, stub shaft) turns once per stroke | `CRANK_RPS` ≈ 0.26 rev/s |
| Can pump | Vertical shaft: motor fan (6 blades, new), coupling with 6 bolts (new), line shaft and 3 impeller stages (new) | 0.30 rev/s |
| Turbo expander | Expander wheel and compressor wheel, 9 vanes each (vanes new), one shaft | 0.50 rev/s |

- The generator rotor is enclosed, so only its shaft ends and the coupling turn. This is kept physically honest.
- 6–12 % of the dots move; 20 % on the Reciprocating pump.

**Unchanged**
- The view sway (±26°, about 28.6 s per cycle).
- The machine cycle and dev's ‹ › / dot navigation.
- Orbit drag.
- Dot counts (6,000 / 2,400), colours, callout cards and anchors, copy.

**Small side effects**
- The new blades and couplings share the same dot budget, so fixed parts are 3–10 % sparser.
- The random dot placement differs from the shipped build, because the sampler's sequence shifts. The shapes are the same.

## How (port from the reference files)

1. **`group` encoding** — the point stride stays 8.
   - `group = colour + PART_STEP × part`, with `PART_STEP = 4`.
   - Colour = `group & 3`: 0 base metal, 1 second body, 2 hot section / volute, 3 bright metal.
   - Part = `group >> 2`: 0 = fixed; k ≥ 1 = `shape.parts[k − 1]`.
   - This replaces "groups 10–12 = plungers". The plungers are now colour 3 on parts 2–4 of the Reciprocating pump.
2. **Data** (`machineShapes.ts`).
   - `PartDef { name, kind: 'turn' | 'slide', axis, c: Vec3, rps, phase, amp }`.
   - `MachineShape.parts: PartDef[]`.
   - Constants: `PART_STRIDE = 12`, `MAX_PARTS = 6`, `SPIN_PER_SECOND = 3`, `CRANK_RPS = 0.55 × 3 / 2π`. That value is exactly the shipped plunger phase, `spin × 0.55`.
   - `PLUNGER_AMP` and `PLUNGER_PHASES` move here; `machineDots.ts` re-exports them.
   - `fitResample` moves each part centre with the fit. A slide's `amp` is already in normalised units and is not scaled.
   - Authoring helpers: `partRecorder`, `blades`, `onCircle`.
3. **`poseParts(parts, seconds, out)`** — writes one 3×4 matrix per part into a preallocated array. Slot 0 is unused. It allocates nothing.
   - Angle = `seconds × rps × 2π + phase`.
   - Turn = a rotation about the axis through `c`.
   - Slide = identity + `amp × sin(angle)` on the axis.
4. **Render loop** (`machineDots.ts`, `DotRenderer.render`).
   - Two preallocated `Float32Array((MAX_PARTS + 1) × 12)`.
   - Pose both machines once per frame from the same clock: `sec = spin / SPIN_PER_SECOND`.
   - In the existing per-point loop: if `group ≥ PART_STEP`, apply that part's matrix to the A point and to the B point BEFORE the A→B blend.
   - A moving surface dot's normal turns with the part, so the rim light stays put.
   - The colour key uses `g & 3`.
   - The four old plunger lines are removed.
   - No extra pass, and no per-frame allocation.

The `parts` table per machine — centres in raw space; every phase is 0 except the plungers:

| Machine | Part | Kind / axis | Centre | rev/s |
|---|---|---|---|---|
| Gas turbine generator | rotor | turn x | (0, 0, 0) | 0.30 |
| Gas turbine compressor | gas generator rotor | turn x | (0, 0, 0) | 0.42 |
| | power turbine shaft | turn x | (0, 0, 0) | 0.26 |
| Motor | rotor | turn x | (0, 0, 0) | 0.36 |
| Reciprocating pump | crankshaft sheave | turn z | (−1.15, 0, 0) | `CRANK_RPS` |
| | plunger 1 / 2 / 3 | slide x, amp 0.09, phase 0 / 2.094 / 4.188 | (0.62, 0.1, −0.62 / 0 / 0.62) | `CRANK_RPS` |
| Can pump | rotor | turn y | (0, 0, 0) | 0.30 |
| Turbo expander | rotor | turn x | (0, 0, 0) | 0.50 |

The exact new geometry per machine (blade counts, radii, positions) is in `machineShapes.reference.ts`.

## Behaviour rules

- **Reduced motion:** exactly as today. `spin` never advances, so every turn is the identity and the plungers sit in their rest pose. There is one still frame, redrawn only on drag.
- **Mini canvas (SetupRail):** gets the motion. It uses the same data and renderer at 2,400 dots.
- **Dissolve, drag, navigation jumps:** both machines are posed from the same clock before the blend. `spin` keeps advancing while dragging.
- **Sensor anchors:** all sit on fixed geometry. They moved by less than 0.000003 units.
- **Performance — must not be slower.** Measured in headless Chrome on the dev PC, hero at pixel ratio 1 and 2: about 1.4–2.2 ms average frame time, both before and after. The differences are inside run-to-run noise.

## Not verified by the design side — check in the real app

- The motion was judged from stills at four moments per machine. The user watched it live in the mockup and approved it.
- Part rotation during a ‹ › jump or a dissolve was not watched live by the agent.
- Reduced motion was not run under an emulated OS setting in the rotation-only build.
- An office laptop, and the installed app.

## Tests

- **Rewrite** `src/__tests__/MachineMorphCanvas.test.tsx` — "only the reciprocating pump has moving plunger particles (groups 10–12)". New assertions:
  - every machine has ≥ 1 part;
  - every point's `group >> 2` is ≤ `parts.length`;
  - `group & 3` is 0–3;
  - only the Reciprocating pump has slide parts, three of them, with the ported phases.
- **Check** `src/__tests__/machineDots.test.ts` — the constants and "plunger colour is group 3" — against the re-export and the new colour key.
- **Add, for `poseParts`:**
  - a turn at 0 s is the identity;
  - a turn keeps each point's distance to the axis;
  - a slide equals `0.09 × sin(spin × 0.55 + phase)`;
  - slot 0 is untouched.
- **Add, for shapes:**
  - part centres follow the fit;
  - sensor anchors equal the shipped ones within 1e-5;
  - `parts.length ≤ MAX_PARTS`.
- **Add, for the renderer:**
  - a moving part's dot lands on a different pixel at two `spin` values, while a fixed dot does not;
  - `spin = 0` gives the rest pose;
  - buffers are reused.
- **`docs/testing/MANUAL_TEST_PLAN.md`:** update IMP-23 / IMP-24, and add "every machine has turning parts; none move under reduced motion". Then regenerate the HTML.

## Design notes on dev's ‹ › navigation bar (NOT part of this spec — for the user and dev to decide)

1. The bottom bar wraps: "Illustration · simulated readings" drops to a second line at a 1440 px window, and the bar is three lines at a 1000 px window.
2. Inactive dots at 0.15 alpha are too faint for a clickable control.
3. The dot hit area is 21×20 px, against 24 px for the arrows beside them.
4. `aria-live` on the name pill announces every automatic cycle, not only user clicks.
5. A possible pop when clicking during a dissolve (read from the code; not seen on screen).

## About the "Mock" tool bar in the mockup — it is NOT part of the design

The mockup has a small tool bar: Installed fonts, Data change, Preview error, Fit lost, Train error, Slow run, Reset.

- It belongs to the mock harness (`mock/runtime.js`). It is not in the app's `src`, it is not in `mockup-vs-real.diff`, and it must never be built into the app.
- It is hidden by default. Press **Alt+Shift+M** in the mockup to show or hide it.
- Dev needs it only to reach some states (preview error, lost fit, train error, data change) and to Reset the example data.
