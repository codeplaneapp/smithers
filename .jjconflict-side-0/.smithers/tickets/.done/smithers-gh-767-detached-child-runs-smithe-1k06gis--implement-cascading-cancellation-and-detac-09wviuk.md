# Implement cascading cancellation and detached-owner process cleanup

GitHub: https://github.com/smithersai/smithers/issues/1001

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: smithers cancel currently affects only the selected run, allowing linked descendants and their agent processes to continue. Acceptance criteria: recursively discover descendants; cancel live children through durable requests and handle waiting, paused, and stale children; terminate detached owners and agent process groups with platform-appropriate fallbacks; make the operation idempotent and cover nested descendants and race cases with integration tests.


> Closed by ticket-fleet sync: Implemented in packages/db/src/adapter.js:1211-1236 (recursive descendant discovery), apps/cli/src/cancel-cascade.js:12-277 (durable live cancellation, waiting/paused/stale handling, idempotency, race rediscovery, process-group termination and fallbacks), apps/cli/src/index.js:6935-6992 (CLI integration), and packages/engine/src/engine.js:2175-2237 (durable cancel watcher). apps/cli/tests/cancel-cascade.test.js:119-448 covers nested descendants, live requests, waiting/paused/stale runs, in-flight attempts, idempotency, finish/spawn races, detached-owner cleanup, process groups, SIGKILL escalation, and CLI integration. Targeted test result: 12 pass, 0 fail.
