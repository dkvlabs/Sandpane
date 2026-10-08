# Sandpane Desktop — Design handoff package

This is a **visual design reference and deferred design prompt**, not the functional Sandpane application.

## Contents

- `SANDPANE_DESKTOP_DESIGN_SPEC_AND_FINAL_PROMPT.md` — Full cinematic, lightweight desktop UI/UX specification, screen-by-screen behavior, design tokens, motion rules, accessibility, performance targets, and final copy-paste agent prompt (Section 17).
- `SANDPANE_FINAL_DESIGN_AGENT_PROMPT.md` — Extracted standalone copy-paste agent prompt for use **at the end** of the implementation.
- `SANDPANE_DESKTOP_VISUAL_REFERENCE.html` — Dependency-free local HTML design reference; sample data only; no Docker or Core backend.
- `SANDPANE_DESKTOP_PREVIEW.png` — Reference screenshot at 1440×900.
- `SANDPANE_DESKTOP_PREVIEW_COMPACT.png` — Compact screenshot at 900×650.

## Recommended workflow

1. Continue functional implementation using the existing Sandpane master plan and `05_DESKTOP_APP.md`.
2. Store the design spec in your project repository at `docs/design/SANDPANE_DESKTOP_DESIGN_SPEC_AND_FINAL_PROMPT.md` for reference.
3. When the real workflows are complete, open the repository in Codex/Claude Code and give it `SANDPANE_FINAL_DESIGN_AGENT_PROMPT.md`.
4. Ask it to implement the UI on existing code, test functionality, profile memory/CPU, and provide before/after screenshots.

## Performance philosophy

**Cinematic without GPU-heavy effects:** static gradients, clean surface layers, native fonts, restrained motion, virtualized chats, batched streaming, lazy loading, and no animated backgrounds. Measure application UI memory separately from Sandpane Core and the external SBX/agent processes.

## Screenshots are mockup data

Statuses, chat content, files and test results in the HTML and PNG are **illustrative**, not real execution results.

## Demo project naming

Public-facing demo projects use fictional names **Atlas Demo**, **Nova Demo**, and **Orbit Demo**. The DKV Labs publisher branding is unchanged. This is a sample-data rule only; actual user project names should never be overwritten by the application.
