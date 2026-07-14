# 🐛 fix(aws): [medium] aborting ECS or CodeBuild runs leaves AWS SDK requests alive

GitHub: https://github.com/smithersai/smithers/issues/807

_via 2026-07 full-codebase audit_

## Summary

The AWS adapter calls client.send(command) without handler options. ECS and CodeBuild runners check cancellation only between awaits, so a pending SDK request cannot be interrupted.

## Where

- `packages/aws/src/resolveAwsSdkClient.js:49-62`
- `packages/aws/src/createAwsEcsSandboxRunner.js:98-102,143-182`
- `packages/aws/src/createAwsCodeBuildSandboxRunner.js:109-113,138-168`

## Failure scenario / repro

If runTask, describeTasks, startBuild, or batchGetBuilds never settles, aborting the run signal leaves the runner pending and prevents reliable cleanup.

## Impact

Cancelled runs can hang locally while billable ECS tasks or CodeBuild builds remain alive.

## Suggested fix

Accept AWS handler options and call client.send(command,{abortSignal}); thread the signal through launch, polling, log, and stop calls, with cleanup once a remote ID exists.

## Tests

- Abort injected never-settling launch and polling calls
- Assert prompt rejection and exactly-once cleanup where possible

## Dedupe notes

#721 is redundant cleanup; #724/#738 are GCP/Vercel cancellation.


> Closed by ticket-fleet: landed on main in 0fb5e448567a50cb04071c0d0328be31d84a1436.
