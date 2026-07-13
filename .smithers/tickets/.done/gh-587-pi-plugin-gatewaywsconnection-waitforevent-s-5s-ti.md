# 🐛 pi-plugin: GatewayWsConnection.waitForEvent's 5s timeout is not enforced while awaiting the next frame — connect() can hang forever

GitHub: https://github.com/smithersai/smithers/issues/587

**What happens**
`GatewayWsConnection.waitForEvent` (packages/pi-plugin/src/runtime/DevToolsClient.ts:250-262) checks `Date.now() < timeoutAt` only BETWEEN frames; `await this.nextEvent()` (lines 227-237) has no timer and resolves only on an incoming message or connection close. `connect()` (line 208) awaits `waitForEvent("connect.challenge", 5_000)`.

**Why it's wrong / failure scenario**
A gateway (or middlebox) that accepts the WebSocket but never sends any frame makes `connect()` await indefinitely — the 5s deadline never fires. `DevToolsStore.consumeStream` (DevToolsStore.ts:518-557) then sits in `connectionState: "connecting"` with no error, no backoff, and no reconnect; only aborting the stream or the socket dying unblocks it.

**Expected behavior**
The timeout should bound the whole wait, e.g. `Promise.race` of `nextEvent()` against a deadline timer (cleaning up the waiter on timeout), so a silent gateway surfaces `PI_GATEWAY_TIMEOUT` after 5s and the store's reconnect/backoff path engages.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in e8c87798775dc86165c4c7826192c45bff5f34e7.
