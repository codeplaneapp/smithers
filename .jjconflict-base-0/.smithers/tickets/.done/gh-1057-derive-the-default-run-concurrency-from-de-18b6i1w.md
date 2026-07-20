# Derive the default run concurrency from declared Parallel widths

GitHub: https://github.com/smithersai/smithers/issues/1057

Make up/workflow run inspect the statically extracted graph and choose a default engine maxConcurrency at least as wide as the largest declared Parallel maxConcurrency. Preserve explicit --max-concurrency pins and define how the auto-raise ceiling interacts with the derived default. Add an end-to-end test proving a workflow with Parallel maxConcurrency={64} is not capped at the default 4 or auto ceiling solely because no CLI flag was supplied.


> Closed by ticket-fleet sync: Implemented in packages/engine/src/engine.js and packages/engine/src/slotGovernor.js: extracted graphs derive the widest declared Parallel width, explicit pins remain authoritative, declared widths bypass the demand auto-raise ceiling, and demand raises remain ceiling-bound. packages/graph/src/extract.js records normalized parallelMaxConcurrency. packages/engine/tests/parallel-declared-width.e2e.test.jsx verifies Parallel maxConcurrency={64} reaches peak concurrency 64 with no flag and a ceiling of 16, while the explicit-pin test verifies the pin wins. packages/engine/tests/slot-governor.test.js covers ceiling interaction and pin behavior. The targeted graph and engine test run passed 145 tests with 0 failures.
