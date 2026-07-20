# server: prevent run-event subscriptions from registering after WebSocket close

GitHub: https://github.com/smithersai/smithers/issues/985

Parent: smithers/gh-553-server-gateway-stream-subscriptions-regist-0ok3jux.md

Context: streamRunEvents awaits resolveRun before registering a run-event subscriber. If the WebSocket closes during that await, connection cleanup runs first and the continuation can create a stale subscriber, heartbeat timer, and subscriber count. Acceptance criteria: expose or otherwise check connection liveness after resolveRun; do not register on a closed connection; ensure no stale runEventStreams entry, heartbeat, or subscriber count remains; add a regression test that closes during resolveRun and verifies cleanup.
