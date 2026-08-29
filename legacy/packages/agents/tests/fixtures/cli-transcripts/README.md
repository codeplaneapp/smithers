# CLI-transcript fixtures for the file-change-contract parser

Each `.jsonl` file is a scrubbed contiguous excerpt of real Smithers execution-log
lines (`.smithers/executions/<runId>/logs/stream.ndjson`), filtered down to
one workflow node/iteration/attempt and trimmed to a focused window. Every
line is a complete JSON object with the same event shape as the source line.
Run `node scripts/scrub-transcript-fixture.mjs <fixture.jsonl>` before commit;
it replaces local paths, run/session identifiers, and timestamps with
deterministic placeholders. Tool-call ids are mapped to *distinct*
placeholders (`tool-fixture-1`, `tool-fixture-2`, … in first-appearance
order) so started/completed correlation by action id survives scrubbing.
The source `stream.ndjson` is compact JSON (no space after `:`/`,`); these
fixtures are re-serialized with the formatter's default spacing for
readability, so lines are not byte-identical to the source, only
value-identical.

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

`KimiAgent.parseFileChanges` is nonetheless implemented (not left absent):
the installed `kimi_cli` 1.48.0 vendor package
(`kimi_cli/tools/file/write.py`, `kimi_cli/tools/file/replace.py`) was read
directly to confirm kimi's real builtin file-mutating tool names and
argument schemas (`WriteFile{path,content,mode}`,
`StrReplaceFile{path,edit:{old,new,replace_all}|Edit[]}` — notably *not*
Claude Code's `Edit`/`Write`/`file_path`/`old_string` shape, despite kimi
sharing Claude's OpenAI-style `function.arguments` JSON-string tool-call
envelope). `packages/agents/tests/file-change-contract.test.js` covers this
with schema-accurate synthetic payloads (not a captured transcript) built
directly from that vendor source. Promote to a real fixture once a kimi run
with file-change activity is captured.

## Other engines checked, not found

Searched `.smithers/executions/*/logs/stream.ndjson` for `"engine":"..."`
values workspace-wide; only `codex`, `claude-code`, `opencode`, `claude`
(a handful of lines, appears to be an alias/legacy tag for claude-code),
`kimi`, and `fake-cli` (test fixture data, not a real engine) appear. No
cursor, gemini, or amp engine traffic exists in this workspace's captured
logs.
