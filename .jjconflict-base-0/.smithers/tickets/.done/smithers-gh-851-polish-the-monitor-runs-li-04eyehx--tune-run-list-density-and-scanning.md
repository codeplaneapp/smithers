# Tune run-list density and scanning

GitHub: https://github.com/smithersai/smithers/issues/943

Parent: smithers/gh-851-polish-the-monitor-runs-list-and-responsive-hierar.md

Context: The rail and all-runs overview should remain information-dense without becoming visually noisy. Acceptance criteria: Keep row controls and spacing compact; ellipsize long workflow names; retain run identity and timing; provide a readable all-runs table with sticky headers, progress, and pagination.


> Closed by ticket-fleet sync: Implemented in apps/cli/src/monitor-ui/monitor.tsx: rail rows retain workflow, short run ID, and elapsed/relative timing; RunsTable provides Status, Run, Workflow, Progress, Started, Duration, and pagination. Its CSS adds compact token spacing, workflow ellipsis, sticky table headers, scrolling, and compact pagination. apps/cli/src/monitor-ui/monitorModel.ts contains progress derivation and 100-row pagination. Tests passed: bun test --timeout=120000 --max-concurrency=1 tests/monitor-ui-model.test.ts tests/monitor-shell-controls.test.tsx (131 pass, 0 fail), and apps/cli typecheck passed.
