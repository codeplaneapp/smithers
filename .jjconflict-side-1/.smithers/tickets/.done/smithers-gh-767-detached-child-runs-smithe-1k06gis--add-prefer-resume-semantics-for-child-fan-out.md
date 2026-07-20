# Add prefer-resume semantics for child fan-out

GitHub: https://github.com/smithersai/smithers/issues/1003

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: restarting or resuming an orchestrator can launch duplicate detached children instead of reusing children already in flight. Acceptance criteria: define a stable child identity or idempotency key; on parent resume discover and reattach or resume an existing child; prevent duplicate launches; preserve child outputs and terminal states; test crash/restart, nested fan-out, and retry scenarios.


> Closed by ticket-fleet sync: Implemented in packages/engine/src/child-workflow.js with deterministic child IDs (parent:child:step:iteration), existing-run discovery, terminal output preservation, live-child attachment, stale-owner resumption, and nested identity composition. packages/engine/tests/child-workflow-prefer-resume.test.jsx covers crash/restart preservation, live attachment, remote terminal failure, retry reuse, stale crashed-owner recovery, and nested child/grandchild fan-out without duplicates. Targeted command passed: bun test --timeout=60000 --max-concurrency=1 packages/engine/tests/child-workflow-prefer-resume.test.jsx — 7 pass, 0 fail, 54 expect() calls.
