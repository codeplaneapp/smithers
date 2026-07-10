# 🐛 fix(integrations): [low] GitHub sleeps after the final failed attempt when retries are disabled

GitHub: https://github.com/smithersai/smithers/issues/814

_via 2026-07 full-codebase audit_

## Summary

GitHub Retry-After handling runs in Effect.tapError before the retry schedule decides whether another attempt exists. The final failure sleeps even when maxRetries is zero or exhausted.

## Where

- `packages/integrations/src/github/GitHubClient.js:198-219`

## Failure scenario / repro

A local server returns 429 with Retry-After and maxRetries:0. Only one request occurs, but the failure is delayed and logged as retrying; the production cap allows up to 60 seconds.

## Impact

Failures and shutdown are delayed after the outcome is decided, consuming workflow time and emitting misleading logs.

## Suggested fix

Move server-directed delay into the retry schedule so it applies only between attempts, and log only when a retry is actually scheduled.

## Tests

- maxRetries:0 has one request and no delay/log
- maxRetries:1 has exactly one delay between two calls
- No trailing delay after the exhausted final attempt

## Dedupe notes

No matching issue or open PR.
