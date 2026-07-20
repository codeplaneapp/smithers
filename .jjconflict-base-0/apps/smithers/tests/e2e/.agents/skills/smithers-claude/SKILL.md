---
name: smithers-claude
description: "Protocol commands for the Claude Code plugin: mirror runs into /workflows and notify the session. Run `smithers claude --help` for usage details."
requires_bin: smithers
command: smithers claude
---

# smithers claude monitor

Follow the runs this session subscribed to (claude tick / claude subscribe) and print one NDJSON line per actionable transition (approval pending, human request, failed, stalled); --transitions all adds finished/cancelled/continued, --all-runs follows every run in the workspace. Backs the plugin's background monitor.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--intervalMs` | `number` | `2000` | Poll interval in ms |
| `--stalledAfterMs` | `number` | `120000` | Heartbeat age that flags a running run as stalled |
| `--ticks` | `number` |  | Stop after N polls (default: run until killed) |
| `--transitions` | `string` | `actionable` | Which transitions stream: actionable (approvals, human requests, failures, stalls) or all (also finished/cancelled/continued) |
| `--allRuns` | `boolean` | `false` | Follow every run in the workspace instead of only the runs this session subscribed to (via claude tick / claude subscribe) |

---

# smithers claude node-wait

Block until one node reaches a terminal state, then print its final state and output. Returns timedOut: true on --timeout-ms expiry (re-invoke to keep waiting).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `nodeId` | `string` | yes | Node ID to wait on |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--runId` | `string` |  | Run ID that owns the node |
| `--iteration` | `number` |  | Loop iteration (default: latest) |
| `--timeoutMs` | `number` | `480000` | Max wait in ms before returning timedOut: true |
| `--intervalMs` | `number` | `1000` | Poll interval in ms |
| `--maxOutputChars` | `number` | `2000` | Truncate the node output to this many chars |

---

# smithers claude subscribe

Subscribe this session's background monitor to a run (done automatically by `claude tick` and Claude-launched runs); the monitor only notifies about subscribed runs.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID the session's monitor should follow |

---

# smithers claude tick

One /workflows mirror frame for a run: status, phase plan, nodes, deltas since --after-seq, outputs, approvals. --wait blocks until something relevant changes.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to mirror |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--afterSeq` | `number` | `0` | Event-log cursor from the previous tick's `seq` |
| `--wait` | `boolean` | `false` | Block until a mirror-relevant event lands after --after-seq (or timeout) |
| `--timeoutMs` | `number` | `420000` | Max wait in ms before returning timedOut: true |
| `--intervalMs` | `number` | `750` | Wait poll interval in ms |
| `--maxOutputChars` | `number` | `2000` | Truncate node outputs to this many chars |
| `--collapsePhases` | `boolean` | `false` | Collapse the phase plan to a single phase |

---

# smithers claude unsubscribe

Stop this session's background monitor from following a run (outside a Claude Code session it drops the run for every session).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID the session's monitor should follow |
