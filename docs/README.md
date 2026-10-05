# Docs index

This folder was reorganized on 2026-09-15 into categories. Two files stay at
the root on purpose — see below.

## Root (kept flat — continuity files, don't reorganize)

- [`PROJECT_HANDOVER.md`](PROJECT_HANDOVER.md) — dated project history, one
  `🆕 YYYY-MM-DD` entry per finished task. The primary source of truth for
  what happened and why; stands in for chat history across machines/sessions
  (see its own header and `CLAUDE.md`). Append-only by convention — don't
  restructure it.
- [`BACKLOG.md`](BACKLOG.md) — confirmed issues and follow-ups not yet picked
  up. Also append-only by convention.
- [`PERSISTENCE_PLAN.md`](PERSISTENCE_PLAN.md) — kept here rather than under
  `planning/` specifically because `BACKLOG.md` links to it by relative path
  and that file is frozen — moving this would have silently broken that link.

## [`archive/planning/`](archive/planning/) — history only (archived 2026-10-05)

- `requirements*.md`, `task.md`, `contracts/` — requirements, phased task
  breakdowns and FE↔BE contracts from Features 1–4 (the early `pm-agent` era).
- **Not updated any more.** Work now comes through the chat prompt, and specs
  and plans are recorded as entries in `PROJECT_HANDOVER.md`.

## [`design/`](design/) — design system

- `DESIGN_SYSTEM.md`, `APP_MAP.md` — owned by `ui-design-lead`

## [`reference/`](reference/) — stable technical reference

- `tech-stack.html` — one-page stack summary, sourced from `package.json` /
  `Cargo.toml` / `lib.rs`
- `figma/` — static SVG mockups from earlier design rounds; explicitly **not**
  kept in sync with code changes (don't touch unprompted, per `CLAUDE.md`)

## [`testing/`](testing/) — manual QA

- `MANUAL_TEST_PLAN.md` / `manual-test-plan.html` — 184-item manual test
  checklist (the `.html` is a standalone file, open it directly in a browser)

## [`release/`](release/) — shipped versions

- `CHANGELOG.md` — per-version changelog; a new section is required in the
  same pass as every installer build (`CLAUDE.md` § Release checklist)

## [`onboarding/`](onboarding/) — non-engineering onboarding material

- `INTERN_BA_SA_GUIDE.md`, `INTERN_BA_SA_EXAMPLES.md` — guide + worked
  examples for a BA/SA intern
