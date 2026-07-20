# Make Monitor connection states actionable

GitHub: https://github.com/smithersai/smithers/issues/1041

Parent: smithers/smithers-gh-855-add-complete-monitor-loadi-0h89cz9--make-gateway-disconnection-and-recovery-st-0z3jdjw.md

Context: The Monitor currently shows Live, Connecting, Offline, and Unauthorized in a header badge, but degraded states do not provide consistent guidance or recovery actions. Acceptance criteria: 1. Connecting, offline, and unauthorized states have consistent visual treatment. 2. Connecting explains that queries are still pending. 3. Offline offers an automatic-retry or refresh/reopen action. 4. Unauthorized clearly explains that credentials or permissions are required and does not use network-outage wording. 5. Add focused UI tests for all connection states.


> Closed by ticket-fleet sync: Implemented in apps/cli/src/monitor-ui/monitorModel.ts:348-390 and rendered by monitor.tsx:205-235 and 420-430. Connecting explains pending queries; offline shows automatic reconnect guidance plus a wired Refresh action; unauthorized explains credential/permission requirements without outage wording. Focused coverage is in apps/cli/tests/monitor-ui-model.test.ts:97-157, and `bun test apps/cli/tests/monitor-ui-model.test.ts` passes 116 tests with 0 failures.
