---
name: smithers-optimize
description: Run GEPA prompt optimization over a workflow eval suite and write an optimized prompt artifact. Run `smithers optimize --help` for usage details.
requires_bin: smithers
command: smithers optimize
---

# smithers optimize

Run GEPA prompt optimization over a workflow eval suite and write an optimized prompt artifact.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workflow` | `string` | yes | Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--cases` | `string` |  | JSON or JSONL eval case file |
| `--suite` | `string` |  | Stable suite ID used in run IDs and report paths |
| `--provider` | `string` | `openai-api` | GEPA patch generator provider |
| `--model` | `string` |  | Optimizer model for provider-backed GEPA |
| `--artifact` | `string` |  | Write the optimized prompt artifact to this path |
| `--reportDir` | `string` |  | Directory for baseline and optimized eval reports |
| `--minImprovement` | `number` | `0.000001` | Minimum required absolute score improvement |
| `--maxCases` | `number` |  | Run only the first N cases |
| `--concurrency` | `number` | `1` | Number of eval cases to run at once |
| `--maxConcurrency` | `number` |  | Per-workflow max task concurrency |
| `--root` | `string` |  | Tool sandbox root directory |
| `--log` | `boolean` | `true` | Enable NDJSON event log file output |
| `--logDir` | `string` |  | NDJSON event logs directory |
| `--allowNetwork` | `boolean` | `false` | Allow bash tool network requests |
| `--maxOutputBytes` | `number` |  | Max bytes a single tool call can return |
| `--toolTimeoutMs` | `number` |  | Max wall-clock time per tool call in ms |
