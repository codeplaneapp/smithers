# Run the long-lived soak against a real workspace runtime

GitHub: https://github.com/smithersai/smithers/issues/830

Parent: smithers/cov-09-six-fault-cases-are-empty-skip-only-stubs-entire.md

Context: e2e/faults/case30-soak-jjhub-long-lived.test.ts:11-13 and :56-85 only simulate runs with an in-memory SmithersDb and defer the real JJHub runtime. Acceptance criteria: exercise a real long-lived workspace runtime across repeated runs; verify file/run integrity and RSS budget; retain the opt-in soak gate; use real runtime data and no simulated JJHub substitute.
