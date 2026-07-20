# Cover fresh-engine and stale-sandbox dual-heartbeat classification

GitHub: https://github.com/smithersai/smithers/issues/828

Parent: smithers/cov-09-six-fault-cases-are-empty-skip-only-stubs-entire.md

Context: e2e/faults/case02-kill-sandbox-engine-alive.test.ts:151-159 skips the fresh-engine/stale-sandbox heartbeat branch. Acceptance criteria: add the production sandbox-heartbeat schema and state path if required, then test with real persistence that a fresh engine heartbeat plus stale sandbox heartbeat yields a sandbox-specific unhealthy reason rather than engine-heartbeat-stale; keep existing case02 coverage green.
