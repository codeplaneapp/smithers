# 🐛 integrations: webhook offer on a full bounded queue suspends ingress; queue-closed error paths are unreachable

GitHub: https://github.com/smithersai/smithers/issues/575

**What happens**
`makeWebhookSource` uses `Queue.bounded(capacity)` (`packages/integrations/src/core/EventSource.js:29`) and offers with `Queue.offerAll(queue, events)` (:54). Effect's bounded queue uses the backpressure strategy: `offerAll` suspends until capacity frees instead of returning `false`.

**Why it's wrong / failure scenario**
- A slow or stalled delivery consumer makes `IntegrationRuntime.handleWebhook` promises hang indefinitely; webhook callers (GitHub, Telegram) time out and redeliver, amplifying the backlog.
- The `!accepted` branch mapping to `queue-closed` / "rejected the event batch" (:55-57) can never be taken under backpressure.
- Offering to a shutdown queue interrupts the fiber rather than producing a typed failure, so the `Effect.mapError(... "queue-closed" ...)` on :54 likely never fires either — ingress would surface a squashed interruption instead of the intended IntegrationError.

The dead error handling indicates non-blocking offer semantics were assumed when this was written.

**Expected behavior**
Either a sliding/dropping strategy (or explicit capacity check) with a typed queue-full failure so ingress can return 429/503, plus proper shutdown detection (`Queue.isShutdown`) — or an explicit comment documenting that ingress intentionally applies backpressure.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
