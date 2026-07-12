# 🐛 server: gateway stream subscriptions registered after awaits leak when the WS closes mid-subscribe

GitHub: https://github.com/smithersai/smithers/issues/553

**What happens**
Three gateway stream handlers register their subscription *after* an `await`, with no re-check that the connection is still alive:
- `subscribeExtensionStream`: `await resolved.entry.subscribe(params, streamCtx)` (packages/server/src/gateway.js:7110) runs before `extensionStreamSubscriptions` is populated (gateway.js:7139-7148).
- `streamRunEvents`: `registerRunEventSubscriber` (6179) after `await this.resolveRun(runId)` (6170).
- `streamDevTools`: `registerDevToolsSubscriber` (6259) after `await this.resolveRun` (6244) and `await adapter.getLastFrame` (6250).

**Why it's wrong / failure scenario**
If the WS closes during the await, the close path (gateway.js:4354-4367) already ran `cleanupDevToolsSubscribers` / `cleanupRunEventSubscribers` / `cleanupExtensionSubscriptions` for the connection. The subscription then registers onto an already-cleaned connection: its AbortController is never fired and its cleanup callback never runs. For extension streams that leaks handler-owned resources (DB cursors, watchers, Electric shape handles) until process exit; for devtools the entry stays in the class-level `devtoolsSubscribers` map (gateway.js:2047) and the polling loop keeps running with a never-aborted signal (sends are dropped by the OPEN check, but work continues).

**Expected**
After the awaits, re-check connection liveness (e.g. a `closed`/`cleanedUp` flag set by the close path) and immediately abort + run cleanup instead of registering.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
