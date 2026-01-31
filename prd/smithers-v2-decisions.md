# Smithers v2 — MVP Hard Decisions & Answers

> All critical blockers resolved. Ready for implementation.

---

## Executive Summary: 5 Key Decisions

1. **Linux VM sandbox is NOT required for MVP** — Ship with YOLO on host + workspace-path containment
2. **Use raw Anthropic API** — Claude Agent SDK adapter is optional later
3. **Checkpoint = JJ-backed named snapshot** — Op-log for safety, bookmarks for sharing
4. **Python backend = long-running `agentd` daemon** — Enables streaming, subagents, crash recovery
5. **Graph view = native Swift renderer** — WebView/D3 is a trap for core interaction surface

---

## 1. Claude Agent SDK

### Decision: Use raw Anthropic API for MVP

**Reasoning:**
- Already have `anthropic>=0.40` in dependencies
- Build **Smithers Agent Runtime Protocol** first; adapters can come and go
- Claude SDK becomes "just another adapter" you can drop in/out

**Implementation:**
- `AnthropicAgentAdapter` in Python emits `assistant.delta`/`assistant.final` events
- `FakeAgentAdapter` replays fixture event logs for deterministic testing
- Protocol is versioned JSON schema

**Verification:**
- Contract tests: adapter emits valid schema for scripted run
- Contract tests: Swift parser accepts fixture logs, builds expected graph
- UI tests: streaming renders without scroll jumps

---

## 2. Sandboxing Architecture

### Decision: MVP ships with host YOLO + workspace containment

**Reasoning:**
- bubblewrap does not support macOS (Linux namespaces only)
- VM/container layer = months of work
- "Workspace containment" prevents accidental `../` nukes

**Implementation:**
- `SandboxRuntime` interface (host impl now, VM impl later)
- `HostRuntime` with strict path canonicalization and controlled CWD
- UX: "Sandbox mode: Host (not isolated)" in Settings

**For v2:**
- Consider OrbStack or Colima as VM layer
- Minimum viable: FS mount policy + process containment inside Linux

**Verification:**
- Unit: path canonicalization + escape attempts (symlinks, `..`, absolute paths)
- Integration: tool execution cannot read/write outside workspace root
- Security regression: symlink-outside, glob escapes

---

## 3. libghostty Integration

### Decision: Share single `ghostty_app_t`, create surface per tab

**Terminal Drawer:**
- Create new terminal "surface" per tab
- Each tab = surface + session/PTY

**Open Terminal Here:**
- If tab for sandbox exists: reuse and `cd` if safe
- Otherwise: spawn new PTY with desired CWD/environment

**Verification:**
- UI: clicking "Open Terminal Here" opens drawer with correct tab
- Integration: `pwd` in terminal equals expected CWD
- Regression: terminal remains usable while agent streaming

---

## 4. JJ Integration

### Decision: Shell out to `jj` CLI for MVP

**Checkpoint Semantics:**
- **Checkpoint (user-facing)** = stable named pointer (bookmark + metadata) to JJ change
- **Safety restore (internal)** = JJ operation log (`jj op restore`)

**Workspace Initialization:**
- If `.jj` missing and `.git` present → auto-run `jj git init --colocate`
- If no `.git` → disable checkpoints until initialized (or offer button)

**Implementation:**
- `RepoStateService` in Python with `ensureJjRepo()`, `createCheckpoint()`, `restoreCheckpoint()`
- Checkpoint metadata table: session node id ↔ checkpoint id ↔ jj rev/bookmark

**Verification:**
- Integration: modify → checkpoint → modify → restore → content matches
- Integration: restore emits graph events, UI jumps appropriately
- Resilience: if `jj` not installed, UI explains and disables features

---

## 5. Session Graph vs Workflow Graph

### Decision: Separate but linked graphs

**Architecture:**
- `WorkflowGraph` = execution DAG (orchestrator)
- `SessionGraph` = UX DAG (messages, tools, checkpoints, skills, subagents)
- Link via IDs: `WorkflowRunId` referenced by SessionGraph nodes

**Storage:**
- Extend existing `SqliteStore` with new tables
- One DB file, multiple tables, use migrations

**Status Mapping:**
- Workflow run status stays in WorkflowGraph domain
- SessionGraph nodes have presentation statuses (`tool.running`, `tool.error`)
- Bridge layer creates derived presentation state from WorkflowGraph events

**Verification:**
- Unit: reducer determinism and idempotency
- Integration: simulated workflow run produces expected SessionGraph nodes
- Migration: DB migration from current schema includes new tables

---

