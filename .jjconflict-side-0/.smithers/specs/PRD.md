# Smithers Studio 2 — PRD (index)

> Status: **DRAFT, in active refinement** via the `grill-me` workflow.
> This file is the **index + decisions log**. The substance lives in three specs:
>
> - **[product-spec.md](./product-spec.md)** — what we're building & why
> - **[design-spec.md](./design-spec.md)** — look & feel (builds on
>   [`DESIGN.md`](./DESIGN.md) tokens)
> - **[engineering-spec.md](./engineering-spec.md)** — how it's built
>
> Background contracts: [`UX.md`](./UX.md) (the *removed* classic tabbed shell),
> [`../src/chat/README.md`](../src/chat/README.md) (the chat-first shell this
> evolves).

## One-sentence version

Studio 2 is **one conversation with an orchestration agent** that manages
everything for you — there are no session tabs, only **tags**; sessions, runs,
and workflows are the agent's concern, surfaced back to you as chat, inline HTML,
openable workflow UIs, and toast notifications.

---

## Decisions log (from the grill-me pass, 2026-06-02)

| # | Topic | Decision | Lives in |
| - | ----- | -------- | -------- |
| Q1 | Sessions ↔ tags | **Decouple, many-to-many.** Session = agent-owned thread; tag = message label. Often coincidentally 1:1 but never hardcoded. Reuse on context overlap; create on unrelated/terminal/agent-change. | product §4, eng §4 |
| Q2 | Tagger | **100% AI-managed.** Both roles tagged (tagger runs on user turn, propagates to assistant turns). **No user tag-edit UI** — chips are display+filter only; tags change only when the user *asks* the agent. | product §4, eng §4 |
| Q3 | Secondary backend | **Gateway extension API.** Not a new service; register new commands/endpoints scoped to the whole gateway *or* an individual workflow (symmetric with UI extensions). Chat/tags/projects/settings become extensions. | eng §3 |
| Q4 | Default-agent change | Default = **codex**, selectable. **Lazy + immutable:** switching doesn't create a session (next prompt does); history never mutated/forked; active sessions keep their agent; agent-change = create-new trigger; show ephemeral "breaks the cache" notice. | product §5, eng §4 |
| — | Context routing | Every message routed to a session by a **cheap+fast router model** (many sessions coexist); prompt encodes when to start/compact; **token-count-aware**; context-traversal workflows. | eng §5 |
| Q5 | System workflows | Live under a **`system/` folder with its own nested `.smithers/`** (runnable/inspectable, hidden from user list/chat/history); wired via the Q3 `system` scope. Global config/workflows = follow Claude Code/Codex OS conventions (**ticket [0029]**). | eng §6 |
| Q6 | One-shot vs. loop | **Predict "<100k tokens?"** → one-shot else research→plan→implement→review. LLM prediction, tuned w/ examples, measured by an **eval**. Plus **auto-escalation**: session over N tokens → compact → research-plan-implement. Act-and-announce, don't modal every turn. | product §6, eng §5 |
| Q7 | Monitor trigger | **Server-side Gateway frame subscription** (system workflow/extension consuming `_smithers_events`); cheap model computes toast delta server-side; thin client renders. **Event-gated** (runs only on real frames) **+ debounced to ≤1 update / 30s**. Not a UI hook, not a cron. | product §7, eng §7 |
| Q8 | JS-into-iframe trust | **DEFERRED** — not yet decided (safe postMessage shim vs. arbitrary eval vs. sandboxed-origin eval). Pick up here next. | eng §9 |
| Q9 | Tag filter semantics | **Multi-select, OR / union.** Any number of chips active at once; a message shows if it carries **any** active tag; **no active chips = show every message** (default). "Clear all" resets. Union (not AND) because messages usually carry one dominant tag. | design §3 |

### Tickets filed during this pass
- **[smithers/0028](../../../.smithers/tickets/smithers/0028-vector-memories-context-management.md)** — Vector memories for cross-session context (Contexto/Contexa-inspired; lights up the dormant `_smithers_vectors` + `SemanticRecallConfig`).
- **[smithers/0029](../../../.smithers/tickets/smithers/0029-global-settings-and-global-workflows.md)** — Global settings + global workflows (OS-convention config home).

---

## Where to pick up next

1. **Resolve Q8** (iframe JS trust boundary) and the remaining open questions in
   each spec (tag-filter AND/OR, toast linger, agent-driving-iframe affordance,
   extension endpoint auth, one-shot signal details).
2. **Build the `grill-all-three` workflow** the user asked for: a Smithers
   workflow that runs `grill-me` over product/design/engineering specs in turn,
   iterating propose → ask → fold-in.
3. The **mock UI** has been updated to reflect this direction (tags-not-tabs, tag
   filter bar, Views ▾, run-state toasts, Settings agent selector, workflow-UI
   Open/Split/Debug). See the chat shell under `../src/chat/`.
