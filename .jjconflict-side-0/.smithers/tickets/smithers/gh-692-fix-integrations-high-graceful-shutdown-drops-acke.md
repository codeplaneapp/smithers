# 🐛 fix(integrations): [high] graceful shutdown drops acked-but-undelivered webhook events

GitHub: https://github.com/smithersai/smithers/issues/692

_via ultracode (Opus multi-agent) review_

**Summary:** `IntegrationRuntime.shutdown()` interrupts the delivery fibers without draining the webhook queues, silently losing events that were already ack'd 2xx to the provider but not yet delivered to waiting runs.

**Locations:**
- `packages/integrations/src/core/IntegrationRuntime.js:84-87` — shutdown runs `Effect.all(sourceShutdowns)` then immediately `Fiber.interruptAll(fibers)`; the comment "so in-flight events drain" is false — there is no drain/wait step.
- `packages/integrations/src/core/EventSource.js:54` — `offer` returns `{ accepted }` (→ HTTP 2xx) the instant `Queue.offerAll` succeeds, before any delivery work.
- `packages/integrations/src/core/deliverEvents.js:26` — the only durable record (`insertIntegrationDeliveryIfNew`) is written *during* `deliverEvent`, so between ack and delivery the event exists only in the in-memory bounded queue (cap 256).

**Failure scenario:** A burst of GitHub/Linear webhooks fills the queue faster than `deliverEvent` drains it (each does DB writes + retried `signalRun`). The ingress has already returned 2xx, so the provider never redelivers. Operator triggers a graceful shutdown (deploy/restart) → `Queue.shutdown` + immediate `Fiber.interruptAll` drop both the still-queued events and the ones already pulled into the delivery fiber's in-flight batch. A run parked on `WaitForEvent(eventName, correlationId)` for one of those deliveries is never signaled and hangs forever, with no error surfaced.

**Reproduced** (effect 3.21.4): 5 events offered/acked into a `Stream.fromQueue` source with a slow handler, then the exact shutdown ordering (`Queue.shutdown` → `Fiber.interrupt`) → 0 delivered.

**Why it matters:** This is a durability control plane whose contract is that an accepted external event durably wakes the waiting run. A correct shutdown must stop ingress and let the delivery fiber drain (e.g. `takeAll` + deliver, or a bounded quiesce wait) before interrupting — or events must be persisted before the HTTP ack.
