# Polish run timing and duration display

GitHub: https://github.com/smithersai/smithers/issues/942

Parent: smithers/gh-851-polish-the-monitor-runs-list-and-responsive-hierar.md

Context: Operators need to understand live progress and completed-run history at a glance. Acceptance criteria: Show live elapsed duration for active runs; show stable duration for terminal runs; show relative start times for older runs; update live labels through a shared timer; cover formatting boundaries with tests.


> Closed by ticket-fleet sync: Implemented in apps/cli/src/monitor-ui/monitor.tsx:131-169 with one shared 1-second clock; active labels use live elapsed time, terminal labels freeze at finishedAtMs, and older starts use timeAgo. The model and rendering are covered by apps/cli/src/monitor-ui/monitorModel.ts:520-605 and apps/cli/tests/monitor-ui-model.test.ts:283-304,1050-1055. Terminal timestamps are persisted by packages/engine/src/engine.js:6224-6283. Focused tests passed: 116 tests in monitor-ui-model.test.ts and 23 tests across coverage-batch-2.test.js and monitor-shell-controls.test.tsx.
