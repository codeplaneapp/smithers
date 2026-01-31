# Smithers v2 — Task-by-Task Implementation Guide

> All blockers resolved. Granular tasks with explicit verification.

---

## Recommended Execution Order (Vertical Slices)

| Slice | Scope | Verification |
|-------|-------|--------------|
| **0** | Protocol + agentd + FakeAgent fixtures | Contract tests + UI tests on fixtures |
| **1** | SessionGraph reducer + persistence | Determinism + migration tests |
| **2** | Transcript UI + markdown + tool cards + output viewer | Snapshot + perf tests |
| **3** | Terminal drawer wired to Ghostty | CWD correctness tests |
| **4** | JJ ensure/init + checkpoint create/restore | Integration tests on temp repos |
| **5** | Graph view MVP + selection sync | Layout snapshot + UI selection tests |
| **6** | Skills palette + todos + AGENTS.md injection | End-to-end skill flows + todo hooks |
| **7** | Browser snapshot + Create Form | UI + security regression tests |
| **8** | Export/import bundle | Roundtrip integrity tests |

---

# Category 1 — Agent Runtime Protocol

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 1.1 | Define `AgentRuntimeProtocol v1` | Versioned JSON schema | Covers streaming text, tool lifecycle, skill lifecycle, checkpoints, error events |
| 1.2 | Implement `AnthropicAgentAdapter` | Python adapter | Emits `assistant.delta`/`assistant.final` events; UI receives smooth streaming |
| 1.3 | Implement `FakeAgentAdapter` | Python adapter | Replays fixture event logs for deterministic UI tests |
| 1.4 | Create golden protocol fixtures | JSON event logs | 5+ scenarios: simple chat, tool use, error, cancel, checkpoint |

## Verification

- **Contract (Python)**: adapter emits valid schema for scripted run
- **Contract (Swift)**: parser accepts fixture logs, builds expected graph
- **UI**: streaming renders without scroll jumps

---

# Category 2 — Sandboxing Architecture

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 2.1 | Define `SandboxRuntime` interface | Python protocol class | `createSandbox()`, `exec()`, `readFile()`, `writeFile()`, `attachTerminal()` |
| 2.2 | Implement `HostRuntime` | Python class | Strict path canonicalization, controlled CWD, safe env |
| 2.3 | Add UX copy in Settings | Swift UI | "Sandbox mode: Host (not isolated)" with explanation |
| 2.4 | Create `LinuxVMRuntime` stub | Python class | Throws "not supported yet" to prevent architecture drift |

## Verification

- **Unit**: path canonicalization blocks `..`, symlinks outside, absolute paths
- **Integration**: tool execution cannot read/write outside workspace
- **Security regression**: symlink-inside-pointing-outside blocked

---

# Category 3 — Swift ↔ Python Bridge

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 3.1 | Create `agentd` skeleton | Python package | Reads NDJSON requests, emits NDJSON events |
| 3.2 | Implement session commands | Python | `session.create`, `session.send`, `run.cancel` |
| 3.3 | Swift `AgentClient` | Swift class | Spawn agentd, parse events, reconnect on crash |
| 3.4 | Add crash recovery | Swift + Python | Auto-restart once, show error banner, persist state |
| 3.5 | Protocol fixtures for Swift | JSON files | Same fixtures used by Python tests |

## Verification

- **Contract**: Swift and Python validate same schema
- **Integration**: kill agentd mid-run → app restarts, marks run interrupted, transcript preserved
- **Unit**: NDJSON parser handles partial lines, invalid JSON, recovery

---

# Category 4 — Session Graph & Persistence

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 4.1 | Define `SessionEvent` table | SQLite migration | Append-only: `{id, sessionId, ts, type, payloadJson}` |
| 4.2 | Define `GraphNode` types | Python + Swift models | Message, ToolUse, ToolResult, Checkpoint, SkillRun, SubagentRun, BrowserSnapshot |
| 4.3 | Implement reducer | Python + Swift | Events → in-memory graph + chat projection |
| 4.4 | Create bridge layer | Python | Listens to WorkflowGraph events, appends SessionEvents |

## Verification

- **Unit**: reducer determinism (same events → same graph hash)
- **Integration**: simulated workflow run produces expected SessionGraph
- **Migration**: DB migration from current schema includes new tables
- **Performance**: 10k events load under 500ms

---

# Category 5 — Chat Transcript UI

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 5.1 | Replace placeholder `SessionDetail` | Swift view | `VirtualizedMessageList` with stable identity per node |
| 5.2 | Implement streaming append | Swift | `assistant.delta` updates single message node |
| 5.3 | Scroll policy | Swift | Autoscroll only at bottom; "Jump to latest" button |
| 5.4 | Markdown rendering pipeline | Swift | Stream as plain text, finalize with syntax highlighting |
| 5.5 | Render cache | Swift | Keyed by `(messageId, contentHash, theme)` |

## Verification

