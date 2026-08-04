# CLI-transcript fixtures for the file-change-contract parser

Each `.jsonl` file is a contiguous excerpt of real Smithers execution-log
lines (`.smithers/executions/<runId>/logs/stream.ndjson`), filtered down to
one workflow node/iteration/attempt and trimmed to a focused window. Every
line is a complete JSON object matching the source format exactly (one
object per line, no reformatting of the payload itself).

## Format choice

All fixtures use the **`AgentEvent` envelope** as captured in
`stream.ndjson` — i.e. `{"type":"AgentEvent", runId, nodeId, iteration,
attempt, engine, "event": {"type":"action", phase, action: {id, kind,
title, detail}, message, ok, level}, timestampMs, correlation}` — rather
than the raw per-engine SDK/CLI wire event. This workspace's captured logs
normalize each engine's native tool-call/file-edit event into this
`action`/`detail` shape at capture time (see `packages/agents` capture
pipeline); the deeper per-engine raw payloads (Anthropic content blocks,
Codex `apply_patch` protocol frames, OpenCode tool JSON) are not retained
verbatim in these logs except as this normalized envelope, so it is what's
actually available as "real" data. `AgentTraceEvent` lines (raw
stdout/stderr text capture) are sparse and mostly non-file-change chatter
in the surveyed runs; a couple of `TaskStarted`/`TaskCompleted` lines are
included where they fall inside the window to give turn-boundary context.

The important parser-relevant fields per engine, inside
`event.action.detail`:

- **claude-code**: `title: "Edit"` → `detail.input = {file_path, old_string,
  new_string, replace_all}`; `title: "Write"` → `detail.input = {file_path,
  content}`.
- **codex**: `title: "file changes"`, `kind: "file_change"` →
  `detail.changes = [{path, kind: "add"|"update"|"delete"}, ...]` (batches
  multiple files per event).
- **opencode**: `title: "write"` → `detail.input = {filePath, content}`;
  `title: "edit"` → `detail.input` with old/new text (see file for exact
  shape).

## Fixtures

### claude-code

- `claude-code/edit-basic.jsonl` — 47 lines. Source:
  `run-1785811783554`, node `mission:integrate` (iteration 1, attempt 1),
  `.smithers/executions/run-1785811783554/logs/stream.ndjson`. Run started
  2026-08-04 ~02:49 UTC (epoch ms in run id). Exercises a real `Edit`
  file-change (`/Users/williamcory/flows/ui/TODO.md`, `old_string`/
  `new_string` replace) interleaved with `Bash`, `Read`, `ToolSearch`,
  `TaskStop`, and assistant-thought events for realistic surrounding
  context.
- `claude-code/write-basic.jsonl` — 55 lines. Source:
  `run-1785815025417`, node `mission:impl:cloud-workspace-e2e` (iteration
  0, attempt 4),
  `.smithers/executions/run-1785815025417/logs/stream.ndjson`. Run started
  2026-08-04 ~03:43 UTC. Exercises real `Write` file-change events (new
  file content payloads) alongside `Edit` and `Bash` events.

### codex

- `codex/file-changes-basic.jsonl` — 61 lines. Source:
  `run-1785811783554`, node `mission:impl:connectors-scaffold` (iteration
  0, attempt 1),
  `.smithers/executions/run-1785811783554/logs/stream.ndjson`. Exercises
  real codex `file_change` action events batching multiple `add`-kind file
  changes per event (e.g. scaffolding
  `connectors/runtime/{harness,index,invoke,manifest,secrets,triggers,types}.ts`).

### opencode

- `opencode/write-edit-basic.jsonl` — 70 lines. Source:
  `run-1785811783554`, node `mission:impl:onboarding-cards` (iteration 0,
  attempt 1),
  `.smithers/executions/run-1785811783554/logs/stream.ndjson`. Exercises
  real opencode `write` and `edit` file-change action events (full file
  content payloads) plus `bash`/`read`/assistant events.

## Missing: kimi

No usable kimi fixture was produced. Every execution log under
`.smithers/executions/` containing `"engine":"kimi"` (four oneshot runs:
`oneshot-ms9diwv5-22e9dda1`, `oneshot-msclpwar-85922675`,
`oneshot-msdkf70k-bc37e6ff`, `oneshot-mse7dxlj-e37c86ba`) has exactly one
kimi `AgentEvent` line each, and all four are a terminal `{"type":
"completed", "ok": false, "error": "To resume this session: kimi -r
<uuid>", ...}` event with no file-change payload at all (kimi appears to
have failed to start/authenticate in each captured run). No line anywhere
in this workspace's execution logs shows a kimi tool call or file edit.
Per instructions, no kimi fixture was fabricated — flagging as missing
pending a real kimi run with file-change activity.

## Other engines checked, not found

Searched `.smithers/executions/*/logs/stream.ndjson` for `"engine":"..."`
values workspace-wide; only `codex`, `claude-code`, `opencode`, `claude`
(a handful of lines, appears to be an alias/legacy tag for claude-code),
`kimi`, and `fake-cli` (test fixture data, not a real engine) appear. No
cursor, gemini, or amp engine traffic exists in this workspace's captured
logs.
