# Smithers Studio 2 — Engineering Spec

> Status: **DRAFT** — refined via the `grill-me` workflow.
> One of three specs: [Product](./product-spec.md) · [Design](./design-spec.md) ·
> **Engineering** (this). Index: [PRD.md](./PRD.md).
> This spec owns *how it is built*. Product owns *what/why*, Design owns *look/feel*.

---

## 1. Hard engineering rules (non-negotiable)

1. **No `useEffect`. Ever.** Components do not synchronize state with effects.
   Derive state during render; drive side effects through explicit event handlers
   and store actions; subscribe to external systems through purpose-built
   primitives (`useSyncExternalStore`-backed store selectors), never ad-hoc
   `useEffect` glue. **A PR that adds `useEffect` is rejected. Enforce as a lint
   error.**
2. **State in Zustand, flux-style.** App state lives in Zustand stores, mutated
   only through **actions** (unidirectional: view → action → store → view).
   Components read via selectors and never duplicate store state in local
   `useState`. Extend the existing `useStudioStore`.
3. **URL is state.** Navigable state — open view, active tag filter, selected
   run, split-vs-modal, split fraction — is encoded in the **URL** so Back/Forward
   work and everything is deep-linkable/shareable. Store ↔ URL stay in sync
   through the router/actions, **not** effects. (Today most state is not in the
   URL; fixing this is a v1 deliverable.)
4. **Design tokens only.** All styling consumes `DESIGN.md` tokens; no ad-hoc
   colors/spacing/fonts.
5. **One export per file; colocate by domain.** Filename matches export;
   `index.ts` is barrels only; pure logic split from components and unit-tested
   without a DOM (existing `src/chat/` conventions).
6. **Real backends in tests.** e2e drives a real Gateway + real workspace API
   with seeded data — no route mocks, no fabricated responses (`e2e/`).

## 2. Architecture

```
Client (Vite + React 19 + Zustand) ──┐
  Chat · tag filter · toasts · overlay/split host · Views dropdown · DevTools
        │ WebSocket (run events / RPC)         │ HTTP (chat, tags, settings…)
        ▼                                       ▼
  Smithers Gateway  ──────────────  Gateway extension endpoints (see §3)
  (runs, frames, workflows,          (chat persistence, tags, projects,
   approvals, DevTools — source       settings, tagger/monitor/router surface)
   of truth)
```

Today there is a Workspace API server (`apps/smithers-studio-2/server`,
`createWorkspaceApiServer.ts`) serving chat/session, chat/message, crons,
run-launch, and settings, alongside the Gateway. **End state (DECIDED): these
move into the Gateway as registered extensions** (§3); the Workspace API server
is the migration starting point, not the destination.

The dev server proxies `/v1/rpc`, `/workflows/*`, and the run-event socket to the
Gateway and everything else to the extension endpoints.

## 3. Gateway extension API (DECIDED — Q3)

Smithers already supports attaching **UIs** at two scopes: the **entire gateway**
or an **individual workflow**. We add the symmetric capability for **backend
functionality**: registering new **commands / endpoints** scoped either to an
individual workflow or to the entire gateway.

Requirements:
- **Registration:** an extension declares endpoints/commands and the scope
  (`gateway` | `workflow`). Mirrors the UI-extension registration model.
- **Workflow root scope:** an extension can declare a workflow root as **`system`
  scope** (see §6) so its workflows are runnable/inspectable but excluded from the
  user-visible list.
- **Discovery, auth, versioning** for endpoints must be specified (an extension
  must not be able to silently shadow core RPC).
- The Studio 2 backend concerns (chat persistence, sessions, tags, projects,
  settings, tagger/monitor/router orchestration) are implemented **as gateway
  extensions** through this API rather than a bolt-on service.

> This API is itself a Smithers deliverable (likely a `packages/gateway` change).
> A ticket should track it.

## 4. Data model

### Sessions ↔ tags (DECIDED — Q1)
- **Many-to-many.** A session = an agent-owned backend conversation thread; a tag
  = a label on messages. One tag spans many sessions; one session carries many
  tags. **Never hardcode 1:1** — though in practice a session usually carries one
  dominant tag, so the common case *looks* 1:1.
- **Session lifecycle:** the agent **reuses** a non-terminal session on context
  overlap (tag overlap / recency) and **creates** a new one when the request is
  unrelated, the session is terminal, or the agent changed (Q4).

### Tags (DECIDED — Q2)
- **100% AI-managed.** Both user and assistant/system messages are tagged; the
  **tagger runs on the inbound user turn** and propagates tags onto the resulting
  assistant/system turns (no second model pass on assistant text).
- **No user CRUD.** Tag chips are display + filter only; tags mutate only when the
  user *asks* the agent. The data model puts tags on every `ChatItem` regardless
  of role.

