# [medium] `smithers up` reports a graceful pause as exit 1 (failure)

GitHub: https://github.com/smithersai/smithers/issues/617

**Severity:** Medium · **Feature:** graceful pause · **File:** `apps/cli/src/index.js:318`

## Problem
`formatStatusExitCode` has no case for the new `'paused'` status, so it falls through to the generic-failure default and returns **exit code 1** — the same code as a failed run. `isWaitingStatus('paused')` is also `false` (`361-365`) and `pauseCtas('paused')` returns `[]` (`372-387`). So a **deliberate, resumable graceful pause** is reported as a failure with the wrong summary and no resume CTA.

Existing mapping: `finished=0`, `waiting-*=3`, `cancelled=2`, else `1`. `paused` was not added and falls through to `1`.

## Failure scenario
`smithers up <wf>` (foreground or `-d`) is running; `smithers pause <runId>` is issued; the engine drains and parks the run resumably; `runWorkflow` returns `{status:'paused'}`. `finishRun` (`index.js:2364`) calls `formatStatusExitCode('paused')` → `1`. The summary prints "Next steps:" instead of "Run is paused (not a failure)", and no `up --resume` CTA is shown. A CI/script wrapping `smithers up` sees **exit 1** and misclassifies the deliberate pause as a failure. Same mapping applies to the hello / chat-create / system-workflow call sites (`index.js:7034,7110,7301,7567`).

## Suggested fix
Give `paused` a distinct non-failure exit code (e.g. `3`, like waiting) and add it to `isWaitingStatus` and `pauseCtas` (with an `up --resume` CTA).

## Verification
Traced the full chain: `runWorkflow` returns `{status:"paused"}` on graceful pause; `finishRun` returns a success envelope so the exit code survives to `process.exit` → **exit 1**. No test references `formatStatusExitCode`/`isWaitingStatus`/`pauseCtas` for `paused`, so this is an oversight. Related: paused status also missing from `snapshotToGatewayRunNode` tone mapping (separate low-severity issue).

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
