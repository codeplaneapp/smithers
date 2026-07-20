# 🐛 integrations: [high] polling source persists cursor before delivering the batch — a crash mid-batch drops events permanently

GitHub: https://github.com/smithersai/smithers/issues/667

_via ultracode (Opus multi-agent) review_

## Summary
`makePollingSource` commits the durable cursor for a poll batch *before* any of that batch's events are delivered, so a crash in the window loses those events forever and the dedupe table can never recover them.

## Location
- `packages/integrations/src/core/EventSource.js:82-87` — `pollOnce` does `Ref.set(cursorRef, result.cursor)` + `cursorStore.set(id, result.cursor)` (lines 82-85), then `return polled` (line 87). Cursor is committed before the batch is emitted.
- `packages/integrations/src/core/deliverEvents.js:84-85` — delivery is a later stream stage: `Stream.runForEach(source.events, deliverEvent)`, where `deliverEvent` (line 24) dedupes via `insertIntegrationDeliveryIfNew` (line 26) and `signalRun`s (line 43).
- `packages/integrations/src/telegram/TelegramSource.js:211-216` — `poll` returns `cursor = maxUpdateId + 1`; getUpdates offset semantics confirm/discard prior updates on the next poll (doc comment lines 163-167).

## Failure scenario
1. Telegram `getUpdates` returns updates 100-105; `poll` computes cursor `106`.
2. `pollOnce` runs `cursorStore.set('telegram','106')` — DB now says 106.
3. Before the 6 ExternalEvents reach `deliverEvent` (dedupe insert + `signalRun`), the process crashes.
4. On restart the persisted cursor is `106`; the next `getUpdates(offset=106)` makes Telegram confirm/discard 100-105.
5. Updates 100-105 are never re-delivered; runs parked on those messages hang until timeout. Same window exists for any polling source.

## Why it matters
The `_smithers_integration_deliveries` dedupe table exists to provide crash-safe **at-least-once** delivery (suppress duplicates on re-poll). Persisting the cursor *before* delivery makes the pipeline **at-most-once**: once the cursor advances, a re-poll never returns the lost updates, so dedupe can never recover them. This inverts the durability guarantee for a control plane that markets crash-safety.

## Suggested fix
Deliver the batch (or per-event acknowledge) *before* persisting the cursor, relying on the dedupe table to suppress the redeliveries a re-poll would produce. Note there is still a smaller inner window in `deliverEvent` (dedupe row inserted at line 26 before `signalRun` at line 43); ordering cursor-after-delivery is strictly safer regardless.
