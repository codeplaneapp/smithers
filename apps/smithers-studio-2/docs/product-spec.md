# Smithers Studio 2 — Product Spec

> Status: **DRAFT** — refined via the `grill-me` workflow.
> One of three specs: **Product** (this) · [Design](./design-spec.md) ·
> [Engineering](./engineering-spec.md). Index: [PRD.md](./PRD.md).
> This spec owns *what we are building and why*. Design owns *how it looks*,
> Engineering owns *how it is built*.

---

## 1. The one-sentence version

Studio 2 is **one conversation with an orchestration agent** that manages
everything for you — there are no session tabs, only **tags**; sessions, runs,
and workflows are the agent's concern, surfaced back to you as chat, inline HTML,
openable workflow UIs, and toast notifications.

## 2. Why this exists (the problem)

Every prior iteration put the *machinery* in front of the user: tabs per session,
a sidebar of 25 views (the "spaceship"), explicit buttons for every capability.
Users had to think like the system. The classic tabbed shell ([../docs/UX.md](./UX.md))
and Smithers Studio 1 (deprecated) are that lineage.

Studio 2 inverts it. **You talk; the agent operates.** The UI renders the
conversation and the artifacts the agent produces — it does not expose every
lever. The few hard controls that remain exist only because they are too
important to bury.

## 3. Principles (the product contract)

1. **Chat is the app.** The primary surface is a conversation with the
   orchestration agent. Everything else is something the agent shows you.
2. **Tags, not tabs.** Conversations are organized by tags, not manually managed
   session tabs. Sessions exist but are an agent-owned implementation detail.
3. **Everything is a workflow.** Any non-trivial action is a Smithers workflow —
   observable, resumable, debuggable.
4. **System workflows are invisible plumbing.** Workflows that are pure UI
   implementation detail run from a *separate directory* and never appear in the
   user's workflow history. Only user-initiated workflows appear in chat.
5. **Delegate down.** The orchestration agent delegates to sub-agents wherever
   possible rather than doing the work itself.
6. **Minimal hard chrome.** Buttons are reserved for the critically important
   (view past workflows, debug a run, the Views dropdown). Everything else the
   agent renders on demand.
7. **Server-client.** The AI runs on the server; the UI is a thin client.

## 4. Tags replace tabs

- **Tags are the organizing primitive.** A tag may *represent a session*, or be
  an arbitrary label (`#auth`, `#flaky-tests`, `#pr-42`).
- **Sessions are hidden and decoupled from tags (DECIDED).** Sessions and tags
  are **many-to-many**: one tag can span many sessions; one session can carry
  many tags. In practice a session will *very often coincidentally* carry the
  same single dominant tag, so the common case looks 1:1 — but nothing is
  hardcoded to 1:1. The orchestration agent **reuses** a session when a request
  shares context (tag overlap / recency) with an active non-terminal session and
  **creates** a new one when the request is unrelated, the session is terminal,
  or the agent was changed.
- **Tags are 100% AI-managed (DECIDED).** Both user and assistant/system
  messages get tagged (the tagger runs on the inbound user turn and propagates
  tags onto the resulting assistant/system turns). There is **no user-facing
  tag-edit UI** — chips are display + filter only. The *only* way tags change is
  the user **prompting the AI** to change them.
- **Filtering:** the user filters chat by tag from a tag bar; the AI also has a
  **tool to filter tags** so it can focus the view itself.

## 5. Agents & responsibilities (product view)

| Agent | Default model | Job |
| ----- | ------------- | --- |
| Orchestration (top-level) | **codex** | Owns the chat; launches & calls Smithers workflows; has Smithers docs + CLI; delegates heavily |
| Orchestration sub-agent | same | Identical tools; lets the top-level agent fan out |
| Create-Smithers-Workflow agent | smart | Creates, runs, and monitors Smithers workflows |
| Tagger | cheap/fast | Tags messages only (see §4) |
| Monitor | cheap (Kimi/Haiku) | Frame-driven; updates run toasts (see §7) |

**Running agents always run Smithers.** The orchestration agent's only job is to
manage the chat and call workflows; the actual work runs as Smithers workflow
agents.

**Default agent = codex, selectable in Settings.** We considered discouraging
changes to protect prompt cache and decided *not* to add that friction.
Changing the agent may require creating new sessions (see Engineering spec).

## 6. Workflows as the unit of action

- **One-shot vs. full loop.** When the user asks for something, the agent
  decides: if trivial, it asks whether to **just do it in one shot** or run the
  full **research → plan → implement → review** loop workflow.
- **Create-Smithers-Workflow workflow.** A first-class workflow that helps the
  user author a new Smithers workflow/agent, then run & monitor it.
- **Discovery workflow.** A system workflow that helps discover work/options.
  Default is deliberately simple (a single task); editable in Settings.
- **System vs. user workflows.** System workflows (UI implementation detail) run
  from a **separate directory**, excluded from the user's workflow history. Only
  user-initiated workflows show in chat. System workflows are **viewable &
  editable in Settings**.

## 7. Workflow UIs, monitoring & notifications

- Smithers supports **attaching UIs to workflows**. Studio 2 surfaces them: an
  **Open** button (modal) and a **split-screen** mode (UI right, chat left). In
  split mode the chat agent can *view* the UI and **interact with it by injecting
  JavaScript into the iframe**.
- A **Debug** button opens **DevTools** for the workflow (snapshot tree + node
  inspector + logs/SQL), mirroring `gui/` and `src/developer/DevTools.tsx`.
- Every running workflow is a **toast** in the upper-right corner; **color =
  state** (blue running / green succeeded / red failed). The **Monitor agent**
  owns toast state and is **frame-driven** — each new frame triggers a cheap
  model to reconcile and update the toast (no polling cron).

## 8. Success criteria

- A user accomplishes a multi-step task by *only* chatting — never opening a tab,
  never naming a session.
- Tags (agent-applied + user filters) are sufficient to find any past work.
- Every user-visible action corresponds to an observable workflow with a toast
  and a DevTools view; system plumbing stays out of the workflow history.
- Switching the default agent in Settings is the only "advanced" knob most users
  ever touch.

## 9. Out of scope / removed (v1)

- **The classic tabbed shell is removed** (not deprioritized), including the
  multi-terminal "tab-swap" workspace. Valuable surfaces (e.g. the Run view)
  survive only as *openable* views via the Views dropdown / agent tool.
- Desktop (Electrobun) packaging is a later phase.

## 10. Open product questions (grill-me)

1. **Default-agent change → sessions.** Force new sessions, branch, or leave
   history intact?
2. **One-shot vs. loop gate.** What heuristic decides "trivial"? Always surface
   the choice, or only above a complexity threshold?
3. **Discovery workflow scope.** What does the default single-task discovery
   workflow actually do?
4. **Toast lifecycle (product side).** Are toasts clickable into the run? How
   long do success/failure toasts persist?
