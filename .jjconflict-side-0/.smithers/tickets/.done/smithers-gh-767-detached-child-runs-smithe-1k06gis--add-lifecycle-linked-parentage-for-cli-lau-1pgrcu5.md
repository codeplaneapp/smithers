# Add lifecycle-linked parentage for CLI-launched child runs

GitHub: https://github.com/smithersai/smithers/issues/1000

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: Engine-created Subflow runs persist parentRunId, but smithers up --detach cannot declare or propagate a parent. Acceptance criteria: add a supported parent-run option or API; validate and persist the relationship; propagate it through detached process arguments and RunOptions; expose it in inspection/list/tree surfaces; add integration tests for detached and nested child launches.


> Closed by ticket-fleet sync: Implemented and tested. apps/cli/src/index.js:1607-1610 adds --parent-run-id; lines 2047-2108 validate non-empty IDs, resume conflicts, self-parentage, and parent existence. Lines 2210-2224 validate detached parents before spawning and forward the option; lines 2432-2445 revalidate it, while lines 2577-2580 and 2620-2624 pass parentRunId through RunOptions. packages/engine/src/engine.js:5136-5147 carries the option and lines 6452-6465 persist it. The DB schema/migration/index are in packages/db/src/internal-schema.js:2-5 and packages/db/src/schema-migrations.js:75-89,153-155. Inspect and ps expose parentRunId at apps/cli/src/index.js:1211-1216,1499-1505; ancestry/descendant tree traversal is implemented in packages/db/src/adapter.js:1165-1235 and tested by packages/db/tests/cov-adapter.test.js and packages/db/tests/db-run-descendants.test.js. apps/cli/tests/up-parent-run-id.e2e.test.js:51-166 covers nested foreground and detached grandchild launches, persistence, inspect/ps output, missing parents, self-parentage, resume conflicts, and blank IDs. Targeted test result: 4 pass, 0 fail.