- **UI**: streaming updates visible without scroll jump when reading older messages
- **Snapshot**: markdown fixtures render identically
- **Performance**: 1k messages, 5k tool nodes, scroll responsive

---

# Category 6 — Tool Output & Artifacts

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 6.1 | Artifact store | Python + Swift | Content-addressed file storage, `ArtifactRef` in graph |
| 6.2 | Tool card UI | Swift | Preview (first N lines), byte/line count, "Open Output Viewer" |
| 6.3 | Output Viewer | Swift | Fast load, search, line numbers, copy selection |

## Verification

- **Unit**: truncation never loads full artifact for previews
- **UI**: "Open Output Viewer" loads artifact, search finds matches
- **Performance**: 10MB output opens without freezing

---

# Category 7 — Terminal Drawer

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 7.1 | Implement `TerminalDrawerView` | Swift view | Open/close, tab list, selected tab state |
| 7.2 | Implement `TerminalSessionManager` | Swift class | `openTab(sandboxId, cwd, title)`, `reuseOrOpenTab()` |
| 7.3 | Add "Open Terminal" buttons | Swift UI | Session header, tool cards, graph node inspector |
| 7.4 | Wire PTY creation | Swift + Python | MVP: `Process` at CWD; v2: sandbox PTY endpoint |

## Verification

- **UI**: clicking "Open Terminal Here" opens drawer, selects correct tab
- **Integration**: `pwd` in terminal matches expected CWD
- **Regression**: terminal survives agent run cancellation

---

# Category 8 — JJ Integration: Checkpoints

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 8.1 | Create `RepoStateService` | Python | `ensureJjRepo()`, `createCheckpoint()`, `restoreCheckpoint()`, `getStatus()` |
| 8.2 | Define checkpoint metadata table | SQLite | `checkpointId ↔ sessionNodeId ↔ jjRev/bookmark` |
| 8.3 | UI: checkpoint markers | Swift | In chat + graph; actions: restore, fork |
| 8.4 | Handle missing JJ | Swift + Python | UI explains, disables features |

## Verification

- **Integration**: temp repo → modify → checkpoint → modify → restore → content matches
- **Integration**: restore creates graph event; UI updates
- **Resilience**: `jj` not installed → UI explains and disables

---

# Category 9 — JJ Integration: Stack

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 9.1 | Implement `StackModel` | Python + Swift | Derived from JJ state + graph metadata |
| 9.2 | Stack inspector | Swift view | View-only + "rebase onto latest" for MVP |
| 9.3 | Background `SyncDaemon` stub | Python | "Push on checkpoint" (no-op MVP) |

## Verification

- **Unit**: stack ordering rules stable for given JJ graph
- **Integration**: create multiple checkpoints, verify stack view order

---

# Category 10 — Graph View

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 10.1 | Graph data model | Swift | Node types, edges, lane assignment rules |
| 10.2 | Layout engine | Swift | Returns coordinates + edge routes (Sugiyama-style) |
| 10.3 | Renderer | Swift Canvas | Pan/zoom, hit-testing/select |
| 10.4 | Selection sync | Swift | Selecting node focuses transcript + inspector + terminal |
| 10.5 | Graph outline (accessibility) | Swift | List fallback for VoiceOver |

## Verification

- **Unit**: layout snapshots for fixture graphs
- **UI**: selecting node highlights and jumps transcript
- **Accessibility**: outline list selection mirrors canvas selection

---

# Category 11 — Skills System

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 11.1 | Skill registry | Swift + Python | Metadata, icon, required surfaces, output type, mode |
| 11.2 | Skills palette (`⌘K`) | Swift UI | "Run as side action" |
| 11.3 | MVP skills | Python | Summarize, Plan, Prompt Rebase, Rename session |
| 11.4 | Skill execution pipeline | Python | Inputs: selected node, workspace, surfaces; Output: artifacts |

## Verification

- **Unit**: skill invocation produces correct graph events
- **Integration**: prompt rebase creates parallel branch, doesn't overwrite original
- **UI**: skill results appear in Inspector → Artifacts

---

# Category 12 — Create Form Tool

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 12.1 | Tool schema | Protocol | `form.create(form_id, html, json_schema)`, `form.submit(form_id, data)` |
| 12.2 | Form renderer | Swift | Sandboxed HTML, no remote scripts |
| 12.3 | Submission flow | Swift + Python | JSON return to agent |

## Verification

- **Integration**: form lifecycle with FakeAgent
- **Security**: external script blocking

---

# Category 13 — Browser Surface

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 13.1 | Browser inspector tab | Swift | WKWebView with basic navigation + tabs |
| 13.2 | "Send to agent" action | Swift | Creates `BrowserSnapshot` artifact (URL + text + screenshot) |
| 13.3 | Surface attachment | Swift | Attach snapshot to next run |

## Verification

- **UI**: navigate → "Send to agent" creates artifact
- **Integration**: FakeAgent receives snapshot as surface reference
- **Performance**: snapshot doesn't freeze UI

