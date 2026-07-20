# Smithers Studio 2 — Information Architecture & UX

## The spaceship problem (and the cure)

The original Smithers Studio had ~25 views, all reachable from one flat sidebar, all
visible at once. It was a *spaceship cockpit*: every dial exposed, equal weight,
nothing prioritized. New users froze. Power users learned to ignore 20 of the 25.

The cure is **progressive disclosure**: show the few things you use daily, hide the
rest one keystroke away, and hide the debug internals entirely until you opt in. The
guiding question for any surface is not "is this useful?" (everything is useful) but
**"do you reach for this every day, and is it a distinct mental model?"** Only "yes
to both" earns a permanent home.

---

## Three altitudes: WELCOME → FOCUS → DETAIL

The app has exactly three navigational altitudes. You always know which one you're at.

1. **WELCOME (Home)** — On launch you land here. It answers one question: *what do
   you want to do?* Two verbs only: open a workspace, or launch a workflow. Plus a
   live "what's running now" strip. No data firehose.
2. **FOCUS (a primary surface)** — Picking a verb routes you into *one* context.
   Open a recent workspace → **Workspace** (terminal + chat ready). Launch a
   workflow → **Runs** with the new run selected. You are now doing one thing.
3. **DETAIL (an inspector pane)** — Inside a surface, selecting a node opens a
   right-hand inspector with tabs (output / diff / logs / props). Detail lives in a
   *pane*, never a new top-level view. Approvals appear as an inline gate in that
   same inspector.

The flow is strictly hierarchical: **Home picks the WHAT, the nav picks the LENS,
the inspector reveals the DEPTH.** You can always return to Home (logo / Home row)
to re-launch.

---

## Three disclosure tiers

### TIER 1 — Primary nav (always visible)

Exactly four rows + a footer. These are the four daily "focus modes."

| id          | label       | what it is                                                                 |
| ----------- | ----------- | -------------------------------------------------------------------------- |
| `home`      | Home        | Welcome/launch: primary CTA + recent workspaces + live "Operations" strip  |
| `runs`      | Runs        | Live split-pane (tree + inspector) + run history + approvals (as filter/badge) |
| `workspace` | Workspace   | Hands-on pane: Ghostty terminal + agent chat (segmented), terminal tabs    |
| `workflows` | Workflows   | Browse + launch workflows and prompts (Local / Remote / Prompts / Schedules) |

Footer: **Command Palette** button (Cmd-P) + **Settings** gear. Settings is global,
not workspace-scoped, so it lives in the footer, not in "More."

**Why these four:** Home is the entry point. Runs is the heart of an *operations*
console. Workspace is where you live for long stretches. Workflows is the launch verb
— the reason the app exists. Each is a distinct mental model; none is a sub-state of
another.

### TIER 2 — "More" group (collapsed by default, one click away)

A single collapsible sidebar group, collapsed on first load, holding six secondary
surfaces. **Every entry is also a command-palette item**, so power users never expand
the group. Cap: ~7 items. If it grows past that, a primary surface is missing — don't
just widen the drawer.

| id           | label                  | why secondary                                              |
| ------------ | ---------------------- | --------------------------------------------------------- |
| `issues`     | Issues                 | Planning; medium frequency                                 |
| `landings`   | Landings               | Review/land; periodic, not daily                          |
| `workspaces` | Workspaces (JJHub)     | Fleet/sandbox management — distinct from the daily *Workspace* pane |
| `memory`     | Memory                 | Cross-run facts; read-mostly, palette-first                |
| `scores`     | Scores                 | Analytics; later a tab inside a selected Run              |
| `search`     | Search                 | Primarily a palette mode; full-page view is the fallback  |

### TIER 3 — "Developer" group (hidden until opted in)

Gated behind a persisted `developerMode` boolean (default `false`). When off, the
group renders **nothing** — the sidebar is byte-for-byte identical to non-dev, and
the surfaces are *not registered* (no palette item, no route, no deep-link). Toggle
via the palette command "Toggle Developer Mode" or a switch in Settings.

| id         | label        | what it is                                            |
| ---------- | ------------ | ----------------------------------------------------- |
| `devtools` | DevTools     | Raw DevTools snapshot tree + node props, unfiltered   |
| `sql`      | SQL Browser  | Read-only query over the workspace SQLite             |
| `logs`     | Logs         | Global event-log firehose (per-run logs live in the Runs inspector) |

**Gating rule:** developer surfaces are gated at the *registry* level (conditional
construction), never with CSS `display:none`. Hidden-with-CSS would leave them
reachable by palette search and deep-link, defeating disclosure.

---

## The single biggest de-spaceshipping move

**Anything that is a *state of a run* is disclosed INSIDE the Runs surface, never as
a sibling nav node.** The original split runs, snapshots, approvals, triggers, and
agents into five top-level rows. Here:

- **Approvals** = a filter on the run list + an inline gate in the inspector + an
  unread **badge** on the Runs nav row (time-sensitive gates must never require
  digging — see Risks).
- **Snapshots / time-travel** = a frame scrubber on the selected run.
- **Scores / events / logs** = inspector tabs on the selected node.

This collapses ~5 original views into one coherent surface: *"what are my agents
doing."*

Similarly, **Prompts merge into Workflows** (same "thing I can launch/configure"
concept) and **triggers/schedules merge into Workflows** as a segment — not separate
rows.