## 6. Swift ↔ Python Communication

### Decision: Long-running `agentd` daemon with NDJSON protocol

**Why daemon:**
- Stable streaming, subagents, skills, background ops
- Crash recovery without contortions

**Protocol:**
- NDJSON is sufficient (one JSON object per line)
- Large outputs stored as artifacts (not inline blobs)
- Robust buffering for partial line reads

**Crash Handling:**
- Auto-restart once (or few times with backoff)
- Show error banner with "Restart backend" button
- Persist everything so you can resume

**Where agentd runs:**
- MVP: on host macOS
- v2: agentd on host, delegates tool execution to `SandboxRuntime`

**Verification:**
- Contract: Swift and Python validate schema
- Integration: kill agentd mid-run; app restarts, marks run interrupted, transcript preserved

---

## 7. Graph View

### Decision: Native Swift renderer with interactive MVP

**Layout:**
- Custom DAG layering algorithm (Sugiyama-style)
- Stable node positions > optimal aesthetics

**Interactivity (MVP):**
- Pan, zoom, click-to-select
- No drag-to-reorder yet

**Lane Rules:**
- Lane 0 = active branch (mainline)
- Forked message/run creates new lane
- Subagents get their own lane group (collapsed initially)

**Verification:**
- Unit: layout snapshots for fixture graphs
- UI: selecting node updates highlight + scrolls transcript
- Accessibility: graph outline list mirrors selection (VoiceOver-friendly)

---

## 8. Skills Architecture

### Decision: Hard-code registry in Swift, execute in Python

**Definition:**
- MVP: skill registry in Swift (metadata + UI)
- Execution in Python (so skills can call models/tools)
- Later: "skill packs" as Python modules + manifest

**Modes:**
- **Side action**: produces artifact, not appended to chat unless user inserts
- **Agent run**: creates run nodes + optionally appends messages
- Each skill declares its mode

**Nesting:**
- MVP: no skill nesting (keep it simple and observable)
- v2: allow orchestration if needed

**Create Form:**
- Agent emits `form.create(form_id, html, json_schema)`
- UI renders sandboxed form
- Submit sends `form.submit(form_id, data_json)` back to agent

**Verification:**
- Unit: skills generate correct event sequences and artifacts
- Integration: Create Form flow with FakeAgent
- UI: "Insert result into chat" works and preserves provenance

---

## 9. Search Implementation

### Decision: SQLite FTS5, client-side in Swift

**Indexing:**
- FTS5 + prefix queries + ranking is sufficient for MVP
- Index: messages, tool previews, artifact previews, checkpoint labels, todos
- Do NOT index full diffs by default (index file paths, labels, summaries)

**Fuzzy Matching:**
- Session title: lightweight fuzzy (Swift)
- Content search: FTS5 prefix + tokenization
- v2: add fuzzy scoring if needed

**Verification:**
- Unit: FTS queries return expected IDs for fixtures
- UI: search jump selects correct node and focuses transcript
- Perf: 50k rows search returns within target latency

---

## 10. Cloud Sync / Thread Sharing

### Decision: Export/import bundles for MVP, no cloud backend

**MVP:**
- Export session graph + artifacts + metadata as bundle
- Import bundle as read-only session view
- "Handoff" skill produces shareable summary artifact

**Artifacts:**
- Content-addressed, optional "lazy fetch" (v2)
- Warn on huge artifacts or allow excluding

**Verification:**
- Integration: export → import roundtrip preserves node IDs, ordering, hashes
- Unit: bundle contains only referenced artifacts

---

## 11. Built-in Browser

### Decision: WKWebView in Inspector tab

**Features:**
- Full WKWebView for auth, JS, SPAs
- Reader-mode extraction for text artifact
- Snapshot: URL + extracted text + optional screenshot (viewport only)

**Screenshot:**
- `WKWebView.takeSnapshot` → compressed PNG
- Full-page capture deferred to v2

**Verification:**
- UI: navigate → "Send to agent" creates artifact in inspector
- Integration: FakeAgent receives snapshot content as surface reference
- Perf: snapshot doesn't freeze UI

---

## 12. MCP Configuration GUI

### Decision: Form-based config, host-only for MVP

**GUI means:**
- Forms to add/edit: server name, command/args, env vars
- Enable/disable per workspace/session
- Show status "reachable / error"

**Tool Surfacing:**
- MCP tools are agent tools, not user-invoked skills
- Show in Tools inspector ("Available tools")
- Skills palette remains curated workflows

**Verification:**
- Unit: config round-trip serialization
- Integration: enabling MCP server exposes tool list to agent runtime

