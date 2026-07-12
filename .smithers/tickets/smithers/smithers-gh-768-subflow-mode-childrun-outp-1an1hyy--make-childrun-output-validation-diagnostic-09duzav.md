# Make childRun output validation diagnostics actionable

GitHub: https://github.com/smithersai/smithers/issues/1005

Parent: smithers/gh-768-subflow-mode-childrun-output-is-the-child--0eqwmrr.md

Context: a parent schema mismatch for a childRun currently produces a generic validation message. Main and bridge validation paths persist Zod issues, but they do not report the received value's top-level keys. Acceptance criteria: include path plus expected/received Zod issue data and the received value's top-level keys, or an explicit non-object/array description, in durable and surfaced validation diagnostics for childRun/compute/static output validation; preserve node and output-table context; add a regression test that mismatches a parent childRun schema against the child's final output and asserts the actionable diagnostics.
