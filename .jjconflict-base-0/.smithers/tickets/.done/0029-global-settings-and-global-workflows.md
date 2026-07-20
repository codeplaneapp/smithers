# Support global settings + global workflows (OS-convention config home)

Filed from the Studio 2 PRD grill-me pass (Q5, system-workflow isolation).

## Problem

Today Smithers config and workflows are workspace-local (`.smithers/`). There is
no global/user-level home for settings or workflows. We should not invent our own
scheme.

## Requirement

Follow the SAME per-OS config conventions as Claude Code and Codex for a global
Smithers home:

- macOS: `~/Library/Application Support/…` (or `~/.config` where those tools use it)
- Linux: XDG `~/.config/…`
- Windows: the platform-appropriate AppData location

This naturally enables:

- **Global workflows** — discoverable/runnable from the user's global home in
  addition to the workspace `.smithers/workflows/`.
- **Global Smithers config/home** — user-level settings shared across workspaces.

## Scope

- NOT needed for Studio 2 v1. This is a follow-up.
- When built, the discovery layer must merge global + workspace + system scopes
  (see Studio 2 Q5: system workflows live in nested `system/.smithers/workflows/`).

## Acceptance

- Smithers resolves a global config/home via OS conventions matching Claude Code / Codex.
- Global workflows are discoverable alongside workspace workflows.
- Documented in the docs as the canonical global-config location.
