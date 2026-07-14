# 🐛 time-travel: [high] process-local rewind lock allows concurrent rewinds to corrupt VCS and DB state

GitHub: https://github.com/smithersai/smithers/issues/777

_via 2026-07 full-codebase audit_

## Summary

The jumpToFrame single-flight lock is a module-local Map. Separate CLI, MCP, or server processes can rewind the same run simultaneously and interleave filesystem reversion with database truncation/rebuild.

## Where

- `packages/time-travel/src/acquireRewindLock.js:12-31 — lock is process-local`
- `packages/time-travel/src/jumpToFrame.js:509-605 — state is preloaded before mutation`
- `packages/time-travel/src/jumpToFrame.js:635-688 — VCS state is reverted`
- `packages/time-travel/src/jumpToFrame.js:721-853 — DB state is truncated and rewritten`

## Failure scenario / repro

Two independent Bun processes both acquired the same run lock. Rewinds to different frames can then leave the filesystem at one frame and durable rows at another.

## Impact

Concurrent operator actions can corrupt filesystem/DB correspondence, delete wrong attempts or outputs, and make later replay/resume operate on inconsistent history.

## Suggested fix

Use a durable compare-and-set lease keyed by run ID with owner token and expiry, acquired before reading rewind state. Verify ownership before destructive phases and release conditionally.

## Tests

- Run a true two-process contention test and assert the second receives Busy
- Cover release and stale-owner recovery

## Dedupe notes

#678 tracks startup recovery clobbering a rewind, not concurrent rewind exclusion. #679 is a different compensation gap.


> Closed by ticket-fleet: landed on main in 2121c9b2b25c29a211106a52f60643798f773f17.
