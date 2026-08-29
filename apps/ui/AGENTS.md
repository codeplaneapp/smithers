# Smithers MVP engineering rules

## ⚖️ THE EMBED LAW — read this before anything else (will, 2026-08-09, permanent)

**Everything embeds in the chat. Nothing opens full-screen unless the user explicitly asks.**

This binds BOTH agent populations:

1. **Agents building this app:** every capability's output renders as a card/embed inside the transcript at conversation width, composer visible below. Building a surface that opens as a takeover/full-screen/second view by default is a defect — the diff gets rejected. Full-screen exists only as a _presentation transition of the same embedded component_ (maximize), entered only by the user's explicit act.
2. **The agent inside the app (encode this in its system prompt and tool projection):** when the user asks about something ("what is in world?"), the agent ANSWERS IN THE CHAT — with an embedded card when a surface is involved — and never opens a full-screen view. Surface-maximizing commands are user-triggered only (`trigger: user` on the axis); the agent's invocation of any surface command renders its embedded form. Full-screen happens only when the user explicitly asks for it, in those words.

The user has stated this law repeatedly; violations keep shipping. Treat any full-screen-by-default behavior — new or existing — as a bug to fix on sight, not legacy to preserve.

## ⚖️ NO INVENTION (will, 2026-08-09, permanent)

Nothing user-visible may be added unless the current brief or the canon (`DESIGN.md`, the vault laws) names it: no decorative chrome, no status badges, no extra pills, no helpful-seeming labels or placeholder copy. Absence is the default; an empty state is a valid state. Unrequested user-visible additions are defects, not initiative.

- Do not use React `useEffect` in application code.
- Prefer derived values during render, event-driven updates, TanStack Query for server state, and focused hooks from a maintained hooks library for external subscriptions.
- If synchronization truly cannot fit one of those patterns, stop and document why before introducing lifecycle synchronization.
- React components are projections, never authorities for application state. Store all application state in TanStack DB collections.
- Human, Smithers, and system changes must enter through the shared Flux transition dispatcher with their actor recorded.
- Persist local collections with SQLite. Preserve the collection boundary so Electric can become the synced authority without rewriting UI consumers.
- Keep Smithers' world state as Markdown-native, linked documents in its own TanStack DB collection. Record provenance, confidence, actor, and revision; do not present inferred world state as ground truth.
- Build every agent context from a fresh versioned world-state snapshot. React does not assemble or own agent context.

## Frames are the navigation model

- New capability output appears first as a chat message containing an embedded mini-app. No capability opens a tab or replaces chat by default.
- Embedded and maximized views render the same frame component from the same persisted state. Maximizing is a presentation transition, not a second implementation.
- A maximized frame keeps Smithers chrome visible: the composer overlays or remains adjacent to the content, and minimize, back, and forward remain available.
- Every visible frame has a durable identity, parent frame, workspace, branch, and app-state revision. Persist the frame graph in SQLite through the shared transition dispatcher and journal.
- Put stable frame, workspace, and branch identifiers in the URL. The URL is a pointer into durable state, not the state payload.
- Browser back and forward traverse frame history. Forking any historical frame creates a new workspace branch rooted at that frame's recorded revision without mutating the original branch.
- Frame navigation, maximize, minimize, back, forward, and fork are Flows with the same slash, agent, and button invocation path as every other capability.
- Deep-link reload, back/forward, historical fork, unchanged embedded/maximized component identity, and composer visibility are mandatory end-to-end tests.

## New Smithers only

- Product code under `src/` uses the new Flows, Harness, Journal, Kernel, and related `@smithers/*` implementations owned by `../flows`.
- Treat the legacy React Smithers implementation and legacy runtime packages in `../smithers` as reference code only. Do not import or depend on them from the product.
- `../flows/ui` is interaction reference code, not a dependency authority; its remaining `@smthrs/*` imports do not authorize those imports in `mvp`.
- Enforce this boundary with dependency and forbidden-import tests so a legacy package cannot return transitively unnoticed.
- Smithers workflow dashboards under `.smithers/ui/` are control-plane tooling, not shipped product code, and may use the workflow runtime's own Gateway UI components.

<!-- smithers:prefer-workflows START -->

## Smithers workflows

Use your best judgment, weighing speed, quality, and token usage, to decide
whether a request should run as a [smithers.sh](https://smithers.sh) workflow
or with regular subagents. Prefer a smithers workflow for multi-step plans and
for work that benefits from retries, approvals, review, or replay; reach for
plain subagents when a request is a quick one-off.

The `smithers` skill is installed: run `smithers workflow list` to see the
available workflows and `smithers workflow run <id>` to launch one.

When a session ends successfully and the work could have been a smithers
workflow, offer to turn the session into a reusable smithers workflow for next
time.

<!-- smithers:prefer-workflows END -->