### Agent selection (DECIDED — Q4)
- Default = **codex**, selectable in Settings.
- **Lazy, immutable:** switching the agent does **not** immediately create a
  session; the next prompt does. History is never mutated or forked. Active
  sessions keep their agent until they end; agent-change is a create-new-session
  trigger. Show an **ephemeral notification** on switch ("breaks the cache, new
  session, may pay to re-warm tokens").

## 5. Context routing, compaction & vector memory

- **Per-message router.** Every inbound message is routed to a session by a
  **cheap + fast router model** (many sessions coexist — there is never just
  one). The router's prompt encodes prompt-engineering best practices: when to
  start a new session, when to **compact**, when to reuse.
- **Token-aware decisions.** Likelihood to compact / start a new session scales
  with the candidate session's **token count**.
- **One-shot vs. loop = a <100k-token prediction (DECIDED — Q6).** The route
  between "do it in one shot" and "research → plan → implement → review loop" is
  driven by a single predictive question: *can this task be accomplished in under
  **100,000 tokens**?* Yes → one-shot; no → loop. This is an **LLM prediction**,
  tuned with few-shot examples in the routing prompt and measured by an **eval**:
  (A) was it actually accomplishable in <100k tokens, and (B) did the LLM predict
  that correctly? The agent acts-and-announces the chosen mode (no modal per
  turn) unless genuinely ambiguous.
- **Auto-escalation on token threshold (DECIDED — Q6).** If a *session* exceeds N
  tokens at runtime, automatically (1) **compact** the session, then (2) trigger a
  **research → plan → implement** flow. So the <100k prediction governs the
  initial route; the token threshold governs automatic mid-session escalation.
- **Context-traversal workflows.** The router has workflows to traverse a session
  and its tags to find useful context before routing/answering.
- **Vector memories (separate ticket).** A background task creates vector
  embeddings of agent-authored memory so retrieval can match query vectors to
  stored memory vectors across sessions/tags. Reference project: **Contexto
  (CONTXTO)**. Tracked in `.smithers/tickets/smithers/0028-...` (extends
  `packages/memory`, not a parallel system).

## 6. System-workflow isolation (DECIDED — Q5)

- System workflows (tagger, monitor, router, discovery, create-workflow, …) live
  under a **`system/` folder that contains its own nested `.smithers/`** —
  i.e. `system/.smithers/workflows/...`. They run from that separate directory
  with their own `.smithers`, so they stay out of the user-visible workflow list,
  chat, and history while remaining runnable + DevTools-inspectable.
- Wire this through the §3 gateway-extension **`system` scope**, not a hardcoded
  skip-list.
- **Global config/workflows (future ticket).** For global/user-level state,
  follow the **same OS conventions as Claude Code / Codex** (macOS
  `~/Library/Application Support` or `~/.config`; Linux XDG `~/.config`). This
  naturally enables a global Smithers home + global workflows. Not built now —
  tracked by a ticket.

## 7. Monitor agent (frame-driven, DECIDED — Product §7)

- **Not a cron.** Each new workflow **frame** triggers the Monitor — a cheap model
  (Kimi/Haiku) — to reconcile the run and update its **toast**.
- Mechanism: a Gateway frame subscription (the Gateway already streams frames /
  DevTools snapshots) fans out to the monitor; the monitor writes toast state to
  the chat/toast store via the extension surface. (Exact trigger wiring is an open
  question — frame subscription vs. workflow-side hook.)

## 8. Seams → real backends

The chat shell currently uses typed **SEAM** mocks (grep `SEAM:`): projects,
per-message tags, agent HTML tool, overlays. This spec is the contract those
seams drop into:

| Concern | Today (seam) | Real backend |
| ------- | ------------ | ------------ |
| Conversation | `feed/useChatFeed` (mock) | gateway-extension chat API |
| Projects | `projects/useProjects` (mock) | gateway-extension projects |
| Tags | seeded on `ChatItem.tags` | tagger agent writes tags server-side |
| Agent HTML | `feed/HtmlContent` | same renderer; HTML over chat stream |
| Overlays | `overlay/*` | overlay tool-calls on the chat stream |
| Runs / DevTools / terminal | **real** Gateway / surfaces | unchanged |

## 9. Open engineering questions (grill-me)

1. **Monitor trigger wiring.** Gateway frame subscription vs. workflow-side hook
   vs. UI hook?
2. **JS-into-iframe trust boundary.** What sandbox/permission model governs the
   agent injecting JavaScript into a workflow UI iframe (origin isolation,
   allowed APIs, audit)?
3. **Extension endpoint security.** Auth + namespacing so an extension can't
   shadow core Gateway RPC.
4. **One-shot vs. loop heuristic.** Concrete signal the orchestration agent uses
   to classify "trivial."
