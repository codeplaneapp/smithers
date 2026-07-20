# Surface concurrency-ceiling saturation in durable run diagnostics

GitHub: https://github.com/smithersai/smithers/issues/1058

When the slot governor reaches SMITHERS_AUTO_MAX_CONCURRENCY_CEILING while demand remains queued, persist an operator-visible run-state warning containing requested demand, effective cap, and the remediation command. Display it in smithers why and the monitor health strip, with tests covering the persisted state and both surfaces.
