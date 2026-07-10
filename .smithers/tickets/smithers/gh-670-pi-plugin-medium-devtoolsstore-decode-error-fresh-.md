# 🐛 pi-plugin: [medium] DevToolsStore decode-error "fresh stream" reset is dead code (negated by ?? lastSeenSeq + client cursor re-derivation)

GitHub: https://github.com/smithersai/smithers/issues/670

_via ultracode (Opus multi-agent) review_

**Summary:** The decode-error recovery in `consumeStream` intends to force a fresh full-snapshot resubscribe (`nextAfterSeq = undefined`), but the value is immediately overwritten, so the escape hatch never runs once any snapshot has been applied.

**Locations**
- `packages/pi-plugin/src/runtime/DevToolsStore.ts:544` — on a decode error, `nextAfterSeq = undefined`.
- `packages/pi-plugin/src/runtime/DevToolsStore.ts:552` — `nextAfterSeq = nextAfterSeq ?? this.lastSeenSeq(runId)` overwrites it. Once a snapshot is applied, `lastSeenSeq` (`:684-689`, `Math.max(lastSeqSeen, liveSnapshot.seq)`) is non-undefined, so `undefined ?? seq → seq`. The reset at `:544` is dead.
- `packages/pi-plugin/src/runtime/DevToolsClient.ts:333` — even if `:552` were fixed, `afterSeqCursor = afterSeq ?? this.lastSeqSeenByRunId.get(runId)` refills undefined with the client's last-good seq (`normalizeEvent` at `:393` throws before `:394` records the seq), so a fresh subscribe is impossible from the store side alone.

**Failure scenario**
After a snapshot/delta is applied (`liveSnapshot.seq > 0`), a devtools frame arrives that `normalizeEvent` cannot classify (unknown/malformed kind — reachable via version-skew against a newer/foreign gateway or wire corruption; this repo's own gateway only synthesizes well-formed snapshot/delta, so it is not the trigger). `consumeStream` catches, increments `decodeErrorCount`, sets `nextAfterSeq = undefined` (`:544`), then `:552` resets it back to the last good seq. The reconnect resumes from just before the bad frame instead of doing the intended fresh full-snapshot resubscribe. If the undecodable frame recurs, there is no self-recovery (`decodeErrorCount` is never used to bound; `shouldReconnect` stays true), and live inspection stays wedged, bounded only by backoff.

**Evidence of intent:** `packages/pi-plugin/tests/DevToolsStore.behavior.test.ts:189` ("force the next reconnect to request a fresh stream", asserting `attempts == [undefined, undefined]`) only passes because it throws before yielding any snapshot, leaving `lastSeenSeq` undefined. It never covers the post-snapshot path the fix must handle.

**Why it matters:** The explicitly-coded decode-error escape hatch is non-functional; the recovery it advertises (and its test names) never executes when there is prior applied state. Fixing requires both honoring `undefined` at `:552` and letting the client (`:333`) perform a genuine fresh subscribe on an explicit resync request.