---

## 13. Performance

### Decision: Target 1k messages, 10k+ graph events

**Strategy:**
- SwiftUI with aggressive caching + artifact deferral first
- NSCollectionView fallback only if insufficient

**UX Affordances:**
- "Collapse history above checkpoint"
- "Summarize older messages" (skill)

**Memory:**
- Only active session fully in memory
- Everything else on-disk with lazy loading + cache eviction

**Verification:**
- Perf: load + scroll fixture sessions (1k/5k/10k messages)
- Memory: open 20 sessions; verify memory stabilizes after switching

---

## 14. Todos Panel

### Decision: Per-workspace in SQLite, agent can create/complete

**Schema:**
```
{ id, workspaceId, sessionId?, text, completed, createdAt, updatedAt, attachedNodeId? }
```

**Scope:**
- Per-workspace, filterable by session
- Agent can create/complete todos via tool/event

**Verification:**
- Unit: todo CRUD and ordering
- Integration: agent creates/completes todos; UI updates live via event bus
- UI: `@todos` attach action includes correct items in next run context

---

## 15. Missing from PRD — MVP Decisions

### 15.1 Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `⌘K` | Skills palette |
| `⌘N` | New session |
| `⌘F` | Search (global) |
| `⌘G` | Toggle Graph/Chat |
| `⌘⌥T` | Toggle Terminal drawer |
| `⌘] / ⌘[` | Next/prev session |
| `⌘↩` | Send (in composer) |
| `Esc` | Cancel selection / close popovers |

Not customizable in MVP. Terminal retains non-⌘ keys.

### 15.2 Undo/Redo
- Composer: standard text undo
- "Undo last message": explicit actions only
  - "Delete last user message" (only if no run started)
  - "Fork from before last message"

### 15.3 Copy/Paste
- Standard clipboard
- "Copy as Markdown" for assistant blocks
- "Copy output" for tool outputs

### 15.4 Drag and Drop
- Drop files into composer as attachments (stored as artifacts)
- Not sent to agent unless attached to run

### 15.5 Notifications
- Optional system notification when run finishes while backgrounded

### 15.6 Accessibility
- VoiceOver navigable: session list, transcript, tool cards, graph outline

### 15.7 Localization
- English only for MVP

### 15.8 Crash Recovery
- Event-sourced persistence ensures transcript reconstructed on restart
- In-flight run marked "interrupted"

### 15.9 Updates
- Decide separately (Sparkle vs self-managed)

### 15.10 Analytics
- None in MVP; add later behind explicit opt-in

---

## 16. Additional Answers

### 16.1 AGENTS.md Injection
- **Injection point:** backend, at `run.start` time
- **Who reads:** `agentd` reads and caches
- **Discovery:** workspace root only (`AGENTS.md` or `.smithers/AGENTS.md`)
- **Context order:** base policy → AGENTS.md → surfaces → skill prompt → user prompt

### 16.2 Session Auto-Naming
- **Model:** MVP = heuristic; optional small/fast model (configurable)
- **Trigger:** after first assistant response finalizes
- **Fallback:** "Untitled" + one retry after second exchange
- **Override:** user edit disables auto-naming permanently

### 16.3 Error Recovery UX
- **UI:** error cards include buttons; nodes have context menu actions
- **Retry:** replays exact same input/surfaces against current code state
- **Fork:** creates branch in same session graph (not new session)
- **Partial state:** tool nodes remain; new retry creates new run node

### 16.4 Cost/Token Tracking
- Capture usage if available (store even if hidden)
- Store per run: `runId, inputTokens, outputTokens, costEstimate`
- Visibility: hidden behind "Run Details" inspector in dev mode

### 16.5 Multiple Workspaces
- Created via "Open Folder…"
- Can be non-git/non-jj (disables checkpoints until initialized)
- Per-workspace: sessions, MCP config, sandbox mode, todos
- One "active" at a time in MVP; multi-window is v2

### 16.6 Subagent Model
- If backend emits `subagent.start`, render as collapsed card + graph lane
- Drill-in: open subagent "detail view" (read-only) if transcript exists
- Terminal: share workspace terminal and label clearly (separate sandbox v2)

---

## References

- [bubblewrap macOS support](https://github.com/containers/bubblewrap/issues/393)
- [JJ operation log](https://docs.jj-vcs.dev/latest/operation-log/)
- [JJ git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/)
- [OrbStack commands](https://docs.orbstack.dev/machines/commands)
- [WKWebView takeSnapshot](https://developer.apple.com/documentation/webkit/wkwebview/takesnapshot)
