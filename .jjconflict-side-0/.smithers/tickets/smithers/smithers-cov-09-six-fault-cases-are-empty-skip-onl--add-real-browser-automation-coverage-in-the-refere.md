# Add real browser automation coverage in the reference runtime

GitHub: https://github.com/smithersai/smithers/issues/826

Parent: smithers/cov-09-six-fault-cases-are-empty-skip-only-stubs-entire.md

Context: e2e/faults/case20-browser-automation-reference-runtime.test.ts is a skip-only stub. Acceptance criteria: provision the reference runtime's real Chromium/Playwright capability; execute a browser task inside the workspace; verify the result through the production runtime path; use no fabricated browser or gateway data; keep typecheck and the e2e package tests green.
