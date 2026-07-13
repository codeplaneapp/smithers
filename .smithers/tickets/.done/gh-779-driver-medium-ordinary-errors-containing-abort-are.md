# 🐛 driver: [medium] ordinary errors containing “abort” are misclassified as cancellation

GitHub: https://github.com/smithersai/smithers/issues/779

_via 2026-07 full-codebase audit_

## Summary

WorkflowDriver treats any error name or message containing the substring abort as intentional cancellation, even when the run AbortSignal was never aborted.

## Where

- `packages/driver/src/WorkflowDriver.js:199-204 — /abort/i matches arbitrary messages`
- `packages/driver/src/WorkflowDriver.js:519-528 — matching failures become cancelled`
- `packages/driver/src/WorkflowDriver.js:583-596 — taskFailed is bypassed and the run is cancelled`

## Failure scenario / repro

A task throwing Error("database transaction aborted due to serialization conflict") with a live signal returns a cancelled run and records no task failure.

## Impact

Ordinary provider, database, and subprocess failures silently bypass failure reporting, retry policy, diagnostics, and correct run status.

## Suggested fix

Classify cancellation from explicit signal state and recognized abort identities or tagged internal sentinels, not arbitrary message substrings.

## Tests

- Assert genuine AbortError/signal cancellation still cancels
- Assert transaction-aborted and custom non-abort errors follow normal task failure handling

## Dedupe notes

#580, #683, and #705 cover different genuine-abort lifecycle bugs.


> Closed by ticket-fleet: landed on main in 4832514082210f99ae3cd4a460283364e19d8b13.
