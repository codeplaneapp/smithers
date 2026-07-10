# 🐛 fix(aws): [low] codebuild runner omits stopped=true on natural termination, firing a redundant StopBuild on cleanup

GitHub: https://github.com/smithersai/smithers/issues/721

_via ultracode (Opus multi-agent) review_

## Summary
The CodeBuild sandbox runner does not set `stopped = true` when a build reaches a terminal state, so `destroy()` issues a redundant (and on real AWS, erroring) `StopBuild` against an already-completed build. The ECS runner does this correctly; the two runners have diverged.

## Location
- `packages/aws/src/createAwsCodeBuildSandboxRunner.js:115` — `if (build && String(build.buildStatus) !== "IN_PROGRESS") return build;` returns without setting `stopped = true`.
- Contrast: `packages/aws/src/createAwsEcsSandboxRunner.js:104-108` sets `stopped = true` on natural STOPPED with an explicit "must not issue a redundant StopTask" comment.
- `stop()` gate: `createAwsCodeBuildSandboxRunner.js:90-98` (`if (!buildId || stopped) return;`).
- Caller: `createAwsSandboxProvider.js:178-179` — `destroy()` calls `runner.stop()`.
- Test locking in wrong behavior: `packages/aws/tests/createAwsSandboxProvider.test.js:317-324` asserts `stoppedBuilds.length === 1`; the analogous ECS test at `:164-176` asserts `stoppedTasks.length === 0`.

## Failure scenario
Run a codebuild-mode sandbox that completes with `buildStatus: SUCCEEDED`, then let the kit call `cleanup('destroy')`. Because `stopped` is still `false` and `buildId` is set, `stop()` invokes `codebuild.stopBuild({ id })` on a terminal build. On real AWS this returns `InvalidInputException` ("Build ... is already completed"), swallowed by the best-effort try/catch — so every codebuild run's cleanup fires one guaranteed-no-op/erroring API call.

## Why it matters
Concrete state-tracking asymmetry with the ECS runner: a wasted (and error-generating) API call on every codebuild cleanup, contributing to throttling and diverging from the documented ECS contract. The test enshrines the incorrect behavior.

## Fix
Set `stopped = true` immediately before `return build` in `pollUntilComplete`, mirroring the ECS runner, and update the codebuild cleanup test to assert `stoppedBuilds.length === 0`.
