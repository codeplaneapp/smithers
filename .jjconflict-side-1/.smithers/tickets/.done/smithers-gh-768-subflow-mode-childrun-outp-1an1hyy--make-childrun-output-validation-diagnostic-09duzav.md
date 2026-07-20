# Make childRun output validation diagnostics actionable

GitHub: https://github.com/smithersai/smithers/issues/1005

Parent: smithers/gh-768-subflow-mode-childrun-output-is-the-child--0eqwmrr.md

Context: a parent schema mismatch for a childRun currently produces a generic validation message. Main and bridge validation paths persist Zod issues, but they do not report the received value's top-level keys. Acceptance criteria: include path plus expected/received Zod issue data and the received value's top-level keys, or an explicit non-object/array description, in durable and surfaced validation diagnostics for childRun/compute/static output validation; preserve node and output-table context; add a regression test that mismatches a parent childRun schema against the child's final output and asserts the actionable diagnostics.


> Closed by ticket-fleet sync: Implemented in packages/engine/src/output-validation-diagnostics.js:46-148, with issue paths, expected/received data, top-level keys, and explicit array/non-object descriptions. Main, compute, and static paths persist these diagnostics with node and output-table context in packages/engine/src/engine.js:4463-4475, packages/engine/src/effect/compute-task-bridge.js:530-539, and packages/engine/src/effect/static-task-bridge.js:150-159. Regression coverage in packages/engine/tests/childrun-output-validation-diagnostics.e2e.test.jsx:34-112 verifies parent childRun mismatch, durable details, surfaced messages, arrays, and static output. Unit coverage is in packages/engine/tests/output-validation-diagnostics.test.js:50-89. Relevant tests passed: 28 pass, 0 fail.
