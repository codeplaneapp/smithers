# Add prefer-resume semantics for child fan-out

GitHub: https://github.com/smithersai/smithers/issues/1003

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: restarting or resuming an orchestrator can launch duplicate detached children instead of reusing children already in flight. Acceptance criteria: define a stable child identity or idempotency key; on parent resume discover and reattach or resume an existing child; prevent duplicate launches; preserve child outputs and terminal states; test crash/restart, nested fan-out, and retry scenarios.
