# Improve all-runs rail hierarchy

GitHub: https://github.com/smithersai/smithers/issues/940

Parent: smithers/gh-851-polish-the-monitor-runs-list-and-responsive-hierar.md

Context: The monitor rail must help operators scan runs by urgency and lifecycle state. Acceptance criteria: Group runs into clearly ordered attention, active, completed, failed, and cancelled sections; omit empty sections; sort newest first within each section; show section counts; preserve unknown statuses in a visible group.


> Closed by ticket-fleet sync: apps/cli/src/monitor-ui/monitorModel.ts:408-427 defines the five ordered groups and preserves unknown statuses in Active; lines 432-448 omit empty groups and sort newest first by createdAtMs. apps/cli/src/monitor-ui/monitor.tsx:419-448 renders each group and its count. apps/cli/tests/monitor-ui-model.test.ts:159-191 tests ordering, empty-group omission, newest-first sorting, and unknown-status visibility. Focused test passed: 116 pass, 0 fail.
