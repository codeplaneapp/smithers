# server: clean up extension streams when WebSocket closes during subscribe

GitHub: https://github.com/smithersai/smithers/issues/987

Parent: smithers/gh-553-server-gateway-stream-subscriptions-regist-0ok3jux.md

Context: subscribeExtensionStream awaits the extension subscribe handler before storing the subscription in extensionStreamSubscriptions. If the WebSocket closes during that await, cleanup runs before registration and the handler-owned resources can leak after the continuation inserts the subscription. Acceptance criteria: re-check connection liveness after the subscribe await; when closed, abort the stream and invoke its cleanup callback exactly once without registering it; add a regression test with a delayed subscribe handler that closes the connection before resolution and verifies cleanup.
