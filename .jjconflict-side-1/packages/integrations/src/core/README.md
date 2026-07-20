# core/

The service-agnostic integration pipeline every service builds on:

- `EventSource.js` — `makeWebhookSource` (bounded-Queue-backed; ingress calls
  `offer(request)` per HTTP request) and `makePollingSource` (repeat
  `poll(cursor)` on a schedule and emit an acknowledged `EventBatch`). A
  proposed cursor reaches the CursorStore only after the whole batch delivers.
  Webhook close reserves an internal EOS slot, so the advertised event
  capacity remains available and accepted events drain before the stream ends.
- `deliverEvents.js` — acquire a leased pending claim in
  `_smithers_integration_deliveries`, then `signalRun` every run parked on
  `WaitForEvent(eventName, correlationId)`. A typed signal failure is recorded
  while later matching runs are still attempted. The claim becomes completed
  only after the full fanout succeeds; failures and interruptions release it
  for immediate replay, while stale leases remain reclaimable after a crash.
- `IntegrationRuntime.js` — the process-wide supervisor: one restart-forever
  fiber per source on a dedicated ManagedRuntime, a promise-based
  `handleWebhook` seam for the node HTTP server, graceful `shutdown`. Shutdown
  closes webhook ingress, drains accepted events, then interrupts polling and
  arbitrary source fibers.

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

Gotcha: individual webhook delivery failures are logged and swallowed by the
drain so later queued items still run. The failed claim remains retryable by a
later duplicate or explicit replay; accepting the HTTP request does not
guarantee that the provider sends another copy. Polling batches have a
different contract: a signal or delivery failure propagates without running
the batch acknowledgement, so IntegrationRuntime restarts the source from its
last committed cursor. Replay uses the ledger's first `receivedAtMs`, making a
signal already inserted just before a crash dedupe to the exact same row while
the wait-resolution bridge finishes.
