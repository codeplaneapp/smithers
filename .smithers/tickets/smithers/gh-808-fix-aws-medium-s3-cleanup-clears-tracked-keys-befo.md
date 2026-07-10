# 🐛 fix(aws): [medium] S3 cleanup clears tracked keys before deletion, making failure unretryable

GitHub: https://github.com/smithersai/smithers/issues/808

_via 2026-07 full-codebase audit_

## Summary

The AWS sandbox S3 transport clears tracked object keys before deleteObjects, then swallows deletion errors. A transient failure permanently erases the information needed to retry.

## Where

- `packages/aws/src/createAwsSandboxS3Transport.js:137-150`

## Failure scenario / repro

Write sandbox objects, make the first deleteObjects fail, then call deleteAll again. The second call returns without another deletion because touchedKeys was already cleared.

## Impact

Request/result/CA objects can remain in S3 indefinitely and callers cannot repair the leak by retrying.

## Suggested fix

Remove keys only after successful deletion and retain exactly any per-object failures. Best-effort cleanup may remain non-fatal while preserving retry state and emitting a warning.

## Tests

- Fail the first deletion and succeed the second; assert the same keys are retried
- Cover partial per-object failures if supported

## Dedupe notes

#721 concerns StopBuild cleanup, not S3 object deletion.
