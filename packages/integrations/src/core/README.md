# core/

The service-agnostic integration pipeline every service builds on:

- `EventSource.js` — `makeWebhookSource` (bounded-Queue-backed; ingress calls
  `offer(request)` per HTTP request) and `makePollingSource` (repeat
  `poll(cursor)` on a schedule, cursor persisted via CursorStore).
- `deliverEvents.js` — dedupe each event against
  `_smithers_integration_deliveries`, then `signalRun` every run parked on
  `WaitForEvent(eventName, correlationId)`.
- `IntegrationRuntime.js` — the process-wide supervisor: one restart-forever
  fiber per source on a dedicated ManagedRuntime, a promise-based
  `handleWebhook` seam for the node HTTP server, graceful `shutdown`.

Contracts:

- `ExternalEvent.js` — Effect Schema decoded at the ingress boundary.
- `signalNames.js` — the reserved `integration:<service>:<event>` signal
  namespace, builder + parser + `receivedBy` attribution.
- `IntegrationError.js` — SmithersError subclass with a machine-readable
  `reason` so ingress can map failures to HTTP statuses.
- `CursorStore.js` — db-backed (survives restarts) or in-memory (tests).

Utilities: `verifySignature.js` (constant-time HMAC-SHA256; hex, base64, and
`sha256=`-prefixed digests) and `readJsonPath.js` (dot-path reads, also used
by packages/server).

Gotcha: per-run signal failures are retried then swallowed — the source
stream must live on. A stream-level failure surfaces so IntegrationRuntime's
supervision restarts the source with capped exponential backoff.
