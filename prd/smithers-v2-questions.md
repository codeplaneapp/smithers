# Questions, Blockers & Clarifications for PRD v2

> ✅ **STATUS: ALL QUESTIONS ANSWERED** — See [smithers-v2-decisions.md](./smithers-v2-decisions.md) for full answers.

After reviewing the PRD against the actual codebase, here are gaps, questions, and clarifications needed.

---

## 1. Claude Agent SDK - Not Actually Installed

**Status**: The PRD assumes `claude_agent_sdk` (or `claude-code-sdk`) but it's not in our dependencies.

**Current state**:
- `pyproject.toml` has `anthropic>=0.40` (the raw API client)
- No `claude-agent-sdk` or `claude-code-sdk` package installed
- Our existing `smithers` Python code is a **workflow orchestration framework**, not an agent runtime

**Questions**:
1. Should we add `claude-agent-sdk` to dependencies, or is the plan to use our smithers framework with raw Anthropic API?
2. The PRD's "Agent Runtime Protocol" is smart, but do we need the Claude SDK at all if we're abstracting it away behind `AgentEngine`?
3. What's the timeline for "your in-house Python agent"? Should MVP even bother with Claude SDK adapter?

> ✅ **ANSWERED**: Use raw Anthropic API for MVP. Build Agent Runtime Protocol first; Claude SDK becomes optional adapter later. See [decisions](./smithers-v2-decisions.md#1-claude-agent-sdk).

---

## 2. bubblewrap + Linux VM Architecture - Major Undertaking

**Status**: The PRD correctly identifies bubblewrap doesn't work on macOS and proposes a Linux VM via Apple Virtualization Framework.

**Reality check**:
- Apple Virtualization Framework requires significant Swift code
- virtiofs mounts, vsock communication, sandboxd daemon = months of work
- This is essentially building a mini container runtime

**Questions**:
1. Is the Linux VM sandbox **actually required for MVP**? Could we ship v1 with macOS sandbox-exec or no sandboxing (true YOLO)?
2. Have you considered OrbStack or Colima as the VM layer instead of building our own?
3. What's the minimum viable sandbox? Just filesystem isolation, or full network/process containment?
4. Should sandboxing be a v2 feature while MVP runs tools directly on host?

> ✅ **ANSWERED**: MVP ships with host YOLO + workspace containment. VM sandbox is v2. Consider OrbStack/Colima. See [decisions](./smithers-v2-decisions.md#2-sandboxing-architecture).

---

## 3. libghostty Integration - Partially There

**Status**: We have GhosttyKit.xcframework and SurfaceView code exists in `ghostty/macos/Sources/Ghostty/Surface View/`.

**What exists**:
- `SurfaceView.swift`, `SurfaceView_AppKit.swift` - full terminal rendering
- `Ghostty.App`, `Ghostty.Surface`, `Ghostty.Config` - runtime wrappers
- Our `SmithersKit` Zig layer wraps ghostty C API

**What's missing**:
- Integration between our `SmithersView` (SwiftUI) and `Ghostty.SurfaceView`
- Terminal drawer component
- Multiple terminal tabs per sandbox

**Questions**:
1. How should `TerminalDrawerView` connect to ghostty? Create a new `ghostty_surface_t` per tab?
2. Should terminals in the drawer share the same `ghostty_app_t` as the main app, or separate instances?
3. For "Open Terminal Here" on a tool card, do we need to spawn a new PTY with a specific CWD, or can we reuse existing surfaces?

> ✅ **ANSWERED**: Share single `ghostty_app_t`, create surface per tab. Reuse existing tab if exists, otherwise spawn new PTY. See [decisions](./smithers-v2-decisions.md#3-libghostty-integration).

---

## 4. JJ Integration - Not Started

**Status**: JJ is installed (`/opt/homebrew/bin/jj`) but no integration code exists.

**Questions**:
1. Does the workspace need to be a JJ repo, or can we use JJ's `jj git init --colocate` on existing git repos?
2. For `RepoStateController`, are you envisioning:
   - Shell out to `jj` CLI commands?
   - Use JJ as a Rust library via FFI?
   - Something else?
3. How do checkpoints map to JJ concepts exactly?
   - Is a checkpoint = `jj commit` ?
   - Is a checkpoint = `jj op log` snapshot?
   - Is a checkpoint = a named bookmark/tag?
4. What happens if the workspace is a plain git repo with no JJ? Fail? Auto-initialize?

> ✅ **ANSWERED**: Shell out to `jj` CLI for MVP. Checkpoint = named pointer (bookmark) + op-log safety. Auto-colocate git repos. See [decisions](./smithers-v2-decisions.md#4-jj-integration).

---

## 5. Session Graph vs Existing Smithers Architecture

**Status**: The PRD proposes a `SessionGraph` as append-only event log. We already have:
- `SqliteStore` with event tables
- `EventBus` for in-process fanout
- `WorkflowGraph` (DAG of workflow nodes)

**Potential conflict**: 
- PRD's `SessionGraph` is UI-focused (messages, tools, checkpoints)
- Existing `WorkflowGraph` is execution-focused (workflows, dependencies)

**Questions**:
1. Are these two separate graphs, or should `SessionGraph` extend `WorkflowGraph`?
2. Should the existing `SqliteStore` tables be extended, or is this a new DB?
3. The PRD mentions "node types" (MessageNode, ToolNode, CheckpointNode). How do these relate to existing `NodeStatus`, `RunStatus` enums?

> ✅ **ANSWERED**: Separate but linked graphs. Extend existing SqliteStore. Bridge layer maps WorkflowGraph events to SessionGraph. See [decisions](./smithers-v2-decisions.md#5-session-graph-vs-workflow-graph).

---

## 6. Swift ↔ Python Communication

**Status**: No bridge exists yet between Swift UI and Python backend.

**PRD proposes**: NDJSON over subprocess pipes or socket.

**Questions**:
1. Should `agentd` be a long-running daemon, or spawned per-session?
2. How do we handle Python process crashes? Auto-restart? Show error in UI?
3. For streaming, is NDJSON sufficient, or should we use a framed protocol (length-prefixed)?
4. Where does `agentd` run?
   - On host macOS?
   - Inside the Linux VM sandbox?
   - Both (host for orchestration, VM for tool execution)?

> ✅ **ANSWERED**: Long-running daemon. Auto-restart once with backoff, show error banner. NDJSON sufficient. Runs on host, delegates to SandboxRuntime. See [decisions](./smithers-v2-decisions.md#6-swift--python-communication).

---

## 7. Graph View - No Prior Art

**Status**: The PRD wants a `SessionGraphCanvas` with lanes, overlays, minimap, filters.

**Questions**:
1. What graph layout library/algorithm for Swift/macOS? Options:
   - Build custom with Core Graphics?
   - Use a charting library adapted for DAGs?
   - WebView with D3.js/Mermaid?
2. Should graph view be **interactive** (click to select, drag to pan) or **read-only** initially?
3. For "lanes" (Main thread, Branches, Subagents) - what determines which lane a node goes in?

> ✅ **ANSWERED**: Build custom (Sugiyama-style layout). Interactive MVP: pan/zoom/select. Lanes from parent edges (lane 0 = mainline, forks get new lanes). See [decisions](./smithers-v2-decisions.md#7-graph-view).

---

## 8. Skills Architecture

**Status**: PRD says "no slash commands, skills only" but doesn't define the skill execution model.

**Questions**:
1. How are skills defined? 
   - Hard-coded in Swift?
   - Python functions?
   - Markdown files (like Claude Code's slash commands)?
2. For "side action" vs "agent run" modes - what determines which?
3. Can skills call other skills?
4. How does "Create Form" skill work mechanically?
   - Agent emits `form.create` event
   - UI renders HTML form
   - User submits
   - How does response get back to the agent?

> ✅ **ANSWERED**: Hard-code registry in Swift, execute in Python. Each skill declares its mode. No nesting in MVP. Create Form via protocol events. See [decisions](./smithers-v2-decisions.md#8-skills-architecture).

---

## 9. Search Implementation

**Status**: PRD wants "excellent, global, fast" search across sessions/messages/tool outputs/diffs.

**Questions**:
1. Is SQLite FTS5 sufficient, or do we need something like Tantivy/MeiliSearch?
2. For "diffs" search - are we indexing the actual file diffs? That could be huge.
3. Should search be:
   - Client-side (Swift queries local SQLite)?
   - Server-side (Python searches, returns results)?
4. What about fuzzy matching? FTS5 is exact match by default.

> ✅ **ANSWERED**: FTS5 sufficient. Don't index full diffs (just paths/labels/summaries). Client-side in Swift. FTS5 prefix + lightweight fuzzy for titles. See [decisions](./smithers-v2-decisions.md#9-search-implementation).

---

## 10. Cloud Sync / Thread Sharing

**Status**: PRD mentions CRDT-ish merge, "send events since cursor", content-addressed artifacts.

**Questions**:
1. What's the cloud backend? Self-hosted? Smithers Cloud™?
2. For MVP, is "export session as file" sufficient instead of real-time sync?
3. How do we handle artifact sync for large files (e.g., 100MB tool output)?
4. Authentication model for shared threads?

> ✅ **ANSWERED**: No cloud backend for MVP. Export/import bundles only. Warn on huge artifacts. Auth deferred. See [decisions](./smithers-v2-decisions.md#10-cloud-sync--thread-sharing).

---

## 11. Built-in Browser

**Status**: PRD wants a browser surface with "Send page to agent."

**Questions**:
1. Is this a full `WKWebView`, or a custom reader-mode renderer?
2. How do we handle:
   - Auth-gated pages?
   - SPAs that require JS execution?
   - Cookies/sessions?
3. For "screenshot snapshot artifact" - what format? PNG? How do we keep size manageable?
4. Should browser be in Inspector, or a floating window?

> ✅ **ANSWERED**: Full WKWebView for auth/JS/SPAs. Compressed PNG for viewport screenshot. Inspector tab for MVP. See [decisions](./smithers-v2-decisions.md#11-built-in-browser).

---

## 12. MCP Configuration GUI

**Status**: PRD mentions MCP support but no details on GUI.

**Questions**:
1. MCP servers are defined in JSON. What does "GUI configuration" mean exactly?
   - Form to add/edit server configs?
   - Visual server status/health?
   - Tool discovery and documentation?
2. Can MCP servers run inside the sandbox, or only on host?
3. How do we surface MCP tools in the Skills palette vs built-in tools?

> ✅ **ANSWERED**: Forms to add/edit server configs + status. Host only for MVP. MCP tools in Tools inspector (not Skills palette). See [decisions](./smithers-v2-decisions.md#12-mcp-configuration-gui).

---

## 13. Performance Concerns

**Status**: PRD acknowledges "high fidelity markdown can make cells heavy."

**Questions**:
1. What's the target session size? 100 messages? 1000? 10000?
2. For virtualized list fallback (`NSCollectionView`), who implements this? Is there a library?
3. Should we proactively limit transcript length with "older messages collapsed" UX?
4. What about memory pressure from many open sessions?

> ✅ **ANSWERED**: Target 1k messages, 10k+ events. SwiftUI first, NSCollectionView fallback only if needed. Yes, collapse + summarize UX. Only active session in memory. See [decisions](./smithers-v2-decisions.md#13-performance).

---

## 14. Todos Panel

**Status**: PRD mentions Todos but minimal detail.

**Questions**:
1. Where do todos live? In session graph as nodes? Separate table?
2. Can todos span sessions (project-level) or only per-session?
3. What's the interaction between todos and agent? Does agent see todos as system context?
4. Can agent create/complete todos programmatically?

> ✅ **ANSWERED**: Separate SQLite table. Per-workspace, filterable by session. Todos are a surface. Agent can create/complete via tools. See [decisions](./smithers-v2-decisions.md#14-todos-panel).

---

## 15. Missing from PRD

Things not addressed that we'll need:

1. **Keyboard shortcuts** - What's the keymap? ⌘K for skills, but what else?
2. **Undo/Redo** - Can user undo their last message? Agent's last action?
3. **Copy/Paste** - How does clipboard work between chat, terminal, browser?
4. **Drag and Drop** - Can user drop files into composer?
5. **Notifications** - Does app notify when long-running task completes?
6. **Accessibility** - VoiceOver support details?
7. **Localization** - English only for MVP?
8. **Crash recovery** - What happens if app crashes mid-session?
9. **Updates** - How does app update itself?
10. **Analytics** - Any telemetry?

> ✅ **ALL ANSWERED**: Full keymap defined. Explicit undo actions only. Standard clipboard + "Copy as Markdown". Drop files as artifacts. Optional notifications. VoiceOver navigable. English only. Event-sourced recovery. Analytics opt-in only. See [decisions](./smithers-v2-decisions.md#15-missing-from-prd--mvp-decisions).

---

## Summary: Recommended Clarifications Before Building

> ✅ **ALL RESOLVED** — See [smithers-v2-decisions.md](./smithers-v2-decisions.md)

### ~~Must Answer for MVP:~~ ✅ ANSWERED
1. ~~**Sandboxing scope**~~ → MVP ships with host YOLO + workspace containment
2. ~~**Claude SDK vs raw API**~~ → Use raw Anthropic API
3. ~~**JJ semantics**~~ → Checkpoint = named pointer + op-log safety
4. ~~**Swift-Python bridge**~~ → Long-running `agentd` daemon
5. ~~**Graph view**~~ → Native Swift renderer, interactive MVP

### Can Defer (confirmed):
- Cloud sync (export-only for MVP) ✅
- Built-in browser (WKWebView in inspector tab) ✅
- MCP GUI (forms to add/edit configs) ✅
- Advanced search (FTS5 sufficient) ✅
- Prompt rebasing (skill-based, v2) ✅

---

## 16. Additional Questions After Task Guide Review

These gaps were identified after reviewing the v2 task guide:

### 16.1 AGENTS.md Injection
PRD mentions "auto-detected and injected as instruction context" but no task specifies:
1. Where in the agent runtime flow does this happen?
2. Does `agentd` read it, or does Swift read and pass it?
3. What's the file discovery logic? (workspace root only? recursive?)
4. How does it interact with skills/system prompts?

> ✅ **ANSWERED**: Backend at `run.start`. `agentd` reads and caches. Workspace root only. Context order: base → AGENTS.md → surfaces → skill → user. See [decisions](./smithers-v2-decisions.md#161-agentsmd-injection).

### 16.2 Todos Panel - Missing Details
Listed as MVP must-have but underspecified:
1. Where do todos persist? In session graph as nodes? Separate table?
2. Can todos span sessions (project-level) or only per-session?
3. Can agent create/complete todos programmatically?
4. What's the data model? `{ id, text, completed, attachedNodeId? }`

> ✅ **ANSWERED**: See section 14 above. Separate SQLite table, per-workspace, agent can create/complete.

### 16.3 Session Auto-Naming
Task says "cheap/fast model" but doesn't specify:
1. Which model? Haiku? Local LLM? Rule-based heuristic?
2. When does it trigger? After first assistant response? On session close?
3. What's the fallback if naming fails? "Untitled Session"?
4. Can user override? (Yes, but when does auto-rename stop trying?)

> ✅ **ANSWERED**: Heuristic for MVP, optional model. After first assistant response. Fallback "Untitled". User edit disables auto-naming. See [decisions](./smithers-v2-decisions.md#162-session-auto-naming).

### 16.4 Keyboard Shortcuts
Only `⌘K` for skills palette is mentioned. Need to define:
1. Full keymap for MVP (navigation, actions, terminal toggle)
2. Are shortcuts customizable?
3. How do shortcuts work when terminal drawer has focus?

> ✅ **ANSWERED**: Full keymap defined (⌘K, ⌘N, ⌘F, ⌘G, ⌘⌥T, etc.). Not customizable in MVP. Terminal retains non-⌘ keys. See [decisions](./smithers-v2-decisions.md#151-keyboard-shortcuts).

### 16.5 Error Recovery UX
PRD mentions "Retry from node" and "Fork from node" but:
1. What's the UI for these? Context menu? Buttons?
2. Does "Retry" replay the exact same input, or let user edit?
3. Does "Fork" create a new session or a branch in the same session?
4. How is partial state handled (e.g., some tool calls succeeded)?

> ✅ **ANSWERED**: Error cards + context menu. Retry replays exact input. Fork creates branch in same session. Tool nodes remain, new run node added. See [decisions](./smithers-v2-decisions.md#163-error-recovery-ux).

### 16.6 Cost/Token Tracking
PRD says "not primary UI element in MVP" but:
1. Is usage data even captured? (Anthropic API returns it)
2. Where is it stored? Per-run? Per-session?
3. Is there any visibility at all? (Inspector? Settings?)
4. Is this needed for rate limiting / budget features later?

> ✅ **ANSWERED**: Capture and store per run. Hidden behind "Run Details" inspector in dev mode. Useful for future budgets. See [decisions](./smithers-v2-decisions.md#164-costtoken-tracking).

### 16.7 Multiple Workspaces
Sidebar shows "WorkspacePicker" in the design but:
1. How are workspaces created? (Open folder dialog?)
2. Can a workspace be a non-git/non-jj directory?
3. What's stored per-workspace? (Sessions, MCP config, settings)
4. Can you have multiple workspaces open simultaneously?

> ✅ **ANSWERED**: "Open Folder…" dialog. Yes, non-git allowed (disables checkpoints). Per-workspace: sessions, MCP config, todos, sandbox mode. One active at a time in MVP. See [decisions](./smithers-v2-decisions.md#165-multiple-workspaces).

### 16.8 Subagent Model (Placeholder)
Tasks mention "subagent" as placeholder but:
1. What's the MVP behavior when Claude SDK spawns a subagent?
2. Do we show subagent runs as collapsed cards? Separate tab?
3. Can user drill into subagent transcript?
4. Is subagent terminal a separate sandbox?

> ✅ **ANSWERED**: Collapsed cards + graph lane. Drill-in to read-only detail view. Share workspace terminal (label clearly). See [decisions](./smithers-v2-decisions.md#166-subagent-model).

---

## Summary: Questions Requiring Answers Before Implementation

> ✅ **ALL QUESTIONS ANSWERED** — Ready for implementation.

**~~Must answer for MVP:~~** ✅ ALL RESOLVED
1. ~~AGENTS.md injection point and discovery logic~~ → Backend at `run.start`, workspace root only
2. ~~Todos data model and persistence~~ → SQLite table, per-workspace
3. ~~Session auto-naming trigger and model choice~~ → Heuristic after first response
4. ~~Error recovery UI~~ → Error cards + context menu

**~~Can defer but need decision:~~** ✅ ALL RESOLVED
5. ~~Full keyboard shortcut map~~ → Defined in decisions doc
6. ~~Cost tracking storage~~ → Per-run, hidden in dev mode
7. ~~Workspace creation flow~~ → "Open Folder…" dialog
8. ~~Subagent display behavior~~ → Collapsed cards + graph lane
