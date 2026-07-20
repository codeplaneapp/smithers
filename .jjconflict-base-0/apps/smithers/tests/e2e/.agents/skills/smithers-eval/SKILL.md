---
name: smithers-eval
description: Run a workflow over a JSON/JSONL eval suite and write a regression report. Run `smithers eval --help` for usage details.
requires_bin: smithers
command: smithers eval
---

# smithers eval

Run a workflow over a JSON/JSONL eval suite and write a regression report.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--cases` | `string` |  | JSON or JSONL eval case file |
| `--suite` | `string` |  | Stable suite ID used in run IDs and report paths |
| `--runLabel` | `string` |  | Run label appended to eval run IDs; defaults to current UTC timestamp plus a nonce |
| `--dryRun` | `boolean` | `false` | Plan the suite without launching runs |
| `--concurrency` | `number` | `1` | Number of eval cases to run at once |
| `--maxCases` | `number` |  | Run only the first N cases |
| `--report` | `string` |  | Write report JSON to this path |
| `--force` | `boolean` | `false` | Overwrite an existing eval report |
| `--includeOutput` | `boolean` | `true` | Include workflow outputs in the report |
| `--maxConcurrency` | `number` |  | Per-workflow max task concurrency |
| `--root` | `string` |  | Tool sandbox root directory |
| `--log` | `boolean` | `true` | Enable NDJSON event log file output |
| `--logDir` | `string` |  | NDJSON event logs directory |
| `--allowNetwork` | `boolean` | `false` | Allow bash tool network requests |
| `--maxOutputBytes` | `number` |  | Max bytes a single tool call can return |
| `--toolTimeoutMs` | `number` |  | Max wall-clock time per tool call in ms |
| `--optimization` | `string` |  | Apply a Smithers optimization artifact while running the eval suite |