---

## Welcome / Home flow

Home is a port of `gui/WelcomeView.swift`: a calm, centered single column,
max-width 720, vertical spacing 32 between three blocks.

1. **HEADER** — hammer glyph 56px in `--accent`, "Smithers Studio" 34px/600 in
   `--text-primary`, one-line tagline 14px in `--text-secondary`.
2. **ACTION ROW** — horizontal spacing 12: primary **Open Folder…** (filled
   `--accent`, white text, `--radius-card`, padding 14/24, min-width 200) wired to
   `openLocalWorkspace`; secondary **Star on GitHub** (`--surface-1` bg, `1px
   --border`). A third remote sign-in slot renders **only** when a cloud/remote flag
   is on (the WelcomeView gating pattern).
3. **OPERATIONS / RECENTS** — "Recent Workspaces" label 13px/600 `--text-secondary`,
   then either an empty-state line ("No recent workspaces yet — open a folder to get
   started." 13px `--text-tertiary`, 24px vpad) or a scrollable list (max-height 280)
   of recent-workspace rows. Each row: folder glyph (accent if exists, tertiary if
   missing), display name 13/500 + tilde-abbreviated middle-truncated path 11px
   tertiary; hover reveals an x-circle remove and paints `--fill-hover`; missing
   folders are strikethrough + disabled. Below recents, a live **Operations strip**
   surfaces running / waiting / pending-approval counts, each deep-linking into the
   pre-filtered Runs surface.

**First-run / disconnected:** if no gateway is connected, Home shows a connect/boot
panel (reuse the gui POC remote-mode phases) instead of empty recents — the first
screen is never a dead end.

Opening a folder or selecting a recent routes to **Workspace**. Launching a workflow
routes to **Runs** with the new run selected.

---

## Command palette behavior (the universal accelerator)

Cmd-K / Cmd-P. Reaches **every** surface in all three tiers (developer surfaces only
when `developerMode` is on) plus contextual actions, so the sidebar stays tiny
without trapping power users. Port of `gui/CommandPaletteView.swift`.

- **Debounce:** 80ms — cancel the prior timer each keystroke, re-run the items
  provider after 80ms, reset selection. Async sources (workflows/files over HTTP)
  debounce the *fetch* and use a request-generation counter to drop stale responses.
- **Prefix pills:** query starting with `>` (commands), `/` (slash / run workflow),
  `@` (open file), `?` (ask AI) strips the prefix and renders it as a mono 11px/700
  `--accent` pill, with the mode title at 11px/600 below.
- **Keyboard:** Arrow up/down clamp to `[0, items-1]`, Enter executes, Tab does
  prefix-completion, Esc closes.
- **Grouped results:** items carry a `section`; render an uppercased 10px/700
  `--text-tertiary` header when the section changes.
- **Row:** 16px icon + title 12/600 + subtitle 10px tertiary + optional mono shortcut
  pill; selected row = `--accent-fill-strong` + `1px --accent-stroke`.
- **Empty state:** sparkles glyph + "No matching results" + an "Ask AI: <query>"
  fallback in accent when the query is non-empty.
- **Panel:** min-width 560 / max-width 760, `--surface-2` header over `--surface-1`
  list, list max-height 460, `rgba(0,0,0,.35)` dimmer click-to-dismiss. Keep the
  existing `data-testid="command-palette"`.

---

## Responsive live-run layout (the Runs inspector)

Port of `gui/LiveRunLayout.swift`.

- **WIDE (width ≥ 800px):** tree pane | draggable 6px divider | inspector pane. The
  inspector fraction persists to `localStorage` (`liverun.layout.inspectorFraction`,
  default 0.46), clamped so both panes stay ≥ 320px.
- **NARROW (< 800px):** tree fills; selecting a node opens the inspector as a
  centered modal sheet (max-width 480, `--surface-1`, `--radius-card`, `1px
  --border`, `rgba(0,0,0,.40)` dimmer, ease-out 150ms). Selection auto-opens the
  sheet in narrow and force-closes it in wide.
- **Tree row:** depth indent `paddingLeft = depth*16`; chevron only when it has
  children (danger dot when a descendant failed); node tag `<name>` 12px mono colored
  by state; key-props summary 11px mono tertiary. **Running cursor** on running leaf
  nodes: 2px `--accent` left bar + pulsing play glyph + one-line last-log 10px mono.

---

## Stable test hooks (do not break the 21 e2e tests)

The Playwright suite asserts: `data-testid="command-palette"`,
`data-testid="terminal-tab"`, `data-testid="close-terminal"`,
`data-testid="terminal-status"`, and `getByRole("button", { name: "Issues" | "Landings" })`
for the jjhub-parity flow.

Rules:
- The **terminal** lives inside the **Workspace** surface with its tab model
  untouched; the `terminal` view id still resolves and the terminal testids stay.
- **Issues** and **Landings** move into "More" but must remain reachable as buttons
  with their exact accessible names ("Issues", "Landings"), and their panels keep
  their existing testids/roles regardless of nav location.
- Add stable hooks mirroring the gui accessibility ids as `data-testid`:
  `nav.<Label>`, `view.welcome`, `liveRun.layout.wide`/`narrow`,
  `liveRun.layout.divider`, `tree.row.<id>`.
- Tests are updated in lockstep with the IA change — docs-driven: the IA and testids
  are specified here *before* any code moves.
