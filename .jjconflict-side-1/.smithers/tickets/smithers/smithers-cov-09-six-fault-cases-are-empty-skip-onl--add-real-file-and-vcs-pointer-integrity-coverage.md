# Add real file and VCS pointer integrity coverage

GitHub: https://github.com/smithersai/smithers/issues/827

Parent: smithers/cov-09-six-fault-cases-are-empty-skip-only-stubs-entire.md

Context: e2e/faults/case21-file-vcs-pointer-integrity.test.ts is a skip-only stub requiring workspace persistence and JJ-backed VCS pointers. Acceptance criteria: run repeated real workspace operations using fs.persist/restore and vcs.pointer; verify files and VCS pointers remain correct across runs; use real workspace snapshots and no hand-rolled stand-ins; keep typecheck and the e2e package tests green.
