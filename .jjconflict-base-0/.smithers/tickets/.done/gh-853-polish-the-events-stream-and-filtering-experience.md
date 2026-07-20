# Polish the events stream and filtering experience

GitHub: https://github.com/smithersai/smithers/issues/853

Provide a readable live event stream with clear lifecycle/activity distinctions, filtering, follow/pause behavior, overflow handling, and useful loading, empty, and error states.


> Closed by ticket-fleet sync: Implemented in apps/cli/src/monitor-ui/monitor.tsx:869-961: live event rendering, Notable/Activity/All filters, follow/pause scrolling, bounded maxEvents, and loading/empty/error states. apps/cli/src/monitor-ui/monitorModel.ts:523-641 provides readable lifecycle details and 120-character truncation. packages/gateway-react/src/useGatewayRunEvents.ts:44-75 caps events, removes heartbeats, and exposes stream state. apps/cli/tests/monitor-ui-model.test.ts passes 60 tests covering formatting, truncation, and classification; packages/gateway-ui/tests/hookComponents.test.tsx passes 72 tests covering live events, empty/error states, follow, and buffer overflow.
