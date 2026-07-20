---
name: smithers-workflow
description: Discover local workflows from .smithers/workflows. Run `smithers workflow --help` for usage details.
requires_bin: smithers
command: smithers workflow
---

# smithers workflow create

Create a new flat workflow scaffold in .smithers/workflows (or the global ~/.smithers with --global).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | yes | Workflow ID |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--global` | `boolean` | `false` | Create the workflow in the global ~/.smithers pack (honors SMITHERS_HOME) instead of the local .smithers |

---

# smithers workflow doctor

Inspect workflow discovery, preload files, and detected agents.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | no | Workflow ID |

---

# smithers workflow inspect

Show workflow metadata and an agent-facing skill preview.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | yes | Workflow ID |

---

# smithers workflow list

List discovered local workflows. System workflows are hidden unless --system is passed.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--system` | `boolean` | `false` | Include system workflows (internal plumbing hidden from the default listing) |

---

# smithers workflow path

Resolve a workflow ID to its entry file.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | yes | Workflow ID |

---

# smithers workflow run

Run a discovered workflow by ID. Omit the ID (or pass --interactive) to pick one interactively.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | no | Workflow ID (omit with --interactive to pick one) |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--detach` | `boolean` | `false` | Run in background, print run ID, exit |
| `--runId` | `string` |  | Explicit run ID |
| `--parentRunId` | `string` |  | Existing run ID to record as this run's parent (persisted lineage, surfaced by inspect/ps and the MCP run tools) |
| `--maxConcurrency` | `number` |  | Maximum parallel tasks (default: 4) |
| `--root` | `string` |  | Tool sandbox root directory |
| `--log` | `boolean` | `true` | Enable NDJSON event log file output |
| `--logDir` | `string` |  | NDJSON event logs directory |
| `--allowNetwork` | `boolean` | `false` | Allow bash tool network requests |
| `--maxOutputBytes` | `number` |  | Max bytes a single tool call can return |
| `--toolTimeoutMs` | `number` |  | Max wall-clock time per tool call in ms |
| `--hot` | `boolean` | `false` | Enable hot module replacement for .tsx workflows |
| `--input` | `string` |  | Input data as JSON string |
| `--annotations` | `string` |  | Run annotations as a flat JSON object of string/number/boolean values |
| `--resume` | `unknown` | `false` | Resume a previous run. Pass true with --run-id, or pass the run ID directly (e.g. --resume <run-id>) |
| `--force` | `boolean` | `false` | Resume even if still marked running |
| `--resumeClaimOwner` | `string` |  | Internal durable resume claim owner |
| `--resumeClaimHeartbeat` | `number` |  | Internal durable resume claim heartbeat |
| `--resumeRestoreOwner` | `string` |  | Internal durable resume restore owner |
| `--resumeRestoreHeartbeat` | `number` |  | Internal durable resume restore heartbeat |
| `--serve` | `boolean` | `false` | Start an HTTP server alongside the workflow |
| `--supervise` | `boolean` | `false` | Run the stale-run supervisor loop (with --serve) |
| `--superviseDryRun` | `boolean` | `false` | With --supervise, detect stale runs without resuming |
| `--superviseInterval` | `string` | `10s` | With --supervise, poll interval (e.g. 10s, 30s) |
| `--superviseStaleThreshold` | `string` | `30s` | With --supervise, stale heartbeat threshold |
| `--superviseMaxConcurrent` | `number` | `3` | With --supervise, max runs resumed per poll |
| `--port` | `number` | `7331` | HTTP server port (with --serve) |
| `--host` | `string` | `127.0.0.1` | HTTP server bind address (with --serve) |
| `--authToken` | `string` |  | Bearer token for HTTP auth (or set SMITHERS_API_KEY); required to bind a non-loopback --host |
| `--insecure` | `boolean` | `false` | Allow binding a non-loopback --host with NO auth (exposes unauthenticated approve/deny/cancel control of the run — dangerous) |
| `--metrics` | `boolean` | `true` | Expose /metrics endpoint (with --serve) |
| `--backend` | `string` |  | Bootstrap storage selection for a workflow owner or workspace Gateway; not a run-discovery/control flag |
| `--postFailure` | `boolean` | `true` | Auto-launch the post-failure autopsy workflow when this run fails (disable with --no-post-failure or SMITHERS_POST_FAILURE=0) |
| `--verbose` | `boolean` | `false` | Show engine info logs (run lifecycle, agent sessions) on interactive runs; the default keeps progress lines + warnings only. Non-TTY/structured output always gets full logs. |
| `--report` | `boolean` | `true` | On an interactive run, narrate the result with a cheap/fast agent and open an HTML summary in the browser when it finishes (disable with --no-report or SMITHERS_NO_REPORT=1). |
| `--prompt` | `string` |  | Prompt text mapped to input.prompt when --input is omitted |
| `--interactive` | `boolean` | `false` | Pick a workflow and its inputs through interactive terminal prompts, then launch the full-screen TUI monitor for the run (TTY only) |

---

# smithers workflow skills

Generate agent-facing skill docs for local workflows.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | no | Workflow ID, or omit to generate skills for all workflows |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--output` | `string` |  | Output file for one workflow, or output directory for all workflows |
| `--force` | `boolean` | `false` | Overwrite existing skill files |
| `--global` | `boolean` | `false` | Write skills into the global ~/.smithers pack (honors SMITHERS_HOME) instead of the local .smithers |
