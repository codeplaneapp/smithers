---
description: "Plan, approve, and run one flow; -d launches it detached"
---

# smithers up

Plan, approve, and run one flow; -d launches it detached.

## Usage

```sh
smithers up [flags] <flow>
```

## Behavior

One-shot launch: plan, approve with scope `run`, run; prints `{ runId }` under `--json`; exit code follows the terminal status. `-d` spawns `smithers run` detached, logs to `.flows/logs/<runId>.log`, and returns after the admission line (30 s default). Operator-supplied run ids are not supported; callers read `runId` from the receipt.

## Flags

| Flag | Meaning |
| --- | --- |
| `--data string` | See the behavior above. |
| `--detached, -d` | See the behavior above. |

## Removed flags

These flags existed in Smithers 0.x. `smithers up` declares each one so it fails with a migration message instead of a usage error, and exits 1.

| Flag | Reason |
| --- | --- |
| `--serve` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `--interactive` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `--supervise` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `--herdr` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `--monitor` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `--report` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `--force` | the run driver's heartbeat sweep owns recovery |
| `--steal-ownership` | the run driver's heartbeat sweep owns recovery |
| `--resume-claim-*` | the run driver's heartbeat sweep owns recovery |
| `--resume-restore-*` | the run driver's heartbeat sweep owns recovery |
| `--max-concurrency &lt;n&gt;` | parallelism is declared by the flow and bounded by plan admission |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
