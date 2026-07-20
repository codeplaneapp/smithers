# Add rendered coverage for runs and run inspector surfaces

GitHub: https://github.com/smithersai/smithers/issues/1045

Parent: smithers/smithers-gh-856-add-responsive-accessibili-1wvv7n1--add-rendered-coverage-for-major-monitor-surfaces.md

Context: runs.spec.ts and inspector.spec.ts cover basic populated rendering but do not provide a full state matrix. Acceptance criteria: Add browser tests against the real seeded gateway for populated runs, no-match/empty filtering, run selection, inspector tabs, node selection, and representative inspector content; assert no uncaught page errors.


> Closed by ticket-fleet sync: apps/smithers/tests/e2e/runs.spec.ts covers populated grouped runs, no-match search/status filtering with Clear recovery, and run selection. apps/smithers/tests/e2e/inspector.spec.ts covers inspector tabs, node selection, real node output, approval content, and pending-node detail. These matrix tests track pageerror events and assert none occurred. apps/smithers/playwright.config.ts, globalSetup.ts, and seedGateway.ts establish the real seeded Gateway with no mocks.
