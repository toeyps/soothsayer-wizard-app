# Project Context: Workspace Manager

## Overview
This project is a desktop application built with **Tauri v2** and **React 19**. 
The core functionality involves importing CSV files, exploring and processing data
through a multi-step workflow, and managing "Workspaces."

## Tech Stack
- **Frontend (UI)**: React 19, TypeScript, Vite, Tailwind CSS (v4), Echarts (for
  data visualization), `lucide-react`.
- **Backend (Desktop/OS)**: Rust, Tauri v2, `rayon` (for parallel processing),
  `csv` (for fast parsing), `serde`.
- **Tauri Plugins**: `@tauri-apps/plugin-store`, `@tauri-apps/plugin-fs`,
  `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-shell`.

## Core Mechanisms & Requirements
1. **Workspace System**: 
   - Workspaces hold the current state of a user's data exploration.
   - Heavy Workspace data must be saved to local JSON files via the file system
     so users can reopen it later.
2. **Auto-Resume (Crash/Exit Recovery)**: 
   - If the app closes, it must reopen exactly where the user left off
     (Last Route + Current State).
3. **Workspace Selection UI**: 
   - The initial landing page should list local workspaces (similar to the
     Microsoft Word start page, e.g., in the `ImportCsv` component).

## Persistence Strategy
- **Lightweight State (Settings, Last Session)**: Use `tauri-plugin-store`.
- **Heavy Data (CSV rows, large JSONs)**: Write directly to the local file system.
- **Rule of Thumb**: Ensure React State is synchronized with a Local Storage or
  Tauri Store frequently to prevent data loss.

## UI/UX & Coding Patterns
- **Step-based UI Pattern**: Implement workflows tracking progress via state
  machines or explicit steps.
- **Component Architecture**: Keep components modular (e.g., `DataTable`,
  `Dashboard`, `FailureGroupCreation`).
- **Styling**: Always use Tailwind CSS utility classes.
- **Rust Backend**: Offload heavy computations (like parsing massive CSVs or
  aggregating data) to Rust commands, utilizing `rayon` for multi-threading
  where applicable.

## Instructions for AI Assistants
- Follow the above persistence rules strictly: state must be recoverable!
- Use Tauri v2 API syntax (which differs slightly from v1).
- Prefer functional React components with hooks.
- Write clean and strictly typed TypeScript code.

---

## Agent Roles & File Ownership
> Each agent must ONLY read and modify files within its own zone.
> Architectural decisions must be approved by the PM Agent.

| Agent              | Zone                        | Responsibility                              |
|--------------------|-----------------------------|---------------------------------------------|
| `pm-agent`         | `docs/`, `task.md`          | Take requirements, plan (Task Breakdown), coordinate |
| `fe-ui-agent`      | `src/components/`, `src/App.tsx` | React UI components, Tailwind styling, Charts |
| `fe-logic-agent`   | `src/hooks/`, `src/types/`  | React Hooks, API/Tauri bindings, State Management |
| `rust-agent`       | `src-tauri/src/`            | Tauri commands, CSV parsing, file I/O       |
| `qa-agent`         | `src/__tests__/`, `src-tauri/tests/` | Write and run tests upon completion         |

## PM & Workflow Process
1. **Planning Phase**: `pm-agent` receives the user requirement and creates/updates `task.md` (the checklist of work statuses).
2. **Execution Phase**: `pm-agent` assigns goals to Worker Agents (`fe-ui`, `fe-logic`, `rust`) to implement phase by phase based on `task.md`.
3. **Contract First**: If a new feature requires backend integration, `pm-agent` MUST instruct `fe-logic-agent` and `rust-agent` to update `src/types/commands.ts` (TauriCommands) **before** writing the UI.
4. **Review Phase**: Once Workers complete their task, they notify `pm-agent` to review coverage of the initial plan before handing it off to the user.

## Interface Contract
> Workspace management (Save/Load/List/Delete) is handled entirely on the frontend using Tauri plugins (`plugin-fs` & `plugin-store`) via `src/workspaceManager.ts`.
> 
> For heavy data processing, the frontend invokes Rust backend commands. The active commands are:
```typescript
// Invoked via `invoke("command_name", args)`
export type TauriCommands = {
  load_csv:              { args: { paths: string[] };                                  returns: CsvMetadata }
  get_loaded_paths:      { args: {};                                                   returns: string[] }
  get_data:              { args: { sensors: string[] };                                returns: void /* Emits events */ }
  get_all_sensors:       { args: {};                                                   returns: string[] }
  load_metadata_command: { args: { path: string };                                     returns: SensorMetadata[] }
  calculate_new_sensor:  { args: { sensors: string[], config: SensorOperationConfig }; returns: string }
  run_python_analysis:   { args: {};                                                   returns: string }
}
```

## Context Guard (Cost Control)
> Load only files needed for your current task. Do not scan the full repo.

- `frontend-agent` → load only the target component + `src/types/`
- `rust-agent`     → load only the relevant `.rs` module + `Cargo.toml`
- `qa-agent`       → load only the file under test + its type definitions

## Task Handoff
When your task is complete, output this block before stopping:
```
## HANDOFF
- Completed: [what was built]
- New commands added: [list or "none"]
- Files changed: [list]
- Needs qa-agent: [yes / no — and what to test]
- Blocking issues: [none / describe]
```

## Anti-patterns
- ❌ `invoke()` without a TypeScript return type
- ❌ Storing large data in `plugin-store` (use filesystem)
- ❌ Resetting full state on reload (breaks Auto-Resume)
- ❌ Using Tauri v1 API syntax
- ❌ Agent modifying files outside its zone