---

# Category 14 — Todos Panel

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 14.1 | Todos DB schema | SQLite | `{id, workspaceId, sessionId?, text, completed, attachedNodeId?}` |
| 14.2 | Todos inspector tab | Swift | Create/complete/reorder |
| 14.3 | "Attach todos to run" surface | Swift | `@todos` includes correct items |
| 14.4 | Agent tool endpoints | Python | `todo.create`, `todo.complete` |

## Verification

- **Unit**: todo CRUD and ordering
- **Integration**: agent creates/completes todos; UI updates live
- **UI**: attach action includes correct items

---

# Category 15 — Search

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 15.1 | Add FTS tables | SQLite | Messages, tool previews, checkpoint labels, todos |
| 15.2 | Global search UI | Swift | Typed navigation, result types |
| 15.3 | Result navigation | Swift | Navigate to graph node, highlight match |

## Verification

- **Unit**: FTS queries return expected IDs
- **UI**: search jump selects correct node
- **Performance**: 50k rows within target latency

---

# Category 16 — MCP Configuration

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 16.1 | MCP config data model | Python + Swift | Per-workspace server configs |
| 16.2 | GUI editor | Swift | Add/edit server, validation |
| 16.3 | Tool registry integration | Python | MCP tools exposed to agent runtime |

## Verification

- **Unit**: config round-trip serialization
- **Integration**: enabling server exposes tool list

---

# Category 17 — Export/Import

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 17.1 | Export bundle | Swift + Python | Session graph + artifacts + manifest |
| 17.2 | Import bundle | Swift | Read-only session view |
| 17.3 | "Handoff" skill | Python | Produces shareable summary artifact |

## Verification

- **Integration**: export → import preserves node IDs, ordering, hashes
- **Unit**: bundle contains only referenced artifacts

---

# Category 18 — AGENTS.md Injection

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 18.1 | AGENTS.md loader | Python | Read from workspace root, cache, watch for changes |
| 18.2 | Context composition | Python | Order: base policy → AGENTS.md → surfaces → skill → user |
| 18.3 | Debug pane (dev-only) | Swift | "Show injected instructions" |

## Verification

- **Unit**: discovery only hits root, handles missing file
- **Integration**: modifying AGENTS.md affects subsequent runs

---

# Category 19 — Session Auto-Naming

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 19.1 | Title generator service | Python | Heuristic: first user message + first assistant summary |
| 19.2 | Trigger logic | Python | After first assistant response finalizes |
| 19.3 | Override handling | Swift | User edit disables auto-naming |

## Verification

- **Unit**: heuristic naming stable for fixture messages
- **Integration**: user rename disables further auto-renames

---

# Category 20 — Error Recovery

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 20.1 | Run failure event + error node | Protocol + Python | `run.error` event type |
| 20.2 | Retry/Fork actions | Swift | Context menu + error card buttons |
| 20.3 | Run replay | Python | Replay inputs (prompt + surfaces) |

## Verification

- **Integration**: fail tool → Retry → new run node, original intact
- **UI**: "Retry with edits" pre-fills composer

---

# Category 21 — Keyboard Shortcuts

## Tasks

| # | Task | Deliverable | Acceptance |
|---|------|-------------|------------|
| 21.1 | Key command router | Swift | Centralized dispatch |
| 21.2 | Implement MVP keymap | Swift | See decisions doc |
| 21.3 | Terminal focus handling | Swift | App-level ⌘ works; terminal retains others |

## Verification

- **UI**: shortcut dispatch with and without terminal focus

---

# Testing Framework Summary

### Python Tests
- **Unit**: protocol serialization, fake agent scripts, tool wrappers, reducers
- **Integration**: agentd ↔ Swift parser contract, JJ operations on temp repos

### Swift Tests
- **Unit**: path constraints, markdown cache, graph layout engine
- **UI (XCUITest)**: streaming, scroll policy, tool cards, terminal drill-in, graph selection
- **Snapshot**: markdown fixture rendering

### Cross-Language Contract Tests
- Versioned JSON schema for protocol events
- Golden event logs run by both Python and Swift tests

### Performance Tests
- 1000-message transcript open + scroll
- 10MB tool output in viewer
- 5k-node graph pan/zoom responsiveness

---

## Additional Implementation Questions (To Answer Before Distribution)

1. **Distribution & entitlements**: Mac App Store or direct? Affects sandboxing, credentials
2. **Secrets handling**: Keychain vs config files? Redaction from logs/bundles?
3. **Workspace file access**: Security-scoped bookmarks or unrestricted?
4. **Logging policy**: Structured log store separate from session graph?
5. **Artifact retention**: How to prune old artifacts?
6. **Concurrency model**: How many simultaneous runs/sessions?
7. **Git/JJ remote policy**: Failure model for remote rejects/conflicts?
8. **Privacy model for sharing**: What gets included by default?
