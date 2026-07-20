# Add real auth persistence coverage across workspace suspend/resume

GitHub: https://github.com/smithersai/smithers/issues/825

Parent: smithers/cov-09-six-fault-cases-are-empty-skip-only-stubs-entire.md

Context: e2e/faults/case19-auth-persistence-suspend-resume.test.ts is a skip-only stub blocked on the workspace runtime. Acceptance criteria: exercise a real workspace runtime with an auth-persistent home volume; suspend and resume the workspace; verify authentication state survives; use real backends and no mocks; keep typecheck and the e2e package tests green.
