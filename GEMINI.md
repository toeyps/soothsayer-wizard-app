# Feature Context: Workspace Manager

## Overview
This project is a desktop application built with **Tauri** and **React**. 
The core functionality involves importing CSV files, processing data through a multi-step workflow, and managing "Workspaces."

## High-Level Requirements
1. **Workspace System**: Save the current state of work (JSON format) to a local file so users can reopen it later.
2. **Auto-Resume (Crash/Exit Recovery)**: If the app closes, it must reopen exactly where the user left off (Last Route + Current State).
3. **UI list workspace**: UI that user have in local machine like Microsoft word first page in ImportCsv component

## Tech Stack
- **Persistence**: 
    - `tauri-plugin-store` for light settings/last session state.
    - Local JSON files for heavy Workspace data.

## Instruction for Gemini
When writing code for this project:
- Ensure the React State is synchronized with a "Local Storage" or "Tauri Store" frequently.
- Use a **Step-based UI pattern** (State Machine) to track progress.
