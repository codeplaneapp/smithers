# Smithers Studio 2 — Design Spec

> Status: **DRAFT** — refined via the `grill-me` workflow.
> One of three specs: [Product](./product-spec.md) · **Design** (this) ·
> [Engineering](./engineering-spec.md). Index: [PRD.md](./PRD.md).
> This spec owns *how it looks and feels*. It builds on the token system in
> [`DESIGN.md`](./DESIGN.md) — that file is the canonical design-system source of
> truth; this spec adds layout, components, and interaction design.

---

## 1. Design system (source of truth)

The dark-console design system lives in [`DESIGN.md`](./DESIGN.md): color,
spacing, typography, radius, and motion tokens plus the verbatim CSS
custom-property block. **All UI consumes those tokens** — no ad-hoc colors,
spacing, or fonts in component CSS. `DESIGN.md` is expanded as the system grows;
this spec must never contradict it.

Core stance (from `DESIGN.md`): a **dark console** where **saturated color means
*run state*** (running / waiting / failed / approved), never decoration. Studio 2
keeps that discipline — the chat is calm; color appears where something is
*happening*.

## 2. The shell layout

Studio 2 is a single conversation, not a set of tabs. The frame:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ● project   #tag #tag #tag  (filter bar)        [Views ▾] [History] ⚙ │  TopBar
├───────────────────────────────────────────────┬──────────────────────┤
│  CHAT (primary, always present)                 │  OVERLAY / SPLIT      │
│   you: ship the auth fix                        │  (optional)           │
│   assistant: opened PR #42   #auth #pr-42       │  • workflow UI        │
│   ┌ inline html card (sandboxed iframe) ──────┐ │  • a "View" (Runs…)   │
│   └────────────────────────────────────────────┘ │  • DevTools          │
│   > prompt…   ⌨ slash autocomplete              │                      │
└───────────────────────────────────────────────┴──────────────────────┘
                                                  ▲ toasts stack here ↗ (upper-right)
```

- **TopBar:** project chip · **tag filter bar** · **Views ▾** dropdown · **History**
  (past workflows) · **Settings** gear. These are the only persistent buttons
  (see Product spec §3 "minimal hard chrome").
- **Chat** is the permanent left/primary column.
- **Overlay/Split** is the optional right column — workflow UIs, openable Views,
  or DevTools. Empty by default.

## 3. Tags (display + filter only)

- Tags render as **chips** colored by a stable hash (`tagColor`), shown on
  messages and in the TopBar filter bar.
- Chips are **display + filter only** — there is no edit/rename/delete affordance
  (tags are AI-managed; the user changes them by *asking* the agent — Product
  spec §4).
- Clicking a chip toggles a filter on the chat stream. The filter is
  **multi-select**: any number of chips can be active at once.
- **Semantics = OR / union (DECIDED).** A message is shown if it carries **any**
  active tag. **No active chips = show every message** (the default, unfiltered
  view). Union beats intersection here because a message usually carries a single
  dominant tag, so AND across two chips would show almost nothing — union answers
  the real question ("show me everything tagged `#auth` *or* `#pr-42`"). A "clear
  all" affordance resets to the unfiltered view.
- The set of active filters is encoded in the **URL** (Engineering spec) so it is
  shareable and Back/Forward-navigable.

## 4. The Views dropdown (manual access to surfaces)

A single **Views ▾** menu lists surfaces a user can open manually: Runs, Memory,
Scores, Search, Workflows/History, Settings. Selecting one opens it in the
overlay/split host. The **same** Views are openable by the agent via a tool — a
View is never a dead-end tab. There is no left sidebar of 25 items (the spaceship
is gone); the dropdown + command palette are the only manual navigators.

## 5. Overlay & split presentation

One overlay at a time, two present modes (reusing `overlay/overlayStore`):

- **Split** — overlay beside the chat (chat left, overlay right). Draggable
  divider; fraction persisted (and in URL). For workflow UIs the agent can drive
  the iframe (inject JS) — there should be a subtle affordance showing the agent
  is interacting.
- **Full / modal** — overlay layered over the chat with a dimmer
  (`rgba(0,0,0,.35–.40)`), `--radius-card`, `1px --border`, ease-out ~150ms.

Workflow UIs get an **Open** (modal) and a **Split** control, plus a **Debug**
button that swaps the overlay to **DevTools** for that run.

## 6. Toasts (run-state notifications)

- Position: **upper-right**, stacked, newest on top.
- **Color = state:** **blue** = running, **green** = succeeded, **red** = failed
  (using the run-state tokens from `DESIGN.md`, not new colors).
- Each toast shows the workflow name + a one-line latest status (written by the
  frame-driven Monitor agent) and is **clickable into the run** (opens Runs/the
  workflow UI in the overlay).
- Running toasts persist while running; terminal toasts (green/red) auto-dismiss
  after a short linger (exact duration is an open question) and can be dismissed
  manually. Multiple concurrent runs stack; consider a collapse/group affordance
  past N.
- An additional **ephemeral, non-run notification** style exists for transient
  notices (e.g. "Switching models breaks the cache and starts a new session — you
  may pay to re-warm tokens"). These are neutral-colored, not run-state colored,
  and auto-dismiss.

## 7. DevTools (debug surface)

Mirrors `gui/` and the existing `src/developer/DevTools.tsx` / `src/devtools/`:
the DevTools snapshot **tree** (node rows, depth indent, state-colored tags,
running cursor on running leaves) + a **node inspector** (output / props / logs)
+ optional **SQL browser** and **logs** firehose. It is the same general dev
surface every workflow exposes (Product spec §7). Opened via the Debug button or
the Views dropdown (developer mode).

## 8. Inline agent HTML

The agent renders rich content inline as **sandboxed-iframe HTML cards**
(`feed/HtmlContent`). Cards inherit the dark theme tokens; buttons the agent
renders use the design-system button styles. This is how the agent shows modals,
forms, and action buttons without adding permanent chrome.

## 9. Motion & feel

- Calm by default; motion only to express *state change* (a toast appearing, a
  run starting, an approval arriving) — consistent with the color discipline.
- Reuse `DESIGN.md` motion tokens; no bespoke easings/durations per component.

## 10. Open design questions (grill-me)

1. **Tag filter semantics.** ✅ **RESOLVED** — multi-select, **OR/union**; no
   active chips = show all; a "clear all" reset exists (see §3).
2. **Toast lifecycle (visual).** Linger duration for green/red; stacking cap and
   collapse behavior.
3. **Agent-driving-iframe affordance.** How do we visually signal the agent is
   injecting JS / interacting with a split workflow UI?
4. **Empty/first-run chat.** What does the very first screen look like before any
   conversation exists (port of the gui WelcomeView, or a bare composer)?
